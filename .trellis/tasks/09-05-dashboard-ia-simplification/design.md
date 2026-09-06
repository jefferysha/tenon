# 信息架构精简设计

## 核心路径

Projects（需要我处理） → Progress（任务队列） → Change 详情（下一动作/证据/日志）

项目名、Change 名和当前状态始终可见；workspace、repository、workflow DAG、AFK provenance 作为解释信息按需出现。

## 导航

主导航只保留 Projects、Progress、Workbench。Settings/Diagnostics 作为二级容器，收纳 AFK、Machine、Host Plan、Loop、Traffic、凭证与 Advanced；Overview 从主导航移入帮助/关于入口。保留深链兼容，旧路由进入对应二级容器。

## 页面职责

- Projects 负责选择项目与发现待处理 Change，不承载注销和机器治理。
- Progress 负责按状态排序任务及执行低风险下一动作。
- Workbench 负责编辑流程结构，不默认展示运行事实和机器设置。
- Host Plan 只展示检测、目标和命令计划；安装流程单独呈现 scope/confirm/result。

## 风险与迁移

导航测试、截图和使用文档中的六项入口需要同步更新；旧链接必须重定向或显示明确迁移提示。跨页状态刷新沿现有 snapshot/SSE，不引入第二套 canonical 状态。
