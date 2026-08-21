export const name = 'loom-fixture-audit'

export function auditPluginInventory(packages) {
  return [...packages].sort().join(',')
}

export function apply(ctx) {
  ctx.provide?.('loomFixtureAudit', { auditPluginInventory })
}
