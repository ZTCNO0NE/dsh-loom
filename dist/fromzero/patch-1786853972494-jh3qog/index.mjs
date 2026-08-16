import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'fs-write';
export const inject = ['tools'];

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'fs-write',
    description: '将内容写入指定路径（支持任意路径）',
    parameters: {
      path: { type: 'string', required: true, description: '目标文件绝对路径' },
      content: { type: 'string', required: true, description: '要写入的内容' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      const { path, content } = args;
      if (!path || !content) throw new Error('path 和 content 为必填');
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, 'utf8');
      return `已写入文件: ${path}`;
    },
  }));
}
