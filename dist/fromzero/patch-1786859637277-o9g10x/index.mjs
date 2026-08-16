import { exec } from 'child_process'
import { promisify } from 'util'
import { defineTool } from '@deepseek-ai/dsh-tools'

const execAsync = promisify(exec)

export const name = 'bash-run'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'bash-run',
    description: '在 shell 中执行命令并返回 stdout/stderr',
    parameters: {
      command: { type: 'string', required: true, description: '要执行的 shell 命令' }
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(args) {
      try {
        const { stdout, stderr } = await execAsync(args.command)
        return (stdout + (stderr ? `\n${stderr}` : '')).trim()
      } catch (error) {
        const stderrMsg = error.stderr ? error.stderr : error.message
        return `ERROR: ${stderrMsg}`
      }
    }
  }))
}
