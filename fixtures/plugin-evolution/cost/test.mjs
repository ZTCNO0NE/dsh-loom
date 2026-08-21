import { strict as assert } from 'node:assert'
import { createCostEvent } from './src/index.mjs'
assert.deepEqual(createCostEvent({ tokens: 1000, costUsd: 0.02 }), { tokens: 1000, costUsd: 0.02 })
