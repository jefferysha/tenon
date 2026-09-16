# Dashboard 与本地 API

Dashboard 是本地控制面，不是公共文档托管服务。它显示项目、Change、阶段、Todo、review、AFK、loop 和证据，但不会取代 CLI 的 canonical 状态操作。

<img src="../../../docs-site/public/images/dashboard-overview.webp" alt="Tenon Dashboard 项目总览" width="1280" height="720">

项目页先汇总真正需要协助的工作，再进入具体 Workflow。正式截图使用脱敏演示项目，不包含用户目录、凭据或真实业务数据。

## 启动

```bash
tenon dashboard --open
```

默认只绑定 loopback。打开页面后先核对 Tenon 标题、项目 root 和 Change 名，避免把其他端口上的应用误当成当前 Dashboard。

## 状态为何显示“等待”

“等待”可能代表：

- phase 工作尚未开始；
- review request 已创建，等待确认；
- AFK 任务排队；
- automation 缺少运行时或凭证；
- canonical session 已结束；
- UI 只收到了旧 snapshot。

先运行：

```bash
tenon status <change> --json
tenon inbox --json
tenon doctor --json
```

不要通过删除 marker 或手改 `.pipeline.yaml` 把等待改成运行中。

## 单端口模型

生产 runtime 在同一端口提供 SPA、只读 snapshot、SSE 和受控 mutation API。公共 VitePress 站点不包含这些端点，也不发布用户项目状态。

## Overview

Overview 是 Dashboard 内的只读产品说明，路由为 `?view=overview`。它和正式文档站互补：Overview 帮本地操作者快速定位，正式站提供完整教程、搜索和公共深链。

## 语言

Dashboard `zh/en` 存在浏览器 `localStorage`，只控制 UI。治理文档 locale 在 Change 创建时固定，二者不会隐式联动。

## 安全

不要把 Dashboard 绑定到公网地址。token、prompt、trace、绝对路径和本地 API 响应都可能包含敏感信息。

## 生产端口

安装后的默认 Dashboard 端口是 `18765`。旧测试端口 `19765` 或其他 Vite 端口不是当前生产默认。指定其他端口时仍应只绑定 loopback。

生产 runtime 在一个端口同时提供 SPA、snapshot、SSE 和受控 mutation API。Vite 开发端口只是热更新工具，不是安装契约。

## 状态语义

| 显示 | canonical 事实 | 操作 |
| --- | --- | --- |
| 未开始 | phase 尚未进入 | 等待前序完成 |
| 运行中 | 当前 phase 有活跃工作 | 查看日志与 Todo |
| 等待确认 | exact review pending | 审阅后确认 |
| 已停止 | session 结束或失败 | 查看原因并恢复 |

如果 CLI 显示 `in_progress` 而页面仍显示等待，先刷新 snapshot/SSE，再确认浏览器打开的是当前 Dashboard，而不是旧 preview。

<img src="../../../docs-site/public/images/dashboard-progress.webp" alt="Tenon Dashboard 流程进度" width="1280" height="720" loading="lazy">

进度页沿真实 Workflow 展示阶段与 Change。`running` 是显示状态，执行来源则独立标记为终端或自动化，避免同一个任务在不同页面出现互相矛盾的身份。

## 操作视图

日常主导航保留三项高频入口：

```text
progress → workbench → skills
```

- `progress`：按状态查看任务，打开详情执行下一动作；
- `workbench`：编辑 Workflow 与阶段结构；
- `skills`：只读查看每个技能的来源、提交、许可证、更新时间与状态。

AFK、Machine、Host Plan 等低频能力从设置面板进入，仍保留原有深链。`hostPlan` 只展示检测结果和零副作用命令计划，不触发安装写操作；需要安装时从明确的项目级安装流程进入。`overview` 独立于操作视图，避免把产品介绍混进日常控制面导航。

### 设置

<img src="../../../docs-site/public/images/dashboard-workflow-editor.webp" alt="Tenon Dashboard 设置" width="1280" height="720" loading="lazy">

设置菜单提供主题与语言切换，不改变 canonical Workflow 状态。AFK、机器诊断和宿主计划继续通过 CLI 与本地 API 使用。

### Workflow 工作台

<img src="../../../docs-site/public/images/dashboard-workbench.webp" alt="Tenon Dashboard Workflow 工作台" width="1280" height="720" loading="lazy">

工作台把 Track、七阶段 DAG、阶段 Skill、Hook 与运行前事实放在同一页面。Default 只读基线、自定义 Workflow 和每个 Workflow 的 Free Track 都从同一份有效计划投影。

### 技能

技能页（`?view=skills`）只读列出 Tenon 自有技能与 `skills/sources.yaml` 声明的上游技能：来源仓库与目录、已安装提交（变化时给出上一提交的对比链接）、许可证、更新时间与状态。数据来自 `GET /api/skills/sources`，即 setup/update 写入的 `skills/skills.lock.json` 与最近一次获取结果，页面本身不联网、不触发安装。

## 本地 API 边界

mutation 端点必须经过 CLI 相同的 schema、CAS、review 和 guard。前端不能直接编辑 canonical JSON 或 `.pipeline.yaml`。

`GET /api/host-targets` 与
`GET /api/host-target-plan?host=codex&operation=setup` 是严格只读端点，只接受
Tenon 已注册宿主以及 `setup`/`update` 操作，返回
`host-target-plan/v1`，不会执行预览命令。原生宿主计划面向用户级安装；适配器宿主计划使用
当前项目目录（`--target .`），不会输出可被 shell 误解的占位符。

生产 server 会为可压缩的生成资源协商 gzip，并返回 `Vary: Accept-Encoding`；明确拒绝 gzip
的客户端仍获得原始字节，API JSON 继续使用 `no-store`。

```bash
lsof -nP -iTCP:18765 -sTCP:LISTEN
curl -fsS -o /dev/null http://127.0.0.1:18765/
```

页面标题、项目 root 和 Change 必须与目标一致；端口可访问不等于页面就是当前插件。

## 页面验收

- 桌面与移动布局无溢出；
- 中文和英文切换可用；
- 键盘焦点、跳转链接和按钮名称可辨识；
- Todo 与真实 workflow 步骤一致；
- 等待、运行中、确认中与 CLI 一致；
- 控制台无资源 404 或运行时错误。

公共分享请使用静态文档站，不要给 Dashboard 建公网隧道或反向代理。
