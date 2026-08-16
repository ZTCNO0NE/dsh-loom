import type { Context } from '@deepseek-ai/cordis'
import type { ReviewDecision } from '../types.js'
import { appendJsonl, paths, PROTOCOL_VERSION } from '../protocol/index.js'
import type { EvolutionSignal } from '../types.js'
import type { RuntimeDigest } from './digest.js'

/** Minimal structural LLM view (same vocabulary as propose.ts). */
export interface LlmChunk {
  kind: string
  type?: string
  text?: string
  usage?: { prompt?: number; completion?: number }
}

export interface ReviewGateOptions {
  enabled: boolean
  prompt: string
  root: string
  sessionId: string
  provider: string
  model: string
  onUsage?: (usage: { prompt: number; completion: number }) => void
  llm?: {
    stream(options: {
      provider: string
      model: string
      prompt: string
      temperature?: number
      maxTokens?: number
      sessionId?: string
    }): AsyncIterable<LlmChunk>
  }
}

export class ReviewGate {
  constructor(
    private ctx: Context | null,
    private options: ReviewGateOptions,
  ) {}

  async decide(
    signals: EvolutionSignal[],
    trajectorySummary: string,
    historySummary: string,
    evidenceRefs: string[],
  ): Promise<ReviewDecision> {
    if (!this.options.enabled) {
      return this.persist({
        shouldRefine: false,
        rationale: 'review gate disabled',
        evidenceRefs,
      })
    }

    const prompt = [
      this.options.prompt,
      '',
      `信号：\n${signals.map((signal) => `- [${signal.kind}] ${signal.evidence.join(' | ')}`).join('\n') || '(无)'}`,
      '',
      `轨迹摘要：${trajectorySummary || '(无)'}`,
      '',
      `迭代历史：${historySummary || '(无)'}`,
      '',
      '只输出一个 JSON 对象：{"shouldRefine": boolean, "rationale": "string", "focus": "string（可选）"}',
    ].join('\n')

    const out = await this.streamText(prompt)

    const parsed = this.parseJson(out)
    const decision = {
      shouldRefine: parsed.shouldRefine === true,
      rationale: typeof parsed.rationale === 'string' ? parsed.rationale : 'no rationale',
      focus: typeof parsed.focus === 'string' ? parsed.focus : undefined,
      evidenceRefs,
    }
    return this.persist(decision)
  }

  /** One-shot supervision on the compact runtime digest (route A). */
  async decideOnDigest(digest: RuntimeDigest): Promise<ReviewDecision> {
    if (!this.options.enabled) {
      return this.persist({ shouldRefine: false, rationale: 'supervisor disabled', evidenceRefs: [] })
    }
    const prompt = [
      this.options.prompt,
      '',
      '你是监督检测器（一次性独立调用）：只看下面这份 actor 运行时摘要（关键指标，不是全量数据），',
      '判断此刻是否值得唤起 builder 做一次全量感知的迭代。不要臆测摘要里没有的信息。',
      '',
      `actor 运行时摘要：\n${JSON.stringify(digest)}`,
      '',
      '只输出一个 JSON 对象：{"shouldRefine": boolean, "rationale": "string", "focus": "string（可选）"}',
    ].join('\n')
    const out = await this.streamText(prompt)
    const parsed = this.parseJson(out)
    const decision = {
      shouldRefine: parsed.shouldRefine === true,
      rationale: typeof parsed.rationale === 'string' ? parsed.rationale : 'no rationale',
      focus: typeof parsed.focus === 'string' ? parsed.focus : undefined,
      evidenceRefs: [],
    }
    return this.persist(decision)
  }

  private async streamText(prompt: string): Promise<string> {
    const llm = this.options.llm
      ?? (this.ctx as unknown as { llm?: ReviewGateOptions['llm'] }).llm
    if (!llm) {
      return JSON.stringify({ shouldRefine: false, rationale: 'review gate: no llm service available' })
    }
    let out = ''
    let inText = false
    for await (const chunk of llm.stream({
      provider: this.options.provider,
      model: this.options.model,
      prompt,
      temperature: 0,
      maxTokens: 500,
      sessionId: `${this.options.sessionId}:meta-review`,
    })) {
      if (chunk.kind === 'block-start') inText = chunk.type === 'text'
      else if (chunk.kind === 'block-end') inText = false
      else if (chunk.kind === 'text-delta' && inText && typeof chunk.text === 'string') out += chunk.text
      else if (chunk.kind === 'usage' && typeof (chunk as { usage?: unknown }).usage === 'object') {
        const usage = (chunk as { usage: { prompt?: number; completion?: number } }).usage
        this.options.onUsage?.({
          prompt: usage.prompt ?? 0,
          completion: usage.completion ?? 0,
        })
      }
    }
    return out
  }

  private parseJson(text: string): Record<string, unknown> {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) return {}
    try {
      return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
    } catch {
      return {}
    }
  }

  private persist(decision: Omit<ReviewDecision, 'schemaVersion' | 'createdAt'>): ReviewDecision {
    const record: ReviewDecision = {
      schemaVersion: PROTOCOL_VERSION,
      ...decision,
      createdAt: new Date().toISOString(),
    }
    appendJsonl(paths.gateDecisions(this.options.root, this.options.sessionId), record)
    appendJsonl(paths.triggers(this.options.root, this.options.sessionId), {
      schemaVersion: PROTOCOL_VERSION,
      sessionId: this.options.sessionId,
      kind: 'host_rule',
      rule: 'review_gate',
      evidenceRefs: record.evidenceRefs,
      createdAt: record.createdAt,
    })
    return record
  }
}
