# Dashboard 功能与信息架构精简

## Goal

降低 Dashboard 的功能噪声，让操作者用最短路径定位需要处理的 Change 并执行下一步。

## Scope

- 一级导航收敛为 Projects、Progress、Workbench；AFK 作为 Progress 上下文，Machine/Host Plan/Advanced 等进入 Settings/Diagnostics，Overview 进入帮助/关于。
- Projects 平铺可操作项目，默认保留搜索与“需要我处理”；异常不可达、注销和治理清理移出主路径，统一计数口径并补空态 CTA。
- Progress 改为需处理/运行中/等待中紧凑任务列表；详情首屏显示状态、阻断原因和下一动作，深层 tab 按需加载；修复重复 key、筛选残留、写后刷新。
- Workbench 首屏仅保留 Workflow/阶段编辑；策略、运行摘要、治理、机器和凭证能力折叠或迁移。
- Host Plan 移除 AdapterInstallWizard 写操作，计划页纯只读；安装走独立项目级流程并显示目标与影响范围。
- AFK 去除重复创建入口和重复阶段轨，处理无结果选择、移动端轨道和异步失败反馈。
- Machine 按当前项目阻断聚合 readiness，跨项目风险只给计数和具体跳转。

## Acceptance Criteria

- 普通 Change 可在 Projects → Progress → 详情三步内找到下一动作。
- 一级导航最多三项日常工作入口，低频页面有可发现的二级入口。
- Host Plan 页面不会触发安装 mutation；安装流程有单独确认和成功/失败反馈。
- Progress 首屏无需横向滚动即可看到任务标题、状态和下一动作。
- Workbench 默认不展开高级策略、机器、凭证和运行时全局摘要。
- 搜索无结果、空项目、写后刷新、失败重试、未保存保护均有明确状态。
- 更新对应路由、导航、交互测试与中文 Dashboard 文档。

## Non-goals

不改 CLI/API canonical 状态，不删除仍被安全边界依赖的诊断能力，只改变入口层级和默认呈现。
