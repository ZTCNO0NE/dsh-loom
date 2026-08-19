#!/usr/bin/env node
/**
 * dsh-loom CLI — 便携版"3 分钟亲历自进化"。
 * 用法：dsh-loom try
 * 不依赖仓库/demo 脚本/本机路径；需要 dsh 在 PATH、DEEPSEEK_API_KEY 可路由，
 * 且当前 profile 已安装 dsh-loom（dsh plugin add dsh-loom）。
 */
import { spawn, spawnSync } from 'node:child_process'
import { writeFileSync, mkdtempSync, readFileSync, existsSync, mkdirSync, rmSync, readdirSync, lstatSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const command = process.argv[2]

const root = process.env.DSH_META_VALIDATE_ROOT
  ?? (process.env.DSH_HOME ? join(process.env.DSH_HOME, 'meta-validate') : join(process.cwd(), '.meta-validate'))
const session = 'loom-try-cli'

const MINI_SWE_VERSION = '2.4.6'
const MINIMUM_PYTHON = [3, 10]
const option = (name) => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function bootstrapRuntime() {
  const runtimeRoot = option('--runtime-root') ?? process.env.DSH_LOOM_RUNTIME_ROOT ?? join(root, 'runtime', `mini-swe-agent-${MINI_SWE_VERSION}`)
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
  const bundledSource = join(packageRoot, 'runtime', `mini-swe-agent-${MINI_SWE_VERSION}.tar.gz`)
  const source = option('--source') ?? (existsSync(bundledSource) ? bundledSource : `mini-swe-agent==${MINI_SWE_VERSION}`)
  const isWindows = process.platform === 'win32'
  const binDir = isWindows ? 'Scripts' : 'bin'
  const pythonName = isWindows ? 'python.exe' : 'python'
  const miniName = isWindows ? 'mini.exe' : 'mini'
  const python = process.env.PYTHON ?? (isWindows ? 'python' : 'python3')
  const mini = join(runtimeRoot, binDir, miniName)
  if (!existsSync(mini)) {
    const version = spawnSync(python, ['-c', 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}")'], { encoding: 'utf8' })
    if (version.error) {
      console.error(`❌ 无法执行 Python（${python}）：${version.error.message}`)
      console.error('mini-SWE 2.4.6 需要 Python >= 3.10。请安装 Python 3.10+ 并确认解释器在 PATH。')
      process.exit(1)
    }
    const [major = 0, minor = 0] = String(version.stdout).trim().split('.').map(Number)
    if (version.status !== 0 || major < MINIMUM_PYTHON[0] || (major === MINIMUM_PYTHON[0] && minor < MINIMUM_PYTHON[1])) {
      const actual = String(version.stdout).trim() || 'unknown'
      console.error(`❌ Python ${actual} 不受支持：mini-SWE ${MINI_SWE_VERSION} 需要 Python >= ${MINIMUM_PYTHON.join('.')}`)
      console.error('请安装 Python 3.10+；Windows 可用 $env:PYTHON 指向对应解释器。')
      process.exit(1)
    }
    mkdirSync(runtimeRoot, { recursive: true })
    const venv = spawnSync(python, ['-m', 'venv', runtimeRoot], { stdio: 'inherit' })
    if (venv.error) {
      console.error(`❌ 无法执行 Python（${python}）：${venv.error.message}`)
      console.error('请安装 Python 3，并确认 python/python3 已加入 PATH；Windows 可设置 $env:PYTHON = "python"。')
      process.exit(1)
    }
    if (venv.status !== 0) {
      console.error(`❌ Python venv 创建失败（exit ${venv.status ?? 'unknown'}）：${runtimeRoot}`)
      process.exit(venv.status ?? 1)
    }
    const install = spawnSync(join(runtimeRoot, binDir, pythonName), ['-m', 'pip', 'install', '--disable-pip-version-check', source], { stdio: 'inherit' })
    if (install.error) {
      console.error(`❌ 无法执行 venv Python：${install.error.message}`)
      process.exit(1)
    }
    if (install.status !== 0) {
      console.error(`❌ mini-SWE 安装失败（exit ${install.status ?? 'unknown'}）：${source}`)
      process.exit(install.status ?? 1)
    }
  }
  const patch = join(runtimeRoot, 'loom-active-evolution.patch.yml')
  // Quote the path so spaces, ':' and other YAML-significant characters are safe.
  writeFileSync(patch, ['- id: meta-validate', '  config:', '    activeEvolution:', '      enabled: true', `      runtimeRoot: ${JSON.stringify(runtimeRoot)}`, ''].join('\n'))
  return { runtimeRoot, mini, patch }
}

// Source checkouts of DSH keep @deepseek-ai/dsh-tools in apps/cli's
// devDependencies. The DSH fallback healer intentionally ignores devDependencies,
// so an out-of-tree bundle's peer cannot resolve from a profile on that path.
// Repair only this known source-mode gap; published DSH installations are left
// untouched. A real directory at the target is never overwritten.
function repairSourceDshHostFallback() {
  const candidates = []
  if (process.env.DSH_ROOT) candidates.push(resolve(process.env.DSH_ROOT))
  let cursor = resolve(process.cwd())
  for (let depth = 0; depth < 6; depth += 1) {
    candidates.push(cursor)
    const parent = dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  const sourceRoot = candidates.find((candidate) =>
    existsSync(join(candidate, 'apps', 'cli', 'package.json'))
      && existsSync(join(candidate, 'packages', 'core', 'tools', 'package.json')))
  if (!sourceRoot) return undefined
  const cliManifestPath = join(sourceRoot, 'apps', 'cli', 'package.json')
  const cliManifest = JSON.parse(readFileSync(cliManifestPath, 'utf8'))
  const packageDir = (name) => {
    const direct = join(sourceRoot, 'node_modules', ...name.split('/'))
    if (existsSync(join(direct, 'package.json'))) return direct
    const roots = [join(sourceRoot, 'packages'), join(sourceRoot, 'apps'), join(sourceRoot, 'vendor')]
    const queue = [...roots]
    while (queue.length > 0) {
      const dir = queue.shift()
      if (!dir) continue
      const manifest = join(dir, 'package.json')
      if (existsSync(manifest)) {
        try {
          if (JSON.parse(readFileSync(manifest, 'utf8')).name === name) return dir
        } catch { /* ignore malformed/unrelated workspace entries */ }
        continue
      }
      let entries = []
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
      for (const entry of entries) if (entry.isDirectory()) queue.push(join(dir, entry.name))
    }
    return undefined
  }
  const pending = new Set([
    ...Object.keys(cliManifest.dependencies ?? {}),
    ...Object.keys(cliManifest.devDependencies ?? {}),
    ...Object.keys(cliManifest.peerDependencies ?? {}),
  ])
  const resolved = new Map()
  while (pending.size > 0) {
    const name = pending.values().next().value
    pending.delete(name)
    if (resolved.has(name)) continue
    const dir = packageDir(name)
    if (!dir) continue
    resolved.set(name, dir)
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      for (const dep of [manifest.dependencies, manifest.devDependencies, manifest.peerDependencies]) {
        for (const child of Object.keys(dep ?? {})) if (!resolved.has(child)) pending.add(child)
      }
    } catch { /* the loader will report an actually unusable package */ }
  }
  const missingBuilt = [...resolved.entries()].find(([, dir]) => {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      // Type-only packages (for example @types/*) intentionally have no
      // runtime entry and must not trigger a host rebuild.
      const main = typeof manifest.main === 'string' ? manifest.main : undefined
      if (main !== undefined) return !existsSync(join(dir, main))
      const defaultExport = manifest.exports?.['.']?.default
      return typeof defaultExport === 'string' && !existsSync(join(dir, defaultExport))
    } catch { return false }
  })
  if (missingBuilt) {
    console.log(`ℹ️ 检测到 DSH 源码模式，正在构建宿主包（缺少 lib：${missingBuilt[0]}）…`)
    // dsh-tools is compiled by DSH's host build; it has no package-local
    // `build` script, so filtering the package produces a misleading
    // recursive-run error.
    for (const script of ['build:lib:host', 'build:lib:client']) {
      const build = spawnSync('pnpm', ['run', script], {
        cwd: sourceRoot,
        stdio: 'inherit',
        shell: process.platform === 'win32',
      })
      if (build.error || build.status !== 0) {
        console.error(`❌ DSH ${script} 构建失败：${missingBuilt[0]}`)
        console.error(`请在 DSH 根目录手动执行：pnpm run ${script}`)
        return false
      }
    }
  }
  const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh')
  if (!dshHome) return false
  for (const [name, target] of resolved) {
    const link = join(dshHome, 'profiles', 'node_modules', ...name.split('/'))
    mkdirSync(dirname(link), { recursive: true })
    try {
      const current = lstatSync(link)
      if (!current.isSymbolicLink()) {
        console.error(`❌ DSH host fallback 不是链接，未覆盖：${link}`)
        console.error('请先移除该路径后重新运行 setup；不会自动删除真实目录。')
        return false
      }
      if (resolve(dirname(link), readlinkSync(link)) === target) continue
      unlinkSync(link)
    } catch { /* missing link: create below */ }
    try {
      symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      console.error(`❌ 无法建立 DSH host fallback：${link}`)
      console.error(String(error))
      console.error('Windows 可用管理员 PowerShell 手动创建 Junction，或改用已发布的 DSH CLI。')
      return false
    }
  }
  console.log(`✅ 已修复 DSH 源码模式 host fallback：${resolved.size} 个宿主包`)
  return true
}

if (command === 'setup') {
  const hostRepair = repairSourceDshHostFallback()
  if (hostRepair === false) process.exit(1)
  const { runtimeRoot, mini, patch } = bootstrapRuntime()
  console.log(`✅ mini-SWE ${MINI_SWE_VERSION} 已安装：${mini}`)
  console.log(`✅ 主动演进 patch 已生成：${patch}`)
  console.log('启动 DSH 时追加：dsh --profile loom --patch "' + patch + '"')
  process.exit(0)
}

if (command === 'start') {
  const { patch } = bootstrapRuntime()
  const profile = option('--profile') ?? 'loom'
  const passthrough = []
  for (let index = 3; index < process.argv.length; index += 1) {
    const arg = process.argv[index]
    if (['--profile', '--runtime-root', '--source'].includes(arg)) { index += 1; continue }
    passthrough.push(arg)
  }
  const [, ...surfaceArgs] = passthrough
  // `web` is DSH's fixed --profile web alias. A custom Loom profile must use
  // the root options directly; never compose `web --profile loom`.
  const dshArgs = ['--profile', profile, '--patch', patch, ...surfaceArgs]
  const result = spawnSync(process.env.DSH_COMMAND ?? 'dsh', dshArgs, { stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.error) {
    console.error(`❌ 无法启动 DSH：${result.error.message}`)
    console.error('源码 checkout 请使用 pnpm dsh --profile loom --patch <patch>。')
  }
  process.exit(result.status ?? 1)
}

if (command !== 'try') {
  console.log('用法：dsh-loom setup [--runtime-root <dir>] | dsh-loom start [--profile <name>] [web] | dsh-loom try')
  process.exit(command ? 1 : 0)
}
const ws = join(root, 'workspace', session)
rmSync(ws, { recursive: true, force: true })
rmSync(join(root, 'overlays', session), { recursive: true, force: true })
rmSync(join(root, 'growth', session), { recursive: true, force: true })

const tmp = mkdtempSync(join(tmpdir(), 'dsh-loom-try-'))
const timeoutOverlay = join(tmp, 'timeout.yml')
writeFileSync(timeoutOverlay, [
  "- id: bash-sandbox",
  "  name: '@deepseek-ai/dsh-bash-sandbox'",
  '  config:',
  '    timeoutMs: 500',
  '',
].join('\n'))
const pluginOverlay = join(tmp, 'plugin.yml')
writeFileSync(pluginOverlay, [
  '- insert:',
  '    - id: meta-validate',
  "      name: 'dsh-loom'",
  '      config:',
  '        mode: apply',
  `        sessionId: ${session}`,
  '        maxIterations: 3',
  '        isolation:',
  '          enabled: true',
  '          probe: "run bash with command \'sleep 1\' and reply with the result"',
  '          probeTimeoutMs: 120000',
  '        reviewGate:',
  '          minIntervalTurns: 0',
  '          maxIterationsPerEpoch: 5',
  '',
].join('\n'))

function run(overlays, task, timeoutMs = 480000) {
  return new Promise((resolve) => {
    const child = spawn(
      'dsh',
      ['--profile', 'headless', ...overlays.flatMap((o) => ['--patch', o]), task],
      { stdio: ['ignore', 'pipe', 'pipe'], detached: true },
    )
    let out = ''
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        // already gone
      }
      resolve({ exitCode: 124, out })
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { out += String(chunk) })
    child.stderr.on('data', (chunk) => { out += String(chunk) })
    child.on('error', (error) => { clearTimeout(timer); resolve({ exitCode: -1, out: String(error) }) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ exitCode: code ?? -1, out }) })
  })
}

