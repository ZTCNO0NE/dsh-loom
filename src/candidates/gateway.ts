import { join } from 'node:path'
import { CandidateImporter, CandidateRegistry, type CandidateAcquisitionRequest, type CandidateManifest, type BuilderGeneratedEdit } from './index.js'
import type { LlmStreamLike } from '../meta/propose.js'
import { atomicWriteJson } from '../protocol/index.js'
import { BuilderDriver } from '../builder/driver.js'
import { BuilderKernel } from '../builder/kernel.js'

export interface LoopCandidateGatewayOptions {
  enabled: boolean
  root: string
  sessionId: string
  allowedGitHosts: string[]
  llm?: LlmStreamLike
  provider: string
  model: string
  maxTokens: number
  buildDependencyRoot?: string
  onUsage?: (usage: { prompt: number; completion: number }) => void
}

export type LoopCandidateDiscovery =
  | { accepted: false; reason: 'disabled' | 'no_candidate' | 'acquisition_failed'; rationale: string; runId?: string }
  | { accepted: true; rationale: string; manifest: CandidateManifest; runId: string }

interface BuilderDiscoveryOutput {
  candidate?: CandidateAcquisitionRequest | null
  rationale?: string
}

/**
 * The sole loop-candidate ingress for meta.auto. Discovery uses the same
 * bounded BuilderKernel as patch design; after a frozen draft is submitted,
 * core (not the model) performs the allowlisted HTTPS acquisition into staging.
 * It has no transition API: verifier/gate own every later state.
 */
export class LoopCandidateGateway {
  constructor(private readonly options: LoopCandidateGatewayOptions) {}

  async discover(requirements: string, context: Record<string, unknown> = {}): Promise<LoopCandidateDiscovery> {
    if (!this.options.enabled) return { accepted: false, reason: 'disabled', rationale: 'allowLoopCandidates is disabled' }
    const llm = this.options.llm
    if (!llm) throw new Error('loop candidate gateway: no independent builder llm available')
    const kernel = new BuilderKernel(this.options.root, `${this.options.sessionId}:loop-candidate`)
    let run = kernel.create({
      kind: 'loop_candidate',
      actor: { requirements, context },
      targetBefore: { registry: this.status(), allowedGitHosts: this.options.allowedGitHosts },
    })
    for (let acquisitionAttempt = 0; acquisitionAttempt < 2; acquisitionAttempt++) {
      const outcome = await new BuilderDriver({
        llm,
        provider: this.options.provider,
        model: this.options.model,
        systemPrompt: '你是 dsh-loom 的独立 loop builder。你可选择公开 Git 候选，或在固定 DSH baseline 上提交受限、可审计的 source edit；不能批准、安装或修改当前 loop。',
        taskContext: this.prompt(requirements, context),
        draftKind: 'loop_candidate',
        maxModelTurns: 10,
        maxToolSteps: 12,
        maxTokens: this.options.maxTokens,
        onUsage: this.options.onUsage,
      }).run(kernel, run.id)
      if (outcome.state === 'aborted' || !outcome.proposal) {
        const result: LoopCandidateDiscovery = { accepted: false, reason: 'no_candidate', rationale: outcome.reason ?? 'builder declined or could not safely submit a candidate', runId: run.id }
        this.persist(result)
        return result
      }
      const output = this.parse(outcome.proposal)
      const rationale = typeof output.rationale === 'string' ? output.rationale : ''
      if (output.candidate === null || output.candidate === undefined) {
        const next = kernel.reopenFromRejection(run.id, { source: 'candidate_draft', verdict: 'rejected', failureSummary: 'submitted loop candidate draft omitted candidate', observedAt: new Date().toISOString() })
        const result: LoopCandidateDiscovery = { accepted: false, reason: 'no_candidate', rationale: rationale || 'builder submitted no candidate', runId: next.id }
        this.persist(result)
        return result
      }
      try {
        const request = this.normalize(output.candidate)
        const manifest = new CandidateImporter({ root: this.options.root, allowedGitHosts: this.options.allowedGitHosts, buildDependencyRoot: this.options.buildDependencyRoot }).acquire(request)
        const result: LoopCandidateDiscovery = { accepted: true, rationale, manifest, runId: run.id }
        this.persist(result)
        return result
      } catch (error) {
        const feedback = {
          source: 'candidate_importer', verdict: 'rejected', failureSummary: String(error),
          candidate: output.candidate, observedAt: new Date().toISOString(),
        }
        const next = kernel.reopenFromRejection(run.id, feedback)
        if (acquisitionAttempt === 1) {
          const result: LoopCandidateDiscovery = { accepted: false, reason: 'acquisition_failed', rationale: String(error), runId: next.id }
          this.persist(result)
          return result
        }
        run = next
      }
    }
    throw new Error('loop candidate gateway: exhausted acquisition attempts')
  }

  status(): ReturnType<CandidateRegistry['list']> {
    return new CandidateRegistry(this.options.root).list()
  }

