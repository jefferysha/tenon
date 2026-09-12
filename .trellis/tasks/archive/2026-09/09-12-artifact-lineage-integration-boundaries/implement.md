# 实施计划

## 阶段 1：契约与快照降级

- [x] 扩展 server/dashboard compatibility issue 类型与 decoder。
- [x] 改造 `projectArtifactAttempts` 返回 attempts + issue，捕获 `ArtifactScopeMigrationError`，保持 change 构造流程继续。
- [x] 为迁移冲突补 snapshot fixture：change 仍存在，artifactAttempts 为空，issue 可见且错误文案不再误导。

## 阶段 2：服务缓存恢复

- [x] 在 `server.ts` 为 artifact service promise 增加 reject eviction，防止旧 promise 删除新 promise。
- [x] 通过 server 生产缓存接线和全量 server 测试验证失败不会阻断后续快照读取。

## 阶段 3：真实 runtime 映射

- [x] 调整 WorkflowView/StageEditorPane 只消费快照中的真实 `stageAttemptId`，删除 step id 作为 stageId 的回退。
- [x] 无可靠关联时显示明确不可用空态，不发起猜测查询。

## 阶段 4：历史参考与上下文生命周期

- [x] 用 memo 派生 App runtime context，移除 render 阶段 sticky ref，限定 root/change。
- [x] 为 ArtifactCatalogPanel 增加历史参考头部、attempt 标识、日期和 i18n 文案。
- [x] 处理上下文切换时轮询/异步响应的取消与清空。
- [x] 现有 dashboard component tests 全部通过，覆盖无上下文空态和工作流渲染。

## 阶段 5：真实验证

- [x] 运行 server/automation/dashboard 相关 typecheck 与 tests。
- [ ] 启动真实本地后端和 dashboard，执行迁移冲突 change 可见、选中历史 change、切换/取消选择的 UI E2E。
- [x] 检查变更通过类型检查、snapshot 回归和 dashboard 组件测试；全量 server 测试通过。

## 风险点与回滚点

- `snapshot.ts` 的 compatibility union 和 decoder 是协议边界，先加测试再改行为。
- App/WorkflowView/StageEditorPane 同步改动，若运行时映射证据不足，保留明确空态，不恢复错误回退。
- 不触碰工作区既有无关 dirty files；只提交本任务相关文件。
