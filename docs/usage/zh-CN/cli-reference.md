# CLI 参考

本页列出常用 tenon 命令族。精确参数以 `tenon <command> --help` 为准。

## Setup 与运行时

```bash
tenon setup --codex
tenon setup --claude
tenon update --codex
tenon host-target-plan --json
tenon host-target-plan --host codex --operation setup --json
tenon --version
tenon doctor --json
tenon runtime status
tenon runtime repair --rollback
tenon dashboard --open
```

`tenon --version`（`-V`）打印这条命令所在插件载荷的版本号（插件清单里的版本）；已安装的运行时上它就是 `tenon doctor` 里 `runtime=` 的那个数字。不需要项目，也不改任何东西。

`tenon dashboard --open` 负责登录：已在运行（或刚启动）的 server 自己用一次性登录链接打开你的浏览器，链接不会返回给这条命令，所以页面打开时已是登录状态。直接运行 `tenon dashboard` 会在前台启动 server，并把链接打印到交互终端；读取 server stdout 的启动者可用 `TENON_DASHBOARD_PRINT_LINK=1` 要求打印。详见[登录](dashboard-and-local-api.md#登录)。

`host-target-plan` 是机器可读的只读契约。仅传 `--json` 时返回已注册宿主目录；同时传入
`--host` 与 `--operation setup|update` 时返回一个 `host-target-plan/v1` 计划。
它不会执行 setup/update，也不接受自定义宿主 ID。原生宿主计划面向用户级安装；适配器宿主
计划固定使用 `--target .`，复制或运行前必须先进入目标项目目录。

## Change 与状态

### Interaction observability

```text
tenon interaction scorecard <fixture-dir> --json
```

该只读命令重放 tracked v1 JSON fixtures，输出确定性的
tenon-interaction-scorecard/v1 JSON：三项固定指标、completeness、accepted stale、
same-state repeats、invalid resumes、diagnostics 及 unclassified extension codes。
存在时每个 Change 的 projection 是普通非 symlink 文件 .pipeline-interactions.jsonl；
projection 写失败只在 canonical 成功后 warning，不改变 canonical state。闭合 codec
拒绝 prompt、token、credential 与 artifact 字段。

```bash
tenon init <name> --track <track> --preset <preset>
tenon init <name> --track frontend --preset full --document-locale zh-CN
tenon list --json
tenon status <name> --json
tenon workflow plan <name> --json
tenon get <name> <field>
tenon set <name> <field> <value>
tenon transition <name> <event>
tenon check <name>
```

不要用 `set phase` 绕过 workflow event。canonical state 和 YAML projection 只能由 CLI 写。

`tenon workflow plan <name> --json` 是 Agent 编排在途 Change 的单一读取入口。它优先返回
WorkflowRun 初始化时冻结的完整计划，包括步骤、Skill、门禁、守卫、产物和转换。后来修改或删除
`.pipeline/workflows/<workflow>.yaml` 只影响新运行，不会改写已有运行的 Todo 和 Skill DAG。

`tenon status <name> --json` 还带一个 `step` 块：单个 `tenon` skill 执行当前步骤所需的全部输入
——本步技能、执行者、评审者、测试、文档、字段、评审回执、带阻塞原因的出口，以及一份闭集的
`next` 动作表，按序执行即可。`run-tests` 与 `run-test` 在将要执行的命令还没有得到用户信任时带一个 `trust` 对象
（先请用户在自己的终端运行 `trust.command`）。带 `escalate` 的 `transition` 表示任务已经超出了它的通道：
standard 通道的风险探针没通过，`escalate.reasons` 点名被突破的阈值，`escalate.then` 说明转换之后另开一个 `default` 任务。

```text
tenon step run <change> [--json]
```

`step run` 一次做完 `step.next` 里确定性的那部分，并说明做了什么：`scaffold-document`（`document scaffold`）、
`record-document`（`document record`，文件已存在且骨架占位符已替换才做）、`read-documents`（`document read <change> all`）
和 `test-plan-seed`（`test plan <change> --seed`）。遇到需要宿主或作者的动作就停下（加载技能、派发 agent、写文档内容、
跑测试、评审、转换），写明停在哪、为什么，并附上最新的 `step.next`，之后不必再 `status`。它幂等：无事可做就什么都不改、
退出码 `0`；某条命令被拒绝退出码 `2`，已做完的部分保留。`--json` 输出 `{ change, step_id, did[], stopped, step }`。

```text
tenon spec apply <change> [--dry-run] [--json]
```

`spec apply` 在 `openspec/` 的临时整拷里跑 `openspec validate --strict`、`openspec archive`
与逐 capability 的严格复验，再把改到的主规格字节按 compare-and-swap 写回，并登记
`applied-spec.md`。`--dry-run` 除回执外不写任何文件。退出码：`0` 通过，`1` 用法或状态，
`2` 校验或彩排失败，`3` PATH 上没有 openspec，`4` 主规格在彩排期间被改过。

## 身份与负责人

```text
tenon user [--json]
tenon user set <邮箱> [--name <名字>]
tenon owner take <change>
tenon owner set <change> <邮箱> [--name <名字>]
```

身份是自报的，不做认证。`tenon user` 依次取 `TENON_USER`、本机 `user.json`、
`git config user.email`，输出 `名字 <邮箱> 来源`；没有身份时退出码 `1`（`--json` 仍输出
`{"user":null}`）。`tenon user set` 写本机 `user.json`；设置了 `TENON_USER` 时它仍优先，并在
stderr 提示。

`tenon owner take` 把负责人改为当前用户；`tenon owner set` 把任务移交给另一位用户，只有当前负责人
可以执行。两者都输出新负责人 `名字 <邮箱>`，并在 history 里记一条 `assignee` 变更；change 名或邮箱
非法、身份缺失、找不到任务、非负责人移交都以 `1` 退出。

## 文档证据

```bash
tenon document init <change>
tenon document scaffold <change> <kind>
tenon document scaffold <change> delta-spec --capability <capability>
tenon document record <change> <kind> <path> --producer <skill>
tenon document record <change> --all [--producer <skill>]
tenon document read <change> all
tenon document status <change> --json
```

scaffold 只创建缺失结构，不登记 producer；delta spec 必须显式提供真实 capability；record 必须对应真实 Skill。Change 语言固定在 `.pipeline-document-locale.json`，不写入严格 canonical schema，以保持旧版本回滚兼容。

## 项目规格骨架

```bash
tenon scaffold spec web
tenon scaffold spec cli --spec-dir docs/specs
tenon scaffold spec lib --document-locale en
```

项目规格骨架也默认生成中文。只有显式传入 `--document-locale en` 才生成英文；路径、命令、OpenSpec 与
workflow token 始终保持英文。冲突策略使用 `--strategy skip|overwrite|append`。
`overwrite` 会在可信项目根下先构建完整顶层项目 envelope，再以持久事务收据提交；进程在目录
切换中崩溃时，下一次调用会先恢复上一事务。检测到仍存活的 writer，或旧 envelope 移走后正式
路径被未知内容占用时，命令会 fail-closed 并保留 lock/stage/backup 恢复证据。

## Review

```bash
tenon review request <change> --event <event>
tenon review acknowledge <change>
tenon review acknowledge <change> --delegated
tenon review acknowledge <change> --as reviewer
```

delegated 需要 Change 绑定的持续授权，且不能跳过 check。

谁能确认评审：任务负责人，与任务上其余写操作（`transition`、`set`、`review request`）一致。负责人之外的人评审
负责人的工作，要显式写 `review acknowledge <change> --as reviewer`；这次确认会在 change 历史里记
`as=reviewer owner=<id>`。不带该标志的非负责人被拒绝、不写任何东西；另一条路是 `tenon owner take <change>`，
它会转移负责人。Dashboard 的「通过」由顶栏用户确认。

`review acknowledge` 退出码：`0` 已确认、重复确认或确认成功但 review marker 清理告警；`2` 没有匹配的待确认
review（缺失、已被消费、binding 失效或 event 已不是 workflow 出口）；`3` revision 冲突（仅 Dashboard CAS
路径）；`4` 幂等键冲突；`1` 非法命令（例如 `--event` 与待确认 receipt 不一致）或意外错误。失败时不写入任何内容。

`review request` 还会冻结并列出测试计划里尚未批准的豁免（`waivers[].approved_by` 为空）。人工的
`review acknowledge` 在提交 approved receipt 的同一把锁内，只给这些豁免写上 `approved_by`，并在 change 历史里留一行
`test:waiver-approve`；`--delegated` 从不批准豁免，计划里有待批准的豁免时它被整个拒绝（不写任何东西，评审仍待确认）；请求之后才加进计划的豁免
也不在那次确认里（`step.next` 会先要求重新发起请求）。Dashboard 复核决策台的「通过」是同一种人工确认：
列出并批准同一份冻结清单，留同一行 `test:waiver-approve`。计划写入与基线更新同样各留
`test:plan-write` / `test:baseline-update` 一行。同一份冻结清单还带着任务里受保护的测试配置改动（目录、基线、已知失败清单、
项目工作流，见「测试证据的可信根」），批准它们留一行 `test:protected-approve`。

自动评审与人工确认是两套不同边界：前者是步骤声明的 agent，后者是 `gate: review`，可以叠加。

```bash
tenon agent next <change> [--json]
tenon agent prompt <change> <agent> [--host <id>] [--rerun-reason <text>] [--json]
tenon agent record <change> <run-id> [--subagent <type>] [--host <id>] [--json]
```

工作流在步骤里声明执行者与评审者；Tenon 只排顺序、渲染交接内容、记录结论与校验候选版本，
模型一律由宿主跑。`next` 给出本波要跑的 agent，`prompt` 开始或续跑一个 agent 并打印交接内容，
`--host claude|codex` 时为宿主生成 `tenon-<name>` 专属子代理文件并返回 `subagent_type`；
`record` 读报告末尾的 ```tenon-result``` 块登记结论，`--subagent` 记下实际用的子代理。评审结论由
Tenon 从问题级别与 `block_at` 计算，评审者不自报结论。同一候选（同一份代码）上评审者的每一次运行都保留，结论取最严的一次，
所以重跑翻不掉一条发现：评审者在当前候选上已有结论后，`agent prompt` 拒绝再开一次（exit `2`），除非改了代码，或用
`--rerun-reason <原因>` 写明为什么重跑——带原因的那次以它为准，原因留痕。`agent next`、`status --json`（`step.reviewers[]`）
与 Dashboard 显示重跑次数（`reruns`）、结论是否翻转（`flipped`）和原因（`rerun_reason`）。

**跨厂商评审。** 工作流步骤里的评审者可以声明 `host: codex | claude | any`（Claude 写、Codex 审），智能体定义也可以用自己的
`host:` 一行建议一个（`tenon agent new --host`）。步骤的声明是硬要求，智能体的建议只用于路由，步骤写 `host: any` 盖过建议。
执行 `tenon agent prompt` 的宿主不是要求的宿主（或检测不到宿主：纯终端）时，运行行照常创建，但提示词不再打印，而是写进
`openspec/changes/<change>/.pipeline-agent-reports/<run-id>.prompt.md`，并给出确切的命令：

```text
[ROUTE] 评审者 'security' 须在 codex 上运行 …；当前宿主：claude
提示词：openspec/changes/demo/.pipeline-agent-reports/<run-id>.prompt.md
运行：codex exec --sandbox workspace-write - < <提示词文件>      # 要求 claude 时是：claude -p --allowedTools "…" < <提示词文件>
登记：tenon agent record demo <run-id> --host codex
```

`--json` 时同样的信息在 `host` 里：`{ required, source: step|agent|none, enforced, current, run_on: { host, command, prompt_file, record } | null }`，
完整的 `prompt` 仍然返回。Tenon 从不自己起另一家的 CLI：命令由你、或当前宿主里的 agent 去执行。`tenon agent record` 记下
跑这次评审的宿主（`host`）以及怎么得知的（`host_source`：`detected` = 进程环境判出；`declared` = 用 `--host` 声明，
即编排方的宿主通过另一家 CLI 跑完评审后由它登记）。裁决照旧绑定候选（被评审代码的内容哈希）：评审期间候选变了，登记被拒；
之后改了代码，裁决过期。步骤要求了宿主时，登记的宿主不符或未知，登记被拒（exit `2`，什么都不写）；台账里已经有的不符记录
（绕开命令写的，或早于这条要求）不算裁决：`agent next` / `status` 显示 `wrong_host`，状态是 `stale`，离开步骤被
`reviewer-wrong-host` 拦下，这类运行也不算"已有结论"，所以在对的宿主上重跑不需要 `--rerun-reason`。宿主是登记者的声明
（与台账其余部分同一信任模型），不是密码学证明。`agent next --json` 与 `status --json`（`step.reviewers[]`）带 `required_host`、
`host`、`host_source`、`wrong_host`（`status` 还有 `route_host`），评审者应在别处运行时 `run-agent` 动作带 `host`。
先按 `attach_on` 挂载：没挂载到本任务的评审者不列出、不路由、不等待，也不检查它的宿主，所以不会报 `reviewer-wrong-host`；
宿主规则只作用于已挂载的评审者。

智能体库在终端登记（详见[智能体](./agents.md)）：

```bash
tenon agent list [--role executor|reviewer] [--source official|custom|project] [--json]
tenon agent show <name> [--json]
tenon agent new [<name>] --role <role> --description <text> [--skills a,b] [--tools A,B] [--model <m>] [--hosts a,b] [--host codex|claude|any] [--scope user|project] [--from <agent>]
tenon agent add <file> [--scope user|project] [--replace]
tenon agent validate <file|name>
tenon agent copy <from> <to> [--scope user|project]
tenon agent rm <name> [--scope user|project]
tenon agent export <name> --host claude|codex
```

`document record --all` 一次登记当前步骤所有「文件已经写好」的文档，每份都走 `document record` 自己的全部校验（占位符、producer 的技能回执、
负责人、归档闸）：本步产出但缺失或已过期的、本步可改而登记后又变了的输入，以及已调用技能还欠的文档。producer 取本步接受且本次访问已调用的那个
（`--producer` 可覆盖）。已是最新的不动，没写或仍含 `[待填写…]` 占位符的列出并跳过，路径要作者定名的（没带 `--capability` 的 delta spec）也跳过；
只有登记被拒才退出 `2`。评审者可在 agent 文件里声明 `attach_on`（`auth`、`dependency`、`contract`、`migration`）：只有任务的改动碰到这类路径，
它才进入该步骤的评审者集合——`agent next`、`status --json` 与 Dashboard 不再列出没挂载的评审者，`agent prompt` 对它退出 `2`。

退出码：`0` 正常；`1` 用法、IO 或记录损坏；`2` 被拦下（未轮到、宿主不支持、评审期间候选已变化）。

```yaml
name: release-train
steps:
  - id: verify
    label: 验证
    gate: review
    skills:
      - id: acme-quality-gate
    agents:
      reviewers:
        - agent: security
          required: true
          block_at: medium
        - agent: code-size
          required: true
          block_at: medium
          reads_tests: [code-size]
        - agent: architecture
          required: false
          block_at: high
          depends_on: [security, code-size]
```

`required` 的评审者全部通过才能离开该步骤；`required: false` 的只报问题、不拦。
`reads_tests` 引用同一步骤声明的测试，结果由 Tenon 执行后交给评审者。agent 定义放在
全局 agent 库，任务创建时随工作流一起冻结进 `<change>/.pipeline-frozen/`，之后改库不影响
进行中的任务。

## 测试

```bash
tenon test discover [--write] [--json]
tenon test catalog show [<id>] [--json]
tenon test catalog validate [--json]
tenon test catalog add [<id>] [--from <方向>] [--kind <k> --command <cmd> …] [--service --start <cmd> …]
tenon test catalog set <id> [同上选项] [--service]
tenon test catalog rm <id> [--service]
tenon test catalog not-applicable <kind> --reason <原因> | --rm
tenon test plan <change> [--seed] [--json]
tenon test register <change> --auto
tenon test register <change> --suite <id> [--scope full|changed|files|grep] [--pattern <regex>] [--select-file <path>]…
tenon test register <change> --file <path>… [--suite <id>] [--kind <kind>]
tenon test register <change> --case <covers> --test "<文件> › <用例名>"…
tenon test unregister <change> --suite <id> | --file <path> | --case <covers> [--test <ref>] | --waiver <种类|场景>
tenon test waive <change> (--kind <k> | --covers <covers>) --reason <原因>
tenon test sync <change> [--json]
tenon test trust [<change>] [--yes] [--status] [--json]
tenon test run <change> [--suite <id>]… [--kind <k>]… [--stage [<step>]] [--all] [--changed] [--json]
tenon test run <change> <test-id> [--json]
tenon test status <change> [--step <id>] [--json]
tenon test integrity <change> [--step <id>] [--json]
tenon test baseline <change> --suite <id> --run <run-id>
tenon test baseline <change> <test-id> --run <run-id>
tenon test known add --suite <id> --test "<文件> › <用例名>" --reason <原因> --expires <YYYY-MM-DD> [--link <url>]
tenon test known rm --suite <id> --test "<文件> › <用例名>"
tenon test known list [--json]
tenon test report <change> [--step <id>] [--write <path>] [--locale zh-CN|en]
tenon test code-size [--base <ref>]
tenon test diff-risk [<change>] [--json]
```

测试分三层登记。项目**目录**（`.tenon/tests/catalog.yaml`，进 git，人可直接改）说明项目有哪些套件、怎么跑：
`kind`、`runner`、`command`、`cwd`、报告格式与路径、可选的覆盖率、产物路径、`select` 模板（`{files}` / `{pattern}`）、
`services`、`retries`、`parallel`，基准套件还有 `benchmark` 段。报告、覆盖率与产物路径必须在 `test-results/`、
`playwright-report/` 或 `coverage/` 之下（声明不可能借此藏起源码）。把运行记录绑到代码上的工作区指纹，只忽略目录声明的路径
（报告、覆盖率与 `artifacts`，按套件 `cwd` 换算）和在途任务冻结工作流里内联测试的 `outputs`：任意层级里没有声明的
`coverage/`、`test-results/` 目录都算候选的一部分。任务**计划**
（`openspec/changes/<change>/test-plan.yaml`）列出本任务用到的套件、新增或修改的测试文件、场景 / 任务 → 用例的映射
（`spec:<capability>/<Scenario 标题>` 或 `task:<编号>`）和豁免。计划只经 `tenon test` 命令写入，每次写入把摘要记进
任务目录里的台账，手改文件就是 `test-plan-tampered`。工作流**策略**（`steps[].test_policy`）说明一个步骤要什么：
必须登记的种类、必须运行的种类、最小范围、覆盖率门槛、flaky 上限、基线要求、浏览器、场景覆盖与 `files: registered`。
仍写着内联 `tests[]` 的步骤照旧可用：照旧运行，并和策略一起判定。默认工作流是零豁免的：只强制 `unit`，其余种类都是
`run_if_registered`（见[默认工作流](./default-workflow.md)）。

某个种类对整个项目都不适用时，在目录里声明，不必每个任务各豁免一次：`test catalog not-applicable <kind> --reason <原因>`
在 `catalog.yaml` 写入 `not_applicable: [{kind, reason, approved_by}]`（`--rm` 撤销）。它要经一次人工确认才生效：
`review request` 把它以 `not-applicable:<kind>` 和计划里待批准的豁免一起列出，`review acknowledge`（不含 `--delegated`）批准它并把
批准人记进 `approved_by`；在此之前策略仍要求这个种类，报 `waiver-unapproved`。改理由会让批准清零。

`test discover` 扫描包脚本与各工具配置（vitest、jest、mocha、node:test、Playwright、tsc、eslint、pytest、go），
给出带推荐 reporter 参数的建议套件，让每个套件都产出可解析的报告；`--write` 追加目录里还没有的 id。
声明了 `test_policy` 的工作流在项目没有目录时，`tenon init` 会替你跑它并在 stderr 说明（没有识别到测试工具就不写，已有目录一律不动）。
JavaScript 单测套件在工具配置里没有 `include` 时，测试文件 glob 覆盖 `src/`、`test/`、`tests/`、`__tests__/` 和根目录下的
`*.test.*` / `*.spec.*`（这几个目录一个都没有时，取套件 `cwd` 下任意位置的 `*.test.*` / `*.spec.*`）。
vitest 工程里的 `*.bench.*` 文件会识别成 `vitest-bench` 基准套件，指标取自能读出的每个 `bench('名字', …)`（`<名字>.mean_ms`，读不出
名字的不猜）；其它 `bench` 脚本只给出登记它的 `catalog add` 命令，因为基准必须声明指标与阈值。
基准命令跟着工程的 vitest 主版本走：先看实际安装的 `node_modules/vitest/package.json`（从工程目录向上到仓库根，取最近的
`node_modules`），没装才看 `package.json` 里声明的 `vitest` 范围。vitest 3 和 4 用
`npx vitest bench --run --outputJson=test-results/bench.json`；vitest 5 删掉了 `--outputJson`（模块级的 `bench()` 导入也没了，
基准要写成 `test('…', async ({ bench }) => { await bench('名字', fn).run() })`），所以 vitest 5 及以上用
`npx vitest bench --run --reporter=default --reporter=json --outputFile.json=test-results/bench.json`。
两者都写 `test-results/bench.json`，套件的报告格式仍是 `benchmark-json`；解析器把两种形状读成同样的
`<基准名>.mean_ms`、`.p99_ms`、`.hz` 样本（vitest 5 取 json reporter 里 `benchmarks[].tasks[]` 的 `latency.mean`、`latency.p99`（毫秒）
和 `throughput.mean`（每秒次数）；`bench.from()` 读回的存档结果不是这次测的，跳过），所以目录里声明的指标名不用改；两代 vitest 的统计引擎
不同，数值不保证可比，升级主版本后用 `tenon test baseline` 重建基线。
读不出主版本时（vitest 没装、`package.json` 里的写法也定不下主版本，例如 `latest`、`workspace:*`、`catalog:`、`>=3`），discover
不生成基准套件——同一条命令对一个主版本是对的，对另一个就直接 exit `1`：改为给出带两种命令的 `catalog add` 提示，装好依赖后重跑
`tenon test discover`，或照提示手工登记。vitest 5 及以上，bench 文件里还从 `'vitest'` 导入模块级 `bench` 的
（`import { bench } from 'vitest'`、`import { describe, bench } from 'vitest'`，多行导入与 CommonJS `require` 也算）必然报
`bench is not a function`，所以 discover 同样不生成这个套件：改为给出一条提示，点名这些文件和 fixture 写法
（`test('…', async ({ bench }) => { await bench('名字', fn).run() })`，选项放第二个参数 `bench(名字, 选项, fn)`）；迁移后重跑
`tenon test discover`。
`catalog add --from <方向>` 用测试方向起步（裸的工具调用会换成该 runner 的推荐调用）；`catalog validate` 逐条列出
`catalog.yaml:<行>: …`（有问题 exit `2`）。`test plan --seed` 补上「拥有或覆盖了本任务改动文件」的套件、策略要求的每个种类
的套件、改动的测试文件，并列出还没映射的场景与任务，附可直接执行的 `register --case` 命令；策略里 `run_if_registered` 的种类
只要目录里有套件也一并登记（基准除外）。只有场景和 `tasks.md`「实现」（`build`）小节下的任务要求映射
（`scenarios: required|passing` 对它们出阻塞）；其他阶段小节的任务单列为可选（验证报告里写「可选」而不是「未覆盖」），永不挡；
骨架提示词（「将本阶段目标拆成可验证任务」）不是作者写的任务：种子、`test sync`、`test plan` 不再列它，追溯矩阵里它显示为可选。`test register <change> --auto` 是一条命令的形态：缺目录先识别，
把没有套件认领的测试文件并进套件的 `files` glob（`test/x.test.js` 得到 `test/**/*.test.js`；`e2e/` 下的用例进 Playwright 套件，
辅助文件和 `*.bench.*` 不会自动认领），再生成计划初稿并登记这些文件；只增不减，可重复运行。`test sync` 拿本任务相对起点的
diff 对账：未登记的测试文件、没有套件认领的文件、登记了但文件已不存在的项，与门禁是同一份计算（有待处理 exit `2`）。

任务的起点是与基线分支的 merge-base；直接在基线分支上做时取任务创建之前的最后一个提交；diff 包含暂存、未暂存与
未跟踪文件。读不到 diff 时门禁以 `files-diff-unavailable` 阻塞（失败关闭，不降级成提示）。

`test run` 每次调用写一份 v2 记录（`.tenon/users/<slug>/tests/<change>/<run-id>.json`），按 `prev_digest` 串成链；
手改记录就断链，该任务的全部 v2 记录视为未运行，直到重跑另起新链。记录按设计入库（它们是别人和 CI 读的证据），所以数量可以设上限：
设 `TENON_RECORD_RETENTION=<n>`，每次运行之后每个用户每个任务只保留最新的 `n` 条（内联步骤测试固定按测试项保留最新 20 条）。
默认不清理，因为上一个发行版（v0.2.1）读不了清理过的链（见
[更新、恢复与卸载](updates-recovery-and-uninstall.md) 里「与上一个发行版（v0.2.1）的兼容」）。
设置之后，清理删掉最老的一段，并在记录旁留一个
`chain-base` 标记，写明被删的最后一条的摘要，剩下的链仍可校验；中间缺记录、标记对不上或标记损坏，照旧是断链。测试进程的 `PATH`
最前是正在运行的 `tenon`（启动器所在目录；直接 `node …/tenon.mjs` 跑时是一个转发脚本），所以没有启动器在 `PATH` 上的环境里
`tenon test code-size --json` 也能跑；宿主自己的 Bash 解析不到 `tenon` 时 `tenon doctor` 的 `env:path-tenon` 会提示。交付提交从不包含
`.pipeline-owned.json`、`test-results/`、`playwright-report/` 和仓库根的 `coverage/`；生成的 `tenon-<name>` 宿主 agent 文件与这些输出目录
会加进本克隆的 `.git/info/exclude`（不改项目的 `.gitignore`）。选择：`--suite`、`--kind`、`--all`（计划里的全部
套件，全量）、`--changed`（套件有 `select.files` 模板且只改了它的测试文件时只跑这些，否则整套跑）、
`--stage [<step>]`（该步骤策略的 `run` 种类，加上计划登记了的 `run_if_registered` 种类；策略要求 `scope: full` 时一律
全量）。没有任何选择参数时缺省就是 `--stage`。`--stage` 只跑目录套件：内联的 `tests[]`（套件 id 以 `step:` 开头）仍走
`tenon test run <change> <test-id>`，摘要会列出还要跑的命令；策略没有要运行的套件时如实说明并 exit `0`。声明的服务每次调用只启动一次，独立进程组，按 URL / 端口 / 日志文本探测就绪，
结束后整个进程组连孙进程一起回收；启动前 URL 或端口就已经在响应会被拒绝——测试会打到旧服务上。`parallel: true` 的套件并发，
其余依次。报告按用例解析：`junit`、`playwright-json`、`vitest-json`、`jest-json`、`go-json`、`tap`；基准读 `benchmark-json`
（也认 hyperfine 与 vitest bench 的输出：vitest 3 / 4 的 `--outputJson` 文件和 vitest 5 的 json reporter）、`k6-summary`、`lighthouse-json`；覆盖率读 `istanbul-summary`、`lcov`、
`cobertura`，`changed_lines` 由 diff 算出。每次执行前先删掉上一次留下的报告。一次运行会因这些判失败：没有报告
（`report-missing`）、报告无法解析（`report-unreadable`）、0 个用例或全部跳过（`no-tests-ran`）、退出码与报告不一致
（`exit-report-mismatch`）、已登记的文件或映射的用例没有出现在报告里（`registered-test-not-executed`）、覆盖率低于策略
（`coverage-below`）、基准退化超过指标阈值（`benchmark-regression`）、flaky 超过策略上限（`flaky-over-limit`）、要求的浏览器
project 不在报告里（`browser-project-missing`）、服务没有就绪（`service-not-ready`）。失败用例按 `retries` 重试（Playwright
补 `--retries`，其他 runner 经 `select.grep` / `select.files` 只重跑失败用例）；重试后通过的用例记为 `flaky` 并计数。已知失败清单
之外的失败都判套件失败。截图、trace、视频、HTML 报告按文件复制进本次运行的产物目录并建立索引（`{path, bytes, digest, media}`），
可打开或下载。退出码：`0` 全部通过、`2` 有套件失败（记录已落盘）、`1` 用法或环境错误（不落记录）。运行结束会重新计算本步骤的
出口检查并打印，每个仍在挡的项带修复命令；`--json` 输出记录全文与出口检查。

node:test 的报告要求每个用例都带 `file`，而 Node 22 及以前不写：内置的 `--test-reporter=junit` 不给 `<testcase>` 写 `file`
（Node 24 才写），没有额外处理时，追溯表、已登记用例的核对和运行详情都无法把用例对应到测试文件。所以 `test discover` 给
node:test 套件的命令是 `node --test --test-reporter="${TENON_NODE_TEST_REPORTER:-junit}" --test-reporter-destination=test-results/junit.xml`：
`tenon test run` 把随 CLI bundle 分发的一个小 reporter 写进本次运行自己的产物目录
（`.tenon/users/<slug>/local/artifacts/<change>/<run-id>/reporters/`，不会写进项目目录树），并把 `TENON_NODE_TEST_REPORTER`
设成它的 `file:` URL，于是 Node 20、22、24 上的报告都带 `file`；不经 `tenon test run`、手工跑同一条命令时变量为空，退回内置 `junit`。
命令依赖 POSIX 的 `${VAR:-default}` 展开，和 Playwright 预设的 `VAR=value` 前缀一样。JUnit 解析器按 `testcase@file`、像路径的 `classname`、
外层 `testsuite@file`、像类名的 `classname`（如 `com.example.MathTest`）的次序确定用例文件；node:test 的 `classname="test"`、
`utils.js` 这样的 describe 标题都不会被当成文件。确定不了文件的用例记为 `(unknown)`。登记的用例引用 `<文件> › <名字>`
只在标题路径等于用例路径的尾部、且整次运行里恰好只有一条用例是这个路径时，才按名字对上这种用例（别的文件里的同名用例会让它
无法归属，不命中，仍是 `registered-test-not-executed`），此时引用里的文件部分不参与比对。登记的文件在它名下某条登记的用例引用
按此对上时算已执行；没有任何用例引用的登记文件在这样的报告里无法核实，如实报 `registered-test-not-executed`，并提示改用随附的 reporter。
已知失败清单与 `fail_on_new` 的 flaky 检查仍然需要真实文件：它们不会匹配 `(unknown)` 的用例。

基准先预热 `warmup` 次再采样 `runs` 次，记录每个指标全部样本的中位数、p95 与 MAD；离散度超过退化阈值一半时先多采一轮再判。
基线按机器画像（OS、架构、CPU、核数、内存档位、运行时主版本，加目录 `profiles_env` 的取值）存到
`.tenon/tests/baselines/<套件>/<画像>.json`，进 git；不同画像互不比较。目录可在顶层写 `profile: coarse` 改用粗口径画像：
OS、架构、核数、运行时主版本加 `profiles_env` 的取值（形如 `linux-x64-4c-node22-1a2b3c4d`），不含 CPU 型号与内存档位，
让同规格的托管 CI 运行器共用一份基线。缺省是 `profile: fine`（与不写相同）；未知取值会被拒绝。改它会让早先的运行记录过期（它们绑定的目录摘要变了），
基线查找也转向另一个画像 id。带 `profile:` 键的目录会被引入该键之前的 Tenon 拒绝读取。该画像没有基线时运行仍通过，并提示
`baseline-missing` 与建立基线的命令（`test baseline --suite --run`），除非步骤策略要求必须有基线。`test baseline` 只认当前记录链
上通过的运行，并往用户的 `audit.jsonl` 追加一行审计。

`known add` 往 `.tenon/tests/known-failures.yaml` 写一项，带原因、可选链接与到期日：清单内的用例仍失败记 `known-fail`，不挡出口；
通过了会提示「已修好」并给出 `known rm` 命令；过期条目按普通失败处理；清单外的失败照挡。`known list` 标出过期项。已知失败是暂时的例外，不是白名单：`--test` 必须指向具体用例（`<文件> › <用例名>`，只写文件被拒），
到期日距今最多 30 天（手写得更晚的条目不被承认，该用例照普通失败处理，并给 `known-failure-too-long` 提示），
新增或改动条目本身是 `known-failures.yaml` 的改动，需要下面说的人工确认。

**测试证据的可信根。** 四层互相独立，专防想要一次绿色运行的 agent：

- *报告*：每次调用前 Tenon 先删掉套件的旧报告；读到的报告必须比本次调用的开始时间新（用 `cp -p` / `touch -d` 回填的旧文件是
  `report-untrusted`），并且 Tenon 把它复制进本次运行的产物目录、记下摘要——读完之后又被改写的报告、没有副本的报告同样是
  `report-untrusted`。报告与退出码的交叉校验不变。
- *本机封存*：按用户、gitignored 的 `<用户目录>/local/test-seal.json`，用 `local/env.key` 里的密钥做 HMAC 签名，记着每个任务记录链
  的链头摘要、Tenon 命令写出的基线与 `known-failures.yaml` 的摘要、你在评审里做过的批准、你做过的信任决定。链头不等于封存链头的记录
  链（记录是绕开 `tenon test run` 写进来的）判 `record-unsealed`，没有人工批准的出口，下一次 `tenon test run` 另起新链取代它。
  封存缺失、损坏或被改动一律读成空，绝不读成放行。
- *人工确认*：任务 diff 里出现 `.tenon/tests/catalog.yaml`、`.tenon/tests/baselines/**`、`.tenon/tests/known-failures.yaml`、
  `.pipeline/workflows/*.yaml` 的改动，会挡住每个 `gate: review` 步骤（`protected-file-unapproved`），直到你确认确切的内容。
  `tenon review request` 逐个列出文件、状态与摘要，目录与已知失败清单还列出新增 / 改动 / 移出的套件、服务与条目；人工的
  `tenon review acknowledge`（或 Dashboard 的「通过」）把这些摘要的批准封存下来，待确认时 `--delegated` 被拒，之后再改一个字节就要重新
  确认。与 Tenon 上次写出的内容对不上的基线或 `known-failures.yaml` 判 `protected-file-tampered`，并标注「台账外改动」。
- *首次信任*：`tenon test run` 拒绝执行你在本机还没信任过的目录（内联步骤测试则是冻结工作流里的测试命令）：套件 `command`、`select`
  模板、`cwd`、声明的环境变量名和服务的 start / ready / stop，按摘要记（改标签、`covers` 不会再问，改任何一条命令会）。
  `tenon test trust [<change>]` 列出将执行的命令，交互终端里问 `[y/N]`（`--yes` 给你自己的脚本，`--status` 只看是否已信任、
  未信任 exit `2`，`--json`）。CI 由运行器显式设置 `TENON_TEST_TRUST=1`，之后每次运行都会打一行说明信任来自环境。Tenon 的 hook
  会拒绝 agent 的 shell 调用里出现 `tenon test trust` 或 `TENON_TEST_TRUST=` 赋值，所以这个决定只留给你。

**测试完整性。** `tenon test integrity <change>` 只回答一个问题：证据比任务开始时变弱了吗？它把任务和它的起点（与改动文件列表
同一个起点）对比，报十种信号，每条带对象和一行事实：

| 信号 | 来源 | 触发 |
| --- | --- | --- |
| `case-count-drop` | 运行记录 | 某套件最新一次全量运行的用例数低于本任务里更早的全量运行 |
| `skip-count-rise` | 运行记录 | 最新一次全量运行的跳过数高于第一次全量运行 |
| `test-file-deleted` | diff | 删除了测试文件（删一个又在别处新增同名文件算搬家） |
| `tests-removed` | diff | 改动的测试文件声明的用例变少（`it(`、`test(`、`def test_`、`func Test…`、`@Test`、`#[test]` …） |
| `test-skipped` | diff | 新增了跳过标记（`.skip`、`xit`、`describe.skip`、`test.todo`、`@pytest.mark.skip` / `xfail`、`@unittest.skip`、`t.Skip`、`@Disabled` / `@Ignore`、`#[ignore]` …） |
| `assertion-weakened` | diff | 用例还在，断言行（`expect(`、`assert`、`t.Errorf`、`assert_eq!` …）少了 |
| `snapshot-rewritten` | diff | 快照文件（`__snapshots__/`、`*.snap`、`*-snapshots/`）被改、被删，或二进制快照变了；只新增快照不算改写 |
| `baseline-changed` | diff | `.tenon/tests/baselines/` 下有改动 |
| `known-failure-added` | diff | `known-failures.yaml` 多了一个用例 |
| `coverage-threshold-lowered` | diff | 测试运行器配置、`pyproject.toml` / `setup.cfg` / `.coveragerc`、`package.json` 或 `.pipeline/workflows/*.yaml` 里的覆盖率门槛（`lines`、`branches`、`functions`、`statements`、`fail_under`、`threshold`、`target`）变小或被删 |

全部是对 `git diff -U0` 与运行记录的文本启发式：信号表示"值得看一眼"，不是"被篡改"，改了用例名、换了断言库也可能出现。
策略键 `test_policy.integrity` 决定信号的去向：`notice`（缺省，默认工作流与标准车道都用它）把信号汇成一条 `test-integrity`
提示，出现在 `test status`、`status` 和 Dashboard 的测试页签里，从不阻塞；`block` 把同样的信号变成该步骤的一条 `test-integrity`
阻塞，读不出 diff 时失败关闭（`files-diff-unavailable`）。`block` 没有逐条豁免：还原被削弱的测试，或改策略。写 `integrity: notice`
与不写完全相同（它不进编译后的工作流，所以已有的指纹和运行记录不受影响）。只在会运行测试（`run` / `run_if_registered`）或声明了
`integrity: block` 的步骤上判。`tenon test integrity` 在该步骤策略是 `block` 且有信号（或读不出 diff）时 exit `2`，否则 `0`；
`--step` 取另一个步骤的策略；`--json` 输出 `{ change, step, pass, mode, state, signals[], truncated? }`。最多读 400 个相关文件，
超出由 `files-truncated` 提示。

`test status` 用与转换拦截完全相同的判定列出该步骤每项测试，所以这里通过就是转换会放行；声明了 `test_policy` 的步骤在 `--json`
里还带 `policy` 对象（带修复命令的阻塞码、提示、套件、场景 / 任务追溯、文件登记与记录链状态）。有阻塞时 exit 2。候选代码、
所跑套件在目录里的条目、计划、步骤策略或工作流指纹任一变化，记录就过期；记录绑定的计划摘要把豁免的 `approved_by` 一律当作空，所以评审
批准豁免不会让批准之前的运行过期（计划的其他任何变化仍会）。`test report` 生成验证报告的测试段，`--write` 替换目标文件里的标记区间，
分两个各自替换的区间：内联步骤测试的旧表格（`tenon:tests:*` 标记之间，只在工作流有内联测试时写）和 v2 块（`<!-- tenon:test-report:begin -->`
与 `<!-- tenon:test-report:end -->` 之间）——追溯矩阵、套件与各套件最新运行的 `run_id`、覆盖率、基准对比、flaky 与已知失败、仍在挡出口的项。
标记之外的字节一个都不动；`tenon status` 靠 v2 块里是否有最新的 run id 判断报告要不要重新生成。`test code-size` 是内建
`code-size` 方向背后的确定性探针，输出一行 JSON 指标；只统计源代码：路径范围与工作区候选一致（不含 `openspec/`、`.tenon/`、
`.pipeline/`、`docs/`、依赖与测试缓存），且不含 Markdown。`test diff-risk` 是内建 `diff-risk` 方向背后的探针，也是 `standard`
通道的风险闸（见[路由与执行模式](routing-and-workflows.md#标准通道)）：只读仓库，从任务起点算起（已提交与未提交的改动都算），输出一行 JSON：
`files_changed`（源码文件数，口径同 `code-size`）、`contract_files` / `auth_files` / `dependency_files` / `migration_files`
（命中对应路径类的文件数：OpenAPI、proto、GraphQL、schema 与 `contract` 名；auth、login、session、jwt、password、permission、
crypto、secret 名与 `.env*`；包清单与锁文件；迁移目录）、`deleted_tests`（被删的测试文件）、`protected_test_files`（测试目录、基线、
已知失败清单、项目工作流的改动；`tenon init` 为没有目录的项目自动生成的那份目录不计）。阈值不在命令里：它们是工作流里 `diff-risk`
步骤测试的 `pass.metrics`，调阈值就是改工作流 YAML。任务名取参数，缺省取 `TENON_CHANGE_NAME`。

内联的步骤测试（`tenon test run <change> <test-id>`）保持 v1 行为：在独立进程组里执行声明的命令，把退出码、耗时、执行人、
输入摘要与输出文件登记成记录，完整日志与输出副本留在该用户 gitignored 的本机目录；候选版本、测试声明摘要或工作流指纹任一变化
即过期。命令可读到 `TENON_CHANGE_NAME`、`TENON_TEST_ID`、`TENON_TEST_RUN_ID`、`TENON_TEST_ARTIFACTS` 与 `TENON_BASE_BRANCH`；
套件运行拿到 `TENON_TEST_SUITE`（套件 id）代替 `TENON_TEST_ID`；套件命令或 `select` 模板引用了 `TENON_NODE_TEST_REPORTER` 时还会拿到它。内联测试的退出码：`0` 通过、`2` 失败（记录已落盘）、`1` 用法或环境错误（不落记录）。

## CI 校验与证据导出

```text
tenon verify --ci (--change <name> | --all-open | --since <ref>) [--step <id>]
                  [--format text|json|sarif|markdown] [--out <file>] [--also <format>=<file>]…
                  [--candidate error|warn|off] [--require-anchor]
tenon evidence export <change> --format agent-trace|otel|git-notes|trailer
                  [--out <file>] [--commit <rev>] [--user <slug>] [--apply] [--anchor]
                  [--contributor human|ai|mixed|unknown] [--model <provider/model>]
```

`tenon verify --ci` 在没有本机 HMAC 密钥的环境里运行：只用已提交的文件，重新推导每个用户目录的记录链、记录自洽、计划 / 记录 / 目录一致性、
Change 当前步骤（或 `--step`）策略下的用例级判定、记录绑定的候选代码与本次检出的树、受保护测试配置改动的评审批准行，以及
`refs/notes/tenon` 上的锚点。必须恰好选一个范围：`--change`（活跃或已归档）、`--all-open`、`--since <ref>`（与 `<ref>` 的 merge-base 以来
改到的 Change）。不带 `--ci` 时退出码 `1`。命令不加锁，只写 `--out` 与 `--also` 指定的文件。退出码：`0` 没有 error 级发现，
`2` 至少一个 error 级发现，`1` 用法或环境错误。报告恒带「没有本机密钥，CI 证明不了什么」。格式：`text`、`json`（`tenon-verify-ci/v1`）、
`sarif`（2.1.0，给 GitHub code scanning）、`markdown`（作业摘要）；用了 `--out` 时 stdout 仍打印 text 摘要。`--candidate warn|off` 放宽
工作区指纹的比对，`--require-anchor` 要求有锚点 note 且等于链头。细节、发现码和 GitHub Action 见[CI 校验](./ci-verification.md)。

`tenon evidence export` 把 Change 的证据导出成别的工具的格式。`agent-trace` 是 Agent Trace v0.1 记录（贡献者缺省 `unknown`，要用
`--contributor` / `--model` 显式断言），`otel` 是遵循 OpenTelemetry GenAI 约定的 OTLP/JSON span（不联网导出），`git-notes` 是挂在
`--commit`（缺省 `HEAD`）上、位于 `refs/notes/tenon` 的 JSON note，`trailer` 是 `Tenon-Change:` 与 `Tenon-Evidence:` 两行。默认只打印；
`--apply` 写 note（`git-notes`）或把尾注 amend 进 `HEAD`（`trailer`），其他格式带它会被拒绝。`--anchor`（仅 git-notes）把链头记为 `verify --ci`
会核对的锚点。记录链断了或为空时退出码 `2`，用法错误退出码 `1`。

## 支持、日志与语言

```bash
tenon support bundle [--out <路径>] [--json]
tenon logs [--follow] [--lines <n>]
```

`support bundle` 在本机生成脱敏的 `.tar.gz`（缺省 `~/tenon-support-<时间>.tar.gz`，权限 `0600`，不超过 5 MiB）：
版本、`doctor`、`runtime status`、配置摘要（只有键名与计数，没有值）、最近的 Dashboard server 日志，以及
有记录时的 hook 耗时。token、API key、cookie、会话码/登录码、私钥、URL 里的密码、邮箱、home 路径和用户名
在写入前抹掉；命令会逐项打印包含了什么、哪些被截断（日志保留最新的部分）以及抹掉了多少处。不会上传任何东西。
`--json` 给脚本输出同样的事实。

`logs` 读取 `<state>/logs/dashboard.log` 与它的轮转文件（`.1`、`.2`，每个 1 MiB，共 3 个）。server 把自己的
stdout/stderr 镜像到那里，凭证在落盘前已抹掉。`--lines` 缺省 100；`--follow` 轮询新增行，轮转后继续，Ctrl+C 结束。

输出语言：`TENON_LANG=en|zh`，其次 `LC_ALL`、`LC_MESSAGES`、`LANG`。没有信号或为 `C`/`POSIX` 时保持历史的中文输出
（hook 为输出稳定会钉 `LC_ALL=C`）。每条命令与选项的说明都有英文；用法错误和最常见的错误在两种语言里都有目录条目
（稳定的消息码，见 `packages/cli/src/i18n/`）；JSON 字段、`ERROR:`/`WARN:` 前缀和退出码不随语言变化。
`tenon verify --ci` 的四种报告格式与用法错误已全部进目录（见 [CI 验证](ci-verification.md)）。跨厂商评审的路由与拒绝（`agent prompt` 的 `[ROUTE]` 行、`agent record` 的宿主拒绝与「声明」旁注）和 `review acknowledge` 的拒绝也已进目录。还没进目录的文案仍是中文。`tenon transition` 遇到非法或未知 event 时，会在第二行用当前语言列出当前 step 的合法 event。

## Session 与恢复

```bash
tenon session activate <change>
tenon session activate <change> --continuous --host-session <id>
tenon session route-context <change> --json
```

## 自动化与高级命令

```bash
tenon afk enqueue <change>
tenon loops list
tenon inbox --json
tenon handoff <change> --json
tenon tap ...
tenon channel ...
```

高级命令可能处理本地敏感数据，先阅读对应安全说明。