const line = (text) => console.log(`\n━━━ ${text} ━━━\n`)
line('Loom · 织机 — 3 分钟亲历自进化（便携版）')
console.log('你会看到：一个 agent 在你面前失败 → 自己长出能力 → 重试成功。\n')

line('① 先让它裸跑失败')
const off = await run([timeoutOverlay], '运行 bash 工具执行命令 `sleep 1`，正常完成后回复 ok。')
const offFailed = off.out.includes('超时') || off.out.includes('timeout') || off.out.includes('Timed out')
console.log(offFailed ? '❌ 失败：命令在约 500ms 就被杀掉——agent 自己解决不了。\n' : `⚠️ 意外成功（${off.out.slice(-120)}）`)
if (!offFailed) process.exit(1)

line('② 看着它长（监督员 → 改进模型 → 核验器 → 安装）')
console.log('…收集失败信号 → 监督员判定 → 改进模型设计（真实调用）…\n')
const iterateTask = "先运行 bash 工具执行命令 `sleep 1`。如果失败，调用 meta_auto 工具，requirements 原文：bash 命令 sleep 1 大约 500ms 就被终止，请让 actor 能正常执行这类命令。meta_auto 返回后回复 verdict 和 applied。"
await run([timeoutOverlay, pluginOverlay], iterateTask)

