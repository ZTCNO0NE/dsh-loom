/**
 * Loop 层契约校验器 v0（零模型成本）：
 *   record <overlay> <task> <golden.json>   —— 在指定 overlay 上跑探针，录制黄金快照
 *   check  <overlay> <task> <golden.json>   —— 跑候选，校验 C1/C2/C4 契约并输出报告
 *
 * 依赖：overlay 需包含 dsh-loom（observe 即可）且 sessionId=loom-contract；
 *       DSH_META_VALIDATE_ROOT 指向一个可写 meta-workspace。
 */
import { spawn } from 'node:child_process'
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

const [mode, overlay, task, goldenPath] = process.argv.slice(2)
if (!['record', 'check', 'rollback'].includes(mode) || !overlay || !task || (mode !== 'rollback' && !goldenPath)) {
  console.log('用法：contract-runner record|check <overlay.yml> <task> <golden.json> | rollback <badOverlay.yml> <task>')
  process.exit(1)
}

const root = process.env.DSH_META_VALIDATE_ROOT
  ?? (process.env.DSH_HOME ? join(process.env.DSH_HOME, 'meta-validate') : join(process.cwd(), '.meta-validate'))
const session = 'loom-contract'
const framesPath = join(root, 'workspace', session, 'trajectory', 'frames.jsonl')

function runOnce() {
  return new Promise((resolve) => {
    const dshCmd = process.env.DSH_CMD ? process.env.DSH_CMD.split(' ') : ['dsh']
    const child = spawn(
      dshCmd[0],
      [...dshCmd.slice(1), '--profile', 'headless', '--patch', overlay, task],
      { stdio: ['ignore', 'pipe', 'pipe'], detached: true, cwd: process.env.DSH_CWD || process.cwd() },
    )
    let out = ''
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        // gone
      }
      resolve({ exitCode: 124, out })
    }, 240000)
    child.stdout.on('data', (chunk) => { out += String(chunk) })
    child.stderr.on('data', (chunk) => { out += String(chunk) })
    child.on('error', (error) => { clearTimeout(timer); resolve({ exitCode: -1, out: String(error) }) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ exitCode: code ?? -1, out }) })
  })
}

