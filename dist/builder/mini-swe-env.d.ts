/**
 * Host-only bridge for mini-SWE's OpenAI-compatible runtime.  Credentials are
 * copied only into the spawned child environment; callers must never serialize
 * this object into a prompt, workspace, trajectory, plan, or evidence record.
 */
export declare function miniSweChildEnv(provider: string, source?: NodeJS.ProcessEnv, credential?: string): NodeJS.ProcessEnv;
/** Maps Loom's provider-neutral model name to mini-SWE/LiteLLM's provider route. */
export declare function miniSweModelName(provider: string, model: string): string;