const historyFile = join(ws, 'history.jsonl')
const history = existsSync(historyFile)
  ? readFileSync(historyFile, 'utf8').trim().split('\n').filter(Boolean).map((row) => JSON.parse(row))
  : []
const appliedUpdate = history.find((row) => row.action === 'apply')
if (!appliedUpdate) {
  console.log('❌ 本次没有应用成功（看上面输出）。')
  process.exit(1)
}
const patchesDir = join(ws, 'patches')
let rationale = ''
if (existsSync(patchesDir)) {
  for (const id of readdirSync(patchesDir)) {
    const candidate = join(patchesDir, id, 'candidate.json')
    if (existsSync(candidate)) {
      try {
        rationale = JSON.parse(readFileSync(candidate, 'utf8')).rationale ?? ''
      } catch {
        // skip
      }
    }
  }
}
console.log(`✅ 改进模型给出了方案：${rationale.slice(0, 160) || '(见台账)'}`)
console.log(`   改动：${JSON.stringify(appliedUpdate.after)}`)
console.log('…隔离环境真实执行 → 预期轨迹 vs 真实帧对齐 → 核验通过 → 安装（reload 后生效）\n')

line('③ 同一个任务，重试')
const rerun = await run([timeoutOverlay, appliedUpdate.overlay], '运行 bash 工具执行命令 `sleep 1`，正常完成后回复 ok。', 120000)
const rerunOk = rerun.exitCode === 0 && rerun.out.includes('ok') && !rerun.out.includes('超时')
console.log(rerunOk ? '✅ 成功了。能力是刚才自己长出来的。\n' : `⚠️ 重试未达预期（${rerun.out.slice(-150)}）`)

