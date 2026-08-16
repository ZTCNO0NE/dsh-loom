import { exec } from 'child_process'
import { promisify } from 'util'
import { defineTool } from '@deepseek-ai/dsh-tools'

const execP = promisify(exec)

export const name = 'bash-run'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'bash-run',
    description: '运行一个 bash 命令并返回其标准输出',
    parameters: {
      command: { type: 'string', required: true, description: '要执行的命令' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      try {
        const { stdout, stderr } = await execP(args.command, { encoding: 'utf8' })
        return (stdout || '') + (stderr ? `\nSTDERR:\n${stderr}` : '')
      } catch (err) {
        throw new Error(`bash-run failed: ${err.message}`)
      }
    },
  }))
}