  private prompt(requirements: string, context: Record<string, unknown>): string {
    return [
      '你是 dsh-loom 的独立 builder。任务仅限于发现一个可审计的 agent-loop 候选；不能批准、安装或修改当前 loop。',
      '你可提交公开、可复现的 Git 候选，或提交 builder-generated source edit。后者只能针对固定 DSH baseline 的 agent-loop/src/*.ts 文件，核心会检查 beforeHash、路径、大小、构建和契约；不能提交 shell 文本。没有可靠证据时应 abort。',
      `允许的 Git host：${this.options.allowedGitHosts.join(', ') || '(none)'}`,
      'Git 候选的 source.uri 必须是 https Git URL；Git source.ref 必须是固定 branch/tag/ref，不能使用 floating 的“latest”。Generated 候选必须使用固定 40 位 DSH baseline commit，并提交 source.edits。',
      '候选必须是可构建的 agent-loop package；packagePath 是仓库内包根（省略仅表示仓库根），entry 相对该包根目录，目标固定 agent-loop。Generated 候选固定为 packages/core/agent-loop + @deepseek-ai/dsh-agent-loop + sandboxed-dsh-workspace。',
      `需求：${requirements.slice(0, 6000)}`,
      `已知运行时上下文：${JSON.stringify(context).slice(0, 6000)}`,
      '写入 candidate draft 的对象 schema：',
      JSON.stringify({
        candidate: {
          id: 'lowercase-kebab-id',
          displayName: 'string',
          source: { kind: 'git', uri: 'https://github.com/org/repo.git', ref: 'fixed-ref' },
          packageName: '@scope/package',
          packagePath: 'packages/core/agent-loop',
          entry: 'lib/index.js',
          build: { method: 'prebuilt | sandboxed-dsh-workspace' },
          config: { agents: [] },
          expectedOutcome: 'string',
          capabilities: ['string'],
        },
        generatedCandidate: {
          id: 'bounded-loop-edit',
          displayName: 'string',
          source: {
            kind: 'builder-generated',
            baseline: { uri: 'https://github.com/deepseek-ai/deepseek-harness.git', ref: '40-char-commit-sha' },
            edits: [{ path: 'packages/core/agent-loop/src/constants.ts', beforeHash: 'sha256-of-baseline-file', after: 'complete replacement file' }],
          },
          packageName: '@deepseek-ai/dsh-agent-loop',
          packagePath: 'packages/core/agent-loop',
          entry: 'lib/index.js',
          build: { method: 'sandboxed-dsh-workspace' },
          config: { agents: [] },
          expectedOutcome: 'string',
          capabilities: ['string'],
        },
        rationale: 'string',
      }, null, 2),
    ].join('\n')
  }

  private parse(value: Record<string, unknown>): BuilderDiscoveryOutput {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('loop candidate gateway: builder draft must be an object')
    return value as BuilderDiscoveryOutput
  }

  private normalize(value: CandidateAcquisitionRequest): CandidateAcquisitionRequest {
    if (!value || typeof value !== 'object') throw new Error('loop candidate gateway: candidate must be an object')
    const source = value.source
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('loop candidate gateway: candidate source is required')
    const sourceRecord = source as Record<string, unknown>
    const isGenerated = sourceRecord.kind === 'builder-generated'
    if (isGenerated) {
      const baseline = sourceRecord.baseline
      if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)
        || typeof (baseline as Record<string, unknown>).uri !== 'string' || typeof (baseline as Record<string, unknown>).ref !== 'string') {
        throw new Error('loop candidate gateway: generated source baseline uri/ref required')
      }
      if (!Array.isArray(sourceRecord.edits)) throw new Error('loop candidate gateway: generated source edits must be an array')
    } else if (typeof sourceRecord.uri !== 'string' || typeof sourceRecord.ref !== 'string') {
      throw new Error('loop candidate gateway: candidate source.uri/ref required')
    }
    if (typeof value.id !== 'string' || typeof value.displayName !== 'string' || typeof value.packageName !== 'string'
      || typeof value.entry !== 'string' || typeof value.expectedOutcome !== 'string') {
      throw new Error('loop candidate gateway: candidate identity fields are required')
    }
    if (!value.config || typeof value.config !== 'object' || Array.isArray(value.config)) throw new Error('loop candidate gateway: config must be an object')
    if (!Array.isArray(value.capabilities)) throw new Error('loop candidate gateway: capabilities must be an array')
    const build = value.build
    if (!build || typeof build !== 'object' || Array.isArray(build)
      || ((build as Record<string, unknown>).method !== 'prebuilt' && (build as Record<string, unknown>).method !== 'sandboxed-dsh-workspace')) {
      throw new Error('loop candidate gateway: candidate build.method is required')
    }
    const packagePath = typeof value.packagePath === 'string'
      ? value.packagePath.replace(/^\.\/+/, '')
      : undefined
    if (isGenerated) {
      const baseline = sourceRecord.baseline as { uri: string; ref: string }
      const edits = sourceRecord.edits as BuilderGeneratedEdit[]
      return {
        id: value.id,
        displayName: value.displayName,
        source: { kind: 'builder-generated', baseline, edits },
        packageName: value.packageName,
        ...(packagePath ? { packagePath } : {}),
        entry: value.entry,
        build: { method: (build as { method: 'prebuilt' | 'sandboxed-dsh-workspace' }).method },
        config: value.config,
        expectedOutcome: value.expectedOutcome,
        capabilities: value.capabilities.map(String),
      }
    }
    return {
      id: value.id,
      displayName: value.displayName,
      source: { kind: 'git', uri: sourceRecord.uri as string, ref: sourceRecord.ref as string },
      packageName: value.packageName,
      ...(packagePath ? { packagePath } : {}),
      entry: value.entry,
      build: { method: (build as { method: 'prebuilt' | 'sandboxed-dsh-workspace' }).method },
      config: value.config,
      expectedOutcome: value.expectedOutcome,
      capabilities: value.capabilities.map(String),
    }
  }

  private persist(outcome: LoopCandidateDiscovery): void {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    atomicWriteJson(join(this.options.root, 'workspace', this.options.sessionId, 'loop-candidates', `${stamp}.json`), {
      schemaVersion: 1,
      at: new Date().toISOString(),
      outcome,
    })
  }
}