line('④ 成长记录')
const growthDir = join(root, 'growth', session)
const reportFile = join(growthDir, 'report.md')
const report = existsSync(reportFile) ? readFileSync(reportFile, 'utf8') : '(空)'
console.log(report)

const esc = (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/><title>Loom try</title>
<style>body{font-family:sans-serif;max-width:720px;margin:40px auto;padding:0 20px;line-height:1.7}h1{font-size:24px}pre{background:#f6f8fa;padding:12px;border-radius:6px}</style></head>
<body><h1>Loom · 织机 — 亲历结果</h1>
<p>裸跑失败：${offFailed ? '✅' : '❌'} · 改进已应用：✅ · 重试成功：${rerunOk ? '✅' : '❌'}</p>
<p>改动：${esc(JSON.stringify(appliedUpdate.after))}</p>
<h3>成长记录</h3><pre>${esc(report)}</pre>
<p style="color:#888;font-size:13px">命令：dsh-loom try · 仓库 github.com/ZTCNO0NE/dsh-loom</p>
</body></html>`
const htmlPath = join(growthDir, 'report.html')
mkdirSync(growthDir, { recursive: true })
writeFileSync(htmlPath, html, 'utf8')
console.log(`\n📄 报告：${htmlPath}`)
console.log(`结果：${offFailed && rerunOk ? 'PASS ✅' : 'FAIL ❌'}`)
