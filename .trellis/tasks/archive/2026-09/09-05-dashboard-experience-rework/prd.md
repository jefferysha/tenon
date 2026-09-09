# Dashboard 体验重构

## Goal

围绕 Tenon 本地 coding-agent 控制面的核心任务——“哪个项目需要我、卡在哪里、下一步做什么”——同步收敛 Dashboard 的功能信息架构，并建立可复用的视觉与交互系统。普通 Change 应在项目 → 进度 → 详情的短路径内完成，低频诊断和治理能力按需出现。

## Scope

本总任务协调两个可独立验收的子任务：

1. **功能与信息架构精简**：收敛一级导航和页面职责，移除重复入口，把低频能力下沉到设置/诊断，并修复关键交互反馈。
2. **视觉系统与组件提升**：在收敛后的信息架构上统一 token、布局密度、颜色语义、组件状态和响应式交互，覆盖选择框、卡片、按钮、画布、抽屉/对话框、空态/错误/加载态。

实现顺序为先完成信息架构基线，再在其上应用视觉系统；两项共享的组件文件需要在同一分支上连续实现并做整体验收。

## Out of Scope

- 不改变 CLI canonical 状态模型、API schema 或权限边界。
- 不把 Dashboard 变成公共文档站，不增加公网访问能力。
- 不在本任务中新增与核心 Change 路径无关的业务功能。
- 不直接清理或覆盖工作区中与本任务无关的既有修改。

## Cross-task Acceptance

- 一级日常入口不超过 Projects、Progress、Workbench 三项；AFK、Machine、Host Plan、Advanced 等有明确二级归属。
- Host Plan 保持纯只读，任何安装写操作都从计划预览中移出并有独立确认边界。
- Progress 首屏以紧凑任务列表呈现当前状态和下一动作，不依赖横向画布滚动。
- Workbench 首屏只承担流程结构编辑，高级策略、治理、运行摘要按需展开。
- 视觉 token 可表达背景、表面、边框、文本、状态色、焦点和禁用态，并被核心组件复用。
- 选择框、按钮、卡片、画布、抽屉/对话框在 hover/focus/active/disabled/loading/error/empty 状态下有一致反馈。
- 375px、768px、1440px 下核心动作可见、可键盘聚焦、无水平溢出；中文/英文切换不破坏布局。
- 运行态无重复 React key、资源 404 或未解释的控制台错误；异步写操作后 UI 与 snapshot/SSE 一致。

## Evidence Baseline

- 既有完整评审：.trellis/tasks/archive/2026-09/09-05-dashboard-comprehensive-review/review.md
- 产品定位与 Dashboard 边界：docs/usage/zh-CN/dashboard-and-local-api.md、product/identity.json
- UX 方向：docs/ux/2026-07-19-full-product-journey-and-orchestration-design.md
- 配置体验分析：docs/ux/2026-07-11-config-experience-analysis.md
