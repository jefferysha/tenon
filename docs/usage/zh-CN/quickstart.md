# 第一个受治理任务

开始本教程前，先一次安装不可变的 Codex 预构建发布包：

```bash
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.1.7/install.sh | /bin/bash -s -- --codex
```

该命令不 clone 仓库，也不从源码编译；它会安装打包好的 `v0.1.7`、启动并验证 Dashboard，
然后打印本机 URL 和 `tenon dashboard --open`。管道安装不会自动打开浏览器。安装完成后，
日常更新只需一条 `tenon update --codex`，并始终绑定稳定 release tag。

本教程用 default workflow 完成一次端到端 Change，并展示 Todo、OpenSpec、Skill、review 和验证如何串联。

## 目标

从一次正常对话创建独立 Change，依次经过 Open、Explore、Spec、Build、Verify、Ship 和 Archive，并能用状态、文档账本和实际测试证明每次推进都成立。

## 前置条件

- 已按[安装与宿主配置](./installation.md)完成对应宿主 setup；
- 当前目录是可写项目，且没有把另一个项目的 Dashboard 误当成当前服务；
- 你知道要实现的可观察结果，但不需要预先写好 OpenSpec；
- 对真实发布、push 或外部部署是否授权仍以当前任务要求为准。

## 步骤

### 1. 从正常对话提出目标

直接描述要实现的结果，例如：

> 为登录页增加响应式错误提示，并在真实浏览器验证键盘操作。

正常开发对话会先经过路由。中大型实现进入 default；明显简单、低风险的任务可以进入 simple；纯问答不会创建 Change。

### 2. 确认 Change

```bash
tenon list --json
tenon status <change> --json
```

`tasks.md` 的一级结构来自真实 workflow。default 展示七阶段；custom 只展示自己的 DAG，不会被硬套 PM、前端或后端步骤。

### 3. 完成三个前置阶段

- Open：明确问题、范围、非目标和验收信号；
- Explore：调研、方案比较、设计和 ADR；
- Spec：增量需求、场景和文件级计划。

后续 phase 会通过 `tenon document read <change> all` 对当前 digest 留下读取收据，不能只说“已经看过”。

在每个 review 出口，先完成产物和检查，再请求精确事件的 review。进入 Explore 本身不代表“等待确认”；只有产物完成并执行 `review request` 后，状态才应显示等待。

### 4. Build 与 Verify

Build 按计划测试先行，实现后先跑类型、测试和构建。`build-complete` 冻结 `build_sha`；Verify 只验收这个基线。发现实现缺陷走 `verify-fail` 返回 Build，发现需求变化走 `requirements-changed` 返回 Spec。

Verify 期间不要修改实现文件。若审查发现缺陷，先写失败报告并走回边；回到 Build 修复后必须重新冻结新基线，不能沿用旧报告。

### 5. Review 与交付

review phase 的正确顺序：

```bash
tenon check <change>
tenon review request <change> --event <event>
tenon review acknowledge <change>
tenon transition <change> <event>
```

持续授权可以记录 delegated acknowledgement，但不会跳过文档、读取、guard 或验证。

### 6. 检查最终状态

```bash
tenon status <change> --json
tenon document status <change>
```

归档前，任务清单应没有当前及更早阶段的未完成项；applied spec 应对应已经验证的 delta；Archive 应重读验证报告和已应用规格。

## 预期结果

- Todo 一级项与实际 workflow 步骤一致；
- proposal、design、ADR、delta spec、plan、verification report 和 applied spec 都有真实 producer；
- 后续阶段对当前 digest 留有 read receipt；
- review receipt 绑定准确 phase/event；
- Verify 失败会回到 Build，而不是强行进入 Ship；
- Archive 后 Change 不再作为新目标的自动恢复对象。

## 验证

```bash
tenon list --json
tenon status <change> --json
tenon document status <change> --json
```

对含 UI 的任务还要打开真实页面，检查桌面、窄屏、键盘、主题和控制台。对安装/更新任务要在干净临时目录验证，不用当前开发工作区冒充新用户环境。

## 常见失败

- 正常对话恢复了旧 Change：确认用户是否明确说“继续”；独立目标应创建新 Change；
- Todo 不是 workflow 步骤：检查 `tasks.md` 是否由真实 effective workflow 生成；
- 文档存在但 guard 仍失败：检查 producer、digest 和当前 phase read receipt；
- UI 显示等待：查看是否真的存在 pending review，还是 AFK 仍在 queued；
- Verify 报 workspace drift：回到 Build 重新冻结，不删除证据文件绕过；
- Pages 或 push 未成功：如实保留为未验证项，不能仅因本地构建通过就声称上线。

## 下一步

深入阅读[Default 七阶段工作流](./default-workflow.md)和[文档、Skill 与证据链](./documents-skills-and-evidence.md)。
