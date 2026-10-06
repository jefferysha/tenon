# 测试体系设计

## 1. 三层模型

```
项目测试目录（共享配置，人可编辑，加载时校验）
  .tenon/tests/catalog.yaml            ← 套件：怎么跑、怎么读报告、要什么服务
        │ 引用 suite id
任务测试计划（状态，CLI 独占写入）
  openspec/changes/<c>/test-plan.yaml  ← 本任务用哪些套件、新增了哪些测试文件、场景→用例映射、豁免
        │ 按策略选出本阶段要跑的
工作流测试策略（工作流 YAML，Dashboard 可编辑）
  steps[].test_policy                  ← 本阶段必须登记/必须运行的种类、范围、门槛
        ↓
运行记录 v2（CLI 独占写入，哈希链）  .tenon/users/<slug>/tests/<change>/<run-id>.json
基线（进 git，按机器画像）            .tenon/tests/baselines/<suite>/<profile>.json
已知失败（进 git）                    .tenon/tests/known-failures.yaml
```

- 目录是「项目有哪些测试、怎么跑」；计划是「这个任务动了哪些测试、要证明什么」；策略是「这个阶段必须看到什么」。三者分开，谁都不重复另一方的信息。
- 旧的步骤 `tests[]` 编译成「内联套件 + 该步骤必须运行」，行为不变（兼容，见 §10）。

## 2. 项目测试目录 `catalog.yaml`

```yaml
schema: tenon-test-catalog/v1
profiles_env: [CI]                 # 参与机器画像的环境变量名（可选）
suites:
  - id: web-unit
    label: 前端单测
    kind: unit                     # 闭集见下
    runner: vitest                 # 闭集见下；决定默认报告格式与选择语法
    command: npx vitest run --reporter=junit --outputFile=test-results/web-unit.xml
    cwd: packages/dashboard-app
    timeout_s: 900
    files: ["src/**/*.test.{ts,tsx}"]          # 本套件拥有的测试文件（未登记文件判定、按文件选择）
    covers: ["src/**/*.{ts,tsx}"]              # 影响范围：改到这些源码时建议纳入
    select:                                    # 可选：只跑部分
      files: "npx vitest run {files} --reporter=junit --outputFile=test-results/web-unit.xml"
      grep:  "npx vitest run -t {pattern} --reporter=junit --outputFile=test-results/web-unit.xml"
    report: { format: junit, path: test-results/web-unit.xml }
    coverage: { format: istanbul-summary, path: coverage/coverage-summary.json }
    artifacts: [test-results, coverage]        # 目录允许；按文件建索引
    env: [NODE_OPTIONS]                        # 只列名字；值来自宿主环境或 tenon secrets
    services: [web-dev]                        # 引用下方 services
    retries: 0
    parallel: false                            # 可与同批其他 parallel 套件并发
    tags: [web]
  - id: web-e2e
    label: 浏览器 e2e
    kind: playwright
    runner: playwright
    command: npx playwright test --reporter=json,html
    report: { format: playwright-json, path: test-results/results.json }
    artifacts: [playwright-report, test-results]
    browsers: [chromium, webkit]               # Playwright project 名；报告按项目分组
    services: [web-dev]
    retries: 2
  - id: api-bench
    label: 接口基准
    kind: benchmark
    runner: custom
    command: node bench/run.mjs --json test-results/bench.json
    report: { format: benchmark-json, path: test-results/bench.json }
    benchmark:
      runs: 5                                  # 重复次数（报告自身已多次采样时为 1）
      warmup: 1
      metrics:
        - { name: p95_ms, unit: ms, better: lower, max_regression_pct: 10, max: 250 }
        - { name: rps, unit: req/s, better: higher, max_regression_pct: 5 }
services:
  - id: web-dev
    start: npm run dev -- --port 5178
    cwd: packages/dashboard-app
    ready: { url: "http://127.0.0.1:5178/", timeout_s: 60 }   # 或 { port: 5178 } / { log: "ready in" }
    stop: SIGTERM
```

