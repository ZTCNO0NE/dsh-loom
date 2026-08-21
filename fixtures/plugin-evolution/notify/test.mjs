import { strict as assert } from 'node:assert'
import { createNotification } from './src/index.mjs'
assert.equal(createNotification({ tokens: 1000, costUsd: 0.02 }), 'tokens=1000; cost=$0.0200')
