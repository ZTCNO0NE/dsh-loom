export declare const BUNDLED_MINI_SWE_VERSION = "2.4.6";
export declare const BUNDLED_MINI_SWE_CONFIG = "mini-swe-agent-v2.4.6.yaml";
export declare const BUNDLED_MINI_SWE_RUNNER = "loom-mini-swe-runner.py";
export interface BundledMiniSwePaths {
    runtimeRoot: string;
    executable: string;
    configPath: string;
    runnerPath: string;
    ready: boolean;
}
/** Resolve the user-owned bootstrap cache without ever writing into the npm package. */
export declare function bundledMiniSwePaths(options: {
    metaRoot: string;
    packageRoot: string;
    runtimeRoot?: string;
    executable?: string;
    configPath?: string;
    exists?: (path: string) => boolean;
}): BundledMiniSwePaths;
