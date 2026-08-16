#!/usr/bin/env node
/**
 * dsh-loom CLI — 便携版"3 分钟亲历自进化"。
 * 用法：dsh-loom try
 * 不依赖仓库/demo 脚本/本机路径；需要 dsh 在 PATH、DEEPSEEK_API_KEY 可路由，
 * 且当前 profile 已安装 dsh-loom（dsh plugin add dsh-loom）。
 */
import { spawn } from 'node:child_process'
import { writeFileSync, mkdtempSync, readFileSync, existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const command = process.argv[2]
if (command !== 'try') {
  console.log('用法：dsh-loom try   （3 分钟亲历自进化）')
  process.exit(command ? 1 : 0)
}

const root = process.env.DSH_META_VALIDATE_ROOT
  ?? (process.env.DSH_HOME ? join(process.env.DSH_HOME, 'meta-validate') : join(process.cwd(), '.meta-validate'))
const session = 'loom-try-cli'
const ws = join(root, 'workspace', session)
rmSync(ws, { recursive: true, force: true })
rmSync(join(root, 'overlays', session), { recursive: true, force: true })
rmSync(join(root, 'growth', session), { recursive: true, force: true })

const tmp = mkdtempSync(join(tmpdir(), 'dsh-loom-try-'))
const timeoutOverlay = join(tmp, 'timeout.yml')
writeFileSync(timeoutOverlay, [
  "- id: bash-sandbox",
  "  name: '@deepseek-ai/dsh-bash-sandbox'",
  '  config:',
  '    timeoutMs: 500',
  '',
].join('\n'))
const pluginOverlay = join(tmp, 'plugin.yml')
writeFileSync(pluginOverlay, [
  '- insert:',
  '    - id: meta-validate',
  "      name: 'dsh-loom'",
  '      config:',
  '        mode: apply',
  `        sessionId: ${session}`,
  '        maxIterations: 3',
  '        isolation:',
  '          enabled: true',
  '          probe: "run bash with command \'sleep 1\' and reply with the result"',
  '          probeTimeoutMs: 120000',
  '        reviewGate:',
  '          minIntervalTurns: 0',
  '          maxIterationsPerEpoch: 5',
  '',
].join('\n'))

function run(overlays, task, timeoutMs = 480000) {
  return new Promise((resolve) => {
    const child = spawn(
      'dsh',
      ['--profile', 'headless', ...overlays.flatMap((o) => ['--patch', o]), task],
      { stdio: ['ignore', 'pipe', 'pipe'], detached: true },
    )
    let out = ''
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        // already gone
      }
      resolve({ exitCode: 124, out })
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { out += String(chunk) })
    child.stderr.on('data', (chunk) => { out += String(chunk) })
    child.on('error', (error) => { clearTimeout(timer); resolve({ exitCode: -1, out: String(error) }) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ exitCode: code ?? -1, out }) })
  })
}

const line = (text) => console.log(`\n━━━ ${text} ━━━\n`)
line('Loom · 织机 — 3 分钟亲历自进化（便携版）')
console.log('你会看到：一个 agent 在你面前失败 → 自己长出能力 → 重试成功。\n')

line('① 先让它裸跑失败')
const off = await run([timeoutOverlay], '运行 bash 工具执行命令 `sleep 1`，正常完成后回复 ok。')
const offFailed = off.out.includes('超时') || off.out.includes('timeout') || off.out.includes('Timed out')
console.log(offFailed ? '❌ 失败：命令在约 500ms 就被杀掉——agent 自己解决不了。\n' : `⚠️ 意外成功（${off.out.slice(-120)}）`)
if (!offFailed) process.exit(1)

line('② 看着它长（监督员 → 改进模型 → 核验器 → 安装）')
console.log('…收集失败信号 → 监督员判定 → 改进模型设计（真实调用）…\n')
const iterateTask = "先运行 bash 工具执行命令 `sleep 1`。如果失败，调用 meta_auto 工具，requirements 原文：bash 命令 sleep 1 大约 500ms 就被终止，请让 actor 能正常执行这类命令。meta_auto 返回后回复 verdict 和 applied。"
await run([timeoutOverlay, pluginOverlay], iterateTask)

const historyFile = join(ws, 'history.jsonl')
const history = existsSync(historyFile)
  ? readFileSync(historyFile, 'utf8').trim().split('\n').filter(Boolean).map((row) => JSON.parse(row))
  : []
const appliedUpdate = history.find((row) => row.action === 'apply')
if (!appliedUpdate) {
  console.log('❌ 本次没有应用成功（看上面输出）。')
  process.exit(1)
}
const patchesDir = join(ws, 'patches')
let rationale = ''
if (existsSync(patchesDir)) {
  for (const id of readdirSync(patchesDir)) {
    const candidate = join(patchesDir, id, 'candidate.json')
    if (existsSync(candidate)) {
      try {
        rationale = JSON.parse(readFileSync(candidate, 'utf8')).rationale ?? ''
      } catch {
        // skip
      }
    }
  }
}
console.log(`✅ 改进模型给出了方案：${rationale.slice(0, 160) || '(见台账)'}`)
console.log(`   改动：${JSON.stringify(appliedUpdate.after)}`)
console.log('…隔离环境真实执行 → 预期轨迹 vs 真实帧对齐 → 核验通过 → 安装（reload 后生效）\n')

line('③ 同一个任务，重试')
const rerun = await run([timeoutOverlay, appliedUpdate.overlay], '运行 bash 工具执行命令 `sleep 1`，正常完成后回复 ok。', 120000)
const rerunOk = rerun.exitCode === 0 && rerun.out.includes('ok') && !rerun.out.includes('超时')
console.log(rerunOk ? '✅ 成功了。能力是刚才自己长出来的。\n' : `⚠️ 重试未达预期（${rerun.out.slice(-150)}）`)

line('④ 成长记录')
const growthDir = join(root, 'growth', session)
const reportFile = join(growthDir, 'report.md')
const report = existsSync(reportFile) ? readFileSync(reportFile, 'utf8') : '(空)'
console.log(report)

const esc = (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/><title>Loom try</title>
<style>body{font-family:sans-serif;max-width:720px;margin:40px auto;padding:0 20px;line-height:1.7}h1{font-size:24px}pre{background:#f6f8fa;padding:12px;border-radius:6px}</style></head>
<body><h1>Loom · 织机 — 亲历结果</h1>
<p>裸跑失败：${offFailed ? '✅' : '❌'} · 改进已应用：✅ · 重试成功：${rerunOk ? '✅' : '❌'}</p>
<p>改动：${esc(JSON.stringify(appliedUpdate.after))}</p>
<h3>成长记录</h3><pre>${esc(report)}</pre>
<p style="color:#888;font-size:13px">命令：dsh-loom try · 仓库 github.com/ZTCNO0NE/dsh-loom</p>
</body></html>`
const htmlPath = join(growthDir, 'report.html')
mkdirSync(growthDir, { recursive: true })
writeFileSync(htmlPath, html, 'utf8')
console.log(`\n📄 报告：${htmlPath}`)
console.log(`结果：${offFailed && rerunOk ? 'PASS ✅' : 'FAIL ❌'}`)
