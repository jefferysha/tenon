# 标准通道（standard lane）设计

范围：prd.md 的 R1–R6。依据 product-audit.md §3、§4.3 bet 2，以及 135 分钟 / 18 次回复的 Claude Code 验收。
基线：integ/v03 = 9f9cbd8b，分支 v03/standard-lane。
（共享检出里的任务目录写不进去，本文件放在 worktree 的同名路径。）

## 0. 结论先行

| 项 | 做法 | 为什么这样 |
| --- | --- | --- |
| R1 | `standard` 是随插件发布的**模板工作流**（`templates/workflows/standard.yaml`，与 `design-system` 同类，可编辑、可被项目文件覆盖），不走 OpenSpec 治理；步骤 open → build → verify → done，外加终态 escalated。配一条内建轨道 `standard`（工作流缺省与允许集都是 `standard`）。 | 不走 OpenSpec = 没有文档登记，也没有「交付步」要求的 PR 值，完结时 `finish-change` 一次提交整个工作区（与 simple 同一路径）。用模板而不是 TS 内建，是因为 R2 的阈值要「写在工作流 YAML 里、可以改」。 |
| R2 | 风险探针 = 一条**内联步骤测试** `diff-risk`（新测试方向 `templates/test-directions/diff-risk.yaml`，命令 `tenon test diff-risk --json`），阈值就是它的 `pass.metrics`。探针不过 → `step.next` 下发 `transition scope-expanded`。`scope-expanded` 是放弃边：离开它不要求测试、评审者、文档证据。 | 复用已有的冻结计划、阈值判定、记录链、信任与 Dashboard 显示，不给工作流 schema 加新类型字段（那要动 parse/serialize/compile/IR/快照/Dashboard 解码器二十多个文件）。放弃边免证据是必须的：没有它，探针一红，其余必需证据没齐就出不去。 |
| R3 | 内建轨道 `standard` 的路由正则覆盖「实现类」动词（中英），排除正则只放明显的重型信号；`router.sh` 里 standard 压过 frontend/backend（它们保留给被点名或重型请求）。一个都没命中、但像实现的请求，输出一行提示。 | 审计里的漏判例子必须被覆盖；提示只是兜底，不替代路由。 |
| R4 | `tenon document record <c> --all`；`tenon step run <c> [--json]`：把 `step.next` 里确定性的动作（scaffold-document、record-document、read-documents、test-plan-seed）循环执行到遇到需要作者或宿主的动作为止，打印做了什么，并附上新的 `step.next`。 | 一次调用代替约 6–8 次；附带 `next` 后省掉一次 `status`。 |
| R5 | 评审者按路径类挂载：官方 agent 文件 frontmatter 新增 `attach_on: [auth, dependency, contract, migration]`；声明了它的评审者只有本任务 diff 命中其中一类路径才进入当前步骤的评审者集合。`security` 声明 `attach_on: [auth, dependency, contract]`。 | 默认工作流的 `default.yaml` 不用改（也就不用重生成冻结物与技能矩阵）；开关跟着 agent 定义走，所有工作流一致。 |
| R6 | 现状先复现再定。HEAD 已经没有内联 `playwright` 步骤测试（590a8bb6 去掉）；本任务补回归测试钉死「一次 verify 里 Playwright 套件只执行一次」，并修复复现里还能找到的重复路径（见 §6）。 | |

## 1. R1：standard 工作流

### 1.1 形状

```text
open --open-complete--> build --build-complete--> verify --verify-pass--> done
  \--scope-expanded->     \--scope-expanded->     |  \--verify-fail--> build
                          escalated (终态) <------+--scope-expanded
```

- `open`（立项，`gate: null`）：无技能、无产出、无守卫。步骤 `prompt` 要求用一句话向用户复述目标与可验证的验收标准；只有目标含糊到没法开工才提问。
- `build`（实现，`gate: null`）：技能 `test-driven-development`；步骤测试 `diff-risk`（必需）；`test_policy`：`plan: required`、`kinds: [unit]`、`run: [unit]`、`run_if_registered: [typecheck]`、`scope: changed`、`files: registered`（与新默认的 backend Build 同一份）。
- `verify`（验证，`gate: review`）：技能 `verification-before-completion`；评审者 `code-review`（必需，`block_at: medium`）与 `security`（`required: false`，靠 `attach_on` 只在鉴权/依赖/契约路径变化时挂上）；`test_policy`：`run: [unit]`、`run_if_registered: [regression, typecheck, integration, e2e, playwright, a11y, visual]`、`scope: full`、`files: registered`。
- `done`、`escalated`：终态，无出边。

