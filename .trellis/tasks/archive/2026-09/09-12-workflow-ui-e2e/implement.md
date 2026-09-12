# 执行计划

1. 阅读 browser/in-app-browser 技能和 Dashboard 启动方式，确认单浏览器 owner。
2. 创建临时项目与测试 workflow，启动 Dashboard server，记录端口、PID 和临时目录。
3. 真实打开页面，编辑 default workflow，执行拖拽/输入/保存，刷新并通过 API 对照。
4. 真实新建 workflow，配置至少两个 stage/skill 和依赖，保存、刷新、API 对照。
5. 分别运行 default 与新 workflow，记录运行结果、产物面板、错误和阻断。
6. 保存截图、日志、复现步骤，运行已有相关测试作为补充证据。
7. 只提交本任务的验收文档和证据索引；不提交临时项目、用户数据或产品代码改动。

## Required checks

- 浏览器真实点击和拖拽，不能以组件测试替代。
- 保存后重新加载和 API 定义一致。
- 两次真实运行均有成功/失败的明确终态或真实阻断证据。
- `git diff --check`，并核对工作区原有 dirty 文件未被改动。
