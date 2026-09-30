# Tenon v0.2.0 真实宿主验收：Claude Code

日期：2026-09-30
宿主：Claude Code（本机已安装的 `tenon@tenon` 0.2.0 插件）
范围：R1（Claude Code 一遍）、R2（两个身份协作）、R7（`tenon` 在 PATH 上）、R8（`tenon-<name>` 子代理由宿主真实加载）。Codex 那一遍不在本记录内，另记为 `docs/acceptance/2026-10-v0.2-codex.md`。

本记录只记录做了什么、看到了什么。验收过程中没有修改任何产品代码，问题不在这里修，只在文末「问题清单」里登记。

## 1. 环境

| 项 | 值 |
| --- | --- |
| 机器 | macOS 24.6.0 arm64，机器画像 `darwin-arm64-m4max-node24` |
| Claude Code | 2.1.285（`claude -p ... --output-format json --permission-mode bypassPermissions`，只在一次性演示项目里用 bypass） |
| Tenon 插件 | `tenon@tenon` 0.2.0，commit `9175f9131d72`，`tenon doctor` 中 `identity:release` 为 PASS |
| 受管 runtime | release `sha256-c0d6136641dc...`，`tenon runtime status` valid=yes |
| Dashboard | 已安装版本 `http://127.0.0.1:18765`，`/api/health` 版本 0.2.0；写请求用页面 HTML 内嵌的 `window.__TENON_DASHBOARD_TOKEN__`，以 `X-Pipeline-Token` / `Authorization: Bearer` 头发送 |
| Node | v24.18.0；项目依赖 vitest 3.2.7、`@playwright/test` 1.61.1（chromium 已在本机缓存，webkit 由 build 步的 builder 子代理在本机下载安装，见「遗留状态」） |
| 演示项目 | `~/tenon-accept-v02/shop-cc`：一个购物车模块（`src/cart.js`）+ vitest 单测 + 静态页面（`public/index.html`）+ 极简开发服务器（`scripts/dev-server.mjs`，端口 4173）+ 一个 Playwright 用例；git 仓库，无远端 |
| 工作流存储 | 演示项目使用项目级工作流库 `shop-cc/.pipeline/workflows/`（`PUT /api/workflows/<name>/yaml?root=<项目>`），没有改动全局 `<config>/workflows` |
| 证据根目录 | `/private/tmp/claude-501/-Users-a1234-Documents-code-manager-projects-tenon-local/68ba5289-0858-4d27-9c74-6add28cc9b4d/scratchpad/acceptance-cc/`，下文记作 `$EV` |
| 时间 | 2026-09-30 17:03–21:52（CST）。18:48 到 21:01 之间编排进程重启，期间没有会话在跑；会话累计执行 8113 秒（约 135 分钟） |

会话通过 `$EV/cc.sh` 无头驱动：每一轮 `claude -p "<用户回复>" --output-format json --permission-mode bypassPermissions`，继续同一会话用 `--resume <session_id>`；启动前清掉继承的 `CLAUDE*`、`TENON*` 环境变量；评审门一律回复「确认继续」（或等价的放行语），没有删除 marker、没有绕过门。全部 JSON 与会话 jsonl 存在 `$EV/transcripts/`。

## 2. 场景与步骤

### 步骤 1：项目、注册与客户端

| # | 命令 / 动作 | 结果 |
| --- | --- | --- |
| 1.1 | 建 `~/tenon-accept-v02/shop-cc`（npm、vitest、Playwright、静态页、开发服务器），`npx vitest run` 3/3 通过、`npx playwright test` 1/1 通过，`git init` 并提交 | 通过 |
| 1.2 | `POST /api/projects {"root": ...}` 注册 | 200 `{"ok":true,"root":...}` |
| 1.3 | `POST /api/projects/clients {"root","enabled":["claude","codex"]}`，`GET` 回读 | 200，`source: "file"`，写出 `.tenon/clients.json`（`tenon-clients/v1`） |

### 步骤 2：终端里生成、注册自定义评审者并挂到工作流

| # | 命令 / 动作 | 结果 |
| --- | --- | --- |
| 2.1 | 新会话对 Claude Code 说：用 `tenon:agent-author` 起草并注册评审者 `cart-pricing-review`（折扣计算与舍入），用户级 | 会话 `0ba98372...`，11 个回合，84 秒，0.42 美元。技能被触发，会话跑了 `tenon agent list --source official`、`agent show security`、`agent add --help`，把草稿写到 `/tmp/tenon-agent-cart-pricing-review.md`，`tenon agent add` 登记，自己用 `node -e` 验证了草稿里举的 `Math.round(-2.5)`、`(1.005).toFixed(2)` |
| 2.2 | `tenon agent list --json` | `cart-pricing-review`：`source: custom`、`role: reviewer`、`version: 0.1.0`、`tools: [Read, Grep, Glob, Bash]`、`shadowed_by: null`、`error: null`（`$EV/step2-agent-verify.txt`） |
| 2.3 | `tenon agent validate cart-pricing-review` | `PASS cart-pricing-review（自定义）`，退出码 0 |
| 2.4 | `GET /api/agents?root=<项目>` | 10 个 agent，`cart-pricing-review` 为 `custom / reviewer / 0.1.0`（`$EV/step2-dashboard-agents-api.txt`） |
| 2.5 | `PUT /api/workflows/default/yaml?root=<项目>`：在 `frontend` 轨道 `verify` 步的 `agents.reviewers` 末尾加 `cart-pricing-review`（`required: true, block_at: medium`），其余原样（只插入 3 行） | 200 `{"ok":true,"name":"default"}`；`GET /api/workflows/default/orchestration?track=frontend&root=` 中 verify 步出现 `reviewer cart-pricing-review`（wave 6） |
| 2.6 | `tenon agent rm cart-pricing-review`（cwd 在演示项目） | 拒绝，退出码 2，列出 `default / frontend / 验证 · 评审者` |
| 2.7 | `DELETE /api/agents/cart-pricing-review?root=<项目>`（探针） | 200 `{"ok":true}`，agent 被删掉，问题 F1；已用备份 `tenon agent add` 原样恢复，digest 不变（`$EV/step2-dashboard-agent-delete-probe.txt`） |