门禁只有 verify 一道评审门：一次「确认继续」。没有 explore / grilling / 访谈类技能，没有执行者（主线直接改，3 文件缺陷不值得派 builder）。

### 1.2 为什么不走 OpenSpec

`finishActions`（statusStepFinish.ts）对治理型工作流只提交归档目录，代码留在工作区，靠「交付步」的 `pr_url` 值触发交付提交；standard 没有交付步。非治理工作流则在完结时 `git add -A` 一次提交整个工作区（`chore(tenon): finish <c>`），正好是轻量通道要的。代价：没有 proposal/tasks 文档，评审者拿不到规格——所以新增官方评审者 `code-review`（§4.1），它对照派发提示里附的用户目标看 diff，不要求规格文档。

### 1.3 落点

- `templates/workflows/standard.yaml`（真相源）→ `tools/generate-default-workflow.mjs` 生成 `STANDARD_WORKFLOW_SOURCE` → `template-workflows.ts` / `identifier.ts`（`TEMPLATE_WORKFLOW_NAMES`）。
- `packages/kernel/src/tracks/builtins.ts`：`BUILTIN_TRACK_IDS` 加 `standard`；定义 `{ workflow: { default: 'standard', allowed: ['standard'] }, policyProfile: { reviewSeed: 'pending', automationEligible: false, coverageProfile: 'none', routing: { enabled: true, pattern, excludePattern, priority: 500 }, skills: { matrix: false, profile: '_all' } } }`。
- `interaction-effect.ts` / `interaction-emitter.ts` 里「内建轨道」白名单加 `standard`。
- `doctor-skills.ts` 对 `standard` 的技能计划也做一次 `compileEffectiveWorkflowPlan`。

## 2. R2：风险升级

### 2.1 探针

`tenon test diff-risk [--json] [--change <c>]`（`packages/cli/src/commands/test-diff-risk.ts`），只读 git，输出一行 JSON：

| 指标 | 含义 |
| --- | --- |
| `files_changed` | 自任务起点的代码类改动文件数（口径 = `isCodePath`：排除 openspec/、状态目录、docs/、依赖与测试缓存、Markdown） |
| `contract_files` | 命中「契约」路径类的文件数（openapi / swagger / proto / graphql / schema / contract 名） |
| `auth_files` | 命中「鉴权」路径类（auth、login、session、oauth、jwt、password、permission、rbac、acl、crypto、secret、credential 等词元） |
| `dependency_files` | 依赖清单与锁文件（package.json、各种 lock、requirements、go.mod、Cargo.toml …） |
| `migration_files` | 迁移（migrations/ 目录、migrate 词元） |
| `deleted_tests` | 被删除的测试文件（`looksLikeTestFile`） |
| `protected_test_files` | 受保护的测试配置改动数（目录、基线、已知失败清单、项目工作流；复用 `protectedChangesSinceChangeStart`） |

起点用任务起点（`changeStartOfFields`：merge-base / 创建前最后一次提交），所以工作区未提交与已提交的任务改动都算。纯函数在 kernel：`packages/kernel/src/workspace/diff-risk.ts`（路径分类 + 汇总，路径类也被 R5 使用），git 读取在 CLI。

阈值是步骤测试的 `pass.metrics`（默认写在 `standard.yaml`）：

```yaml
tests:
  - id: diff-risk
    direction: diff-risk
    command: tenon test diff-risk --json
    label: 改动风险
    timeout_s: 60
    required: true
    pass:
      metrics:
        - { name: files_changed, max: 8 }
        - { name: contract_files, max: 0 }
        - { name: auth_files, max: 0 }
        - { name: dependency_files, max: 0 }
        - { name: migration_files, max: 0 }
        - { name: deleted_tests, max: 0 }
        - { name: protected_test_files, max: 0 }
```

改阈值 = 改工作流 YAML（项目 `.pipeline/workflows/standard.yaml` 或 Dashboard 工作流页）。已冻结的任务沿用冻结值。

### 2.2 `next` 与放弃边

