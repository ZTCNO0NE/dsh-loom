import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'

const option = (name) => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}
const dshRoot = option('--dsh-root')
const profile = option('--profile')
if (!dshRoot || !profile) throw new Error('cold profile probe requires --dsh-root and --profile')
const profileBoot = join(dshRoot, 'apps', 'cli', 'src', 'profile-boot.ts')
const appBoot = join(dshRoot, 'packages', 'boot', 'app-boot', 'src', 'index.ts')
if (!existsSync(profileBoot) || !existsSync(appBoot)) throw new Error('cold profile probe cannot resolve the configured DSH source checkout')
const [{ runProfile }, { loadLayeredEnv }] = await Promise.all([
  import(pathToFileURL(profileBoot).href),
  import(pathToFileURL(appBoot).href),
])
const temp = mkdtempSync(join(tmpdir(), 'dsh-loom-cold-profile-'))
const patch = join(temp, 'cold.patch.yml')
const coldHmr = new URL('./loom-cold-hmr.mjs', import.meta.url).href
writeFileSync(patch, [
  '- id: hmr',
  '  disabled: true',
  // A cold Loader probe must mount every plugin, but it must not execute the
  // profile surface.  In a headless profile these two rows parse a user task
  // and run an Agent after the Loader has already succeeded.  Leaving them
  // enabled turns a valid cold boot into a CLI usage failure (or, with a dummy
  // task, an unrelated model call).  Disable the surface rows while retaining
  // the rest of the real profile tree and candidate plugin apply lifecycle.
  '- id: headless-startup',
  '  disabled: true',
  '- id: headless-runner',
  '  disabled: true',
  '- insert:',
  '    - id: loom-cold-hmr',
  `      name: ${JSON.stringify(coldHmr)}`,
  '      config: {}',
  '',
].join('\n'), 'utf8')
try {
  const { ctx } = await runProfile({ environment: loadLayeredEnv('dsh'), profile, patchFiles: [patch], args: [] })
  await ctx.fiber.dispose()
  console.log(JSON.stringify({ passed: true, profile }))
} finally {
  rmSync(temp, { recursive: true, force: true })
}
