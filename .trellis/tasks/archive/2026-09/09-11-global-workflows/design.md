# Design · 全局工作流存储

## kernel
- `workflow/global-store.ts`：`globalWorkflowRoot(input?)` = `join(resolveProductPaths(input).configRoot, 'workflows')`；
  `workflowFileCandidates(repoRoot, name)` → `[项目路径, 全局路径]`；`workflowNamesUnder(dir)`。
- `loadWorkflow`：builtin → 依次找第一个存在的候选文件 → parse + `validateWorkflowForStorage`（错误信息带路径）→ null。
- `branch-track-lookup.projectWorkflowNames`：default ∪ 项目目录 ∪ 全局目录。
- 测试：用 `TENON_RUNTIME_HOME` 指向临时目录（`process.env` 在 vitest 内可设）；根 vitest 配置加 setup 把未设置的 `TENON_RUNTIME_HOME` 指到临时目录，避免开发机全局文件泄漏进测试。

## server
- `serverGovernance.ts`：`globalWorkflowRootCheck()`：`mkdirSync(<global>/.pipeline/workflows, recursive)` 后捕获并缓存 anchor；导出 `workflowStoreForRequest(root)` = `root === '' ? global : workflowRootForRequest(root)`。
- 六个工作流路由改用 `workflowStoreForRequest`；`source` = 全局 anchor → `'global'`，项目 anchor → `'project'`。
- 带 root 的 `GET /api/workflows/:name`：项目 anchor 读不到 → 全局 anchor 读（source global）→ default 内建模板。
- 删除工作流的引用扫描以 anchor 为基：全局删除只扫全局目录（项目内引用不在范围，风险说明写入 spec）。

## dashboard
- `WbWorkflowSource` 加 `'global'`；schema 放行；i18n `source_global: 全局`。
- App：`view === 'workbench'` 直接渲染 `<WorkflowView root="" />`；删除 workbenchRoot / retained / authorityLost / ProjectGate 分支；离开守卫 `leavesDirtyWorkbench = target.view !== 'workbench'`。
- `useWorkflowEditor`：去掉 `root === ''` 早退。
- App.test：改写依赖「切换项目触发草稿守卫」的用例为「切换视图触发」；删掉 root 失权保留草稿的用例。