- `statusStep.ts`：本步有 `direction === 'diff-risk'` 的必需测试且状态为 `failed`，并且本步有 `scope-expanded` 出边时，`next` 在 `load-tenon` 之后立即只给 `[{ action: 'transition', event: 'scope-expanded', escalate: { reason, then } }]`；`reason` 取该测试未过的指标原因，`then` 是「新建 default 任务并 `tenon set <new> depends_on <old>`」。
- 没有探针的工作流（simple）行为不变。有探针的工作流里，`scope-expanded` 不再和 `build-complete` 一起以 `choose-exit` 下发（探针没红时只推荐前进边）。
- **放弃边免证据**：`scope-expanded` 事件在四处不要求证据——`step-exit-report.ts`（出边就绪不带测试/评审者/文档阻断）、`transition-step-gates.ts`（评审者与技能门）、`test-evidence/transition-gate.ts`（测试证据）、`transition-application.ts`（文档证据）。放弃一个任务不该先把它做完。评审门步骤（verify）的评审确认不免（人在场仍是规则）。
- 探针没跑或过期时是普通的 `run-test diff-risk`（已有动作），所以直接 `transition build-complete` 会被必需测试证据拒绝——越过 `next` 也绕不过去。

### 2.3 信任

步骤测试命令属于「冻结工作流里的内联命令」，首次执行前要用户在自己的终端 `tenon test trust <c>` 一次（与目录套件的信任同一条命令、同一次确认）。验收计数里按一次用户回复算。

## 3. R3：路由

### 3.1 轨道与正则

`BUILTIN_ROUTER_PATTERNS.standard`：实现类动词与对象。中文：修复/修正/修一下/修改/改一下/改成/调整/实现/新增/增加/添加/加一个/加上/补上/补一个/删除/去掉/移除/替换/重命名/重构/整理/优化/拆分/抽取/合并/提取/支持；英文（大小写不敏感，词边界用 `(^|[^A-Za-z])…([^A-Za-z]|$)`，不用 `\b`，兼容 BSD grep）：fix、add、implement、create、remove、delete、rename、refactor、extract、rewrite、update、change、make、support、patch、handle。
`BUILTIN_ROUTER_EXCLUDE_PATTERNS.standard`：只放明显重型信号——架构、跨模块/多模块/全项目/全仓/整个项目/所有文件/批量、迁移/migration、schema、数据库、鉴权/认证/登录/权限/auth/security、依赖升级、发布/部署/release/deploy、生产数据、全栈/前后端/多端、完整流程。这些落回 default 的 frontend/backend/pm。
与 simple 的关系：simple 优先级 1000，仍先吃「错字/注释/格式化」这类；standard 优先级 500，压过 frontend 300 / backend 200 / pm 100。

### 3.2 standard 压过领域轨

评分是按行计数的 `grep -c`，多行 prompt 里领域轨可能以更高分赢过 standard。`router.sh` 在打分循环之后加一步：胜者是内建的 frontend/backend 且 standard 本轮得分 > 0（没被排除）→ 改判 standard。点名轨道（`user-named`）和恢复（`state`）不受影响。

### 3.3 dispatch 与「自定义选择」判定

`CUSTOM_SELECTION_AVAILABLE` 把「非 default 工作流的路由轨道」当成项目自定义选择，会要求用户先选轨道。`standard→standard` 与 `simple→simple` 一样是插件自带的版本化策略对，豁免。新任务的 dispatch：`workflow: standard`、`phase: open`、`todo_source: tenon-phase-template`；breadcrumb 的 TAIL 说明 standard 的四步和 `scope-expanded` 升级。

### 3.4 兜底提示

没有任何轨道命中（`BEST_SCORE<=0`、无点名、非恢复）时，若 prompt 带「像在改代码」的标记（源码路径/扩展名、反引号代码、函数/方法/类/模块/接口/测试/bug/报错/崩溃 等词），输出**一行** `<workflow-state>…</workflow-state>`，内容：未命中任何轨道规则，但这像是实现类请求，当前不会被治理；确实要改代码就先调用 tenon 创建 standard 任务（`tenon init <名字> --workflow standard --track standard`），纯讨论请忽略。不输出 `<tenon-dispatch>`（不强制），讨论类前缀的早退仍在它前面。

### 3.5 缓存契约

