export const name = 'loom-cold-hmr'
export function apply(ctx) {
  // runProfile only needs a truthy hmr service to avoid installing filesystem
  // watchers after boot. The cold probe is one-shot and never performs HMR.
  ctx.provide('hmr', Object.freeze({
    coldProbe: true,
    async registerConfig() { return async () => {} },
  }))
}
