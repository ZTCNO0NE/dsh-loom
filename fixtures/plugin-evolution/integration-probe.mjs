import { strict as assert } from 'node:assert'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const profile = process.argv[2] ?? 'loom-plugin-e2e'
const profileDir = join(process.env.DSH_HOME ?? '', 'profiles', profile)
const cost = await import(pathToFileURL(join(profileDir, 'node_modules', 'dsh-loom-fixture-cost', 'dist', 'index.mjs')).href + `?v=${Date.now()}`)
const notify = await import(pathToFileURL(join(profileDir, 'node_modules', 'dsh-loom-fixture-notify', 'dist', 'index.mjs')).href + `?v=${Date.now()}`)
const event = cost.createCostEvent({ model: 'deepseek-v4-flash', tokens: 1000, costUsd: 0.02 })
const message = notify.createNotification(event)
assert.equal(event.model, 'deepseek-v4-flash', 'cost event must retain the model dimension')
assert.match(message, /deepseek-v4-flash/, 'notification must expose the selected model')
assert.match(message, /premium|priority/i, 'notification must route the high-value model to a visible priority')
console.log(JSON.stringify({ passed: true, event, message }))
