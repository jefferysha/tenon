# 技术设计

## 边界与数据流

```text
openArtifactService(changeDir)
        │
        ├─ success ──> server root cache ──> snapshot.artifactAttempts
        │                                      │
        └─ migration conflict                 └─> dashboard runtime context
             │                                      │
             └─ compatibility issue                ├─ history badge + provenance
                (change remains visible)            └─ catalog(stageAttemptId)
```

### 1. 快照兼容降级

在 `snapshot.ts` 的 artifact projection 边界捕获 `ArtifactScopeMigrationError`，不要在外层 project catch 中处理。将它转换为一个新的 `CanonicalStateCompatibilityIssueSnapshot` 联合成员，例如 `kind: 'legacy-scope-unmerged'`，只携带可展示的 change、legacy scope 路径和 action。`projectArtifactAttempts()` 对该异常返回空数组并通过结果对象把 issue 交给 `scanAnchoredProject`，这样 `Promise.all` 仍能完成，随后统一 push issue，再构造 `changes.push`。

为了避免额外的全局异常状态，采用显式投影结果：

```ts
{ attempts: ReadonlyArray<...>; compatibilityIssue?: ... }
```

同一 change 只登记一次 issue；issue 不改变 `changes` 的内容。dashboard decoder 扩展联合类型，保持旧版本只读能力。

### 2. rejected promise 缓存

在 `server.ts` 缓存包装 promise：创建后立即 `catch`，发现 reject 时仅删除仍指向该 promise 的 map entry，然后重新抛出原错误。身份检查避免旧 promise 的延迟 rejection 删除已经替换的新 promise。成功 promise 继续长期复用。

### 3. 历史上下文契约

将 App 到 WorkflowView 的上下文改成不可变的 `RuntimeArtifactReference`，包含：`root`、`change`、`stageAttempts`（真实 `stageId` + `stageAttemptId`）及可选运行元数据。上下文由选中的当前 project/change 派生，使用 effect/state 生命周期更新；取消选择、切换项目或离开 progress 时设为 `null`。

`StageEditorPane` 不再传 `stageId={step.id}`。它从上下文的 attempt 列表按明确的 `workflowStepId` 映射查找 `stageAttemptId`；若没有映射，渲染不可关联空态。运行时面板接收 `historyReference`，显式渲染“历史参考”、run/attempt id 与日期，再展示 catalog 条目。

优先复用快照中的真实 attempt。若当前 snapshot 只有 pipeline stage id，则在 server projection 增加可选 `workflowStepId`（从 immutable workflow/pipeline plan 映射）；映射不可得时宁可空态，不回退到 workflow step id 发请求。

### 4. UI 语义

`ArtifactCatalogPanel` 的历史头部和空态使用 i18n key，不写死文案。目录条目仍保持现有 observed metadata、候选/交付物和 affected 标记。历史头部必须与声明的 `stage-outputs` 区分，避免被理解为可编辑 workflow 输出。

## 兼容与回滚

- 新 compatibility issue 是向后兼容的可选数组成员；旧 dashboard 收到未知 issue 时按 decoder 失败保护，server 保持 change 可读。
- `stageAttemptId` 仍是既有 catalog API 参数，不改变 API 路由。
- 若真实 stage 映射在旧 state 中不存在，退化为空态，不影响工作流编辑和其他 change。
- 不删除 legacy 目录，不修改迁移 receipt。

## 风险控制

- 迁移错误类型从 automation 包导入时使用已有导出；若造成 server 层依赖扩大，改为结构化 type guard（`name`/`code`/`legacyPath`）并在测试中锁定形状。
- 面板轮询必须随上下文 key 变化取消旧请求，防止旧 change 的响应覆盖新 change。
- 真实 E2E 同时断言 UI 文案和 network 请求参数，避免理想化的 submission-only 调用掩盖 executor 路径。
