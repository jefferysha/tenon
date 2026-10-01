# CLI 参考

本页列出常用 tenon 命令族。精确参数以 `tenon <command> --help` 为准。

## Setup 与运行时

```bash
tenon setup --codex
tenon setup --claude
tenon update --codex
tenon host-target-plan --json
tenon host-target-plan --host codex --operation setup --json
tenon doctor --json
tenon runtime status
tenon runtime repair --rollback
tenon dashboard --open
```

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
`next` 动作表，按序执行即可。

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
`test:plan-write` / `test:baseline-update` 一行。

自动评审与人工确认是两套不同边界：前者是步骤声明的 agent，后者是 `gate: review`，可以叠加。

```bash
tenon agent next <change> [--json]
tenon agent prompt <change> <agent> [--host <id>] [--json]
tenon agent record <change> <run-id> [--subagent <type>] [--json]
```

工作流在步骤里声明执行者与评审者；Tenon 只排顺序、渲染交接内容、记录结论与校验候选版本，
模型一律由宿主跑。`next` 给出本波要跑的 agent，`prompt` 开始或续跑一个 agent 并打印交接内容，
`--host claude|codex` 时为宿主生成 `tenon-<name>` 专属子代理文件并返回 `subagent_type`；
`record` 读报告末尾的 ```tenon-result``` 块登记结论，`--subagent` 记下实际用的子代理。评审结论由
Tenon 从问题级别与 `block_at` 计算，评审者不自报结论。

智能体库在终端登记（详见[智能体](./agents.md)）：

```bash
tenon agent list [--role executor|reviewer] [--source official|custom|project] [--json]
tenon agent show <name> [--json]
tenon agent new [<name>] --role <role> --description <text> [--skills a,b] [--tools A,B] [--model <m>] [--hosts a,b] [--scope user|project] [--from <agent>]
tenon agent add <file> [--scope user|project] [--replace]
tenon agent validate <file|name>
tenon agent copy <from> <to> [--scope user|project]
tenon agent rm <name> [--scope user|project]
tenon agent export <name> --host claude|codex
```

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
tenon test run <change> [--suite <id>]… [--kind <k>]… [--stage [<step>]] [--all] [--changed] [--json]
tenon test run <change> <test-id> [--json]
tenon test status <change> [--step <id>] [--json]
tenon test baseline <change> --suite <id> --run <run-id>
tenon test baseline <change> <test-id> --run <run-id>
tenon test known add --suite <id> --test "<文件> › <用例名>" --reason <原因> --expires <YYYY-MM-DD> [--link <url>]
tenon test known rm --suite <id> --test "<文件> › <用例名>"
tenon test known list [--json]
tenon test report <change> [--step <id>] [--write <path>] [--locale zh-CN|en]
tenon test code-size [--base <ref>]
```

测试分三层登记。项目**目录**（`.tenon/tests/catalog.yaml`，进 git，人可直接改）说明项目有哪些套件、怎么跑：
`kind`、`runner`、`command`、`cwd`、报告格式与路径、可选的覆盖率、产物路径、`select` 模板（`{files}` / `{pattern}`）、
`services`、`retries`、`parallel`，基准套件还有 `benchmark` 段。报告、覆盖率与产物路径必须在 `test-results/`、
`playwright-report/` 或 `coverage/` 之下，产出它们不会改变工作区指纹。任务**计划**
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
手改记录就断链，该任务的全部 v2 记录视为未运行，直到重跑另起新链。记录按设计入库（它们是别人和 CI 读的证据），所以数量有上限：
每次运行之后，每个用户每个任务只保留最新的 20 条（内联步骤测试按测试项算）。清理删掉最老的一段，并在记录旁留一个
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
（也认 hyperfine 与 vitest bench 的输出）、`k6-summary`、`lighthouse-json`；覆盖率读 `istanbul-summary`、`lcov`、
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
`.tenon/tests/baselines/<套件>/<画像>.json`，进 git；不同画像互不比较。该画像没有基线时运行仍通过，并提示
`baseline-missing` 与建立基线的命令（`test baseline --suite --run`），除非步骤策略要求必须有基线。`test baseline` 只认当前记录链
上通过的运行，并往用户的 `audit.jsonl` 追加一行审计。

`known add` 往 `.tenon/tests/known-failures.yaml` 写一项，带原因、可选链接与到期日：清单内的用例仍失败记 `known-fail`，不挡出口；
通过了会提示「已修好」并给出 `known rm` 命令；过期条目按普通失败处理；清单外的失败照挡。`known list` 标出过期项。

`test status` 用与转换拦截完全相同的判定列出该步骤每项测试，所以这里通过就是转换会放行；声明了 `test_policy` 的步骤在 `--json`
里还带 `policy` 对象（带修复命令的阻塞码、提示、套件、场景 / 任务追溯、文件登记与记录链状态）。有阻塞时 exit 2。候选代码、
所跑套件在目录里的条目、计划、步骤策略或工作流指纹任一变化，记录就过期；记录绑定的计划摘要把豁免的 `approved_by` 一律当作空，所以评审
批准豁免不会让批准之前的运行过期（计划的其他任何变化仍会）。`test report` 生成验证报告的测试段，`--write` 替换目标文件里的标记区间，
分两个各自替换的区间：内联步骤测试的旧表格（`tenon:tests:*` 标记之间，只在工作流有内联测试时写）和 v2 块（`<!-- tenon:test-report:begin -->`
与 `<!-- tenon:test-report:end -->` 之间）——追溯矩阵、套件与各套件最新运行的 `run_id`、覆盖率、基准对比、flaky 与已知失败、仍在挡出口的项。
标记之外的字节一个都不动；`tenon status` 靠 v2 块里是否有最新的 run id 判断报告要不要重新生成。`test code-size` 是内建
`code-size` 方向背后的确定性探针，输出一行 JSON 指标；只统计源代码：路径范围与工作区候选一致（不含 `openspec/`、`.tenon/`、
`.pipeline/`、`docs/`、依赖与测试缓存），且不含 Markdown。

内联的步骤测试（`tenon test run <change> <test-id>`）保持 v1 行为：在独立进程组里执行声明的命令，把退出码、耗时、执行人、
输入摘要与输出文件登记成记录，完整日志与输出副本留在该用户 gitignored 的本机目录；候选版本、测试声明摘要或工作流指纹任一变化
即过期。命令可读到 `TENON_CHANGE_NAME`、`TENON_TEST_ID`、`TENON_TEST_RUN_ID`、`TENON_TEST_ARTIFACTS` 与 `TENON_BASE_BRANCH`；
套件运行拿到 `TENON_TEST_SUITE`（套件 id）代替 `TENON_TEST_ID`；套件命令或 `select` 模板引用了 `TENON_NODE_TEST_REPORTER` 时还会拿到它。内联测试的退出码：`0` 通过、`2` 失败（记录已落盘）、`1` 用法或环境错误（不落记录）。

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