**kind 闭集**：unit / integration / regression / e2e / playwright / browser / benchmark / typecheck / lint / coverage / a11y / visual / contract / smoke / code-size / design-system / custom。（`browser` = 非 Playwright 的浏览器脚本，如 Cypress、WebdriverIO；探索式检查不是 kind。）

**runner 闭集**：vitest / jest / mocha / node-test / pytest / go / cargo / playwright / cypress / vitest-bench / hyperfine / k6 / lighthouse / tsc / eslint / custom。runner 决定：默认报告格式、`select` 默认模板、`discover` 识别规则。

**report.format 闭集**：junit / playwright-json / vitest-json / jest-json / go-json / tap / benchmark-json / k6-summary / lighthouse-json / exit-code（只有 typecheck、lint、code-size、custom 可用 exit-code；其余必须有报告）。

**benchmark-json**（Tenon 定义的最小格式，任何工具包一层即可）：`{"metrics":{"p95_ms":[12.1,11.8],"rps":[...]}}` 或单值；多值取中位数，并记录 p95 与离散度。hyperfine / vitest bench / k6 summary 内置转换。

校验：id 唯一、`[a-z0-9-]{1,48}`；引用的 service 存在；report 路径与 artifacts 在仓库内、不含 `..`；kind 与 format 组合合法（benchmark 必须有 benchmark 段）；命令非空。错误逐条带 `catalog.yaml:<line>`。

**自动发现** `tenon test discover [--write]`：扫描 package.json 脚本（test / test:* / e2e / bench / typecheck / lint）、playwright.config.*、vitest.config.*、jest.config.*、pytest.ini / pyproject、go.mod、Cargo.toml、`**/*.bench.*`、`e2e/`、`tests/` 目录，给出建议套件（含推荐 reporter 参数）。不带 `--write` 只打印差异；带 `--write` 追加到目录，已存在的 id 不覆盖。

目录的编辑：人可以直接改（它是配置），也可用 `tenon test catalog add|set|rm|show|validate`。

## 3. 任务测试计划 `test-plan.yaml`（CLI 独占）

```yaml
schema: tenon-test-plan/v1
change: add-login
suites:                                   # 本任务要跑的目录套件
  - { suite: web-unit, scope: changed }   # full | changed（按 covers/files 与 diff 选文件）| files | grep
  - { suite: web-e2e,  scope: grep, pattern: "@login" }
  - { suite: api-regression, scope: full }
files:                                    # 本任务新增或修改的测试文件，全部要登记
  - { path: packages/web/src/login/Login.test.tsx, suite: web-unit, kind: unit }
  - { path: e2e/login.spec.ts, suite: web-e2e, kind: playwright }
cases:                                    # 场景/任务 → 用例（追溯）
  - covers: "spec:auth/登录成功跳转首页"       # spec:<capability>/<Scenario 标题>
    tests: ["e2e/login.spec.ts › 登录成功跳转首页"]
  - covers: "task:2.3"                        # tasks.md 条目编号
    tests: ["Login.test.tsx › 密码为空时禁用提交"]
waivers:                                  # 策略要求但本任务不适用
  - { kind: benchmark, reason: 纯文案改动，无性能路径, approved_by: null }
```

- 写入只经 CLI：`tenon test plan <c>`（查看，`--json`）、`tenon test register <c> --suite <id> [--scope ...]`、`--file <path> [--suite <id>] [--kind <k>]`、`--case "<covers>" --test "<file › name>"`、`tenon test waive <c> --kind <k> --reason <text>`、`tenon test unregister <c> ...`。每次写入把摘要记进 change 状态（与 document record 同一机制）；手改文件 → 摘要不符 → `test-plan-tampered` 阻塞，提示用 CLI 重新登记。hook 拦截对 `test-plan.yaml` 的 Write/Edit/重定向。
- 计划初稿 `tenon test plan <c> --seed`：从 delta-spec 的 `#### Scenario:` 与 tasks.md 条目生成待映射的 `cases`，从 diff 生成 `files`，从目录 `covers` 与 diff 生成建议 `suites`。agent 再补全映射。
- 豁免需要评审：`waivers[].approved_by` 只能由 `tenon review acknowledge` 的同一次确认写入（review 请求里列出豁免）；未批准的豁免不解除阻塞。

