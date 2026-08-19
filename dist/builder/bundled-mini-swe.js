import { existsSync } from 'node:fs';
import { join } from 'node:path';
export const BUNDLED_MINI_SWE_VERSION = '2.4.6';
export const BUNDLED_MINI_SWE_CONFIG = 'mini-swe-agent-v2.4.6.yaml';
/** Resolve the user-owned bootstrap cache without ever writing into the npm package. */
export function bundledMiniSwePaths(options) {
    const runtimeRoot = options.runtimeRoot || join(options.metaRoot, 'runtime', `mini-swe-agent-${BUNDLED_MINI_SWE_VERSION}`);
    const binDir = process.platform === 'win32' ? 'Scripts' : 'bin';
    const executable = options.executable || join(runtimeRoot, binDir, process.platform === 'win32' ? 'mini.exe' : 'mini');
    const configPath = options.configPath || join(options.packageRoot, 'runtime', BUNDLED_MINI_SWE_CONFIG);
    const present = options.exists ?? existsSync;
    return { runtimeRoot, executable, configPath, ready: present(executable) && present(configPath) };
}