`ROUTER_CONTRACT_REV`（router.sh 里的 hex）是 `routerContractRevision(manifest)` 的钉死值，内建轨道定义变了就要更新；由现有单测给出新值。

## 4. R5 与评审者

### 4.1 新官方评审者 `code-review`

`templates/agents/code-review.md`：只读；对照派发提示附带的用户目标与验收标准，看 diff 的正确性、回归风险、测试是否真的覆盖了改动、夹带；没有目标就从 diff 与测试推断并写进报告的「假设」一节，不要求规格文档。登记：`tools/check-agents.mjs` 的 INVENTORY、`templates/agents/manifest.json`（`--write` 重写）、`tools/test-bundle.sh` 清单、`docs/usage/agents.md`（中英）。

### 4.2 `attach_on`

- `AgentDefinition.attachOn?: readonly PathClass[]`；frontmatter `attach_on: [auth, dependency, contract, migration]`，值域是闭集。`parseAgentFile` 校验；agent 文件原文写回，往返保真。
- `StepAgentsInput` 增加可选 `unattached?: readonly string[]`（评审者名）；`projectStepAgents` / `evaluateStepAgents` / `nextAgentWave` 统一通过一个内部 `reviewersOf(input)` 过滤——调用方只负责算出 `unattached`。缺席 = 全部挂载（旧行为）。
- 计算：`unattachedReviewers(step, frozen, classes)`（kernel，纯函数）。`classes` 是本任务 diff 命中的路径类集合；读不出 diff（git 失败）时视为全部命中（失败关闭 = 评审者挂上）。
- 调用点：`agentGate.ts`（transition/check 的阻断）、`statusStepAgents.ts`（`step.reviewers`、波次编号）、`commands/agent.ts`（`agent next/prompt`，没挂载的评审者 `prompt` exit 2 并说明）、`server/agentRuns.ts`（Dashboard 投影与 readiness）。四处用同一个 kernel 函数。
- `security.md` 加 `attach_on: [auth, dependency, contract]`，`manifest.json` 摘要同步。已冻结任务里的 security 副本不带这个键，行为不变。

## 5. R4：批量命令

### 5.1 `tenon document record <c> --all`

`record <c> [kind] [path] --all [--producer p]`：对当前步骤 `step.documents.records` 中文件已存在、状态为 `missing` / `stale` 的文档逐个登记，producer 取该槽第一个合法 producer（`--producer` 可覆盖）。已是 `current` 的跳过（幂等）。骨架占位符未填、producer 技能没加载等逐项报告，不中断其余项；有失败项退出码 2，全部成功或无事可做退出码 0。输出每项一行。

### 5.2 `tenon step run <c> [--json]`

循环（最多 8 轮）：读 `step.next`，当前一波里的动作按下表处理，遇到不在表里的动作就停下。

| 动作 | 处理 |
| --- | --- |
| `scaffold-document` | `document scaffold`（路径要 `--capability` 的留给作者） |
| `record-document` | 文件存在且已填 → `document record`；没填 → 记为「等作者」并停 |
| `read-documents` | `document read <c> all` |
| `test-plan-seed` | `test plan <c> --seed` |
| 其余（`load-tenon`、`load-skill`、`run-agent`、`fix`、`run-tests`、`run-test`、`request-review`…） | 停；它们要宿主或作者 |

幂等：没有可做的事就什么都不改，退出码 0。输出「做了什么 / 停在哪 / 为什么」，`--json` 给结构化结果并带最新的 `step`（`next` 可以直接当下一轮的输入，不必再 `status`）。复用现有命令函数，不另写业务逻辑；动作调用顺序就是 `next` 给的顺序。

## 6. R6：Playwright 一次 verify 跑两遍

复现结果（HEAD）：默认工作流已经没有内联 `playwright` 步骤测试，目录里的 Playwright 套件（种类 `playwright`）只被阶段运行集（`planRunSet`）按套件 id 去重后跑一次。仍可能重复的路径：

1. 项目或全局里保存着 0.2.0 时期的 `default.yaml` 副本，Verify 里还留着内联 `playwright` 测试，同时目录里有 Playwright 套件——同一个命令跑两遍。
2. `e2e` 评审者（agent）自己再起一遍项目的 Playwright 套件。