**全量登记强制**（R3）：`tenon test sync <c>` 与门禁判定都计算「diff（相对 change 起点）里匹配任一套件 `files` 的新增/修改文件」减去「计划 files」→ 非空即 `test-file-unregistered`，逐个列出路径与建议命令。匹配不到任何套件、但看起来像测试的文件（`*.test.*`、`*.spec.*`、`test_*.py`、`*_test.go`、`*.bench.*`、`e2e/**`）→ `test-file-orphan`，提示先在目录里加套件。

## 4. 工作流测试策略 `test_policy`

```yaml
steps:
  - id: spec
    test_policy:
      plan: required                     # 出口要求计划存在且覆盖 kinds
      kinds: [unit, regression, playwright]
      scenarios: required                # 每个 OpenSpec 场景至少映射一个用例（或已批准豁免）
  - id: build
    test_policy:
      run: [unit, typecheck]
      scope: changed
      files: registered                  # 出口要求无未登记测试文件
  - id: verify
    test_policy:
      run: [unit, integration, regression, playwright, benchmark, a11y]
      scope: full
      coverage: { lines: 80, branches: 70, changed_lines: 90 }
      flaky: { max: 2, fail_on_new: true }
      benchmark: { require_baseline: false }   # true = 无同画像基线也挡
      scenarios: passing                 # 每个场景的映射用例在本轮通过
  - id: ship
    test_policy: { run: [smoke] }
```

- `kinds` 是「必须登记」，`run` 是「本阶段必须在当前代码上跑过并通过」。一个 kind 在计划里既无套件也无已批准豁免 → `test-kind-missing`。
- default 工作流各轨道默认值（可在工作流页改）：
  - 对话 / 自由：spec 要求 unit；build 跑 unit+typecheck（changed）；verify 跑 unit+regression（full）。
  - 前端：再加 playwright（verify 必跑，chromium+webkit）、a11y、visual（有则跑），覆盖率 lines 80。
  - 后端：再加 integration、regression（full）、benchmark（带 perf 标签的变更要求），覆盖率 lines 80。
  - 产品：spec 要求场景映射；verify 跑 playwright 冒烟。
- 旧步骤 `tests[]` 编译为：内联套件（id 前缀 `step:`）+ 该步骤 `run` 包含它（required 时）。两者可以并存。

## 5. 执行 `tenon test run`

```
tenon test run <change> [--suite <id>...] [--kind <k>...] [--stage [<step>]] [--all] [--changed] [--json]
tenon test run <change> <test-id>          # 旧形式保留：跑步骤内联测试
```

流程（单进程编排，`parallel: true` 的套件在同一批里并发）：

1. **计划运行集**：参数 × 计划 × 当前阶段策略 → 套件与范围；先打印将要执行的命令。
2. **启动服务**：按引用去重启动；就绪探测（URL 200 / 端口可连 / 日志匹配），超时 → `service-not-ready`（附服务日志尾部）；结束或中断时按进程组回收，残留进程写入记录。
3. **执行套件**：沿用现有进程执行器（进程组、超时 SIGTERM→SIGKILL、日志截断与哈希）；注入 `TENON_*` 与声明的 env（值只取不记，记录里只存名字与是否存在）。
4. **解析报告**：按 format 解析为用例 `{id, file, name, suite_path, project, status(pass|fail|skip|flaky|known-fail), duration_ms, attempts, failure{message, stack, expected?, actual?}, artifacts[]}`；Playwright attachments（截图、trace、视频）挂到对应用例。
5. **重试**：失败用例按 `retries` 用 `select.grep/files` 重跑（Playwright/Jest 自带重试时直接读 attempts）；最终通过 → `flaky`。
6. **判定**（每个套件）：
   - 报告缺失或解析失败 → `report-missing` / `report-unreadable`
   - 总用例 0 或全部 skip → `no-tests-ran`
   - 退出码非 0 但报告全过，或退出码 0 但报告有失败 → `exit-report-mismatch`
   - 计划里的 `files` / `cases` 在报告中找不到对应用例 → `registered-test-not-executed`
   - 覆盖率低于策略 → `coverage-below`（逐项列出实际值）
   - 基准见 §6；回归见 §7；flaky 超限 → `flaky-over-limit`
