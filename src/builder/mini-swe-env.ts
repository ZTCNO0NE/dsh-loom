/**
 * Host-only bridge for mini-SWE's OpenAI-compatible runtime.  Credentials are
 * copied only into the spawned child environment; callers must never serialize
 * this object into a prompt, workspace, trajectory, plan, or evidence record.
 */
export function miniSweChildEnv(provider: string, source: NodeJS.ProcessEnv = process.env, credential?: string): NodeJS.ProcessEnv {
  const isTerra = provider === 'gpt-5.6-terra'
  const baseURL = isTerra
    ? source.LOOM_TERRA_BASE_URL ?? source.DSH_TERRA_BASE_URL
    : source.DSH_META_BASE_URL ?? source.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1'
  // Do not forward provider-specific source variables in bulk. The resolved
  // credential is mapped to the one variable mini-SWE needs for this child.
  const child = { ...source }
  delete child.DSH_META_API_KEY
  delete child.DEEPSEEK_API_KEY
  delete child.LOOM_TERRA_API_KEY
  delete child.DSH_TERRA_API_KEY
  delete child.OPENAI_API_KEY
  return {
    ...child,
    MSWEA_CONFIGURED: 'true',
    // Loom accepts provider/model names that are newer than LiteLLM's bundled
    // static price table. Cost lookup is observability, not an implementation
    // precondition: an otherwise valid response must not abort before the
    // first tool action merely because its price is unknown. Preserve an
    // explicit operator policy, otherwise retain calls/tokens and ignore only
    // price-mapping errors.
    MSWEA_COST_TRACKING: source.MSWEA_COST_TRACKING ?? 'ignore_errors',
    // LiteLLM's OpenAI adapter consumes OPENAI_API_BASE.  Keep the common
    // OPENAI_BASE_URL spelling too for runtimes that use the OpenAI SDK
    // directly, but never fall back to api.openai.com for Loom providers.
    ...(baseURL ? { OPENAI_API_BASE: baseURL, OPENAI_BASE_URL: baseURL } : {}),
    ...(credential ? isTerra
      ? { OPENAI_API_KEY: credential }
      : { DEEPSEEK_API_KEY: credential }
      : {}),
  }
}

/** Maps Loom's provider-neutral model name to mini-SWE/LiteLLM's provider route. */
export function miniSweModelName(provider: string, model: string): string {
  if (model.includes('/')) return model
  return provider === 'deepseek-official' ? `deepseek/${model}` : `openai/${model}`
}
