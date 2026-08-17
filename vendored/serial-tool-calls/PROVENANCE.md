# serial-tool-calls loop candidate — provenance

This is a runnable, vendored build of the DeepSeek Harness `agent-loop` plugin.

- upstream repository: `https://github.com/deepseek-ai/deepseek-harness.git`
- upstream commit: `47f943859bef60e4160492346772ded9b24f765a`
- upstream package: `packages/core/agent-loop`
- candidate package: `@deepseek-ai/dsh-agent-loop-candidate@0.1.0-candidate.1`
- candidate delta: `DEFAULT_MAX_PARALLEL_TOOL_CALLS` changed from `10` to `1`
- build input: `/chenzute/dsh-src/deepseek-harness/packages/core/dsh-agent-loop-candidate`
- imported build artifacts: `package.json`, `lib/index.js`, `lib/invariant.js`
- canonical content SHA-256: recorded in
  `loop-candidates/serial-tool-calls.manifest.json` (the hash intentionally
  excludes no files, so it must not be duplicated inside this hashed artifact).

The artifact is intentionally immutable. Builder-created candidates must first
land in a runtime staging directory and must never overwrite this directory.
