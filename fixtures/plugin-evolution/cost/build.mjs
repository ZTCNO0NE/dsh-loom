import { copyFileSync, mkdirSync } from 'node:fs'
mkdirSync('dist', { recursive: true })
copyFileSync('src/index.mjs', 'dist/index.mjs')
