# 信息架构精简实施

1. 盘点导航配置、路由和页面共享容器，先改入口层级与深链兼容。
2. 以 Projects/Progress 为主路径重排首屏信息和动作，移除重复入口并修复状态选择/刷新。
3. 收敛 Workbench 默认内容，迁移 AFK/Machine/Host Plan 的低频入口和安装写操作。
4. 同步更新测试、文档和 aria 文案；运行 focused tests 后做整体验收。

每一步保留现有 API 类型和 mutation guard，修改前搜索所有入口引用。
