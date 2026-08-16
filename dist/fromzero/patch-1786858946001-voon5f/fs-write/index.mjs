import { defineTool } from '@deepseek-ai/dsh-tools';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export const name = 'fs-write';
export const inject = ['tools'];

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'fs-write',
    description: 'Write content to a file at the given path',
    parameters: {
      path: { type: 'string', required: true, description: 'Target file path (absolute or relative)' },
      content: { type: 'string', required: true, description: 'Content to write' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      const target = resolve(args.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, args.content, 'utf8');
      return `Written ${target}`;
    },
  }));
}
