import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LoopCandidateGateway } from '../candidates/gateway.js'

function candidateDecisionLlm(draft: Record<string, unknown>) {
  return {
    async *stream(options: { prompt: string }) {
      const decision = options.prompt.includes('"passed":true')
        ? { kind: 'submit' }
        : options.prompt.includes('"written":"candidate_draft"')
          ? { kind: 'tool', action: { name: 'preflight_staging_entry', entry: 'candidate.json' } }
          : { kind: 'tool', action: { name: 'write_candidate_draft', proposal: draft } }
      yield { kind: 'block-start', type: 'text' }
      yield { kind: 'text-delta', text: JSON.stringify(decision) }
      yield { kind: 'block-end' }
    },
  }
}

describe('loop candidate gateway', () => {
  it('does not invoke a builder or write a registry while disabled', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-gateway-'))
    const gateway = new LoopCandidateGateway({
      enabled: false, root, sessionId: 's', allowedGitHosts: ['github.com'], provider: 'x', model: 'y', maxTokens: 4096,
    })
    await expect(gateway.discover('find a loop')).resolves.toMatchObject({ accepted: false, reason: 'disabled' })
    expect(gateway.status().candidates).toEqual({})
  })

  it('allows the builder to explicitly decline discovery without staging anything', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-gateway-'))
    const gateway = new LoopCandidateGateway({
      enabled: true,
      root,
      sessionId: 's',
      allowedGitHosts: ['github.com'],
      provider: 'x',
      model: 'y',
      maxTokens: 4096,
      llm: {
        async *stream() {
          yield { kind: 'block-start', type: 'text' }
          yield { kind: 'text-delta', text: '{"kind":"abort","reason":"no compatible public candidate"}' }
          yield { kind: 'block-end' }
        },
      },
    })
    await expect(gateway.discover('find a loop')).resolves.toMatchObject({ accepted: false, reason: 'no_candidate' })
    expect(gateway.status().candidates).toEqual({})
  })

  it('normalizes a root package path from builder JSON before acquisition', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-gateway-'))
    const gateway = new LoopCandidateGateway({
      enabled: true, root, sessionId: 's', allowedGitHosts: ['github.com'], provider: 'x', model: 'y', maxTokens: 4096,
    llm: candidateDecisionLlm({ candidate: { id: 'root-package', displayName: 'Root package', source: { uri: 'not-a-url', ref: 'main' }, packageName: 'example', packagePath: './', entry: 'lib/index.js', build: { method: 'prebuilt' }, config: {}, expectedOutcome: 'staging only', capabilities: [] }, rationale: 'test' }),
    })
    const discovery = await gateway.discover('find a loop')
    expect(discovery).toMatchObject({ accepted: false, reason: 'acquisition_failed' })
  })
})
