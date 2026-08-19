/**
 * Loop 层契约校验器 v0（零模型成本）：
 *   record <overlay> <task> <golden.json>   —— 在指定 overlay 上跑探针，录制黄金快照
 *   check  <overlay> <task> <golden.json>   —— 跑候选，校验 C1/C2/C4 契约并输出报告
 *
 * 依赖：overlay 需包含 dsh-loom（observe 即可）且 sessionId=loom-contract；
 *       DSH_META_VALIDATE_ROOT 指向一个可写 meta-workspace。
 */
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, existsSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'

const cli = process.argv.slice(2)
const reportFlag = cli.indexOf('--report')
const reportPath = reportFlag === -1 ? undefined : cli[reportFlag + 1]
if (reportFlag !== -1 && !reportPath) {
  console.log('--report requires a JSON output path')
  process.exit(1)
}
const regression = cli.includes('--regression')
const expectedEntryFlag = cli.indexOf('--expected-entry')
const expectedEntry = expectedEntryFlag === -1 ? undefined : cli[expectedEntryFlag + 1]
if (expectedEntryFlag !== -1 && !expectedEntry) {
  console.log('--expected-entry requires the resolved agent-loop entry path')
  process.exit(1)
}
const profileFlag = cli.indexOf('--profile')
const profile = profileFlag === -1 ? 'headless' : cli[profileFlag + 1]
if (profileFlag !== -1 && !profile) {
  console.log('--profile requires a dsh profile name')
  process.exit(1)
}
const profileHomeFlag = cli.indexOf('--profile-home')
const profileHome = profileHomeFlag === -1 ? undefined : cli[profileHomeFlag + 1]
if (profileHomeFlag !== -1 && !profileHome) {
  console.log('--profile-home requires an isolated DSH_HOME path')
  process.exit(1)
}
// A missing optional flag has index -1.  Do not let its synthetic `-1 + 1`
// position accidentally remove argv[0] (the command mode) from positionals.
const optionPositions = new Set([
  reportFlag, reportFlag >= 0 ? reportFlag + 1 : -1,
  expectedEntryFlag, expectedEntryFlag >= 0 ? expectedEntryFlag + 1 : -1,
  profileFlag, profileFlag >= 0 ? profileFlag + 1 : -1,
  profileHomeFlag, profileHomeFlag >= 0 ? profileHomeFlag + 1 : -1,
])
const positional = cli.filter((value, index) => value !== '--regression' && !optionPositions.has(index))
const [mode, overlay, task, goldenPath] = positional
if (!['record', 'check', 'rollback'].includes(mode) || !overlay || !task || (mode !== 'rollback' && !goldenPath)) {
  console.log('用法：contract-runner record|check <overlay.yml> <task> <golden.json> [--profile <name>] [--profile-home <DSH_HOME>] [--expected-entry <path>] [--regression] [--report <path>] | rollback <badOverlay.yml> <task> [--report <path>]')
  process.exit(1)
}

function persistReport(report) {
  if (!reportPath) return
  mkdirSync(dirname(reportPath), { recursive: true })
  writeFileSync(reportPath, `${JSON.stringify({
    schemaVersion: 1,
    runner: 'dsh-loom-contract-runner',
    mode,
    profile,
    profileHome: profileHome ?? null,
    overlay,
    task,
    goldenPath: goldenPath ?? null,
    generatedAt: new Date().toISOString(),
    ...report,
  }, null, 2)}\n`, 'utf8')
}

const root = process.env.DSH_META_VALIDATE_ROOT
  ?? (process.env.DSH_HOME ? join(process.env.DSH_HOME, 'meta-validate') : join(process.cwd(), '.meta-validate'))
const session = 'loom-contract'
const framesPath = join(root, 'workspace', session, 'trajectory', 'frames.jsonl')
const dshEnv = profileHome ? { ...process.env, DSH_HOME: profileHome } : process.env

