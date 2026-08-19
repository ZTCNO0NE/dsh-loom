import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { defineTool } from '@deepseek-ai/dsh-tools'

const execAsync = promisify(exec)
export const name = 'bash-run'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'bash-run',
    description: '执行 shell 命令并返回输出',
    parameters: { command: { type: 'string', required: true, description: '要执行的 shell 命令' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(args) {
      try {
        const { stdout, stderr } = await execAsync(args.command, { encoding: 'utf8' })
        return `${stdout}${stderr}`.trim()
      } catch (error) {
        const failure = error
        const message = `${failure.stdout ?? ''}${failure.stderr ?? ''}`.trim()
        return message || String(failure.message)
      }
    },
  }))
}
