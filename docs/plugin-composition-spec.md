# Plugin Composition Spec — Capability / Verifier / Gate

更新：2026-08-18。状态：设计基线，尚未实现注册器。

本规格承接 [`builder-foundation-spec.md`](./builder-foundation-spec.md)。目标不是让所有组件拥有相同权限，而是使能力可以自由增加、验证可以按能力组合，同时让任何不完整或非法的验收都不能穿过 Gate。

## 1. 三类插件与最小 Kernel

```text
Builder base loop
  └─ Capability plugin（Builder 可使用、可提案升级）
       └─ immutable proposal + artifacts
            └─ Verifier plugin set（独立、只读、fail-closed）
                 └─ Gate（唯一 live apply / rollback 权限）
```

| 类别 | 目的 | 谁可改 | 是否能让目标生效 |
| --- | --- | --- | --- |
| Capability plugin | 给 Builder 增加探索/产出能力 | Builder 可提案，普通 verifier 审核 | 否 |
| Verifier plugin | 对一个 capability/target 的契约给出独立 verdict | 治理注册表/操作者；Builder 只读 | 否 |
| Gate | 绑定证据、快照、安装、回滚 | 最小 Kernel 所有 | 是 |
| Kernel | journal、proposal hash、状态迁移、授权与回注 | 产品代码 | 只调度 Gate，不选择内容 |

“一切皆插件”适用于能力和实现接口；不适用于把裁决权交给待裁决对象。

## 2. Capability contract

每个 capability 描述 Builder 能做什么、交付什么、以及必须由哪些 verifier 验收。它不包含 `approved` 或 `install` 操作。

```ts
interface CapabilityPlugin {
  id: string                 // e.g. loop-evolution
  version: string
  targetKinds: string[]      // e.g. ['actor-loop']
  tools: string[]            // Builder 可调用的 DSH tools
  inputRefs: string[]        // actor state, source, journal, reports …
  proposalSchema: string     // versioned schema id
  requiredVerifiers: VerifierRequirement[]
  installStrategy: string    // gate-owned strategy id
}

interface VerifierRequirement {
  id: string
  version: string
  required: true
}
```

Builder 可以在自身 workspace 自由探索；最终只提交 `proposal + artifact refs + proposalHash`。Capability 的工具失败只是 journal 反馈，Builder 可以继续修正或 abort。

## 3. Verifier contract

Verifier 是可注册的插件，但不是 Builder 可写的普通 skill。它在冻结 proposal 上独立运行，读取 artifact、目标 before snapshot、回归集和 capability contract，输出带 hash 的报告。

```ts
interface VerifierPlugin {
  id: string
  version: string
  supports: { capability: string; proposalSchema: string[] }[]
  verify(input: VerificationInput): Promise<VerificationReport>
}

interface VerificationReport {
  verifier: { id: string; version: string; artifactHash: string }
  proposalHash: string
  verdict: 'passed' | 'rejected' | 'error'
  checks: Array<{
    id: string
    required: boolean
    verdict: 'passed' | 'rejected' | 'error' | 'not_run'
    evidenceRefs: string[]
  }>
  runRef: string
  observedAt: string
}
```

Verifier 应尽量是确定性的。若需要模型判断，模型输出仍须落为可重放的 report/evidence，并由确定性 policy 检查报告完整性；不能只凭模型说“通过”。

## 4. Fail-closed 放行规则

Gate 不理解某个 loop 或 skill 是否“好”；它只执行固定授权谓词：

```text
allow_apply(proposal, contract, reports) =
  proposal 已冻结且 hash 未变
  AND 所有 contract.requiredVerifiers 都有恰好匹配 id/version 的报告
  AND 每份报告 proposalHash 相同
  AND 每个 required check = passed
  AND 无 error / timeout / not_run / stale evidence
  AND target before snapshot 未冲突
```

任一条件不成立即拒绝，绝不“部分通过后安装”。Gate 将 rejection/rollback report 回注 Builder 的下一 immutable run。

工具失败不自动等同最终 rejection：429、编译错误、测试失败等首先是 Builder 自主修正的反馈。**只有 required verifier 的 fail-closed report 才阻断 Gate。**

## 5. 首个拼装：`loop-evolution`

```text
Builder base loop
  + loop-evolution capability
      read actor state/source/history
      discover or author candidate
      build/probe in workspace
      freeze proposal + artifact hashes
  ↓
verifier set
  1. provenance-verifier     source/ref/hash/edit manifest
  2. build-verifier          reproducible build + entry resolution (C0)
  3. loop-contract-verifier  C1–C8
  4. regression-verifier     C6 / required regressions
  5. runtime-verifier        disposable cold replacement + actor rerun
  6. performance-verifier    only when capability claim includes performance
  ↓ all passed
Gate
  before snapshot → cold install → smoke → after snapshot
  failure → rollback
```

性能不应默认成为每一个 loop candidate 的硬门；只有 candidate 声称吞吐/延迟提升或 policy 要求时，才把 `performance-verifier` 列入 `requiredVerifiers`。这避免无意义地阻塞安全/功能修复。

## 6. 新 capability 与新 verifier

新增 capability 的正常路径：新增 capability manifest → 指定现有 verifier set → Builder 可立即使用。

新增 verifier 的正常路径：操作者/治理发布新 verifier artifact → 治理注册表固定 `id + version + artifactHash` → capability manifest 引用它 → Gate 才承认其 report。

Builder 可以提出“需要一个新 verifier”的请求或草稿，但它不能自行把该 verifier 加入可信注册表，更不能用刚生成的 verifier 审批同一 proposal。否则会形成自证循环。验证 verifier 本身的方式是独立的治理变更、测试集、版本 pin 和操作者批准；这条根不属于普通 Builder 的变更权限。

## 7. 实现顺序

1. 定义并加载 `CapabilityPlugin` manifest；暂时静态注册即可；
2. 定义 `VerifierPlugin` registry 与上述 hash-bound report；
3. 把 Gate 改为只接受 capability contract 中完整 verifier set；
4. 将现有 C0/C1–C8/C6/冷替换代码封装成 `loop-evolution` 的 verifier plugins；
5. 用一个 capability 的 pass/reject/missing-report/changed-proposal 测试证明 Gate 全部 fail-closed；
6. 再让 Builder 真实调用 `loop-evolution` capability 跑端到端案例。