7. **收集产物**：目录产物按文件建立索引 `{path, bytes, digest, media: image|video|trace|html|json|text}`，单文件 ≤64 MiB、单次 ≤256 MiB（沿用）；Playwright HTML 报告整目录保留并记录入口文件。
8. **写记录 v2** + 哈希链；输出人类可读摘要（通过/失败/flaky/跳过计数、前 10 条失败用例、产物位置）；退出码：全部通过 0、有失败 2、用法/环境错误 1。

**记录 v2**（每次调用一份，含多个套件）：

```jsonc
{ "schema": "tenon-test-run-v2", "run_id": "...", "change": "...", "step": "verify",
  "bindings": { "candidate": "...", "workflow_fingerprint": "...", "catalog_digest": "...", "plan_digest": "...", "policy_digest": "..." },
  "machine_profile": "darwin-arm64-m3max-node22-<hash>",
  "services": [{ "id": "web-dev", "ready_ms": 2310, "exit": "stopped", "log": "services/web-dev.log" }],
  "suites": [{ "suite": "web-e2e", "kind": "playwright", "scope": "full", "command": "...", "exit_code": 1,
      "result": "fail", "reasons": [{ "code": "test-failed", "detail": "2 failed" }],
      "totals": { "cases": 48, "pass": 45, "fail": 2, "skip": 0, "flaky": 1, "known_fail": 0 },
      "cases": [ /* 失败、flaky、已知失败与计划内用例全量；其余只计数（大型套件不膨胀） */ ],
      "coverage": { "lines": 83.1, "branches": 71.0, "changed_lines": 92.4 },
      "metrics": [], "artifacts": [ /* 文件索引 */ ], "log": { /* 同 v1 */ } }],
  "result": "fail", "actor": {}, "host": {}, "started_at": "...", "finished_at": "...",
  "prev_digest": "<上一条记录摘要>", "digest": "<本条内容摘要>" }
```

## 6. 基准

- **机器画像** `machine_profile` = OS + 架构 + CPU 型号 + 核数 + 内存档位 + 运行时版本 + `profiles_env` 的值 → 短哈希，附可读名。
- **基线**存 `.tenon/tests/baselines/<suite>/<profile>.json`（进 git，团队共享；不同画像互不比较）。字段：每个指标的中位数、p95、样本数、离散度（MAD）、来源 run、提交、时间、历史 ≤20。
- **判定**：同画像有基线 → `delta = (median - base) / base`，按 `better` 方向与 `max_regression_pct` 判定；噪声保护：样本离散度大于阈值一半时自动再跑一轮再判；绝对阈值 `max/min` 始终生效。
- 无同画像基线：`require_baseline: false` 时记 `baseline-missing` 提示（不挡）并给出 `tenon test baseline <c> --suite <id> --run <run-id>`；`true` 时挡。
- 基线更新只经 CLI，且需要一次通过的运行；更新动作写审计。

## 7. 回归与已知失败

- 回归 = 套件以 `scope: full` 在当前代码上跑。`kind: regression` 的套件在 verify 默认必跑。
- `.tenon/tests/known-failures.yaml`：`{suite, test: "<file › name>", reason, link, expires: YYYY-MM-DD, added_by}`。
  - 清单内用例失败 → `known-fail`，不挡；清单内用例通过 → 提示「已修好，移出清单」（`tenon test known rm`）；过期条目 → 按普通失败并提示续期或修复；清单外失败 → 挡。
- `scope: known`（旧字段）= 只跑清单内用例（经 `select.grep`），用于修复中的快速复查；不能替代 full。

## 8. 浏览器测试

