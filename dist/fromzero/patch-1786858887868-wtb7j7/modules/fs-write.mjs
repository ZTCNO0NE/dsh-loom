import { defineTool } from '@deepseek-ai/dsh-tools'
import fs from 'node:fs/promises'
import path from 'node:path'

export const name = 'fs-write'
export const inject = ['tools']
export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'fs-write',
    description: '写入内容到指定路径（任意路径）',
    parameters: {
      path: { type: 'string', required: true, description: '目标文件路径' },
      content: { type: 'string', required: true, description: '写入内容' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(args) {
      await fs.mkdir(path.dirname(args.path), { recursive: true })
      await fs.writeFile(args.path, args.content, 'utf8')
      return `written: ${args.path}`
    },
  }))
}
