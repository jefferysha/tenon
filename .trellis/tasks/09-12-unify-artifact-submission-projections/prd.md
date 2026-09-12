# 统一 submission service 接入文档与字段 projection

## Goal

将 document ledger、field state 与 runtime artifact 接入统一 subject/version submission service，完成跨 projection lineage、迁移、权限、UI/API 与真实多阶段验证。

## Requirements

- TBD

## Acceptance Criteria

- [ ] TBD

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
# 统一 submission service 接入文档与字段 projection

## 目标

把 document ledger、workflow field state 和 runtime artifact 三套存储接入同一个 host-owned submission application boundary，使同一逻辑产物只拥有一个 canonical subject/version lineage，同时保留三种 projection 各自的治理职责。

## 已确认约束

- Runtime 已有 `ArtifactSubjectRef`、subject mapping、legacy alias、声明优先提交和 reconcile 降级语义。
- Document ledger 位于 `.pipeline-documents.json`，由 `recordDocumentLedger()` 按 document kind、phase、producer policy 管理。
- Workflow field state 位于 `.pipeline.yaml` / canonical state reducer，由 transition/field reducers 管理，不能绕过 reducer 直接写入。
- UI 不负责让模型推断 I/O；UI 只展示 bounded contract、subject status、version 和按需内容。

## 要求

### R1 统一提交入口

新增 Kernel/Automation 可复用的 `ArtifactSubmissionService`（或等价应用层），接受 document、field、runtime 三类声明，完成 subject 解析、内容 digest、producer 授权、版本分配、治理证据和 projection adapter 调用。既有直接 API 继续作为兼容适配器。

### R2 文档 projection

DocumentRecord 增加可选 canonical subject ref；文档登记在原有 phase/kind/producer policy 通过后，由 submission service 记录同一 subject/version。旧 ledger 无 subject 时生成迁移 receipt，保持旧记录可读。

### R3 字段 projection

Field output 通过既有 transition/reducer 写入，增加可选 subject/version metadata；不得绕过 canonical field state。字段值的权限和校验继续由原 field reducer 负责。

### R4 跨 projection lineage

同一 logical key 的 document、field、runtime projection 返回同一 `subject_id` 和对应 immutable version；不同 projection 的 source metadata 不改变 subject identity。

### R5 API/UI

Server 返回 bounded subject/projection/declaration metadata；Dashboard 将三类 projection 按 subject 聚合，正文和字段值继续按需读取。未知或未声明 projection 显示为 contract status，不阻塞普通 workflow 编辑。

### R6 兼容与失败策略

旧 document ledger、field state、path-hash artifact ID 必须可读。projection adapter 失败时保留 canonical workflow state，写入 bounded diagnostic 和 retry receipt，不静默宣称提交成功。

## 验收标准

- 一个测试场景同时提交 document、field、runtime 三种 projection，并断言 subject/version lineage 一致。
- 文档和字段原有治理规则、权限和 reducer 测试继续通过。
- 旧 ledger/state 重启迁移幂等，旧 ID/路径仍可读取。
- Server/Dashboard 展示统一 subject，且不会重复显示为三个无关产物。
- 真实多阶段 backend workflow 覆盖声明、字段写入、文档登记、runtime 文件、reconcile-only 文件、rename 和 restart。
