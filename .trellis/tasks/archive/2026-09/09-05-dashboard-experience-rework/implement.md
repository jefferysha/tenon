# Dashboard 体验重构实施计划

## 顺序

1. 子任务 IA：从导航配置和路由入口开始，收敛页面职责；再处理 Progress、Workbench、AFK、Projects、Machine、Host Plan 的重复能力和反馈。
2. 子任务 Visual：整理全局 CSS/token 与共用组件，再逐页替换布局和状态样式；最后处理画布、抽屉、对话框和移动断点。
3. 总任务整合：修复跨页状态同步、重复 key、测试夹具和文档中的导航/语义漂移，完成浏览器验收。

## 约束

- 修改前搜索现有 token、组件和路由用法，优先复用已有 primitive。
- 不修改 canonical API/CLI 状态契约；如需展示字段，沿现有 snapshot 类型流转。
- 每个子任务保持可回滚的提交边界，不覆盖无关 dirty files。
- 任何 Host Plan 写操作必须通过独立、可见的 mutation 流程并保留确认与结果反馈。

## 完成定义

两个子任务的验收均通过，整体验收覆盖跨页导航、响应式、可访问性、异步反馈和生产同源运行态；更新 Dashboard 使用文档中已变化的入口和作用域。
