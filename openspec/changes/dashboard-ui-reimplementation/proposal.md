# 提案

## Why

当前 Dashboard 的功能是完整的，但用户必须在 Projects、Progress、AFK、Workbench、Machine 和 Host Plan 之间拼接上下文。项目、Change、workflow、track、当前 phase、自动化状态和治理阻断没有一个稳定的阅读顺序；首次使用时也难以判断“现在发生了什么”和“下一步要做什么”。这直接放大了 Tenon 插件能力的学习成本：workflow/track 决定编排，Skill/Hook 决定执行，AFK 决定无人值守，Machine/Host Plan 决定运行准备度，但界面没有把这些能力组织成同一条任务路径。

本 Change 重新梳理 UI 信息架构和排版，基于现有 API 与插件能力重做操作入口。它从当前分支的真实实现重新开始，不沿用已取消的三套概念方案，也不把视觉原型当作生产代码。

## What Changes

- 建立稳定的“任务指挥台”上下文：项目、Change、workflow、track、phase、连接状态和下一动作在页面顶部以固定顺序呈现。
- 以 Progress 作为默认工作入口，先呈现需要处理的决策、正在运行的任务和当前阶段；证据、历史、原始日志通过抽屉渐进展开。
- 将 AFK、Workbench、Machine、Host Plan 统一成同一套页面外壳和状态字典，明确标出只读事实、可写配置、派生状态和需要用户确认的动作。
- 重新排版 Workbench：阶段脊显示结构，右侧 inspector（窄屏下移到内容后）承载 Track、Pipeline、Skill、Hook、Loop 和治理编辑，保留现有写端点、脏态和 CAS 语义。
- 重做 Skill 编排的可读性：保留图形视图，同时提供键盘可遍历的有向依赖列表、状态文字和失败原因；图形不再承担唯一信息载体。
- 统一 loading、error、empty、offline、权限拒绝和 reduced-motion 反馈，覆盖桌面 1440/1024 与窄屏 720/390 宽度，禁止文档级横向溢出。

非目标：不修改 kernel 状态机和 transition 语义，不新增 UI 库或全局状态库，不改变插件安装、Hook 阻断、AFK 执行和 Host 鉴权边界，不加入手机专用控制流程。

## Capabilities

### New Capabilities

- `task-command-context`：跨 Projects、Progress、AFK 的当前上下文和下一动作投影。

### Modified Capabilities

- `dashboard-ui-ux-system`：统一页面层级、状态语义、渐进披露、响应式和可访问性。
- `skill-dependency-editor`：将 Skill 依赖图与可读列表、键盘操作和错误状态统一呈现。

## Impact

主要影响 `packages/dashboard-app/src/App.tsx`、`src/shell`、`src/progress`、`src/afk`、`src/workbench`、`src/machine`、`src/hostPlan`、`src/shared` 和 `src/index.css`。数据仍通过既有 `src/api` 客户端与 snapshot/SSE 边界获取；不会让组件直接复制服务端协议或修改 canonical 文件。需要同步受影响组件测试、i18n 资源和真实浏览器 smoke 证据。后端、CLI、插件 manifest 和数据库不在本 Change 的实现范围内，除非验证发现现有客户端契约不足且能以向后兼容方式补齐。