- 计入证据的只有可重放的脚本：Playwright（首选），或目录登记的 Cypress / WebdriverIO（kind `browser`）。
- 多浏览器：`browsers` 列出 Playwright project；策略可要求覆盖哪些；报告按项目分组，缺项目 → `browser-project-missing`。
- 视觉回归：`toHaveScreenshot` 的快照文件视为测试文件（登记、进 git）；差异图作为用例产物。
- a11y：推荐 `@axe-core/playwright`，作为 kind `a11y` 的套件，或 Playwright 套件里带 tag 的用例。
- 探索式检查（browser-qa 技能、Playwright MCP 手动操作）：技能流程要求把发现落成 `e2e/*.spec.ts`（可用 `npx playwright codegen` 起草）并登记；纯截图描述不算证据。
- 需要登录态、种子数据的：用 `services` 启动 + 套件自己的 `globalSetup`；Tenon 不管理测试数据。

## 9. 门禁、防伪与追溯

**阻塞码（新增）**：test-catalog-missing、test-plan-missing、test-plan-tampered、test-kind-missing、test-file-unregistered、test-file-orphan、test-not-run、test-failed、test-stale、no-tests-ran、report-missing、report-unreadable、exit-report-mismatch、registered-test-not-executed、coverage-below、benchmark-regression、baseline-missing（按策略挡或提示）、flaky-over-limit、browser-project-missing、scenario-uncovered、scenario-failing、service-not-ready、record-chain-broken、waiver-unapproved。每个阻塞带短标签（Dashboard 用）+ 完整说明 + 修复命令，与 `tenon status` 的 blockers 同源。

**新鲜度**：记录绑定 候选代码指纹 + 目录摘要（只取相关套件条目）+ 计划摘要 + 策略摘要 + 工作流指纹；任一变化 → stale，并写明哪一项变了。

**防伪**：
- 记录目录只允许 `tenon test run` 写；hooks 的 gate 拦截 Write/Edit/MultiEdit，以及 Bash 中 `>`、`>>`、`tee`、`cp`、`mv`、`sed -i` 指向 用户测试记录目录、`test-plan.yaml`、`baselines/`、`known-failures.yaml` 的命令（后两者允许 `tenon test` 子命令与人工 git 操作）。**匹配只看目标路径（tool_input.file_path / 命令里的重定向目标），不看写入内容**——v0.1.10 的 gate 按整段输入匹配，写一份提到这些路径的文档也会被误拦（见 v02-fixes F9）。
- 记录按 `prev_digest` 串成链；判定时校验链，断链 → `record-chain-broken`，该用户该任务的记录全部视为未运行，提示重跑。
- 不做密码学签名（本机单用户威胁模型，hook + 链足以发现 agent 误改）。

**追溯报告**：`tenon test report <c> --write <verification-report>` 生成「场景/任务 → 用例 → 最近结果」矩阵 + 套件汇总 + 覆盖率 + 基准对比 + flaky 与已知失败；verify 阶段由 runner 的下一步动作自动调用，替换报告文件的标记区间。

## 10. 兼容与迁移

- v1 记录继续可读，只参与旧步骤内联测试的判定；v2 为新写入格式。
- 步骤 `tests[]` 与测试方向继续有效；测试方向升级为「目录套件模板」（按 runner 预置 reporter 参数），`tenon test catalog add --from <direction>`。
- 没有 `catalog.yaml` 的项目：`tenon status` 在 spec 阶段给出 `test-discover` 动作；策略要求的阶段在目录缺失时挡 `test-catalog-missing`。
- default 工作流升级后，旧任务按冻结计划继续用旧规则；新建任务用新策略。

## 11. 流程接入（技能与 runner）

`tenon status` 的 `step.next` 新增动作：`test-discover`（无目录）→ `test-plan-seed`（spec）→ `test-plan-map`（场景未映射）→ `test-register-files`（有未登记文件）→ `run-tests`（策略 run 未满足，给出一条 `tenon test run <c> --stage` 命令）→ `test-report`（verify）。tenon 技能按动作执行；评审者 `reads_tests: true` 时提示词附带失败用例与覆盖率摘要。

## 12. Dashboard（只展示与配置策略，不登记、不执行）

