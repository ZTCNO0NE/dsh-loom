import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BuilderCapabilityRuntimeRegistry, WORKSPACE_SIMULATION_CAPABILITY } from '../builder/capabilities.js'
import { BuilderKernel } from '../builder/kernel.js'
import { compareSimulationToReal, createWorkspaceSimulationRuntime, SimulationRunner } from '../builder/simulation.js'

describe('workspace simulation capability', () => {
  it('runs a reproducible fixture in Builder workspace and persists a hashed report', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-loom-sim-'))
    const report = new SimulationRunner(workspace).run({
      id: 'hello',
      command: process.execPath,
      args: ['fixture.mjs'],
      files: { 'fixture.mjs': 'console.log("simulation-ok")' },
      expectedStdoutIncludes: ['simulation-ok'],
    })
    expect(report.status).toBe('passed')
    expect(report.exitCode).toBe(0)
    expect(report.reportHash).toMatch(/^[a-f0-9]{64}$/)
    expect(report.reportPath).toContain('.loom/simulations/hello.json')
  })

  it('returns failed and inconclusive instead of turning simulation into approval', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-loom-sim-'))
    const failed = new SimulationRunner(workspace).run({
      id: 'bad', command: process.execPath, args: ['-e', 'process.exit(2)'], expectedExitCode: 0,
    })
    const inconclusive = new SimulationRunner(workspace).run({
      id: 'unknown', command: process.execPath, args: ['-e', 'process.exit(0)'], inconclusive: true,
    })
    expect(failed.status).toBe('failed')
    expect(inconclusive.status).toBe('inconclusive')
  })

  it('compares the same observable contract with an isolated real observation', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-loom-sim-'))
    const simulation = new SimulationRunner(workspace).run({
      id: 'same', command: process.execPath, args: ['-e', 'console.log("same")'], expectedStdoutIncludes: ['same'],
    })
    expect(compareSimulationToReal(simulation, { exitCode: 0, stdout: 'same\n', stderr: '' })).toMatchObject({ consistent: true })
    expect(compareSimulationToReal(simulation, { exitCode: 0, stdout: 'different\n', stderr: '' })).toMatchObject({ consistent: false, divergences: ['stdout differs'] })
  })

  it('executes simulation through a registered capability runtime, not a Kernel special case', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loom-sim-runtime-'))
    const runtimes = new BuilderCapabilityRuntimeRegistry().register(createWorkspaceSimulationRuntime())
    const kernel = new BuilderKernel(root, 's', runtimes)
    const run = kernel.create({ kind: 'loop_candidate', actor: {}, targetBefore: {} })
    const result = kernel.decide(run.id, {
      kind: 'tool',
      action: {
        name: 'invoke_capability',
        capability: WORKSPACE_SIMULATION_CAPABILITY.id,
        tool: 'run_simulation',
        input: { id: 'runtime', command: process.execPath, args: ['-e', 'console.log("runtime-ok")'], expectedStdoutIncludes: ['runtime-ok'] },
      },
    })
    expect(result).toMatchObject({ status: 'passed', exitCode: 0 })
    expect(kernel.load(run.id).phase).toBe('baseline_simulating')
    expect(kernel.context(run.id).journal).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'tool', action: 'invoke_capability' }),
    ]))
  })
})
