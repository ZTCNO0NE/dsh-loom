/**
 * Host-only Builder credential resolution.
 *
 * Loom stores credential *references* in config and resolves them only at the
 * moment an LLM or mini-SWE process is invoked.  Values never enter plans,
 * prompts, journals, evidence, or status projections.
 */
export interface CredentialResolution {
    ref: string;
    value: string;
    source: string;
}
export interface CredentialDescription {
    ref: string;
    configured: boolean;
    source?: string;
}
export interface CredentialServiceLike {
    resolve(ref: string): Promise<{
        value: string;
        source: string;
    } | undefined>;
    describe(ref: string): Promise<{
        configured: boolean;
        source?: string;
    }>;
}
export type BuilderProvider = 'deepseek-official' | 'gpt-5.6-terra';
/**
 * Credentials are selected by the already-selected model route, never by
 * whichever secret happens to be available.  This prevents a DeepSeek key
 * from being sent to an OpenAI-compatible endpoint (and vice versa).
 */
export declare function defaultCredentialRefs(provider: string): string[];
export declare class BuilderCredentialResolver {
    private readonly credentials;
    private readonly provider;
    private readonly explicitRef;
    constructor(credentials: CredentialServiceLike | undefined, provider: string, explicitRef?: string);
    private refs;
    resolve(): Promise<CredentialResolution | undefined>;
    require(): Promise<CredentialResolution>;
    describe(): Promise<CredentialDescription>;
}
