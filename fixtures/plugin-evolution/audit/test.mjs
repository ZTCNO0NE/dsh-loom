import assert from 'node:assert/strict'
import { auditPluginInventory } from './dist/index.mjs'

assert.equal(auditPluginInventory(['notify', 'cost']), 'cost,notify')
console.log('audit-fixture-pass')