### 步骤 3：真实任务，从路由到归档

任务文本：`/tenon 新任务：购物车满 100 减 10 的折扣，含单测与一个 Playwright 用例`。路由选了 `frontend` 轨道。

**3.0 立项被前置条件挡住。** `tenon init cart-threshold-discount --workflow default --track frontend --preset full` 退出码 1：`工作流 default 轨道 frontend 要求项目 DESIGN.md 就绪（当前：缺失）；先完成设计体系任务：tenon init <name> --workflow design-system --track free --preset <preset>`。工作区未被改动，会话停下问选哪条路。按推荐先建 `design-system` 任务：

| 回合 | 时间 | 内容 |
| --- | --- | --- |
| t02 | 147 秒 | 建 `shop-design-system`（free 轨道），`hue` 技能问设计方向和令牌，停下等回答 |
| t03 | 51 秒 | 回答「都按推荐」，写 `design/direction.md`，`tenon review request --event direction-complete` |
| t04 | 1129 秒 | 「确认继续」；生成 `design/design-model.yaml`、`DESIGN.md`、4 个预览页，会话自己用 Playwright 截图检查；`tenon design check` 就绪、`tenon design validate` 0 错误 0 警告；停在「预览」评审门。会话用 `open` 在默认浏览器里打开了 4 个预览页 |
| t05 | 201 秒 | 「确认继续」，`transition archived`，`openspec archive`，只提交 `openspec/changes/archive` 和几个 `.gitignore`；随即建折扣任务，`.claude/agents/tenon-*.md` 生成 |

折扣任务 `cart-threshold-discount`（default / frontend / full）之后的每一步：

| 阶段 | 回合与时长 | `tenon status --json` 的 `step.next` 观察到的动作 | 备注 |
| --- | --- | --- | --- |
| open 立项 | t06，97 秒 | `load-skill openspec-propose` → `scaffold-document`（proposal、openspec-design、tasks）→ `record-document` ×3 → 出口 `tasks-incomplete` → `transition open-complete` | 会话先问了一个业务选择（Playwright 怎么让小计到 100：改示例数据还是加交互），答「A」 |
| explore 调研 | t07 289 秒、t08 141 秒、t09 115 秒、t10 182 秒 | `run-agent researcher`（`status: running`，带 `run_id`、`report_path`）→ `load-skill` openspec-explore / brainstorming / grilling / domain-modeling → `record-document` superpower-design、adr → `request-review` → `await-review explore-complete` | 研究执行者被门挡住，见 F4；设计确认答「可以」、grilling 4 个问题答「按推荐」；评审门用「确认继续」 |
| spec 规格 | t11 432 秒、t12 81 秒 | `fix test-unconfigured`（`typecheck` 脚本不存在）→ `test-discover` → `test-plan-seed` → `load-skill` openspec-propose / writing-plans → `record-document` delta-spec、superpower-plan、plan → `await-review spec-complete` | `tenon test discover --write` 生成 `.tenon/tests/catalog.yaml`（unit / e2e / typecheck 三个套件）；`tenon test plan --seed` 生成计划；`tenon test waive --kind regression` 产生待批准豁免，`review request` 单独列出，「确认继续」之后计划里 `approved_by` 写成评审人（`$EV/snaps/s3-d-spec-2/`） |
| build 实现 | t13 1829 秒、t14 745 秒 | `set-field build_mode`（推荐 `subagent-driven-development`）、`set-field isolation`（推荐 `in-place`）→ `run-agent builder` → `load-skill` test-driven-development / frontend-design → `run-tests`（`tenon test run <c> --stage`，先报 `test-not-run`，后来报 `test-stale`） | 3 个 builder 子代理（`tenon-builder`）按计划的 Task 1、2、3 顺序做，`tenon test catalog set` 补覆盖率与 webkit，23 条场景与任务映射由会话主动 `tenon test register --case ...` 完成 |
| verify 验证（第 1 轮） | t14 末段、t15 120 秒、t16 978 秒 | `load-skill` browser-qa 等 → `run-agent` ×6 评审者 → `fix`（`reviewer-failed`、`tasks-incomplete`）→ 出口 `verify-fail` ready | `cart-pricing-review` 报 1 条 medium：`addItem` 缺安全整数校验（单价 1e15、数量 1e10 时小计 1e25 被静默算错），阻断 `verify-pass`。`verify-fail` 是回退边，需要自己的 `review request --event verify-fail` 和一次新的「确认继续」 |
| verify（第 2 轮） | t16 后段、t17 439 秒 | 回 build → 修复 → 再 verify → `spec-consistency`、`frontend-quality` 各报 medium（文档没写新规则、会话自己写的设计提案措辞不完整）→ `requirements-changed` 回 spec → spec 评审门 | `cart-pricing-review` 这一轮 pass |
| spec（第 2 次）与 verify（第 3 轮） | t18 610 秒 | spec 评审门「确认继续」→ build 再走一遍 → verify → `await-review verify-pass` | 6 个必需评审者均无 medium 及以上，`architecture`（非必需，`block_at: high`）1 条 medium 不阻断 |
| ship 交付 | t19 366 秒（含 archive） | `load-skill finishing-a-development-branch`、`run-test design-system`、`apply-spec`、`commit`（×3）、`complete` | 4 个提交：`9878b24` deliver、`6f5954e` 主规格、`4c8042b` 按提案修订 `DESIGN.md`、`9a631dc` archive；`pr_url` 记为 `no-remote` |
| archive 归档 | t19 | `finish-change`（`openspec archive --skip-specs`）→ `stop code: finished` | `tenon list` 显示「无活跃 change」，归档目录 `openspec/changes/archive/2026-09-30-cart-threshold-discount/` |

最初的 `/tenon` 之后，用户共回复 18 次：评审门确认 8 次（设计方向、设计预览、explore、spec ×2、verify-fail ×2、verify-pass），业务或技术选择回答 9 次，普通「继续」1 次。会话累计成本 77.87 美元（最后一轮 JSON 的 `total_cost_usd`，含设计体系任务）。

