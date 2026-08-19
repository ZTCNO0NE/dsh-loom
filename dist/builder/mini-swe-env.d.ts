/**
 * Host-only bridge for mini-SWE's OpenAI-compatible runtime.  Credentials are
 * copied only into the spawned child environment; callers must never serialize
 * this object into a prompt, workspace, trajectory, plan, or evidence record.
 */
export declare function miniSweChildEnv(provider: string, source?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
