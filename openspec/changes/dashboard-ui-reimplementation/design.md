# 设计

## 现状证据

- `App.tsx` 负责视图选择、项目选择、脏态导航拦截和 snapshot 连接；默认入口为 `progress`，因此上下文条应在 App shell 组合，而不是复制到各功能域。
- `Nav.tsx` 已提供 Projects、Progress、AFK、Workbench、Machine、Host Plan 六个入口；导航只负责切换，不应承载 workflow 或 Skill 业务状态。
- `ProgressView.tsx` 已有同源 `progressModel`、阶段画布和 `ProgressDrawer`；新的主视图只重排优先级，不复制状态判定。
- `AfkView.tsx` 消费自动化状态并提供 enqueue/retry/cancel；操作结果和错误仍由现有 API 客户端映射。
- `WorkbenchView.tsx` 同时承载 workflow、Track、Skill、Hook、Loop 和治理写入口；重排必须保留 `useWorkbenchDirtyState`、CAS 保存和 default workflow 只读边界。
- `src/api` 已按领域拆分 client/decoder/types，UI 不能绕过这些边界；`src/i18n` 是所有新增用户文案的唯一资源入口。

## 信息架构

1. App shell：左侧一级导航；顶部上下文条显示当前项目、Change、workflow、track、phase、连接和待处理数量。
2. Command（Progress）：第一屏顺序固定为“需要你处理 → 当前运行 → 下一动作 → 阶段脊”；证据、历史和日志进入同一 inspector 抽屉。
3. Automation（AFK）：按失败、运行、排队分组，顶部先给调度健康和并发限制，再给可执行动作；没有任务时明确说明如何从当前 Change 入队。
4. Workbench：顶部 workflow 选择与脏态提示；主区阶段脊和选中阶段摘要；配置字段进入 inspector/对话框，不把高级策略与运行事实堆在首屏。
5. Machine/Host Plan：只展示运行准备度、能力和安装/修复动作，使用与 Command 相同的状态字典；不把宿主事实混进 Change 业务列表。

## 状态与交互

- 状态至少同时包含文字和结构标记：`ready`、`running`、`queued`、`blocked`、`failed`、`offline`、`readonly`、`dirty`。
- 可写动作显示作用域和失败后的恢复路径；default workflow 和服务端派生状态标记为只读。
- 所有异步视图提供 loading、error、empty、retry/cancel 路径；SSE 更新只刷新受影响投影，不重播整页动画。
- 键盘顺序遵循导航 → 上下文 → 主动作 → 内容 → inspector；抽屉有焦点回收和 Escape 关闭；图视图旁始终渲染等价列表。
- 断点以 1024px、720px 为结构重排边界，390px 仅验证可读和可操作；不允许页面级横向滚动。

## 实施边界

先在 `model`/`state` 中提取 command context 和状态字典，再迁移 shell 与页面布局，最后调整局部 CSS 和动效。任何客户端契约缺口先通过现有 decoder/API 测试确认，再决定是否扩大到 server；不在本 Change 中新增第二套协议或临时静态数据。

## 风险

- 外壳重排可能破坏深链和脏态导航：保留现有 `dashboardLocation`、testid 和拦截测试，逐页迁移。
- inspector 抽离可能隐藏写入口：每个现有 mutation 保留同一 API client、错误映射和可访问触发器。
- 响应式问题无法由 jsdom 完整证明：使用真实浏览器检查 1440/1024/720/390、键盘、200% 缩放和 reduced-motion。
- 状态字典若与终端漂移会造成误导：所有标签来自现有 model/decoder，新增映射必须有定向测试。

## 待验证问题

- 当前所有页面是否都能从同一个 `currentRoot` 和 selected Change 恢复上下文？
- Skill 依赖图的服务端返回是否已经包含足够的节点状态和错误原因，还是需要补充只读字段？
- Host Plan 与 Machine 的写动作是否有统一的 pending/error 反馈，能否在共享 inspector 中复用？
