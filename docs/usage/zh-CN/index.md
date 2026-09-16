# Tenon 文档

Tenon 是面向 Codex、Claude Code 等 Agent 宿主的本地优先交付工作流插件。它把正常对话里的开发请求路由到合适的执行模式，并用状态机、OpenSpec、Skill 证据、文档摘要和 review receipt 约束“做了什么、为什么能推进、后续读了哪一版”。

## 从这里开始

- 第一次使用：先读[安装与宿主配置](./installation.md)，再完成[第一个受治理任务](./quickstart.md)。
- 不确定该走哪种流程：读[选择执行模式](./routing-and-workflows.md)。
- 任务一直显示等待：读[Dashboard 与本地 API](./dashboard-and-local-api.md)和[故障排查](./troubleshooting.md)。
- 需要团队定制：读[自定义 Workflow 与 Track](./custom-workflows-and-tracks.md)。
- 需要理解证据门：读[文档、Skill 与证据链](./documents-skills-and-evidence.md)。

## 四种常用结果

| 入口 | 适用目标 | 是否创建 Change | 文档行为 |
| --- | --- | --- | --- |
| discussion | 问答、解释、只读分析 | 否 | 不创建治理文档 |
| simple | 少量、低风险、可快速验证的修改 | 是 | 只遵守 short workflow 自己的合同 |
| default | 跨模块、需要规格与验证的开发 | 是 | 完整七阶段与 OpenSpec 证据链 |
| free/custom | 中性任务或团队自定义 DAG | 取决于 workflow | 只生成声明的文档 |

## 默认生命周期

```text
open → explore → spec ⇄ build ⇄ verify → ship → archive
```

`explore`、`spec`、`verify` 的出口需要精确 review receipt。Build 发现需求变化时走 `requirements-changed` 回到 Spec；Verify 不通过时走 `verify-fail` 回到 Build。Pipeline 不允许通过手改状态文件跳过这些边界。

## 你会在仓库中看到什么

- `.pipeline/workflows/`：项目自定义 Workflow 的版本化定义；
- `openspec/changes/<name>/`：活跃 Change 的 proposal、design、tasks、delta spec 与状态投影；
- `openspec/specs/`：已经应用、持续维护的主规格；
- `docs/adr/` 与 `docs/superpowers/`：架构决策、技术设计、计划和验证报告；
- `.pipeline-document-locale.json`：新 Change 固定的文档呈现语言；
- `.pipeline-documents.json`：文档 producer、digest 和读取收据账本。

状态机决定“能否推进”，OpenSpec 描述“系统必须做什么”，计划描述“如何实现”，验证报告描述“实际验了什么”。任何一份文件都不能单独冒充流程完成。

## 文档如何保证可信

每份受治理文档记录 kind、路径、producer、SHA-256 和后续 phase 的读取收据。模板只提供结构；真实 Skill 必须填写有意义正文并登记。中文是新 Change 的默认呈现语言，但 phase id、命令、文件名、账本字段和 OpenSpec 操作词保持稳定英文 token。

## 运行边界

Dashboard 和 API 默认只绑定 loopback。公共文档站是纯静态产物，不包含本地 Change、token、SSE、写 API 或工作区路径。

安装后的本地控制面默认使用 `18765`；文档站使用 GitHub Pages 项目路径，两者不共享用户数据或运行时状态。

## 按角色阅读

- 第一次安装插件：从[安装与宿主配置](./installation.md)开始；
- 开发者执行需求：阅读[第一个受治理任务](./quickstart.md)；
- 技术负责人定制团队流程：阅读[自定义 Workflow 与 Track](./custom-workflows-and-tracks.md)；
- 运维人员处理更新或故障：阅读[更新、恢复与卸载](./updates-recovery-and-uninstall.md)和[故障排查](./troubleshooting.md)；
- 贡献者修改插件：阅读[贡献者开发指南](./contributor-development.md)。

## 三条不可绕过的原则

1. 新目标不会仅因存在旧的 `active-change` 指针就恢复旧 Change；
2. review receipt 必须绑定准确 phase 和 event，删除 marker 不等于确认；
3. 未运行的测试、未打开的页面和未成功的部署不得写成通过。

## 下一步

完成[第一个受治理任务](./quickstart.md)，或直接查阅[CLI 参考](./cli-reference.md)。
