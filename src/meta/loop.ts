import type { EvolutionSignal, MetaPatch, ValidationReport } from '../types.js'
import type { Proposer, ProbeResult } from './propose.js'
import type { Validator, VerifierInput } from '../validate/index.js'
import type { ApplyOps, ApplyResult, Gate } from '../gate/index.js'
import { appendJsonl, paths } from '../protocol/index.js'

export interface LoopDeps {
  proposer: Proposer
  validator: Validator
  gate: Gate
  root: string
  sessionId: string
  maxIterations: number
  confirm: (patch: MetaPatch, report: ValidationReport) => Promise<boolean>
  autoConfirm?: boolean
  /** After the builder produces a patch, collect real frames (isolation probe) before verification. */
  collectFrames?: (patch: MetaPatch, baseInput: VerifierInput) => Promise<VerifierInput>
  /** Builder-requested isolation probes (A): executed before full verification. */
  probeRunner?: (patch: MetaPatch, task: string) => { exit: number; outputTail: string } | Promise<{ exit: number; outputTail: string }>
  /** Post-apply growth hook: ledger/report/preferences sedimentation. */
  onApplied?: (info: {
    patch: MetaPatch
    report: ValidationReport
    applied: ApplyResult
    signals: EvolutionSignal[]
  }) => void | Promise<void>
}

export interface LoopResult {
  patch: MetaPatch | null
  report: ValidationReport
  applied: ApplyResult | null
  iterations: number
  escalated: boolean
}

/**
 * v1 iteration loop (08 §10/§14):
 * inner loop = builder self-check -> verifier full fixed verification;
 * rejection is a hard requirement to iterate again; maxIterations escalates to the user.
 */
export class IterationLoop {
  constructor(private deps: LoopDeps) {}

  async run(
    signals: EvolutionSignal[],
    currentConfig: Record<string, unknown>,
    userRequirements?: string,
    verifierInput?: VerifierInput,
    applyOps?: ApplyOps,
  ): Promise<LoopResult> {
    const { proposer, validator, gate, root, sessionId, maxIterations, confirm, collectFrames, probeRunner } = this.deps
    let previousReport: ValidationReport | undefined
    let probeResults: ProbeResult[] | undefined

    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      let patches: Awaited<ReturnType<Proposer['propose']>> | undefined
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          patches = await proposer.propose(signals, currentConfig, userRequirements, previousReport, probeResults)
          break
        } catch (error) {
          if (attempt === 2) throw error
          await new Promise((resolve) => setTimeout(resolve, 1500))
        }
      }
      if (!patches) throw new Error('proposer returned no patches')
      const patch = patches[0]!
      probeResults = undefined

      if (patch.probes?.length && probeRunner) {
        const results: ProbeResult[] = []
        let allPassed = true
        for (const probe of patch.probes) {
          const outcome = await probeRunner(patch, probe.task)
          const record: ProbeResult & { description?: string; at: string } = {
            task: probe.task,
            exit: outcome.exit,
            outputTail: outcome.outputTail.slice(0, 1000),
            description: probe.description,
            at: new Date().toISOString(),
          }
          appendJsonl(paths.probes(root, sessionId, patch.id), record)
          results.push(record)
          if (outcome.exit !== 0) allPassed = false
        }
        if (!allPassed) {
          gate.markStatus(root, sessionId, patch.id, 'draft', 'loop-probes', iteration, `probe failed: ${results.find((item) => item.exit !== 0)?.task ?? 'unknown'}`)
          probeResults = results
          continue
        }
      }

      gate.markStatus(root, sessionId, patch.id, 'verifying', 'loop', iteration)

      const cases = await validator.loadRegressionCases()
      const frames = collectFrames
        ? await collectFrames(patch, verifierInput ?? { actualEvents: [] })
        : verifierInput ?? { actualEvents: [] }
      const report = await validator.run(patch, cases, frames)
      validator.persistReport(root, sessionId, patch.id, report, frames.actualEvents)

      if (report.verdict === 'approved') {
        gate.markStatus(root, sessionId, patch.id, 'approved', 'loop', iteration)
        if (!applyOps) {
          return { patch, report, applied: null, iterations: iteration, escalated: false }
        }
        const userApproves = this.deps.autoConfirm ? true : await confirm(patch, report)
        if (!userApproves) {
          return { patch, report, applied: null, iterations: iteration, escalated: false }
        }
        const applied = await gate.applyWithRollback(patch, applyOps)
        if (applied.applied) {
          await this.deps.onApplied?.({ patch, report, applied, signals })
        }
        return { patch, report, applied, iterations: iteration, escalated: false }
      }

      gate.markStatus(root, sessionId, patch.id, 'rejected', 'loop', iteration, report.failureSummary)
      previousReport = report
    }

    return {
      patch: null,
      report: previousReport ?? {
        patchId: '',
        verdict: 'rejected',
        score: 0,
        evidence: [],
        validatedAt: new Date().toISOString(),
        failureSummary: probeResults
          ? `probe-request unresolved after ${maxIterations} iterations`
          : 'maxIterations exceeded before any proposal',
      },
      applied: null,
      iterations: maxIterations,
      escalated: true,
    }
  }
}