- **项目页**：中列顶部分段「客户端 / 测试」。测试 = 目录套件列表（名称、种类图标、runner、最近结果点、flaky 数）；右列套件详情：命令、报告格式、服务、覆盖率门槛、基线（按画像，中位数与历史折线）、已知失败清单。
- **工作台任务「测试」页签**（替换现有测试表）：
  - 顶部一行汇总：套件 N · 用例 M · 失败 x · flaky y · 覆盖率 z%。
  - 策略矩阵：本阶段要求的种类 × 是否登记 × 最近结果（点 + 词），缺项直接显示阻塞短标签与可复制命令。
  - 场景追溯表：场景/任务 · 用例 · 结果。
  - 未登记文件列表（有则置顶）。
- **运行详情抽屉**：命令、退出码、耗时、服务就绪时间；失败用例列表（名称、文件:行、消息，展开看堆栈与 expected/actual）；产物区：截图网格（点开放大）、视频、trace（下载 + 复制 `npx playwright show-trace <path>`）、HTML 报告入口；覆盖率三项与门槛；基准指标 vs 基线（delta 与方向，超限标红）；日志尾部与完整日志下载；失效原因（哪一项绑定变了）。
- **工作流页测试段**：策略的结构化表单——种类多选、运行多选、范围单选、覆盖率三项数字框（带 %）、flaky 上限、基线要求开关、场景要求单选；说明全部进 Tooltip。旧 `tests[]` 以只读行显示，可转换为目录套件。
- **库「测试模板」**：按 runner 的模板只读展示结构化字段（不再显示 YAML 原文），复制命令 `tenon test catalog add --from <id>`。
- 遵循既定规则：表格不堆卡片、不换行、状态用点 + 一个词、一词一概念（测试 / 套件 / 用例 / 基线 / 已知失败 / 豁免）。

## 13. 分期（worker 批次）

1. **T1 内核模型**：catalog / plan / policy / known-failures / baseline / record-v2 的类型、解析、校验、摘要；机器画像；新鲜度与阻塞判定（含场景追溯、未登记文件计算的纯函数）；default 工作流策略；旧 `tests[]` 编译兼容。
2. **T2 CLI 执行**：discover、catalog、plan/register/waive/sync、run 编排（服务、并发、重试）、报告解析器（junit、playwright-json、vitest-json、jest-json、go-json、tap、benchmark-json、k6、hyperfine 转换）、覆盖率解析、基准判定与 baseline、known 子命令、report 追溯矩阵、哈希链。
3. **T3 流程接入**：status 动作、tenon 技能与 AGENTS 受管块文案、hooks 防伪规则（按目标路径匹配）、评审者读测试、审计。
4. **T4 Dashboard**：server 路由与快照字段（v2 记录、产物文件索引与安全下载、目录与基线读取）、项目页测试、工作台测试页签与运行抽屉、工作流页策略表单、库测试模板。
5. **T5 自举**（v02-dogfood-e2e）：Tenon 仓库自身目录与策略、Dashboard Playwright e2e、CI 接入。

T1 先行；T2/T3/T4 在 T1 合入后并行（各自 worktree）；T5 在 T2 后。

## 14. T1 实施后的决定（2026-09-29，主线程）

1. Dashboard 保存工作流会丢 `test_policy`：T4 必须在 `governanceSchema.ts` 解码/编码透传 `test_policy`（并提供表单）；T4 合入前不发布。
2. T1 与 T2 同版本发布；默认策略在没有 discover/register/plan --seed 时会挡住 spec，不得单独发布 T1。
3. `files: registered` 需要宿主提供「自 change 起点以来的改动文件」：T2 在 CLI（`testEvidenceContextFor`）与 server 快照两处接入；提供者抛错时**阻塞**（新码 `files-diff-unavailable`，fail closed），不降级为提示。
4. 豁免支持按场景：`waivers[].covers: "spec:<capability>/<Scenario>"`，与按 kind 豁免同样需要评审批准。
5. 报告、覆盖率、产物路径必须位于 `test-results/`、`playwright-report/`、`coverage/` 之下（否则运行本身会改变工作区指纹，使候选失效）；目录校验器强制，§2 以此为准。
6. 默认策略近似：后端基准为 `run_if_registered: [benchmark]`；产品轨道冒烟在 verify 阶段。接受。
7. 基准噪声重跑在 T2 实现（内核只给 `noisy`）。
8. 豁免批准只由 `tenon review acknowledge` 同一次确认写入（T3）。
