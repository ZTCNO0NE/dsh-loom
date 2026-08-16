import { defineTool } from '@deepseek-ai/dsh-tools'
import { readFile } from 'node:fs/promises'

export const name = 'file-read'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'file-read',
    description: '读取指定文件的内容并返回',
    parameters: {
      path: { type: 'string', required: true, description: '目标文件路径' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      const content = await readFile(args.path, 'utf-8')
      return content
    },
  }))
}
