# 接通三投影统一提交与 reconcile 降频

## Goal

将 document、field、runtime 三条生产写入路径接入 change 级统一 submission service，修复 namespace 分裂，降低 Codex path-unresolved reconcile 频率，并生成与最新代码一致的真实多阶段 evidence。

## Requirements

- Use one change-level namespace for document, field, runtime, and server read projections.
- Preserve existing document governance, field canonical writes, runtime attempts, visibility, and
  legacy read compatibility while routing new writes through the shared submission boundary.
- Reuse an explicit logical key across projections; a path is only a locator alias.
- Coalesce path-unresolved reconcile scheduling within one Codex turn and keep the stage-end reconcile.
- Produce evidence from the current implementation and record unrelated baseline failures separately.

## Acceptance Criteria

- [ ] CLI and server production paths resolve the same namespace and submission service.
- [ ] Document, field, and runtime submissions share a subject id for one logical key.
- [ ] Multiple path-unresolved events in one turn schedule one reconcile.
- [ ] Rename, restart, and reconcile-only intermediate behavior remain durable and inspectable.
- [ ] Focused tests, backend typecheck, diff check, and current evidence pass.

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
# 接通统一 submission 与 reconcile 降频

## 目标

修复上一轮发现的生产断链：document、field、runtime 三条写入路径没有真正共用 `openArtifactSubmissionService`，导致 namespace 分裂和同一文件多个 subject；同时避免 Codex `command_execution` 无结构化路径时重复全量 reconcile。

## 要求

- 以 change 级稳定 namespace 作为三种 projection 的共同边界。
- CLI document record、CLI artifact register/field projection、runtime execution 都通过统一 submission service 或其生产 adapter 写入。
- 现有 document policy、field reducer、runtime attempt/visibility/pinning 规则保持不变。
- 同一个显式 logical key 必须在三种 projection 中产生相同 `subject_id`；没有显式 key 时 fail closed 或 host-issued subject，不按路径自动合并。
- `command_execution` 无 path 时，每个执行 turn 至多触发一次 reconcile；阶段结束仍做一次完整 reconcile。
- 生成与最新代码一致的真实多阶段 backend evidence，不能复用旧 commit 之前的 JSON。
- 保留现有 compatibility aliases、legacy ledger、field sidecar 和 projection failure diagnostics。

## 验收

- 真实 document + field + runtime 同 logical key 的 subject id 一致。
- `grep`/调用链证明三条生产入口均接入 submission service。
- 一个阶段有多个无 path command event 时，reconcile 调用次数为 turn 数，而不是事件数。
- rename、restart、legacy read、reconcile-only intermediate 仍通过。
- 新 evidence 包含当前 commit、subjectRef、declarationStatus、quality 和 reconcile 次数。
- 相关测试、backend tsc、diff check 通过；既有 dashboard `ErrorOptions` 与无关架构失败单独记录。
