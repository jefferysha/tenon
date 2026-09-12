# E2E 验证设计

使用项目已有 Dashboard server 和一个复用的浏览器 owner。测试项目创建在临时目录，注册到 server 后通过真实 HTTP 页面访问。浏览器负责 UI 交互；终端负责启动服务、读取日志、运行真实 workflow 命令和清理临时项目。

验证分三层：

1. 页面层：工作流导航、stage 编辑器、拖拽画布、保存反馈和刷新后的定义。
2. 接口层：读取保存后的 workflow YAML/definition catalog，核对 stage 顺序、依赖和 skill 配置。
3. 运行层：执行两个 workflow 的真实 runner，记录 orchestration 状态、阶段状态和 artifact catalog。

浏览器证据保存到 `.trellis/tasks/09-12-workflow-ui-e2e/evidence/`，包括截图、页面文本、网络响应摘要和终端日志。失败时保留临时项目目录路径，不通过修改产品代码绕过失败。
