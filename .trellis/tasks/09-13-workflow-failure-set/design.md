# Design

`fields` 与 artifact 解析共享当前 workflow branch 选择；校验和写入保持同一 change 锁。测试 fixture 使用真实 branch。每个失败记录“产品回归/fixture 过期/环境 flake”分类依据后再改动。

## 失败分类证据（2026-09-13）

- `fields.test.ts` 中 7 个组合校验失败属于过期 fixture：`effectiveWorkflowForState` 现按 default workflow 分支解析，registry-only 的 `data` 轨没有 default 分支；测试已改用无文件的同 workflow 名称验证 allowed 组合，保持 R6 fail-closed 语义。
- `artifact.test.ts` 中 2 个 `spec/pm` 失败属于过期 policy fixture：`mockState` 使用 `manifest-overlay`，而 artifact declaration 的 policy 为 `effective-phase-skills`；测试改用 `mockLegacyDefaultState` 以复现 required_when 排除。
- `internal-skill-gate-hook.integration.test.ts` 的 optional 未声明 skill 是产品回归：phase entry skill 完成后，track overlay mandatory 缺口不应阻断 unrelated optional；门禁已修正并回归通过。
- Codex receipt ENOENT 是测试 fixture 与缓存身份校验不匹配：trust 校验要求 cache plugin/marketplace manifests，测试已补写 0.2.0 identity manifests，回归通过。
- workflow orchestration dynamic registry-only track 属 R6 语义：无同名 workflow branch 必须 fail-closed；测试改为断言 init 拒绝并指出缺失分支。
- `stable-hook.integration.test.ts` proposal path 失败保持未修改。失败断言明确要求文档路径只能位于 `openspec/` 或 `docs/`，当前 fixture 使用 `proposal.md`；按任务要求先不改断言，待稳定 hook 子任务决定修产品路径或 fixture。

### PM artifact declaration diagnosis (2026-09-13)

- `default` workflow 的 `spec/pm` 同时声明 `plan: file_path` 和 `artifacts: []`。旧编译器把所有已知
  `file_path` output 先派生为 `effective-step-skills`，再把显式列表当覆盖项；空列表没有清除派生项，
  导致 `set plan` 被 artifact cutover 拦截，`artifact register` 又因 PM 的 `manifest-overlay` policy 被拒。
- 编译器现明确区分三态：artifacts 未声明时派生、显式空数组时不派生、显式非空列表时按 field 覆盖。
  派生/覆盖逻辑已拆到 `compile-artifacts.ts`，保留 malformed、duplicate 和 policy 相容性校验。
- 真实 PM `set plan` 与 backend artifact 门禁回归均通过。已有 Change 的 frozen workflow snapshot 保持旧
  IR/指纹，不自动迁移；仓库当前没有 rebase/refresh 旧快照命令，恢复路径是新建 Change 或显式治理迁移。

### Stable-hook path-frame diagnosis (2026-09-13)

The fixture supplies repository-relative paths (`openspec/changes/<change>/proposal.md`).
`cmdDocumentRecord` intentionally converts these to Change-relative paths for the artifact
submission boundary. The document projection adapter was forwarding that Change-relative value
directly to Kernel `recordDocument`, whose resolver is rooted at the repository and therefore
correctly rejected `proposal.md` as outside the allowed `openspec/` or `docs/` prefixes. The
product fix converts the path back to repository-relative at the adapter boundary; Kernel path,
symlink, digest, authorization, and producer-evidence checks remain unchanged.