**3.1 测试体系流水线（`tenon status` 的 `step.next` 与实际命令）**

- `test-discover`（`tenon test discover --write`）、`test-plan-seed`（`tenon test plan <c> --seed`）、`run-tests`（`tenon test run <c> --stage`）、`test-report` 在会话中按 `step.next` 依次出现，全部被执行。
- `test-plan-map`、`test-register-files` 两个动作没有在会话里出现：会话在 `next` 点名之前就主动登记了 23 条场景映射和两个测试文件，所以「未登记测试文件会挡」没有在 Claude Code 这条任务里被触发。改在步骤 5 用 CLI 单独验证（见 5.3）。
- 计划里的 `regression` 豁免在 spec 评审门批准后，verify 阶段的 `testPolicy` 显示 `waivers: [{kind: regression, approved: true}]`。
- 第一次 `--stage` 是 build 阶段，只跑 unit 和 typecheck（策略 `run: [unit, typecheck]`）；verify 阶段跑 unit 和 e2e（chromium、webkit）。最终记录 `20260930T133121Z-5b0821`：unit 23/23，行覆盖率 100%；e2e 4/4（2 个用例 × 2 个浏览器）；typecheck 通过。

**3.2 宿主原生子代理（R8）**

- `tenon init` 时生成 9 个文件：`.claude/agents/tenon-{architecture,builder,cart-pricing-review,code-size,e2e,frontend-quality,researcher,security,spec-consistency}.md`，同时写出 `.pipeline-owned.json`（列出各文件内容哈希）。`tenon-cart-pricing-review.md` 的 frontmatter 是 `tools: Read, Grep, Glob, Bash`、`model: sonnet`，正文与自定义 agent 一致。
- `tenon agent prompt <c> <agent> --host claude --json` 返回 `subagent_type: tenon-<name>`、`native: true`；Agent 工具用该类型派发。宿主会话目录 `.../subagents/*.meta.json` 里的 `agentType` 统计：`tenon-builder` 8、`tenon-frontend-quality` 4、`tenon-security` 3、`tenon-code-size` 3、`tenon-spec-consistency` 3、`tenon-cart-pricing-review` 3、`tenon-e2e` 3、`tenon-researcher` 1、`tenon-architecture` 1，另有 1 个 `general-purpose`（主线自己做的验证前就绪审查，不是 Tenon agent）。
- `.pipeline-agent-runs.jsonl` 里每条已完成的运行都记 `subagent: {host: claude, type: tenon-<name>, native: true}`，没有一次回退到通用子代理。
- 归档后 `git status` 干净，`.pipeline-owned.json` 已不存在，`.claude/agents/` 目录已删除，但留下一个空的 `.claude/` 目录（F14）。
- Dashboard `GET /api/agents/cart-pricing-review?root=` 的 `runs` 列出 3 次运行（fail、pass、pass），每次带 `subagent.type: tenon-cart-pricing-review`。

**3.3 Playwright 服务与产物**

- 会话没有用目录的 `services`，而是在 `playwright.config.js` 加 `webServer: { command: 'npm run serve', url: 'http://127.0.0.1:4173', reuseExistingServer: true }`，由 Playwright 自己起停服务。verify 运行的 e2e 套件因此不需要预先起服务，4/4 通过。
- 记录 `20260930T103729Z-d89776`（首次 verify）的产物索引：4 个 `trace.zip`、4 张 `test-finished-1.png`、`playwright-report/index.html`（528522 字节，`entry: true`）及其 trace 资源。
- `GET /api/tests/artifact` 下载：`trace.zip` 返回 `Content-Disposition: attachment; filename="trace.zip"`、`Content-Type: application/zip`；PNG 返回 `inline; filename="test-finished-1.png"`；`index.html` 为 `attachment; filename="index.html"`；均带 `nosniff` 与 `Content-Security-Policy: sandbox`。下载文件已存进 `$EV/step4-artifact-*`，`file` 识别为 zip、PNG 1280×720、HTML。
- 目录 `services` 的行为在步骤 5 用一个探针单独验证（见 5.4）。

**3.4 验证报告的测试块**

`docs/superpowers/reports/cart-threshold-discount-verify.md` 第 120–174 行有 `<!-- tenon:test-report:begin -->` … `end` 块：追溯矩阵（20 个场景全部「通过」，只有非实现章节的任务显示「未覆盖」）、套件表（e2e 4/4，unit 23/23 覆盖率 100%，运行 `20260930T133121Z-5b0821`）、「仍挡出口的项：无」。副本：`$EV/step3-verification-report.md`、`$EV/step3-test-report-block.txt`。

### 步骤 4：Dashboard API 检查

| # | 请求 | 观察 |
| --- | --- | --- |
| 4.1 | `GET /api/snapshot` | 项目 `shop-cc` 的 change 带 `phase`、`phase_status`、`track`、`owner`、`creator`、`reviewHandshake`（如 `{status: pending, event: verify-pass}`）、`todo`（按阶段）、`documents`、`agentRuns`（按步骤列出每个评审者的状态、结果、发现数）、`workflowExecution.readinessByTransition`（每个出口的 `ready` 与 `blockers`）、`terminalActivity`、`testPolicy`、`testPlan`、`testUser` |
| 4.2 | explore 阶段的 `testPolicy` | spec 步：`test-catalog-missing`（fix `tenon test discover --write`）、`test-plan-missing`（fix `tenon test plan cart-threshold-discount --seed`） |
| 4.3 | verify 评审门时的 `testPolicy` | verify 步 `pass: true`、`chain: intact`；套件 e2e（4）、unit（23，覆盖率 100）、内联 `step:playwright`、`step:code-size`；`trace` 逐场景给出用例引用与状态（`spec:cart-pricing/...` → `test/cart.test.js › ...` → pass）；`agentRuns` 里 verify 的 7 个评审者均 `done / pass` |
| 4.4 | `GET /api/tests/records?root&change` | 4 条运行记录（首个 verify 时点），`users: [{user: <owner-slug>, chain: intact}]`，均 `trusted: true` |
| 4.5 | `GET /api/tests/record?...&run=20260930T103729Z-d89776` | `suites[]` 含用例数、覆盖率、`artifacts[]`（`path`、`bytes`、`media`、`entry`、`present`） |
| 4.6 | `GET /api/tests/artifact?...&path=...` | 见 3.3，文件名保留 |
| 4.7 | `GET /api/change/cart-threshold-discount/orchestration?root=` | 任务在 build 时（verify-fail 回退后）：`current: build`，open / explore / spec 各节点 `done`，`builder` 节点 `running`，typecheck、unit `done`，verify 与 ship 各节点 `waiting`（含 `reviewer cart-pricing-review`、`test design-system`）。`stages`、`returns`、`flows`、`io` 齐全 |
| 4.8 | `GET /api/workflows/default/orchestration?track=frontend&root=` | 自定义评审者在 verify 步的位置与顺序正确（wave 6，和 spec-consistency 等并列） |

