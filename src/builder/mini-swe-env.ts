/**
 * Host-only bridge for mini-SWE's OpenAI-compatible runtime.  Credentials are
 * copied only into the spawned child environment; callers must never serialize
 * this object into a prompt, workspace, trajectory, plan, or evidence record.
 */
export function miniSweChildEnv(provider: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const isTerra = provider === 'gpt-5.6-terra'
  const baseURL = isTerra
    ? source.LOOM_TERRA_BASE_URL ?? source.DSH_TERRA_BASE_URL
    : source.DSH_META_BASE_URL ?? source.DEEPSEEK_BASE_URL
  const apiKey = isTerra
    ? source.LOOM_TERRA_API_KEY ?? source.DSH_TERRA_API_KEY
    : source.DSH_META_API_KEY ?? source.DEEPSEEK_API_KEY
  return {
    ...source,
    MSWEA_CONFIGURED: 'true',
    ...(baseURL ? { OPENAI_BASE_URL: baseURL } : {}),
    ...(apiKey ? { OPENAI_API_KEY: apiKey } : {}),
  }
}
