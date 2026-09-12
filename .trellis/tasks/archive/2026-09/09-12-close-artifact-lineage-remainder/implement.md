# 实施清单

## A. 迁移与审计

- [x] 在 kernel subject 类型/decoder 中补充迁移冲突与 legacy 保留 metadata 的可选表达，保持旧 receipt 可解码。
- [x] 重构 `openArtifactService()` 的 scope migration：同锁读取两侧、复制成功立即写 receipt、双写冲突写 durable diagnostic 并稳定失败、重复 open 幂等。
- [x] 为 canonical-only、legacy-only、both-sides-unmerged、equivalent、concurrent-open、restart-read 增加 service tests。

## B. 批量 reconcile

- [x] 在 automation artifact service 和 port 增加 `observeBatch`，复用现有版本/事件逻辑并保证一次 mutate。
- [x] 修改 `StageArtifactRuntime.reconcileNow()` 使用 batch，兼容无 batch 的注入 service，并验证失败不推进 baseline。
- [x] 增加批量调用计数测试、独立事件/版本测试和删除混合场景测试。

## C. 编排页运行时可见性

- [x] 在 App/WorkflowView/StageEditorPane 传递最近的 `{root, change}` runtime context。
- [x] 有上下文时复用 `ArtifactCatalogPanel` 显示当前 stage catalog；无上下文时显示只读空状态且不发 API 请求。
- [x] 增加 workflow 组件测试，覆盖空状态；有上下文复用现有 panel/API 测试。

## D. 宿主边界与类型检查

- [x] 更新 automation/kernel spec，记录 pathless Codex host 的 source/attribution 限制。
- [x] 修复 dashboard TypeScript lib 对 `ErrorOptions` 的解析，不放宽 strict/noUnused。

## E. 验证与收尾

- [x] `node_modules/.bin/tsc -b packages/kernel packages/automation packages/cli packages/server --pretty false`
- [x] `npm run typecheck:web`
- [x] 运行 artifact service、stage-runtime、submission、server route、dashboard workflow 相关 Vitest。
- [x] 运行迁移/批量等价证据测试；真实 Codex production runtime 脚本已尝试但受宿主 `codex exec` 长时间无输出影响中止，既有 production evidence 未被覆盖。
- [x] `npm run check:architecture`，确认失败项均为既有基线；`git diff --check`。
- [ ] 只提交本任务相关文件，保留用户已有 dirty files。