### 步骤 5：两个身份（R2）

工作流：为让评审门足够小，在项目里加了一个自定义工作流 `mini-review`（`change` → `check`（`gate: review`）→ `done`，`change` 步带 `test_policy: {plan: required, kinds: [unit], run: [unit], run_if_registered: [smoke], scope: full, files: registered}`），通过 `PUT /api/workflows/mini-review/yaml?root=` 写入。身份：创建者 jefferySha（git 身份），第二身份 `TENON_USER=second@example.com TENON_USER_NAME=Second`。全部用 CLI 驱动，没有再开 Claude Code 会话。日志：`$EV/step5.log`、`$EV/step5b.log`、`$EV/step5-end-state.txt`。

| # | 命令（身份） | 结果 |
| --- | --- | --- |
| 5.1 | `tenon user`（jefferySha）/ `tenon user`（Second） | `jefferySha <...> git` / `Second <second@example.com> env` |
| 5.2 | `tenon init mini-note --workflow mini-review --track free`；Second `tenon transition mini-note change-complete` | init 成功；Second 被拒：`任务 mini-note 的负责人是 jefferySha ...；先接手：tenon owner take mini-note`。`tenon set mini-note phase_status running` 被拒（该字段由 transition 管理） |
| 5.3 | Second `tenon owner take mini-note`（两次） | 两次都退出码 0，历史里只有一条 `set assignee`（jefferySha → Second）；jefferySha 随后 `tenon owner set mini-note x@y.z` 被拒：负责人是 Second。`tenon test plan --seed` 自动登记了 `test/label.test.js`；随后新增 `test/label-extra.test.js`：`tenon test sync` 退出码 2（`未登记 test/label-extra.test.js`）；`tenon test run --stage` 通过但出口检查写 `[test-file-unregistered]`；`tenon transition change-complete` 退出码 1（`测试文件 ... 没有登记进测试计划`）；`tenon test register --file ... --suite unit` 之后通过 |
| 5.4 | 目录服务探针 | `tenon test catalog add dev-server --service --start "PORT=4195 node scripts/dev-server.mjs" --ready-url http://127.0.0.1:4195/ --ready-timeout 20` 成功；套件 `svc-smoke`（`kind: custom`，`report: exit-code`，`services: [dev-server]`，`curl` 页面）因 F10 只能手写进 `catalog.yaml`。`tenon test run mini-note --suite svc-smoke`：`服务 dev-server：已回收，就绪 210ms`，通过；运行后 4195 端口无监听、无残留 `dev-server.mjs` 进程。先手动占住 4195 再运行：失败 `service-not-ready ... 在启动前就已经在响应：有别的进程占着，测试会打到旧代码上；先停掉它`，退出码 2 |
| 5.5 | Second `tenon test run mini-note --stage`、`tenon transition change-complete`、`tenon review request mini-note --event check-pass` | 全部成功；`review request` 后 `.pipeline-history.jsonl` 有 `review:request`，actor Second |
| 5.6 | jefferySha（非负责人）`tenon review acknowledge mini-note` | 退出码 0，`已确认，可重发 transition`（F16）。之后 Second 再 `acknowledge` 得到同样输出（重放） |
| 5.7 | Second `tenon transition mini-note check-pass` | `check -> done`，`archive-run` 动作执行，`tenon list`（两个身份）都显示「无活跃 change」，`tenon status mini-note` 为 `done`、`archived: true` |
| 5.8 | 干净版本 `mini-note2`：jefferySha init，Second `owner take`、`test plan --seed`、`test run --stage`、`transition`、`review request`、`review acknowledge`（只有 Second）、`transition check-pass` | 全部成功；历史里 `review:acknowledge via=terminal` 的 actor 是 Second |
| 5.9 | 记录按用户分开 | `mini-note` 的 8 条运行记录全在 `.tenon/users/second-at-example.com/tests/mini-note/`；`cart-threshold-discount` 的记录在创建者的 `.tenon/users/<owner-slug>/tests/`；两个用户目录并存。`GET /api/tests/records?change=mini-note` 的 `users` 只列 `second-at-example.com`（chain intact）。快照里 `mini-note` 的 `owner = Second`、`creator = jefferySha` |

### 步骤 6：R7，`tenon test code-size --json` 与 PATH