function extract() {
  if (!existsSync(framesPath)) {
    throw new Error(`no frames at ${framesPath}（overlay 是否包含 dsh-loom 且 sessionId=${session}？）`)
  }
  const frames = readFileSync(framesPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const eventTypes = frames.map((frame) => frame.type)
  const turns = frames.filter((frame) => frame.type === 'turn/start' || frame.type === 'turn/end')
    .map((frame) => ({ type: frame.type, turn: Number(frame.data?.turn ?? 0), reason: frame.data?.reason }))
  const toolCalls = frames.filter((frame) => frame.type === 'tool/call')
    .map((frame) => ({ callId: String(frame.data?.callId ?? ''), turn: frame.data?.turn, step: frame.data?.step, name: String(frame.data?.name ?? '') }))
  const toolResults = frames.filter((frame) => frame.type === 'tool/result')
    .map((frame) => ({ callId: String(frame.data?.callId ?? ''), turn: frame.data?.turn, step: frame.data?.step, name: String(frame.data?.name ?? '') }))
  return { eventTypes, turns, toolCalls, toolResults, raw: frames }
}

function checks(data) {
  const report = { C1: 'fail', C2: 'fail', C3: 'fail', C4: 'fail', C7: 'fail', C8: 'fail', detail: [] }
  const CORE = ['turn/start', 'turn/end', 'step/start', 'step/end', 'tool/call', 'tool/result', 'assistant/message']
  const types = data.eventTypes.filter((type) => CORE.includes(type))
  const allowed = {
    'turn/start': ['step/start', 'assistant/message'],
    'step/start': ['tool/call', 'assistant/message', 'step/end'],
    'tool/call': ['tool/result'],
    'tool/result': ['tool/call', 'step/end'],
    'step/end': ['step/start', 'turn/end'],
    'assistant/message': ['tool/call', 'assistant/message', 'step/end'],
    'turn/end': ['turn/start'],
  }
  let okC1 = types.length > 0 && types[0] === 'turn/start' && types[types.length - 1] === 'turn/end'
  for (let i = 1; i < types.length; i++) {
    if (!(allowed[types[i - 1]] ?? []).includes(types[i])) okC1 = false
  }
  report.C1 = okC1 ? 'pass' : 'fail'
  if (report.C1 === 'fail') report.detail.push(`核心事件顺序异常：${types.slice(0, 24).join(' ')}`)

  let okC2 = true
  let lastTurn = 0
  for (const t of data.turns) {
    if (t.type === 'turn/start') {
      if (t.turn < lastTurn) okC2 = false
      lastTurn = t.turn
    }
  }
  const starts = data.turns.filter((t) => t.type === 'turn/start').length
  const ends = data.turns.filter((t) => t.type === 'turn/end').length
  report.C2 = okC2 && starts === ends ? 'pass' : 'fail'
  if (report.C2 === 'fail') report.detail.push(`turn 配对/单调异常：start=${starts} end=${ends}`)

  // C3 持久化可重放：frames.jsonl 完整、时间戳单调、步骤号单调
  let okC3 = data.eventTypes.length > 0
  let lastTs = -1
  let lastStep = -1
  for (const frame of data.raw) {
    const ts = Date.parse(String(frame.ts ?? ''))
    if (!Number.isFinite(ts) || ts < lastTs) okC3 = false
    lastTs = ts
    if (frame.type === 'step/start') {
      const step = Number(frame.data?.step ?? -1)
      if (step < lastStep) okC3 = false
      lastStep = step
    }
  }
  report.C3 = okC3 ? 'pass' : 'fail'
  if (report.C3 === 'fail') report.detail.push('持久化帧不完整/时间戳或步骤号不单调')

  const pairKey = (item) => `${item.turn ?? '?'}:${item.step ?? '?'}`
  const callIds = new Set(data.toolCalls.map(pairKey))
  const resultIds = new Set(data.toolResults.map(pairKey))
  const okC4 = data.toolCalls.length === data.toolResults.length
    && [...callIds].every((id) => resultIds.has(id))
    && [...resultIds].every((id) => callIds.has(id))
  report.C4 = okC4 ? 'pass' : 'fail'
  if (report.C4 === 'fail') report.detail.push(`tool call/result 配对异常：calls=${data.toolCalls.length} results=${data.toolResults.length}`)

  // C7 监督员可观测：帧含 ts、user/message、assistant/message，工具帧带 turn/step
  const typeSet = new Set(data.eventTypes)
  const toolFrames = data.raw.filter((frame) => frame.type === 'tool/call' || frame.type === 'tool/result')
  const okC7 = typeSet.has('user/message') && typeSet.has('assistant/message')
    && toolFrames.every((frame) => frame.data?.turn !== undefined && frame.data?.step !== undefined)
  report.C7 = okC7 ? 'pass' : 'fail'
  if (report.C7 === 'fail') report.detail.push('监督员帧缺失：需要 user/message、assistant/message、工具帧带 turn/step')

  // C8 模型路由：候选 run 正常退出（更深的 usage/replayState 校验留后续）
  report.C8 = data.exitCode === 0 ? 'pass' : 'fail'
  if (report.C8 === 'fail') report.detail.push(`run 非正常退出：exit=${data.exitCode}`)

  report.pass = report.C1 === 'pass' && report.C2 === 'pass' && report.C3 === 'pass'
    && report.C4 === 'pass' && report.C7 === 'pass' && report.C8 === 'pass'
  return report
}

const run = await runOnce()

if (mode === 'rollback') {
  const ok = run.exitCode !== 0 && run.exitCode !== 124 && /fail|error/i.test(run.out)
  console.log(JSON.stringify({
    contract: 'C5 冷替换/回滚演练',
    pass: ok,
    exitCode: run.exitCode,
    tail: run.out.slice(-200),
  }, null, 2))
  process.exit(ok ? 0 : 1)
}

let data
try {
  data = extract()
} catch (error) {
  if (mode === 'record') throw error
  console.log(JSON.stringify({
    C1: 'fail', C2: 'fail', C3: 'fail', C4: 'fail', C7: 'fail', C8: 'fail',
    detail: [String(error)],
    pass: false,
    exitCode: run.exitCode,
  }, null, 2))
  process.exit(1)
}
data.exitCode = run.exitCode

if (mode === 'record') {
  const report = checks(data)
  if (!report.pass) {
    console.log('黄金快照录制失败（当前 loop 未通过契约自检）：', JSON.stringify(report, null, 2))
    process.exit(1)
  }
  const golden = {
    recordedAt: new Date().toISOString(),
    overlay,
    task,
    eventTypes: data.eventTypes,
    turns: data.turns,
    toolCalls: data.toolCalls,
    toolResults: data.toolResults,
  }
  mkdirSync(dirname(goldenPath), { recursive: true })
  writeFileSync(goldenPath, JSON.stringify(golden, null, 2), 'utf8')
  console.log(`✅ 黄金快照已录制：${goldenPath}（exit=${run.exitCode}，事件 ${data.eventTypes.length} 条）`)
  process.exit(0)
}

const golden = JSON.parse(readFileSync(goldenPath, 'utf8'))
const report = checks(data)
report.goldenEvents = golden.eventTypes.length
report.candidateEvents = data.eventTypes.length
report.exitCode = run.exitCode
console.log(JSON.stringify(report, null, 2))
if (process.argv.includes('--regression')) {
  try {
    const { execFileSync } = await import('node:child_process')
    const out = execFileSync(process.execPath, ['scripts/fromzero-verify.mjs'], { cwd: process.cwd(), stdio: 'pipe', timeout: 900000 })
    report.C6 = out.toString().includes('allPass') ? 'pass' : 'fail'
    report.C6Output = out.toString().slice(-300)
  } catch (error) {
    report.C6 = 'fail'
    report.C6Output = String(error.stdout ?? error.stderr ?? error.message ?? '').slice(-300)
  }
  console.log(`C6(regression): ${report.C6}`)
  report.pass = report.pass && report.C6 === 'pass'
}
process.exit(report.pass ? 0 : 1)