做法：钉回归测试（一次 verify 走完整条 `next`，假 Playwright 可执行文件计数 = 1）；对 1，让 `next` 不再对「方向是 playwright/e2e、而目录里已有同种类且本候选已通过的套件运行」的内联测试下发 `run-test`；对 2，在 `e2e` 评审者正文里写明「目录套件的结果由 Tenon 执行并随提示给出，不要重跑项目的 Playwright 套件，只走套件没覆盖的用户路径」。具体是否需要 1 以复现为准，见实现记录。

## 7. 验收

- 集成测试 `standard-lane.integration.test.ts`：3 文件缺陷（真 git 项目、node:test 单元套件、一个故意写错的 `src` 文件加 2 个调用方）在 standard 通道从 init 走到 `stop finished`；harness 计数每一次 `tenon` 调用（含 status / step run）≤ 25，用户回复（评审确认 + 一次信任）≤ 2。
- 升级测试：改 9 个文件 / 动 package.json / 删测试文件，探针红，`next` 是 `scope-expanded`，转换成功，状态 `escalated`，随后能建 default 任务并 `depends_on`。
- 路由测试：`tools/test-hooks.sh` 补审计里的漏判例子（英中各一）、提示一行、重型信号仍回 default、点名轨道优先。
- kernel/cli 单测：路径分类、diff-risk 汇总、`attach_on` 解析与过滤、放弃边免证据、`step run` / `record --all` 幂等。
- 文档：routing-and-workflows（中英）、cli-reference（中英）、default-workflow（中英）、agents（中英）、release-notes 一行；SKILL.md 动作表补 `transition` 的 `escalate` 载荷与 `step run`。

## 8. 实现记录（与上面设计的差异与补充）

- **放弃边的 next 处理放在 `exitActions`**：`scope-expanded` 永远就绪，却从来不是「走完这一步」的候选，所以 `exitActions` 的前进边候选统一排除放弃边
  （simple 也受益：不再把 `change-complete` 与 `scope-expanded` 挤成 `choose-exit`）。升级信号（探针红）才下发它。
- **信任预告**：`run-tests` / `run-test` 在命令还没被用户信任时带 `trust`（命令清单 + 要用户在自己终端运行的 `tenon test trust <c>`），
  省掉一次白跑的拒绝；执行前的校验不变。
- **探针不数「自动识别写出的第一份测试目录」**：`tenon init` 为没有目录的项目写 `.tenon/tests/catalog.yaml`，它仍列进评审请求等用户确认，
  但不让每个新项目的第一个任务都升级；已有目录的修改 / 删除、基线、已知失败清单、项目工作流的任何改动照常计数。
- **harness**：`diffChanges` 默认抛错（临时项目不是仓库 = 读不出改动 = 评审者全部挂载，失败关闭）；`TENON_TEST_REAL_DIFF=1` 走真 git。
  PATH 上的 `tenon` 桩对 `test diff-risk` 默认返回「在限内」，`TENON_TEST_REAL_DIFF=1` 时转交 `packages/cli/dist/main.js`。
- **router**：除设计里的三条（standard 压领域轨、自定义选择豁免、兜底提示）外，加了第四条——standard 被重型信号排除、却确是实现类请求、又没有任何轨道
  认领时回落 backend 轨（`新增用户登录鉴权` 这类，否则既没有路由也没有提示）。server 的 router 预览镜像了两条 standard 规则。
  `MAX_TRACKS` 随内建轨道数 +1（34）；router.sh 的 cache 容量上限同步 +1（33/34），自定义轨道上限 27 不变。
- **R6 结论**：HEAD 的默认工作流没有内联 `playwright` 步骤测试（590a8bb6 去掉），F12 的直接原因（内联测试 + 目录套件）已消除。本任务补了
  `playwright-once.integration.test.ts`（结构：默认与 standard 只剩 code-size / design-system / diff-risk 探针；行为：frontend verify 里套件只执行一次，
  之后 `next` 不再要求跑）并让 `e2e` 评审者（1.1.0）不再重跑项目的 Playwright 套件。0.2.0 冻结的在途任务和复制过的项目工作流仍带内联测试，不改它们的证据语义。
- **验收计数**（`standard-lane.integration.test.ts`）：23 次 tenon 调用（含 init / activate / workflow plan / 每次 step run / test run / agent prompt+record /
  review request / transition）、2 次用户回复（`tenon test trust` 一次、评审门「确认继续」一次）；hook 触发的 6 次技能回执不算助手调用。