- 任务内：`tenon test code-size --json` 在会话里直接被执行（PATH 上是 `~/.local/bin/tenon` 启动器），输出 `{"files_changed":9,"lines_added":2036,"lines_deleted":156,"largest_added_lines":1378}`；内联测试 `code-size` 经 `tenon test run <c> code-size` 3 次均 `exit_code: 0`、`result: pass`（记录副本 `$EV/step6-code-size-record.json`）。
- 探针（`$EV/r7-code-size-probe.txt`，临时 git 仓库）：正常环境通过；`env -i HOME=<临时目录> PATH=~/.local/bin:/usr/bin:/bin` 也通过（启动器把 runtime 根目录写死，不依赖 HOME）；PATH 上没有启动器（`env -i PATH=/usr/bin:/bin:/opt/homebrew/bin`）时 `sh: tenon: command not found`，退出码 127。
- `tenon doctor` 的 24 个检查里没有「PATH 上能解析到 `tenon`」这一项。
- AFK 沙箱（只读推理，没有运行 AFK）：`tools/sandcastle/Dockerfile` 里 `printf '#!/bin/sh\nexec node /opt/pipeline/packages/cli/dist/tenon.mjs "$@"\n' > /usr/local/bin/tenon`，并 `apk add git`，`tenon-afk-run.sh` 也直接调用 `tenon get ...`，所以沙箱里 PATH 上有 `tenon`，`code-size` 的 `git diff` 依赖也在。仍要留意：沙箱 `HOME=/tmp`（官方 agent 与配置从 `/opt/pipeline/templates` 同步，不依赖宿主 HOME）；镜像只复制了 `tenon.mjs` 与 `templates`；`node:22-alpine` 是 busybox `sh`，`${VAR:-default}` 是 POSIX 展开，可用。
- 结论：任务内和 AFK 镜像可用；用户自己的 CI 或没有装启动器的机器上，必需测试 `code-size` 会 127，而 doctor 没有事先提示（F17）。

## 3. 结果表

| 项 | 结果 | 说明 |
| --- | --- | --- |
| 1 建项目、注册、启用 claude+codex | 通过 | `.tenon/clients.json` 写出 |
| 2 `tenon:agent-author` 起草并注册自定义评审者 | 通过 | `list --json` 为 custom / reviewer；`validate` PASS |
| 2 挂到 default 工作流 frontend verify | 通过 | 通过工作流 YAML 写入接口（项目级库）；编排接口可见；CLI `agent rm` 拒绝 |
| 2 Dashboard agent 引用与删除保护 | 失败 | F1：详情 `references` 为空，`DELETE` 成功 |
| 3 路由与立项 | 部分通过 | 路由选 frontend；立项需要先完成整个 design-system 任务（F3），之后 frontend 轨道正常 |
| 3 阶段推进到归档 | 通过 | 7 个阶段走完，3 轮 verify，8 次评审门确认，全程无删 marker、无绕门 |
| 3 discover → seed → 映射 → 登记 → `run --stage` → 报告 | 通过 | `test-plan-map`、`test-register-files` 未在会话里被触发，登记由会话主动完成；未登记文件的阻断在步骤 5 验证 |
| 3 未登记测试文件阻断 | 通过（CLI 验证） | `test sync` 退出 2、出口 `test-file-unregistered`、`transition` 退出 1 |
| 3 builder 与各评审者（含自定义）以 `tenon-<name>` 子代理运行 | 通过 | `agentType` 与运行记录一致，0 次回退；`.claude/agents` 任务中存在、归档后移除（留空目录） |
| 3 Playwright 起服务、产物 | 通过 | 通过 Playwright `webServer`；trace、截图、HTML 报告有索引且可下载 |
| 3 验证报告 `tenon:test-report` 块 | 通过 | 第 120–174 行 |
| 3 归档 | 通过 | 4 个提交，工作区干净 |
| 4 快照、testPolicy、记录、产物、编排接口 | 通过 | 见 4.1–4.8；F15、F9 是体验问题 |
| 5 R2 接手、评审、归档、按用户分开 | 通过 | `owner take` 幂等；非负责人 `transition` 被拒；记录按用户分目录；F16 是行为澄清 |
| 5 目录服务（起停、探测、占用拒绝） | 通过 | 210ms 就绪，进程被回收，占用被拒；F18、F10 是附带问题 |
| 6 R7 | 部分通过 | 任务内与 AFK 镜像可用；无启动器的环境 127，doctor 无检查（F17） |
| R8（Claude Code） | 通过 | 9 种 `tenon-<name>` 类型被宿主真实加载 |
| Codex 一遍 | 未做 | 本记录只覆盖 Claude Code |

## 4. 问题清单

严重度：P0 阻断发布；P1 主路径失败且无合理绕过；P2 功能缺陷或与文档不符，有绕过；P3 体验、文档或小瑕疵。本次没有 P0、P1。

### 4.1 缺陷与文档不符

**F11（P2）默认工作流的 `code-size` 阈值没有生效**
- 现象：发布说明与 `docs/usage/default-workflow.md` 写 `code-size` 测试在 `lines_added` 不超过 2000 时通过。实际记录里 `lines_added` 为 2002（首次 verify）、2036（最后一次 verify），内联测试仍 `result: pass`、`metrics: []`。冻结计划里该测试是 `"pass":{"exit_code":0,"metrics":[]}`，方向模板 `templates/test-directions/code-size.yaml` 的 `pass.metrics: [{name: lines_added, max: 2000}]` 没有进入计划。
- 复现：在 frontend 任务里让候选新增超过 2000 行（本次的 `package-lock.json` 就有 1378 行），跑 `tenon test run <c> code-size`。
- 证据：`$EV/step6-code-size-record.json`；`~/tenon-accept-v02/shop-cc/openspec/changes/archive/2026-09-30-cart-threshold-discount/.pipeline-workflow-plan.json` 中 `code-size` 测试块；`$EV/transcripts/step3-session-A.jsonl` 中 `lines_added":2036`。
- 建议归属：kernel（direction → 计划的编译）/ templates；文档随后对齐。

