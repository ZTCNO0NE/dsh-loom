import { existsSync } from 'node:fs'
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path'

export interface PluginCommandInvocation {
  executable: string
  args: string[]
}

export interface CommandInvocationOptions {
  platform?: NodeJS.Platform
  nodeExecutable?: string
  env?: NodeJS.ProcessEnv
  fileExists?: (path: string) => boolean
}

function windowsNodeCliCandidates(command: 'npm' | 'npx' | 'pnpm', requestedExecutable: string, nodeExecutable: string, env: NodeJS.ProcessEnv): string[] {
  const nodeDirectory = dirname(nodeExecutable)
  const requestedDirectory = isAbsolute(requestedExecutable) ? dirname(requestedExecutable) : undefined
  const npmScript = command === 'npx' ? 'npx-cli.js' : 'npm-cli.js'
  const candidates: string[] = []
  const currentCli = env.npm_execpath
  if (currentCli) {
    const normalized = currentCli.replaceAll('\\', '/').toLowerCase()
    if (
      (command === 'npm' && normalized.endsWith('/npm-cli.js'))
      || (command === 'npx' && normalized.endsWith('/npx-cli.js'))
      || (command === 'pnpm' && /\/pnpm(?:\.cjs|\.js)$/.test(normalized))
    ) candidates.push(currentCli)
  }
  if (command === 'npm' || command === 'npx') {
    candidates.push(
      ...(requestedDirectory ? [join(requestedDirectory, 'node_modules', 'npm', 'bin', npmScript)] : []),
      join(nodeDirectory, 'node_modules', 'npm', 'bin', npmScript),
      join(nodeDirectory, '..', 'node_modules', 'npm', 'bin', npmScript),
    )
  } else {
    candidates.push(
      ...(requestedDirectory ? [join(requestedDirectory, 'pnpm.cjs'), join(requestedDirectory, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')] : []),
      join(nodeDirectory, 'pnpm.cjs'),
      join(nodeDirectory, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
      join(nodeDirectory, '..', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
    )
  }
  for (const directory of (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)) {
    if (command === 'npm' || command === 'npx') {
      candidates.push(
        join(directory, 'node_modules', 'npm', 'bin', npmScript),
        join(directory, '..', 'node_modules', 'npm', 'bin', npmScript),
      )
    } else {
      candidates.push(
        join(directory, 'pnpm.cjs'),
        join(directory, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
        join(directory, '..', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
      )
    }
  }
  return [...new Set(candidates.map((candidate) => resolve(candidate)))]
}

/** Resolve npm-family Windows shims to Node + a concrete JS CLI without shell interpolation. */
export function resolvePluginCommandInvocation(
  command: string,
  args: string[],
  options: CommandInvocationOptions = {},
): PluginCommandInvocation {
  if (!/^[A-Za-z0-9._/@:+\\-]+$/.test(command)) throw new Error(`unsafe plugin command executable: ${command}`)
  const platform = options.platform ?? process.platform
  const commandName = basename(command).toLowerCase().replace(/\.(?:cmd|bat)$/i, '')
  if (platform !== 'win32' || !['npm', 'pnpm', 'npx'].includes(commandName)) return { executable: command, args: [...args] }
  const nodeExecutable = options.nodeExecutable ?? process.execPath
  const env = options.env ?? process.env
  const fileExists = options.fileExists ?? existsSync
  const manager = commandName as 'npm' | 'npx' | 'pnpm'
  const cli = windowsNodeCliCandidates(manager, command, nodeExecutable, env).find(fileExists)
  if (!cli) throw new Error(`unable to resolve Windows ${manager} CLI without a command shell; install ${manager} beside Node or expose its JavaScript CLI on PATH`)
  return { executable: nodeExecutable, args: [cli, ...args] }
}
