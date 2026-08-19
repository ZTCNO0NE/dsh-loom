import { defineTool } from '@deepseek-ai/dsh-tools'
import { readdir } from 'node:fs/promises'

export const name = 'ls-dir'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'ls-dir',
    description: '列出指定目录下的文件名列表',
    parameters: { path: { type: 'string', required: true, description: '目标目录路径' } },
    output: { schema: { type: 'array', items: { type: 'string' } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args) { return (await readdir(args.path, { withFileTypes: true })).map((entry) => entry.name) },
  }))
}