**F1（P2）Dashboard 的 agent 详情与删除不看项目级工作流**
- 现象：`GET /api/agents/<name>?root=` 的 `references` 恒为 `[]`，`DELETE /api/agents/<name>?root=` 直接成功，而同一 agent 被 `shop-cc/.pipeline/workflows/default.yaml` 的 frontend verify 引用。CLI `tenon agent rm`（cwd 在项目里）正确拒绝并列出步骤。
- 原因（读码）：`packages/server/src/serverAgentRoutes.ts` 两处调用 `agentWorkflowReferences({ configRoot })` 没传 `projectRoot`，而 CLI 传了 `deps.cwd`。`docs/usage/custom-workflows-and-tracks.md` 仍写「项目工作流放在 `.pipeline/workflows/<name>.yaml`」，Dashboard 页面的 `PUT .../yaml?root=` 也写项目库，所以这条不是遗留路径。
- 复现：登记自定义 agent，`PUT /api/workflows/default/yaml?root=<项目>` 引用它，`GET`/`DELETE` 上面的接口。
- 证据：`$EV/step2-attach-verify.txt`、`$EV/step2-agent-rm-refuse.txt`、`$EV/step2-dashboard-agent-delete-probe.txt`。已从备份原样恢复该 agent（digest `sha256:1c80fc47...` 不变）。
- 建议归属：server（agent 路由）；同时决定项目级工作流库到底是不是正式路径并对齐文档。

**F4（P2）待处理交互 marker 把后台执行者子代理挡住，连它自己的报告都写不了**
- 现象：explore 步 `researcher`（`tenon-researcher`，后台运行）还在跑时，主线加载 `brainstorming` 产生 `.pipeline-pending-interaction`，marker 挡住了子代理的 `Bash`、`WebFetch` 和最后的 `Write`（报告路径 `openspec/changes/<c>/.pipeline-agent-reports/<run_id>.md`）。子代理没有 AskUserQuestion，只能停下汇报；主线在用户回复「可以」解封后自己补写报告并 `tenon agent record`。
- 复现：在有执行者的 Explore 步，让主线在执行者未返回前就加载一个要先问用户的技能。
- 证据：`$EV/transcripts/subagents/agent-aadd18e4814a28ac2.jsonl`（`PreToolUse:Bash hook error ... .pipeline-pending-interaction`、`Write` 被拦）、`$EV/transcripts/step3-t07-continue-explore.out`。
- 建议归属：hooks/gate（子代理写自己的 `report_path` 应放行，或 marker 只约束主线）与 `skills/tenon`（`run-agent` 的执行者返回前不该继续加载会提问的技能）。

**F7（P2）design-system 工作流归档没有提交 `DESIGN.md` 与 `design/`**
- 现象：`shop-design-system` 归档时会话按 `next` 的提交范围只提交了 `openspec/changes/archive`、`.gitignore` 等，`DESIGN.md`（10 章）和 `design/`（模型、方向文档、4 个预览页，约 2350 行）留在工作区。随后折扣任务的 `tenon test code-size` 把它们算进候选：报告新增 4354 行；会话不得不停下来问用户能否做一次「不在工作流规定提交点上」的单独提交（`d3b2d22`），否则 `code-size` 评审会按「夹带」判 high。
- 复现：跑完 design-system 任务后不手动提交，直接开一个 frontend 任务再跑 `tenon test code-size --json`。
- 证据：`$EV/transcripts/step3-t13-build-decisions.out`（Q1）、`git log d3b2d22`、`$EV/step3-end-state.txt`。
- 建议归属：templates/workflows（design-system 的归档 `commit.paths`），或让 frontend 任务立项时要求 `DESIGN.md` 已提交。

**F10（P2）`tenon test catalog add ... --report-format exit-code` 恒失败**
- 现象：只要传 `--report-format exit-code`（且没有 `--report-path`），报 `catalog.yaml:61: 套件 'x' 的 report：exit-code 格式没有报告文件，不要写 path`，说明 CLI 自己填了默认路径。`--kind lint --runner eslint` 同样失败。绕过只有手改 `catalog.yaml`。同一轮里还连续踩到 `--runner shell` 不在闭集、`--kind smoke` 不能用 `exit-code`（提示「只有 typecheck/lint/code-size/custom」），以及 YAML 键是 `services` 而 CLI 标志叫 `--uses`（写成 `uses` 报未知键）。
- 复现：`tenon test catalog add probe-x --kind custom --runner custom --command true --report-format exit-code`。
- 证据：`$EV/step5.log`（「F10 probe」段）。
- 建议归属：cli（catalog add 对 exit-code 不写默认 path），并让 `--help` 说明种类与格式的约束。

**F5（P2）研究执行者按裸名加载 `deep-research`，被宿主拒绝**
- 现象：`tenon-researcher` 子代理第一步 `Skill("deep-research")`，返回 `Skill deep-research cannot be used with Skill tool due to disable-model-invocation`。它随后不用技能直接调研，并在报告「方法说明」里如实写明。插件里的 `skills/deep-research/SKILL.md` 没有该 frontmatter，所以裸名被解析到了别处（本机同时存在 `~/.agents/skills/deep-research` 与宿主的 `anthropic-skills:deep-research`；具体命中哪个未逐一确认）。`skills/tenon/SKILL.md` 对 Codex 的规则是一律按 `tenon:<id>` 加载，agent 正文对 Claude 却写裸名。
- 复现：在装有同名外部技能的机器上跑 Explore 步的 `researcher`。
- 证据：`$EV/transcripts/subagents/agent-aadd18e4814a28ac2.jsonl` 首条 tool_result。
- 建议归属：templates/agents（researcher 与其他 agent 正文的技能名）和 `agents` 渲染（`tenon-<name>.md` 里给宿主的技能引用应带插件前缀）。

**F8（P2）同一评审者可以在不改候选的情况下被重跑到「通过」**
- 现象：verify 第 1 轮 `frontend-quality` 报 3 条 medium；主线换了一份带倾向的补充说明（会话自己承认「带有一定引导性」）重开一次，第二次加载 `design-taste-frontend` 后把 3 条降为 low，运行记录变成 pass。Tenon 只按最新一次运行判定，没有把「同一候选、同一评审者、结论翻转」标出来。会话把这件事摆给了用户确认，所以本次没有造成误放行，但机制上没有拦。`agentRuns` 里 `frontend-quality` 共 2 次 fail、2 次 pass。
- 证据：`$EV/transcripts/step3-t14-build-more.out`（Q2）；`.pipeline-agent-runs.jsonl`（`~/tenon-accept-v02/shop-cc/openspec/changes/archive/2026-09-30-cart-threshold-discount/`）。
- 建议归属：kernel / agent 运行记录（同候选重复运行且结论翻转时在 `step.next` 或评审门里显式提示）。

