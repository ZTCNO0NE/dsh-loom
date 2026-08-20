/**
 * Host-only Builder credential resolution.
 *
 * Loom stores credential *references* in config and resolves them only at the
 * moment an LLM or mini-SWE process is invoked.  Values never enter plans,
 * prompts, journals, evidence, or status projections.
 */
export interface CredentialResolution {
  ref: string
  value: string
  source: string
}

export interface CredentialDescription {
  ref: string
  configured: boolean
  source?: string
}

export interface CredentialServiceLike {
  resolve(ref: string): Promise<{ value: string; source: string } | undefined>
  describe(ref: string): Promise<{ configured: boolean; source?: string }>
}

export type BuilderProvider = 'deepseek-official' | 'gpt-5.6-terra'

/**
 * Credentials are selected by the already-selected model route, never by
 * whichever secret happens to be available.  This prevents a DeepSeek key
 * from being sent to an OpenAI-compatible endpoint (and vice versa).
 */
export function defaultCredentialRefs(provider: string): string[] {
  if (provider === 'deepseek-official') return ['DEEPSEEK_API_KEY']
  // OPENAI_API_KEY is the normal DSH/OpenAI credential reference.  The two
  // Loom-era aliases remain only as migration fallbacks for explicit Terra.
  if (provider === 'gpt-5.6-terra') return ['OPENAI_API_KEY', 'LOOM_TERRA_API_KEY', 'DSH_TERRA_API_KEY']
  return []
}

export class BuilderCredentialResolver {
  constructor(
    private readonly credentials: CredentialServiceLike | undefined,
    private readonly provider: string,
    private readonly explicitRef = '',
  ) {}

  private refs(): string[] {
    if (this.explicitRef) return [this.explicitRef]
    return defaultCredentialRefs(this.provider)
  }

  async resolve(): Promise<CredentialResolution | undefined> {
    if (!this.credentials) return undefined
    for (const ref of this.refs()) {
      const resolved = await this.credentials.resolve(ref)
      if (resolved?.value) return { ref, value: resolved.value, source: resolved.source }
    }
    return undefined
  }

  async require(): Promise<CredentialResolution> {
    const resolved = await this.resolve()
    if (resolved) return resolved
    const ref = this.refs()[0] ?? 'DEEPSEEK_API_KEY'
    throw new Error(`Builder credential "${ref}" is not configured in DSH credentials`)
  }

  async describe(): Promise<CredentialDescription> {
    const refs = this.refs()
    if (!this.credentials || refs.length === 0) return { ref: refs[0] ?? 'DEEPSEEK_API_KEY', configured: false }
    for (const ref of refs) {
      const info = await this.credentials.describe(ref)
      if (info.configured) return { ref, configured: true, ...(info.source ? { source: info.source } : {}) }
    }
    return { ref: refs[0]!, configured: false }
  }
}