function runOnce() {
  return new Promise((resolve) => {
    const dshCmd = process.env.DSH_CMD ? process.env.DSH_CMD.split(' ') : ['dsh']
    const child = spawn(
      dshCmd[0],
      [...dshCmd.slice(1), '--profile', profile, '--patch', overlay, task],
      { stdio: ['ignore', 'pipe', 'pipe'], detached: true, cwd: process.env.DSH_CWD || process.cwd(), env: dshEnv },
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

/** `name` in a dsh patch is a matcher, not a mutable entry field. Assert the
 * composed config before spending model calls, so a no-op replacement cannot
 * masquerade as a candidate-loop validation. */
function resolveAgentLoopEntry() {
  const dshCmd = process.env.DSH_CMD ? process.env.DSH_CMD.split(' ') : ['dsh']
  const result = spawnSync(
    dshCmd[0],
    [...dshCmd.slice(1), '--profile', profile, '--patch', overlay, '--dump-config'],
    { encoding: 'utf8', cwd: process.env.DSH_CWD || process.cwd(), timeout: 120000, env: dshEnv },
  )
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  const match = output.match(/- id: agent-loop\s*\n\s+name:\s*(?:>-\s*\n\s+([^\n]+)|['"]?([^'">\n]+)['"]?)/)
  return { exitCode: result.status ?? -1, resolved: (match?.[1] ?? match?.[2])?.trim() ?? null, outputTail: output.slice(-500) }
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
    // Parallel-safe siblings may be committed as call, call, result, result
    // (or an interleaving).  Both shapes are valid within one assistant step.
    'tool/call': ['tool/call', 'tool/result'],
    'tool/result': ['tool/call', 'tool/result', 'step/end'],
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

// One report must describe one probe. Reusing an eval workspace is allowed,
// but its append-only observer frames must not be compared across separate
// process lifetimes (their timestamps/turn counters have distinct origins).
if (mode !== 'rollback') rmSync(framesPath, { force: true })
let entryResolution
if (expectedEntry && mode !== 'rollback') {
  const resolved = resolveAgentLoopEntry()
  entryResolution = resolved
  if (resolved.exitCode !== 0 || resolved.resolved !== expectedEntry) {
    const report = {
      C0: 'fail',
      pass: false,
      detail: [`agent-loop entry mismatch: expected=${expectedEntry} actual=${resolved.resolved ?? '<unresolved>'}`],
      resolvedEntry: resolved.resolved,
      resolveExitCode: resolved.exitCode,
      resolveOutputTail: resolved.outputTail,
    }
    persistReport(report)
    console.log(JSON.stringify(report, null, 2))
    process.exit(1)
  }
}
const run = await runOnce()

if (mode === 'rollback') {
  const ok = run.exitCode !== 0 && run.exitCode !== 124 && /fail|error/i.test(run.out)
  const report = {
    contract: 'C5 冷替换/回滚演练',
    C5: ok ? 'pass' : 'fail',
    pass: ok,
    exitCode: run.exitCode,
    tail: run.out.slice(-200),
  }
  persistReport(report)
  console.log(JSON.stringify(report, null, 2))
  process.exit(ok ? 0 : 1)
}

let data
try {
  data = extract()
} catch (error) {
  if (mode === 'record') throw error
  const report = {
    C1: 'fail', C2: 'fail', C3: 'fail', C4: 'fail', C7: 'fail', C8: 'fail',
    detail: [String(error)],
    pass: false,
    exitCode: run.exitCode,
  }
  persistReport(report)
  console.log(JSON.stringify(report, null, 2))
  process.exit(1)
}
data.exitCode = run.exitCode

if (mode === 'record') {
  const report = checks(data)
  if (expectedEntry) {
    report.C0 = 'pass'
    report.resolvedEntry = entryResolution?.resolved
  }
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
  persistReport({ ...report, goldenEvents: data.eventTypes.length, exitCode: run.exitCode })
  console.log(`✅ 黄金快照已录制：${goldenPath}（exit=${run.exitCode}，事件 ${data.eventTypes.length} 条）`)
  process.exit(0)
}

const golden = JSON.parse(readFileSync(goldenPath, 'utf8'))
const report = checks(data)
if (expectedEntry) {
  report.C0 = 'pass'
  report.resolvedEntry = entryResolution?.resolved
}
report.goldenEvents = golden.eventTypes.length
report.candidateEvents = data.eventTypes.length
report.exitCode = run.exitCode
if (regression) {
  try {
    const { execFileSync } = await import('node:child_process')
    const out = execFileSync(process.execPath, ['scripts/fromzero-verify.mjs'], {
      cwd: process.cwd(),
      stdio: 'pipe',
      timeout: 900000,
      env: {
        ...process.env,
        DSH_LOOP_OVERLAY: overlay,
        DSH_LOOP_PROFILE: profile,
        ...(profileHome ? { DSH_LOOP_PROFILE_HOME: profileHome } : {}),
      },
    })
    const output = out.toString()
    // `fromzero-verify` always prints an `allPass` field, including when one
    // of L1–L5 failed.  Presence is not evidence of a successful regression.
    report.C6 = /"allPass"\s*:\s*true\b/.test(output) ? 'pass' : 'fail'
    report.C6Output = output.slice(-300)
  } catch (error) {
    report.C6 = 'fail'
    report.C6Output = String(error.stdout ?? error.stderr ?? error.message ?? '').slice(-300)
  }
  report.pass = report.pass && report.C6 === 'pass'
}
persistReport(report)
console.log(JSON.stringify(report, null, 2))
process.exit(report.pass ? 0 : 1)