**F2（P3）agent 来源在 JSON 里叫 `builtin`，文档叫 official**
- 现象：`tenon agent list --json` 与 `GET /api/agents` 的 `source` 值为 `builtin`，文本输出显示「官方」，`agents.md` 与发布说明写 official。
- 建议归属：docs 或 API 命名对齐。

### 4.2 体验摩擦（按真实用户的感受记录）

**F3（P3）小页面 + Playwright 用例被路由到 frontend，必须先做完整设计体系任务才能开工**
- 现象：立项即被拒（提示清楚、命令正确），但代价是一个完整的 design-system 任务：3 步、`hue` 技能问 2 个设计问题、生成 `DESIGN.md` 与 4 个预览页、会话自己截图自查；其中一个回合 1129 秒、约 7 美元，`open` 在用户默认浏览器里打开了 4 个预览页（无头会话里也会弹）。资源步骤取来的 DESIGN.md 只是「起步」，前端任务的就绪检查照样拦（`check.ts` 的注释说明是有意的）。
- 证据：`$EV/transcripts/step3-t01-start.out`、`step3-t04-design-confirm1.out`。
- 建议归属：产品决策（是否为小项目提供轻量路径或在路由时提示）；skills/hue（无头模式下不要 `open`）。

**F6（P3）纯 JS 项目被 frontend 轨道要求加 TypeScript**
- 现象：build 步内联必需测试 `npm run typecheck`，项目没有该脚本，`step.next` 在 spec 步就发出一条超过 700 字的 `fix test-unconfigured`；会话只能问用户是否新增 `typescript`（当时最新主版本 7.0.2）、`tsconfig.json`、JSDoc。同一处还要求 `@vitest/coverage-v8`（覆盖率 ≥ 80%）和 webkit 浏览器（本机没有，需下载）。一个 50 行的购物车模块因此增加了 3 项依赖与 1378 行 `package-lock.json`，又是 F11 里 2000 行阈值的主要来源。
- 建议归属：templates/workflows（frontend 轨道的默认策略）与提示文案。

**F12（P3）Playwright 每次 verify 跑两遍**
- 现象：目录套件 `e2e`（`test_policy.run: [..., playwright]`）和默认工作流保留的内联测试 `playwright`（`npx playwright test`）都在 verify 阶段被要求，会话依次跑了 `tenon test run --stage` 和 `tenon test run <c> playwright`。webkit + chromium 各 2 个用例，多花约 10 秒和一套重复的产物。
- 建议归属：templates/workflows（去掉内联测试或让策略识别它）。

**F13（P3）非实现章节的任务在追溯矩阵里显示「未覆盖」**
- 现象：验证报告里 `task:1.1`、`2.1`、`3.1`、`5.1`、`7.1` 等显示「未覆盖」，虽然它们是可选项、不阻断。读报告的人会误以为有缺口。
- 建议归属：kernel（`test report` 文案，例如「无需用例」）。

**F14（P3）交付提交里带上了 `.pipeline-owned.json` 与全部运行记录，并留下空目录**
- 现象：`9878b24 deliver` 提交包含 `.pipeline-owned.json`（11 行）和 `.tenon/users/<slug>/tests/<c>/` 下 27 个运行记录 JSON（约 6300 行，占该次提交新增总行数的一半左右）；归档提交又把 `.pipeline-owned.json` 删掉。文档说 `tenon-*.md` 文件「never part of the delivery commit」，文件本身确实没提交，但清单被提交后又删除。归档后 `.claude/` 空目录残留。
- 证据：`git -C ~/tenon-accept-v02/shop-cc show --stat 9878b24`、`ls -la ~/tenon-accept-v02/shop-cc/.claude`。
- 建议归属：cli（提交范围与清理）。

**F9（P3）套件产物归属混乱**
- 现象：`unit` 与 `e2e` 两个套件都声明 `artifacts: [test-results]`，`GET /api/tests/record` 中 `unit` 的 12 项产物索引里含 8 个 Playwright 的 `test-results/pw/*.png`、`trace.zip`，`e2e` 里又有一份（`artifacts/e2e/test-results/pw/...`）。运行抽屉里 unit 会挂着浏览器 trace。
- 证据：`$EV/step4-record-verify.raw`。
- 建议归属：cli（产物目录按套件隔离或去重）。

**F15（P3）Dashboard 只按「查看者」的记录判定，看别人的任务会显示「测试未跑」**
- 现象：`mini-note` 由 Second 跑完测试并归档；以 jefferySha 视角的快照里 `testPolicy` 为 `change: pass=false, chain=empty, test-not-run`，而 `GET /api/tests/records` 能看到 Second 的 8 条记录。另外，快照里已经过去的 `build` 步在后续改动后显示 `test-stale` 阻断，读起来像当前问题。
- 证据：`$EV/step5-snapshot.json`、`$EV/step4-snapshot-verify-pass.json`。
- 建议归属：server / dashboard（按 change 的负责人或所有用户的记录合并展示，已过的步骤不显示 stale）。

**F16（P3）非负责人可以确认评审，文档没说**
- 现象：jefferySha 不再是 `mini-note` 的负责人，`tenon review acknowledge` 仍成功（历史里 `review:acknowledge via=terminal` 的 actor 是 jefferySha），随后 `transition` 由负责人 Second 完成。`transition`、`set`、`owner set` 都有负责人校验，`acknowledge` 没有。这对「负责人之外的人做评审」很合理，但 `cli-reference.md` 没有说明谁可以确认。
- 建议归属：docs（明确 acknowledge 的身份规则）；如果要限定，则是 cli。

**F17（P3）无启动器的环境下必需测试 `code-size` 会 127，`tenon doctor` 不提示**
- 现象：见步骤 6。`code-size` 命令依赖 PATH 上的 `tenon`；`doctor` 的 24 个检查里没有 PATH 上 `tenon` 可解析这一项。
- 建议归属：cli（doctor 增加检查，或让内置测试走稳定入口）。

