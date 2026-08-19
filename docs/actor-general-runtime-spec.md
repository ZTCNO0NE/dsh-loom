# Actor General Runtime Spec

更新：2026-08-19。状态：设计冻结，作为把 mini-SWE 从 loop implementation
runtime 扩展为 actor 通用 execution runtime 的迁移合同。

## 1. 问题与非目标

当前系统有两条不对称路径：

```text
loop:  mini-SWE → Kernel compile_loop_submission → Importer → C0/C1-C8/C6 → cold Gate
patch: Loom-native Proposer → patch-evolution envelope → Validator → patch Gate
```

这不是“actor 一切可改”：mini-SWE 不能为 config/tool/skill 产生受同一 immutable
workspace、compiler、reopen 语义约束的候选。迁移目标是**统一 execution runtime
入口，而不是统一所有 verifier 内容**。不同目标仍应由不同的、独立的 verifier/gate
合同裁决。

永远不纳入 Builder 可改范围：`verifier`、`gate`、`meta-validate`、可信 verifier
registry、生产 runtime 与密钥/服务环境。它们是 TCB，不是 actor 可演化组成部分。

## 2. 统一合同

每个 actor capability 必须注册以下四个独立部分：

```ts
interface ActorEvolutionCapability {
  id: string
  targetKinds: readonly ('config' | 'tool' | 'skill' | 'composition' | 'actor-loop')[]
  workspace: WorkspaceMaterializer      // host-owned before snapshot + isolated writable copy
  compiler: ProposalCompiler            // workspace diff / structured draft → frozen envelope
  verifierContract: VerifierContract    // ids/versions/required checks, hash-bound
  gate: GateStrategy                    // only implementation allowed to touch target
}
```

`mini-SWE` only receives the materialized workspace and task. Its durable
`Submitted` means “ask compiler to freeze”, never “approved” or “install”.
The Controller selects a capability before materialization; the model may
explore freely within its workspace but cannot choose an unregistered
compiler/verifier/gate at submission time.

All compilers must produce the same outer envelope:

```json
{
  "capability": "<registered-id>",
  "payload": { "...capability schema...": true },
  "rationale": "builder intent",
  "artifacts": ["hash-bound paths"]
}
```

The Kernel freezes proposal/input/target-before/evidence hashes exactly once.
Rejection or rollback creates a new immutable run; the same contract applies
to mini-SWE and Loom-native execution.

## 3. Capability mapping

| Capability | target | compiler source | independent verifier | Gate |
| --- | --- | --- | --- | --- |
| `loop-evolution` | actor-loop | Kernel-captured `src/**/*.ts` diff | Importer + C0/C1-C8/C6 | Loader cold replacement/rollback |
| `config-evolution` | existing config row | host materializes target row JSON; compiler emits one exact update diff | existing Validator + trajectory/probe rules | existing patch Gate |
| `tool-evolution` | tool insert/update | host materializes module bundle + target metadata; compiler emits module manifest | existing module/load/probe Validator | existing patch Gate |
| `skill-evolution` | skill insert/update | host materializes SKILL bundle + target metadata | existing skill layout/load/probe Validator | existing skill Gate |
| `actor-composition` | multiple actor components | explicit composition graph, never arbitrary config dump | **new composition verifier required** | **new composition Gate required** |

`config/tool/skill` first reuse the existing patch Validator/Gate rather than
inventing a new verifier. They cease being a separate Proposer route once the
common compiler feeds the existing `patch-evolution` payload. `composition`
must initially remain `needs_verifier`: allowing a multi-target proposal to
pretend it is a sequence of single-variable patches would weaken the existing
one-variable and rollback contracts.

## 4. Workspace and compiler invariants

- Workspace is created from host-owned snapshot; never a live profile.
- Compiler, not mini-SWE, calculates `before` hashes, target IDs, module
  inventory, size limits and expected trajectory bindings.
- A workspace edit outside the capability allowlist cannot appear in payload.
  If no allowed change exists, compilation fails and run aborts.
- Compiler emits at most one `config/tool/skill` target in v1.2. A composition
  change requires its future dedicated capability.
- Importer/Validator repeats all security-relevant checks; compiler is not a
  trust anchor.
- Gate captures before/after and applies atomically; all failures produce
  rejection/rollback reports consumable by a fresh Builder run.

## 5. Implementation order

1. Extract a `CapabilityExecutionPlan` selected by Controller, used by both
   Loom-native and mini-SWE gateways; add capability metadata for
   config/tool/skill (no routing change yet).
2. Implement host materializer + Kernel `compile_patch_submission` for one
   config update, emitting the existing `patch-evolution` payload; prove
   mini-SWE → compiler → Validator → Gate → rollback end to end.
3. Add tool and skill bundle materializers/compilers; reuse existing probes
   and add cold load/rollback cases.
4. Introduce a composition graph schema, dedicated verifier registry and
   transactional multi-target gate. Until all three exist, composition remains
   `needs_verifier` and cannot install.
5. Retire direct Proposer execution as a production path after parity matrix
   passes; retain Loom-native only as diagnosis/conversation runtime.

## 6. Required evidence matrix

For every capability/runtime pair: successful immutable run, no Submitted,
timeout, malformed/partial trajectory, verifier rejection → immutable reopen,
allowed + outside workspace changes, stale before snapshot, gate smoke fail →
rollback, and actor replay. Performance claims additionally require the
capability-specific workload, raw frames and preregistered metrics.
