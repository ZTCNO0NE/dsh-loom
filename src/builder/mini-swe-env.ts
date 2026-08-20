/**
 * Host-only bridge for mini-SWE's OpenAI-compatible runtime.  Credentials are
 * copied only into the spawned child environment; callers must never serialize
 * this object into a prompt, workspace, trajectory, plan, or evidence record.
 */
export function miniSweChildEnv(provider: string, source: NodeJS.ProcessEnv = process.env, credential?: string): NodeJS.ProcessEnv {
  const isTerra = provider === 'gpt-5.6-terra'
  const baseURL = isTerra
    ? source.LOOM_TERRA_BASE_URL ?? source.DSH_TERRA_BASE_URL
    : source.DSH_META_BASE_URL ?? source.DEEPSEEK_BASE_URL
  const inheritedKey = isTerra
    ? source.LOOM_TERRA_API_KEY ?? source.DSH_TERRA_API_KEY
    : source.DSH_META_API_KEY ?? source.DEEPSEEK_API_KEY
  // Do not forward provider-specific source variables in bulk. The resolved
  // credential is mapped to the one variable mini-SWE needs for this child.
  const child = { ...source }
  delete child.DSH_META_API_KEY
  delete child.DEEPSEEK_API_KEY
  delete child.LOOM_TERRA_API_KEY
  delete child.DSH_TERRA_API_KEY
  return {
    ...child,
    MSWEA_CONFIGURED: 'true',
    ...(baseURL ? { OPENAI_BASE_URL: baseURL } : {}),
    ...(credential ?? inheritedKey ? { OPENAI_API_KEY: credential ?? inheritedKey } : {}),
  }
}