**F18（P3）服务探测被 fetch 的「坏端口」挡住时没有任何原因**
- 现象：目录服务 `ready.url: http://127.0.0.1:4190/`，服务其实起来了（日志有 `listening`），但 20 秒后报 `service-not-ready ... 日志尾部：`（空），因为 4190 在 Fetch 规范的禁用端口表里，`probeUrl` 吞掉了异常。换 4195 就好了。
- 证据：`$EV/step5.log` 的 4190 段与 `services/dev-server.log`。
- 建议归属：cli（`probeUrl` 失败时把最后一次错误带进原因，或对禁用端口给出提示）。

**F19（P3）无头会话里 `Grep` 在子代理工具白名单里但宿主不提供**
- 现象：`tenon-researcher.md` 的 `tools` 含 `Grep`，子代理调用得到 `No such tool available: Grep`，需要改用 `grep`。这是宿主行为，白名单本身合法。
- 建议归属：无需处理，记录备查。

**UX-A 多轮问答与耗时。** 包含设计体系任务在内，最初的 `/tenon` 之后共 18 次用户回复：9 次业务或技术选择（是否先做设计体系、Playwright 怎么到 100、设计确认、grilling 4 题、typecheck/覆盖率/webkit 3 题、build_mode/isolation、单独提交设计体系、verify 三个选择）、1 次普通「继续」、8 次评审门确认；交互模式下即使给了「非评审门不用每步问」的常驻指令，主线仍在部分转换前停下问「继续」。评审门 `verify-fail` 需要自己的 `review request` 和新的一次确认：我在 request 之前说的「按推荐」被会话明确判为「工作流不认」，多出一整轮（t15 → t16）。总计约 135 分钟的会话时间和 77.87 美元。建议归属：skills/tenon（交互模式的合并提问）与 hooks（放行语的时序说明）。

**UX-B 三轮 verify。** 必需评审者 `block_at: medium`，加上评审者对会话自己写的文档（设计变更提案 `design-system.md`）也提 medium，形成 verify → 回退 → spec → 评审门 → build → verify 的循环，第 2、3 轮各约 10–16 分钟。自定义评审者第一次就抓到真问题（金额溢出）是好结果，但小项目里循环成本很高。建议归属：产品决策（评审者范围、`block_at` 默认值）。

**UX-C 评审门期间连只读命令也被挡。** `.pipeline-pending-review` 存在时 `Bash` 全部被拦（会话想 `git status` 或删除自己留下的临时脚本都被拒，且必须等下一个用户回复才能收尾）。这是三门的设计，但用户的观感是「助手停在那里连状态都查不了」。建议归属：hooks（是否放行只读命令）。

**UX-D 命令行独用时 `step.next` 一直是 `load-tenon`。** 步骤 5 里没有宿主会话，`tenon status` 的 `next` 始终是 `[{"action":"load-tenon"}]`，真正的阻断只在 `exits[].blockers` 里；纯终端协作者看不到「下一条该敲什么」。建议归属：cli（无宿主会话时按阻断给出命令，或在 `load-tenon` 后仍展示 fix）。

**UX-E 长提示。** spec 步的 `fix test-unconfigured` 单条消息包含配置方式、Dashboard 覆盖说明和对计划步的要求，超过 700 字，一次塞进 `step.next`。建议归属：cli/skills（拆成命令 + 一句说明）。

## 5. 遗留状态与清理建议

本次验收在真实机器上留下的状态，均未删除（按任务要求只在两个指定位置内删除文件，而本次没有删除任何文件）：

- 用户级自定义 agent `cart-pricing-review`（`<config>/agents/custom/cart-pricing-review.md`）。它现在被 `shop-cc` 的项目工作流引用；F1 使 Dashboard 可以直接删掉它。清理：先 `DELETE /api/projects?root=~/tenon-accept-v02/shop-cc` 注销项目，再在项目外 `tenon agent rm cart-pricing-review`。
- 演示项目 `~/tenon-accept-v02/shop-cc` 已注册进 Dashboard 项目表；git 历史 11 个提交，工作区干净。
- `~/Library/Caches/ms-playwright/webkit-2311`：build 步的 builder 子代理为满足 `browsers: [chromium, webkit]` 下载的 WebKit（2026-09-30 18:06）。
- 全局工作流库 `<config>/workflows` 没有变动；`~/.claude/skills`、`~/.agents/skills` 没有触碰。
- `hue` 技能在默认浏览器里打开过 4 个预览页；会话在 `/tmp` 下留有若干临时截图与脚本（`/tmp/shopcc-*`）。

## 6. 证据索引

`$EV` 下：

- `transcripts/`：每一轮的 `.json`（`claude -p` 输出）、`.out`（摘要）、`.stderr`，`step3-session-A.jsonl`（折扣与设计体系任务的完整会话）、`step2-agent-author.session.jsonl`、`subagents/`（30 个子代理的 jsonl 与 `meta.json`）、`_log.txt`（起止时间）
- `snaps/s3-*/`：各阶段 `tenon status --json` 与摘要（`step.next`、`step.exits`、`git status`、`.claude/agents` 列表）
- `step2-*.txt`、`default-workflow-{before,after}.yaml`：步骤 2
- `step3-end-state.txt`、`step3-verification-report.md`、`step3-test-report-block.txt`：步骤 3
- `step4-*.raw`、`step4-snapshot-verify-pass.json`、`step4-artifact-*`：步骤 4
- `step5.log`、`step5b.log`、`step5-end-state.txt`、`step5-snapshot.json`、`mini-review.yaml`：步骤 5
- `r7-code-size-probe.txt`、`step6-code-size-record.json`：步骤 6
- `notes.txt`、`timings.txt`：观察笔记与各回合耗时

演示项目内：`~/tenon-accept-v02/shop-cc/openspec/changes/archive/2026-09-30-cart-threshold-discount/`（含 `.pipeline-agent-runs.jsonl`、`.pipeline-workflow-plan.json`、`.pipeline-history.jsonl`）、`.tenon/tests/catalog.yaml`、`.tenon/users/`。
