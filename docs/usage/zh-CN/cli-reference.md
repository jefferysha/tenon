# CLI 参考

本页列出常用 tenon 命令族。精确参数以 `tenon <command> --help` 为准。

## Setup 与运行时

```bash
tenon setup --codex
tenon setup --claude
tenon update --codex
tenon setup --claude --from-source <repo>
tenon update --claude --to-stable
tenon host-target-plan --json
tenon host-target-plan --host codex --operation setup --json
tenon --version
tenon doctor --json
tenon runtime status
tenon runtime repair --rollback
tenon dashboard --open
```

`tenon --version`（`-V`）打印这条命令所在插件载荷的版本号（插件清单里的版本）；已安装的运行时上它就是 `tenon doctor` 里 `runtime=` 的那个数字。不需要项目，也不改任何东西。

`tenon setup --claude|--codex --from-source <repo>` 是源码开发安装，用于在 Tenon 源码仓库里工作：它构建该仓库（`npm --prefix <repo> run build`，`--skip-build` 可跳过）、按 `skills/sources.yaml` 获取缺失的上游技能与本机 `skills/skills.lock.json` 索引（获取失败则整条命令在改动宿主之前中止）、把仓库目录登记成 `tenon` marketplace，并发布一份在 manifest 里记录 `devSource`（commit、`dirty`、安装内容摘要、技能索引摘要）而不是稳定标签的受管 runtime。它不冒充发布版本：插件版本仍是仓库 `plugin.json` 的版本，只有 `/api/health` 显示 `<version>+dev.<sha7>`。开发安装会关闭自动更新，`tenon update` 对它默认拒绝，`tenon update --claude|--codex --to-stable` 切回最新正式版。不带 `--from-source` 时 setup / update 与以前完全一致，只认稳定标签。`tenon doctor` 对开发安装给出 `identity:release` 警告，仓库与已装内容不一致时给出 `source:drift`。`--from-source` 只能与 `--claude` 或 `--codex` 之一同用，不能与 adapter 宿主或 `--auto-update` 同用。

已知风险：`--from-source` 会运行所给检出的构建（`npm --prefix <repo> run build`），并按该检出的 `skills/sources.yaml` 拉取上游技能，然后把该检出的 hooks 与技能长期装进宿主，之后每个会话都会运行它们。目录算不算 Tenon 仓库只看检出自己的文件，agent 发起这条命令时也没有额外确认。它与 agent 能执行的任意命令同级，是开发者显式命令，只对你信任的检出使用。

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
tenon assess --files <路径>... [--workflow <name>] [--track <track>] [--json]
tenon init <name> [--workflow <name>] [--track <track>] [--preset <preset>] [--domain <track>]
tenon init <name> --workflow default --track frontend --preset full --document-locale zh-CN
tenon list --json
tenon list --finished
tenon tracks list [--json]
tenon tracks show <工作流>:<轨道> [--json]
tenon status <name> --json
tenon workflow plan <name> --json
tenon get <name> <field>
tenon set <name> <field> <value>
tenon transition <name> <event>
tenon check <name>
tenon advance <name>
tenon task finish <name> [--json]
tenon task terminate <name> [--yes] [--json]
tenon task delete <name> [--yes] [--json]
```

不要用 `set phase` 绕过 workflow event。canonical state 和 YAML projection 只能由 CLI 写。

`tenon init` 的轨道取自工作流自己的分支：声明了 `tracks:` 的工作流必须写 `--track`（default 的是 `lite`、`pm`、`frontend`、`backend`），`design-system` 这样的平铺工作流不用写。`--workflow standard`、`--workflow simple` 退出码 `1`，并提示改用 `--workflow default --track lite`；把已退役的轨道 id（`standard`、`simple`、`chat`、`free`）传给 `--track` 同样退出码 `1`，并列出该工作流可选的轨道。`--domain <track>` 用于轻量任务：它记下「升级时去同一工作流里的哪条轨道」（必须是该工作流里另一条存在的分支），这样改动风险探针的 `escalate.then` 就能直接点名那条轨道；没记时 `then` 列出可选轨道请用户选。`tenon tracks list` 只读，列出项目可用的全部工作流的全部轨道（列 `WORKFLOW:TRACK`、`LABEL`、`ROUTABLE`）；内建登记表与 `.pipeline/tracks.yaml` 不再读取。见[路由与执行模式](routing-and-workflows.md#建任务前先评估)。新任务会记下第一步的检查点，`spec: openspec` 的轨道另铺 `tasks.md` 骨架；不铺 proposal、design 骨架，也没有文档账本。

`tenon assess` 把你预计要改的文件，按某条轨道的改动风险阈值（它的 `diff-risk` 步骤测试的 `pass.metrics`；缺省 `--workflow default --track lite`）评估，分类规则与改动风险探针完全相同，不读文件内容。路径必须是仓库内的相对路径：绝对路径、含 `..` 或经符号链接指向仓库外的路径退出码 `1`，该轨道没有 `diff-risk` 阈值同样退出码 `1`。退出码 `0`：未超限；退出码 `3`：超限，列出被突破的阈值（如 `auth_files 1 > 0`）并推荐重型轨道。`--json` 输出 `{ workflow, track, metrics, exceeded, reasons, recommendation }`。

新任务的转换因交接来的输入没读完被拒，退出码 `1`；因 guard 未满足（含缺失的 `required-output`）被拒，退出码 `2`。不带 event 的 `check <name>` 报告当前步骤的 guards 与它的前进边的 guards，一次列出全部未满足的条件，退出码 `2`。`advance <name>` 只自动走唯一的前进边，不走回退边和放弃边 `scope-expanded`。

`task finish` 与 `task terminate` 都是把任务目录移进 `openspec/changes/archive/<日期>-<名字>/` 并记下任务结果（`finished`、`escalated` 或 `terminated`，界面是完结、已升级、已终止）。`finish` 只接受状态机已走到终态（完结或已升级）的任务；`spec: openspec` 的轨道由 Tenon 调用 `openspec archive <name> --skip-specs --yes --json`，其余由 Tenon 自己移动目录，同一天已有同名归档时追加 `-2`、`-3`。`terminate` 接受任何还没结束的任务，记为已终止，只提交任务目录（`chore(tenon): terminate <name>`），任务改过的代码既不提交也不回退。退出码：`0` 完成；`1` 用法、名称、任务或身份缺失、状态不对或失败；`2` 需要确认（加 `--yes` 重试）；`3` 被阻止（如 AFK 运行中、被别的任务依赖）。`--json` 输出 `{ change, result, archived_dir, ended_at }`（`terminate` 另带 `commit`）。原来的「隐藏」子命令 `archive`、`unarchive`（在 `tenon task` 下）已不存在，运行退出码 `1` 并指向 `finish` 与 `terminate`。`tenon list --finished` 列出已结束的任务（含已归档的）。

`tenon workflow plan <name> --json` 是 Agent 编排在途 Change 的单一读取入口。它优先返回
WorkflowRun 初始化时冻结的完整计划，包括步骤、Skill、门禁、守卫和转换。后来修改或删除
`.pipeline/workflows/<workflow>.yaml` 只影响新运行，不会改写已有运行的 Todo 和 Skill DAG。

`tenon status <name> --json` 还带一个 `step` 块：单个 `tenon` skill 执行当前步骤所需的全部输入
——本步技能、执行者、评审者、测试、文档、字段、评审回执、带阻塞原因的出口，以及一份闭集的
`next` 动作表，按序执行即可。`run-tests` 与 `run-test` 在将要执行的命令里有还没得到用户信任的时带一个 `trust` 对象
（只列这些命令，信任在同一仓库的所有 worktree 共享；先请用户在自己的终端运行 `trust.command`）。`test-register-files` 只在出现孤儿测试文件时才有，
内容是一条 `tenon test register <change> --auto`；`test-plan-map` 只在缺必需测试类，或档位要求场景映射时才有。带 `escalate` 的 `transition` 表示任务已经超出了它的轨道：
轻量轨道的风险探针没通过，`escalate.reasons` 点名被突破的阈值，`escalate.then` 给出转换之后要运行的重型轨道 `tenon init` 命令，
以及随后的 `tenon set <新任务> depends_on <本任务>`。`finish-change` 动作带 `command`（`tenon task finish <name>`），命令之后再按 `commit` 提交。

新任务的 `step.documents` 带 `mode: "observed"`：`observation`（`observed`、`unavailable` 或 `truncated`）、`inputs`（`path`、`from_step`、`skill`、`status` 为 `read` 或 `unread`）、`outputs`（`path`、`change` 为 `added`、`modified` 或 `deleted`、`skill`）和 `required`（本步每条 `required-output` 的 `path` 与 `status`，`produced` 或 `missing`）。它唯一的文档动作是 `read-documents`，`documents` 列出未读的输入，`note` 说明本步可以改它们、改动记为本步产出；必须产出缺失走 `fix`。升级前创建的任务的 `step.documents` 带 `mode: "contract"` 和 `reads`、`records`、`updates` 三张表，`next` 还可能有 `scaffold-document`、`record-document`、`register-field`。

```text
tenon step run <change> [--json]
```

`step run` 一次做完 `step.next` 里确定性的那部分，并说明做了什么：`read-documents`（`document read <change> all`）
和 `test-plan-seed`（`test plan <change> --seed`）；升级前创建的任务还有 `scaffold-document`（`document scaffold`）和
`record-document`（`document record`，文件已存在且骨架占位符已替换才做）。遇到需要宿主或作者的动作就停下（加载技能、派发 agent、写文档内容、
跑测试、评审、转换），写明停在哪、为什么，并附上最新的 `step.next`，之后不必再 `status`。它幂等：无事可做就什么都不改、
退出码 `0`；某条命令被拒绝退出码 `2`，已做完的部分保留。`--json` 输出 `{ change, step_id, did[], stopped, step }`。

```text
tenon spec apply <change> [--dry-run] [--json]
```

`spec apply` 在 `openspec/` 的临时整拷里跑 `openspec validate --strict`、`openspec archive`
与逐 capability 的严格复验，再把改到的主规格字节按 compare-and-swap 写回，并登记
`applied-spec.md`。`--dry-run` 除回执外不写任何文件。退出码：`0` 通过，`1` 用法或状态，
`2` 校验或彩排失败，`3` PATH 上没有 openspec，`4` 主规格在彩排期间被改过。

### 验证轮次上限

设了评审门且至少有一条回退边的步骤（default 里是带 `verify-fail` 的验证）限制最多验证几轮。一轮 = 自上次重新计数以来进入这一步的一次，含当前这次：第一次进入是第 1 轮，每次 `verify-fail` 回到实现、再经 `build-complete` 进入验证，就多一轮。任务落到早于所有回退目标的步骤时重新从 1 计数（在 `default` 里就是经 `requirements-changed` 回到规格）。删标记、重跑命令、换 agent 都不会让计数清零。

上限有三个来源，后者覆盖前者：内置默认 2（没有声明的受限步骤，例如自定义工作流的步骤，或这个键出现之前就已冻结的计划）、步骤的 `max_rounds` 键（default 工作流在每条轨道的验证步声明 2，见[默认工作流](./default-workflow.md#验证轮次上限)）、任务字段 `max_rounds`。

```text
tenon set <change> max_rounds <N>
tenon get <change> max_rounds
```

`set` 只接受 1 到 20 的整数，其余取值以退出码 `1` 拒绝且不写任何东西；写入会记进 change 历史。字段从没设置过时 `get` 输出一个空行。这个值对本任务所有受限步骤生效。调高上限是用户的决定：agent 只在用户明确指示时才执行 `set max_rounds`。写入会改变任务状态，已发起或已批准的评审请求随之失效：重新读 `step.next`，再重新 `tenon review request`。设成不高于当前轮次的值，立即算用完；只有设成大于当前轮次的值，回退边才恢复。

`tenon status <change> --json` 在 `step.rounds`（紧跟在 `exits` 之后）里给出计数：

```json
"rounds": { "current": 2, "max": 2, "source": "workflow" }
```

`source` 是 `workflow`（步骤的 `max_rounds`）、`default`（内置的 2）或 `task`（任务字段）。不受上限约束的步骤（实现步、没有回退边的评审门步骤）和已完结的任务，值是 `null`。

`current` 达到 `max`、而必需测试或必需评审者仍不通过时，这一步不再自动回退：

- `step.next` 不再给回退边的 `request-review`、`choose-exit` 或 `transition`。只有必需评审者不通过、或失败的必需测试都已登记豁免时，给前进边的 `request-review`，多带三个字段：`residual`（不通过的评审者，形如 `reviewer:<agent>`）、`rounds` 与 `alternatives`（另外的出路）。还有没登记豁免的失败必需测试时，给 `stop`，`code: rounds-exhausted`，`message` 点名失败的测试，并说明可以先登记步骤测试豁免。两种都列出另外三条出路：调高上限（用户的决定）、回到规格、终止任务。回到规格要分两步，因为受约束的步骤上没有直达的边（它声明的每条回退边本身就是它的回退目标，落到那里不会让计数清零，上限用完后这些边也同样被拒）：用户先调高上限，经回退边 `verify-fail` 回到实现，再在实现步上执行 `tenon transition <change> requirements-changed`；任务落到规格之后计数从第 1 轮重新开始，用户可以再把 `max_rounds` 调回去。自定义工作流里，文案按计划点出回退边和回退目标步骤上落到更早步骤的事件；没有比所有回退目标更早的步骤时，文案会说明回去也不会让计数清零。
- `step.exits[]` 里回退边是 `ready: false`，带阻断 `{ "source": "guard", "code": "rounds-exhausted", "message": … }`；前进边与放弃边 `scope-expanded` 不变。
- `tenon review request <change> --event <回退事件>` 与 `tenon transition <change> <回退事件>` 以退出码 `1` 拒绝，什么都不写，并写出已用轮次、上限和 `tenon set <change> max_rounds <N>`。Dashboard 的转换返回 HTTP `409`，`code: "rounds-exhausted"`（另带 `step`、`event`、`current`、`max`、`source`）。不受上限约束的步骤的回退边（例如实现步的 `requirements-changed`）始终可用。
- 上限没用完时一切照旧：回退边照常给出，照常被拒。

**接受剩余阻断。** 轮次用完的步骤上，`tenon review request <change> --event <前进事件>` 对在当前候选上不通过的必需评审者不再拒绝请求，而是放行。它把这些评审者逐个冻结进 `.pipeline-review-waivers.json`，成为待接受的剩余阻断（键 `reviewer:<agent>`，带评审者那次运行、代码候选和阻断级发现），并连同发现逐条打印；把这份输出和 `alternatives` 一起摆给用户。上限没用完时，必需评审者不通过仍会让请求被拒。

- 只有人工确认才接受：用户回复放行语（「确认继续」「继续执行」），或用户本人在自己的终端运行 `tenon review acknowledge <change>`。接受与已批准的回执在同一把锁内写入，并为每个评审者往 change 历史追加一行 `review.residual-accepted`（评审者、运行、候选、发现数、确认人，以及 `summary=`：冻结时的发现摘要，最多 5 条，用 `|` 连接，条内的 `|` 换成全角 `｜`，每条已清洗）。之后 `tenon check` 对这个评审者只打印一行 `[WARN]` 而不再阻塞，`tenon transition <change> <前进事件>` 也不再因它被拒。
- `review acknowledge --delegated` 与 AFK 从不接受：有待接受的剩余阻断时命令被拒，什么都不写，评审保持待确认。Dashboard 复核决策台也不展示它们，所以它的「通过」返回 HTTP `409`，`code: "residual-pending"`，要回终端确认。
- 接受绑定评审者那次运行和当时的代码候选。代码变了，或该评审者有了新的运行（含带 `--rerun-reason` 的重跑），接受就失效：前进边重新被这个评审者挡住，需要再请求、再确认。已批准的回执覆盖不到现在的结论时，`step.next` 给 `fix`，阻断码 `residual-unaccepted`；先 `tenon review revoke <change> --reason <原因>`，再重新发起评审。
- 剩余阻断只覆盖评审者。失败的必需测试仍由步骤测试豁免处理（`tenon test waive <change> --test <步骤测试 id> --reason <原因>`），同一次评审请求可以把它和剩余阻断一起列出。

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
tenon document read <change> <path|all>
tenon document status <change> [--json]
```

新任务不登记任何东西：Tenon 在离开步骤时记录该步新增、修改、删除的文件与来源技能。`document read <change> all`（或一个交接来的输入路径；项目外的路径退出码 `1`）对当前内容取摘要，为本步的输入写读取回执。`document status` 打印本步的输入（`READ` / `UNREAD`）、产出和必须产出，`--json` 输出 `{ change, workflow, mode, observation, inputs, outputs, required }`；有输入未读或必须产出缺失时退出码 `2`。见[文档、Skill 与证据链](./documents-skills-and-evidence.md)。

只服务升级前创建的任务（新任务运行 `document init`、`scaffold`、`record`、`migrate-delta` 退出码 `2`，运行 `artifact register` 退出码 `1`，并提示本任务的产出由 Tenon 在离开步骤时自动记录）：

```bash
tenon document init <change>
tenon document scaffold <change> <kind>
tenon document scaffold <change> delta-spec --capability <capability>
tenon document record <change> <kind> <path> --producer <skill>
tenon document record <change> --all [--producer <skill>]
tenon document read <change> <kind|all>
tenon artifact register <change> <field> <path> --producer <skill>
```

scaffold 只创建缺失结构，不登记 producer；delta spec 必须显式提供真实 capability；record 必须对应真实 Skill。Change 语言固定在 `.pipeline-document-locale.json`，不写入严格 canonical schema，以保持旧版本回滚兼容；新任务的 `tasks.md` 骨架同样按这个语言生成。

`tenon handoff <name> --bundle` 在新任务里把当前步骤交接来的输入（直接上游的产出，`--target` 缺省取当前步骤）编成包，每份摘要必须等于上游记下的摘要或本步的读取回执，否则失败关闭并要求重读；升级前创建的任务仍按文档账本编包。

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
tenon review revoke <change> --reason <原因>
```

delegated 需要 Change 绑定的持续授权，且不能跳过 check。

谁能确认评审：任务负责人，与任务上其余写操作（`transition`、`set`、`review request`）一致。负责人之外的人评审
负责人的工作，要显式写 `review acknowledge <change> --as reviewer`；这次确认会在 change 历史里记
`as=reviewer owner=<id>`。不带该标志的非负责人被拒绝、不写任何东西；另一条路是 `tenon owner take <change>`，
它会转移负责人。Dashboard 的「通过」由顶栏用户确认。

`review acknowledge` 退出码：`0` 已确认、重复确认或确认成功但 review marker 清理告警；`2` 没有匹配的待确认
review（缺失、已被消费、binding 失效或 event 已不是 workflow 出口）；`3` revision 冲突（仅 Dashboard CAS
路径）；`4` 幂等键冲突；`1` 非法命令（例如 `--event` 与待确认 receipt 不一致）或意外错误。失败时不写入任何内容。

`review revoke <change> --reason <原因>` 撤回误给的批准：把当前步已批准、尚未被 transition 消费的回执撤回为同一 event 的待确认（沿用原 `requestedAt` 与绑定），重写评审标记让门重新拦住，并在 change 历史追加一行 `review.revoked`（操作者、原因、回执标识、event）。只有任务负责人能执行，`--reason` 必填（一行，不超过 200 字）。原因缺失、回执本就待确认、不存在或已被 transition 消费时拒绝且不写任何东西（退出码 `1`）。批准之后决策状态变过的话，下一次 `review acknowledge` 会因绑定失效被拒；对同一 event 重新 `review request` 即可刷新。

`review request` 还会冻结并列出测试计划里尚未批准的豁免（`waivers[].approved_by` 为空）。人工的
`review acknowledge` 在提交 approved receipt 的同一把锁内，只给这些豁免写上 `approved_by`，并在 change 历史里留一行
`test:waiver-approve`；`--delegated` 从不批准豁免，计划里有待批准的豁免时它被整个拒绝（不写任何东西，评审仍待确认）；请求之后才加进计划的豁免
也不在那次确认里（`step.next` 会先要求重新发起请求）。Dashboard 复核决策台的「通过」是同一种人工确认：
列出并批准同一份冻结清单，留同一行 `test:waiver-approve`。计划写入与基线更新同样各留
`test:plan-write` / `test:baseline-update` 一行。同一份冻结清单还带着任务里受保护的测试配置改动（目录、基线、已知失败清单、
项目工作流，见「测试证据的可信根」），批准它们留一行 `test:protected-approve`。步骤的验证轮次用完后，同一份冻结清单还带着仍不通过的必需评审者，
作为剩余阻断，见[验证轮次上限](#验证轮次上限)。

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

（升级前创建的任务）`document record --all` 一次登记当前步骤所有「文件已经写好」的文档，每份都走 `document record` 自己的全部校验（占位符、producer 的技能回执、
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
tenon test unregister <change> --suite <id> | --file <path> | --case <covers> [--test <ref>] | --waiver <种类|场景|test:步骤测试 id>
tenon test waive <change> (--kind <k> | --covers <covers> | --test <步骤测试 id>) --reason <原因>
tenon test sync <change> [--json]
tenon test sync <change> --prune [--json]
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
（报告、覆盖率与 `artifacts`，按套件 `cwd` 换算）和在途任务冻结工作流里内联测试的 `outputs`，外加一条通用规则：
名为 `test-results`、`playwright-report` 或 `coverage` 的目录之下（任意层级）、git 没有跟踪、且扩展名属于证据格式
（log、txt、xml、md、csv、png、jpg、jpeg、gif、webp、webm、mp4、lcov、info）的文件不算候选的一部分，
所以 e2e 被测服务写一份日志不会让冻结的版本失效。已跟踪的文件、源码 / 脚本扩展名（js、ts、mjs、sh、py 等）、没有扩展名的文件，
以及能被代码或浏览器直接加载、解包的格式（json、html、htm、zip、gz、har）仍然计入，目录名藏不住代码和页面；
真会产出 json、html、zip、har 这类文件的套件，在测试目录里把它们声明为输出。git 读不出来时，这些目录下的文件全部计入。任务**计划**
（`openspec/changes/<change>/test-plan.yaml`）只列你手工做的选择：用 `register --suite` 加进来的套件、用 `--file --kind` 登记的资源文件、
场景 / 任务 → 用例的映射（`spec:<capability>/<Scenario 标题>` 或 `task:<编号>`）和豁免。本任务新增或修改的测试文件在步骤求值时由
`files` glob 匹配它们的套件认领，不写进计划。计划只经 `tenon test` 命令写入，每次写入把摘要记进
任务目录里的台账，手改文件就是 `test-plan-tampered`。工作流的**档位**（`steps[].test`）说明一个步骤要什么：`none`、`plan`、`changed`、`full`
四选一。每档的含义由目录这个文件的可选顶层键 `levels` 定义，没写的取内建缺省：

```yaml
levels:
  plan:    { required: [unit] }
  changed: { required: [unit], touched: [static] }
  full:    { required: [unit], touched: [integration, e2e, static, benchmark] }
```

每档只接受六个键：`required` 与 `touched`（测试类）、`scenarios`（`off`，缺省；`required` 或 `passing`）、`coverage`（`lines`、`branches`、
`functions`、`statements`、`changed_lines`，0–100）、`flaky`（`{ max, fail_on_new }`）、`require_baseline`（缺省 `false`）；`plan` 档只接受
`required` 与 `scenarios`。一档运行 `required` 类（`full` 全量跑它们的全部套件，`changed` 只跑被碰到的）和被改动碰到的 `touched` 类；
套件被「碰到」是指某个改动文件匹配它的 `files` 或 `covers` glob。没写 `covers` 的套件只有它自己的测试文件改了才算被碰到：
改动只含源码文件时，这类套件在 `changed` 档（不论 `required` 还是 `touched` 类）与 `full` 档（`touched` 类）都不跑，`tenon test status` 与
`test run --stage` 会给出不阻断的提示 `suites-without-covers` 并点名它们。要让源码改动触发这个套件，用
`tenon test catalog set <id> --cover-glob "<glob>"` 写上 `covers`。一档没有任何要跑的东西就算满足：`test run --stage` 如实说明并 exit `0`。
`levels` 写错（未知的档、键、类，或超出 0–100 的覆盖率）会让目录无效、阻断所有测试相关出口；`levels` 计入目录摘要。测试类有
`unit`（种类 `unit`、`coverage`）、`integration`（`integration`、`regression`、`contract`、`smoke`）、`e2e`（`e2e`、`playwright`、`browser`、`a11y`、
`visual`）、`static`（`typecheck`、`lint`、`code-size`、`design-system`）、`benchmark` 和只在点名时运行的 `custom`；套件的 `kind` 可以写类名或旧种类名（别名）。
较早的多字段 `steps[].test_policy` 是旧写法：冻结了它的任务照旧读取并按种类名判定，同一步不能与 `test` 并写。
仍写着内联 `tests[]` 的步骤照旧可用：照旧运行，并和档位一起判定（见[默认工作流](./default-workflow.md)）。

某个测试类对整个项目都不适用时，在目录里声明，不必每个任务各豁免一次：`test catalog not-applicable <kind> --reason <原因>`
在 `catalog.yaml` 写入 `not_applicable: [{kind, reason, approved_by}]`（`--rm` 撤销），它同时满足该种类所属的测试类。它要经一次人工确认才生效：
`review request` 把它以 `not-applicable:<kind>` 和计划里待批准的豁免一起列出，`review acknowledge`（不含 `--delegated`）批准它并把
批准人记进 `approved_by`；在此之前档位仍要求这个类，报 `waiver-unapproved`。改理由会让批准清零。

失败的必需步骤测试用户决定放行时（默认的 `code-size` 没有上限、不会因规模失败；项目在工作流里给它写了 `pass.metrics` 上限之后才适用），用
`tenon test waive <change> --test <步骤测试 id> --reason <原因>` 登记步骤测试豁免。id 必须是本任务工作流某个步骤声明的测试，否则退出码 2 并列出可用的 id；该步骤要声明测试档位（或旧策略）
才会判豁免。它与种类豁免是同一机制：写进计划、随 `review request` 以 `test:<id>` 连同理由列出，人工确认这道评审门时一并批准，
批准前仍报 `waiver-unapproved`。`test:<id>` 豁免出现的每个地方（`review request` 清单、验证报告、评审者提示、`test-waived` 提示）都另起一行写出
当前候选上最新失败记录的实测值，例如 `最新运行：lines_added=2810（上限 2000）`；当前候选上没有失败记录则写 `当前候选上没有失败记录`。
实测值每次展示都重读，你写的登记理由仍标注为登记者自述、不做核实。登记之后 `step.next` 不再发 `run-test`，照常走评审者与 `request-review`；评审者提示里该测试
的结果下面带一行 `豁免（已批准|待评审批准）：<理由>`。豁免只覆盖新鲜的失败记录：未运行、运行中、过期的测试照旧阻塞，
代码变了就要重跑。`test unregister <change> --waiver test:<id>` 撤销。

`test discover` 扫描包脚本与各工具配置（vitest、jest、mocha、node:test、Playwright、tsc、eslint、pytest、go），
给出带推荐 reporter 参数的建议套件，让每个套件都产出可解析的报告；`--write` 追加目录里还没有的 id。
声明了测试档位的工作流在项目没有目录时，`tenon init` 会替你跑它并在 stderr 说明（没有识别到测试工具就不写，已有目录一律不动）。
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
不同，数值不保证可比，升级主版本后用 `tenon test baseline` 重建基线。基准名就是指标名，所以两个基准重名（或只有标点不同，
指标名会把标点去掉）时，报告会解析失败并点名重名的基准，而不是让后一个悄悄盖掉前一个；给每个 `bench()` 起不同的名字。
读不出主版本时（vitest 没装、`package.json` 里的写法也定不下主版本，例如 `latest`、`workspace:*`、`catalog:`、`>=3`；或最近的 `node_modules/vitest` 的 `package.json` 读不出 `x.y.z` 版本，即安装到一半——这时既不去看更远的安装，
也不退回声明的范围），discover
不生成基准套件——同一条命令对一个主版本是对的，对另一个就直接 exit `1`：改为给出带两种命令的 `catalog add` 提示，装好依赖后重跑
`tenon test discover`，或照提示手工登记。vitest 5 及以上，bench 文件里还从 `'vitest'` 导入模块级 `bench` 的
（`import { bench } from 'vitest'`、`import { describe, bench } from 'vitest'`，多行导入与 CommonJS `require` 也算）必然报
`bench is not a function`，所以 discover 同样不生成这个套件：改为给出一条提示，点名这些文件和 fixture 写法
（`test('…', async ({ bench }) => { await bench('名字', fn).run() })`，选项放第二个参数 `bench(名字, 选项, fn)`）；迁移后重跑
`tenon test discover`。
`catalog add --from <方向>` 用测试方向起步（裸的工具调用会换成该 runner 的推荐调用）；`catalog validate` 逐条列出
`catalog.yaml:<行>: …`（有问题 exit `2`）。`test plan --seed` 在计划缺失时建好计划。有测试档位的步骤，它不写套件也不写测试文件
（运行什么由档位、目录和本任务的 diff 在步骤求值时决定），只报告目录里没有套件的必需类，以及档位要求映射时还没映射的场景与任务，
附可直接执行的 `register --case` 命令；旧策略仍补上「拥有或覆盖了本任务改动文件」的套件和必需种类的套件，但不再登记测试文件。
只有场景和 `tasks.md`「实现」（`build`）小节下的任务要求映射
（`scenarios: required|passing` 对它们出阻塞）；其他阶段小节的任务单列为可选（验证报告里写「可选」而不是「未覆盖」），永不挡；
骨架提示词（「将本阶段目标拆成可验证任务」）不是作者写的任务：种子、`test sync`、`test plan` 不再列它，追溯矩阵里它显示为可选。
档位不要求映射（`scenarios: off`，缺省）时，矩阵只列已映射的行，另加一行「另有 N 条场景 / 任务未映射（本步不要求映射）」，
也不出 `scenario-uncovered` 阻断。`test register <change> --auto` 是处理孤儿测试文件的一条命令：缺目录先识别，
再只看本任务新增或修改、没有任何套件 `files` glob 认领的像测试的文件（从不扫整个仓库，也不看 `openspec/`、`.tenon/`、`.pipeline/` 下的路径），
把每个文件的精确路径追加进合适的套件（`e2e/` 下的用例进 Playwright 套件，辅助文件和 `*.bench.*` 不会自动认领）。它不放宽任何 glob：
`tools/x.test.mjs` 就只加这一条路径，不会出现 `tools/**`，本任务没动过的文件也原样不动；只增不减，可重复运行；没有合适的套件时停下并给出
`catalog add` 命令、不写任何东西。`test sync` 拿本任务相对起点的
diff 对账：没有套件认领的文件（孤儿）、登记了但文件已不存在的项、登记了但目录已不认领的项（套件不在目录里了，或没有套件的
`files` glob 再匹配这条路径；`--json` 字段 `registeredButUnclaimed`），与门禁是同一份计算（有待处理 exit `2`）。

所有写目录的命令（`catalog add|set|rm`、`catalog not-applicable`、`register --auto`，以及 `init` 写入已有目录）只改动实际变化的节点所在的行，
分三层：顶层键、`suites` 条目、条目里的键。新增节点追加在所属列表或映射的末尾，删除的节点只去掉它自己的行（它前面的注释行跟着后面的内容保留），
其余每个字节（含注释和空行）原样不动；被改键上的行内注释是唯一会丢失的东西。新文本会重新解析，必须与预期目录一致，否则不写盘。
`discover --write` 写入不存在的目录时照旧整份写出。

登记只增不减（`register`、`plan --seed` 只加，`sync` 只报告），而套件出口检查对每条写明了套件的登记都要求「报告里执行过」，不看套件的 glob
还认不认领它。所以套件的 `files` glob 被放宽、后来又收窄之后，那段时间登记进来的文件会留在计划里，一直以 `registered-test-not-executed` 挡住出口。
`test sync <change> --prune` 就是出路：只把当前目录不认领的登记从计划的 `files` 里删掉，其余原样保留。一条登记被保留的条件是：写明的套件还在目录里、
且该套件的 `files` glob 匹配这条路径；没写套件的登记则要有任意一个套件的 glob 匹配。用 `register --file --kind` 登记、没有套件的资源文件（例如视觉快照）
也会保留：它从不运行，也不会挡出口。输出逐条列出被删的路径和原因（`没有套件认领`、`套件 '<id>' 不在目录中`、`套件 '<id>' 的 files glob 不再认领它`）；
`--json` 输出 `{ change, digest, pruned: [{ path, suite?, reason }] }`，`reason` 取 `no-owner`、`suite-missing`、`glob-mismatch`。
它只动 `files`：套件、用例映射和豁免不动，也不读 diff。没有可删的项算成功（exit `0`，不重写计划）；目录缺失或无效、目录里一个套件都没有、
计划被手改、不是任务负责人，都会被拒绝（exit `1`）。写入走与 `test register` 相同的加锁、记摘要的路径，所以删完 `test plan` 与出口检查照常读取，
任务历史里多一行 `test:plan-write op=prune`。

为什么不能拿它去删合法的登记：合法的测试文件总被它的套件 glob 认领，要被 prune 必须先改目录里的 glob，而任务改动过的测试配置文件会在评审请求里列出、由用户批准。

任务的起点是与基线分支的 merge-base；直接在基线分支上做时取任务创建之前的最后一个提交；diff 包含暂存、未暂存与
未跟踪文件。读不到 diff 时门禁以 `files-diff-unavailable` 阻塞（失败关闭，不降级成提示）。

`test run` 每次调用写一份 v2 记录（`.tenon/users/<slug>/tests/<change>/<run-id>.json`），按 `prev_digest` 串成链；
手改记录就断链，该任务的全部 v2 记录视为未运行，直到重跑另起新链。算记录摘要之前，所有字符串字段（失败用例的 message / stack 也算）里的
仓库根（逻辑路径与真实路径两种写法，含 `file://` 前缀，所以 `/var/…` 与 `/private/var/…` 一视同仁）改写成仓库相对路径，用户主目录改写成 `~/`，
入库的记录因此不带本机绝对路径；`local/artifacts/` 里的本机日志不入库、保持原样，早先版本写下的记录也不回写。记录按设计入库（它们是别人和 CI 读的证据），所以数量可以设上限：
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
`--stage [<step>]`（该步骤的阶段运行集：步骤档位按本任务 diff 要跑的套件，加上计划里用 `register --suite` 显式加进来的套件；
`test: full` 一律全量，`status` 与 `check` 求值用的是同一个运行集）。没有任何选择参数时缺省就是 `--stage`。`--stage` 只跑目录套件：内联的
`tests[]`（套件 id 以 `step:` 开头）仍走
`tenon test run <change> <test-id>`，摘要会列出还要跑的命令；档位在本任务上没有要运行的套件时如实说明并 exit `0`，不写记录。声明的服务每次调用只启动一次，独立进程组，按 URL / 端口 / 日志文本探测就绪，
结束后整个进程组连孙进程一起回收；启动前 URL 或端口就已经在响应会被拒绝——测试会打到旧服务上。`parallel: true` 的套件并发，
其余依次。报告按用例解析：`junit`、`playwright-json`、`vitest-json`、`jest-json`、`go-json`、`tap`；基准读 `benchmark-json`
（也认 hyperfine 与 vitest bench 的输出：vitest 3 / 4 的 `--outputJson` 文件和 vitest 5 的 json reporter）、`k6-summary`、`lighthouse-json`；覆盖率读 `istanbul-summary`、`lcov`、
`cobertura`，`changed_lines` 由 diff 算出。每次执行前先删掉上一次留下的报告。一次运行会因这些判失败：没有报告
（`report-missing`）、报告无法解析（`report-unreadable`）、0 个用例或全部跳过（`no-tests-ran`）、退出码与报告不一致
（`exit-report-mismatch`）、被认领或已登记的文件、映射的用例没有出现在报告里（`registered-test-not-executed`；一个文件被多个套件认领时，只要在其中一个跑过的套件里执行过即可）、覆盖率低于档位
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
  的链头摘要、Tenon 命令写出的基线与 `known-failures.yaml` 的摘要、你在评审里做过的批准（早先版本写在这里的信任决定只在不是 git 仓库的项目里才认，
  git 仓库里的信任只记在下面的信任存储）。链头不等于封存链头的记录
  链（记录是绕开 `tenon test run` 写进来的）判 `record-unsealed`，没有人工批准的出口，下一次 `tenon test run` 另起新链取代它。
  封存缺失、损坏或被改动一律读成空，绝不读成放行。
- *人工确认*：任务 diff 里出现 `.tenon/tests/catalog.yaml`、`.tenon/tests/baselines/**`、`.tenon/tests/known-failures.yaml`、
  `.pipeline/workflows/*.yaml` 的改动，会挡住每个 `gate: review` 步骤（`protected-file-unapproved`），直到你确认确切的内容。
  `tenon review request` 逐个列出文件、状态与摘要，目录与已知失败清单还列出新增 / 改动 / 移出的套件、服务与条目；人工的
  `tenon review acknowledge`（或 Dashboard 的「通过」）把这些摘要的批准封存下来，待确认时 `--delegated` 被拒，之后再改一个字节就要重新
  确认。与 Tenon 上次写出的内容对不上的基线或 `known-failures.yaml` 判 `protected-file-tampered`，并标注「台账外改动」。
- *首次信任*：`tenon test run` 拒绝执行你在本机还没信任过的命令。信任按用户、仓库、单条命令记录：每条可执行命令各有自己的摘要
  （套件的 `command`、`cwd`、`select.files` / `select.grep`、排好序的 `env` 和它用到的服务；内联步骤测试则是它的 `command` 与 `cwd`），
  所以改一条命令只会让这一条重新问，改标签、`covers` 不会问。只校验本次运行要执行的命令，拒绝（exit `1`，不写记录）时只列出未信任的那几条，
  `run-tests` 的 `trust` 对象显示的也是它们。仓库身份取 `git rev-parse --git-common-dir` 的真实路径，所以同一仓库的所有 worktree 共享信任；
  当前检出还必须出现在 `git worktree list --porcelain` 里，一个 `.git` 文件指向已信任仓库的拷贝树什么信任也借不到。信任条目存在用户级状态目录
  （`<state>/test-trust/<user>.json`，旁边的密钥做 HMAC 签名，权限 `0600`，最多 2000 条、满了先淘汰最旧的），不在仓库里；读不出或被改动的文件
  视为没有信任。只有检出目录及其所有上级都没有 `.git`（不是 git 仓库）时才退回检出里的旧封存，早先版本写在那里的 `trusted[]` 仍然让整份摘要相同的目录保持已信任，
  `tenon test trust` 也写在那里。git 仓库里一律不认检出里的旧封存，不论它是否被 git 跟踪：检出里的任何文件（含封存和它的密钥）都可能随仓库或压缩包带来，
  能算好封印给仓库自己授信，只看检出内容的检查（例如「是否被 git 跟踪」）都能被伪造。以前在检出里信任过的命令，请在你自己的终端重新运行一次 `tenon test trust`；
  检出旧封存恰好记着当前整份摘要时，`tenon test run` 多打一行提示说明这一点。git 仓库里没有用户级状态目录时，`tenon test trust` 直接报错，不再退回写检出封存。
  有 `.git` 却读不出仓库身份（git 出错、超时，或 `.git` 是伪造的指针）一律未信任：用户级条目和旧封存都不认，
  `tenon test run` 提示先修好 git，`tenon test trust` 拒绝写入任何东西。
  `tenon test trust [<change>]` 列出未信任的命令，交互终端里问 `[y/N]`（`--yes` 给你自己的脚本，`--status` 逐条显示是否已信任、
  有未信任的 exit `2`，`--json`）。CI 由运行器显式设置 `TENON_TEST_TRUST=1`，之后每次运行都会打一行说明信任来自环境。Tenon 的 hook
  会拒绝 agent 的 shell 调用里出现 `tenon test trust` 或 `TENON_TEST_TRUST=` 赋值，也拒绝写入任何 `test-trust/` 路径，所以这个决定只留给你。
  信任记的是路径而不是文件内容：之后在同一路径克隆出另一个仓库，会继承命令级的信任，与往已信任的仓库里拉新提交是同一个信任级别。

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
信号的去向按步骤决定：`notice`（缺省，也是测试档位唯一的模式，所以默认工作流的各条轨道都用它）把信号汇成一条 `test-integrity`
提示，出现在 `test status`、`status` 和 Dashboard 的测试页签里，从不阻塞；`block` 把同样的信号变成该步骤的一条 `test-integrity`
阻塞，读不出 diff 时失败关闭（`files-diff-unavailable`）。只有冻结的旧策略还能写 `integrity: block`，它没有逐条豁免：还原被削弱的测试。
只在档位会运行测试（`changed`、`full`），或旧策略会运行测试、声明了 `integrity: block` 的步骤上判。`tenon test integrity` 在该步骤的模式是
`block` 且有信号（或读不出 diff）时 exit `2`，否则 `0`；`--step` 取另一个步骤的设置；`--json` 输出 `{ change, step, pass, mode, state, signals[], truncated? }`。最多读 400 个相关文件，
超出由 `files-truncated` 提示。

`test status` 用与转换拦截完全相同的判定列出该步骤每项测试，所以这里通过就是转换会放行；声明了测试档位的步骤在 `--json`
里还带 `policy` 对象（档位及其生效的要求、带修复命令的阻塞码、提示、套件、场景 / 任务追溯、被认领的文件与孤儿、记录链状态）。有阻塞时 exit 2。候选代码、
所跑套件在目录里的条目、计划、步骤的档位定义或工作流指纹任一变化，记录就过期；记录绑定的计划摘要把豁免的 `approved_by` 一律当作空，所以评审
批准豁免不会让批准之前的运行过期（计划的其他任何变化仍会）。`test report` 生成验证报告的测试段，`--write` 替换目标文件里的标记区间，
分两个各自替换的区间：内联步骤测试的旧表格（`tenon:tests:*` 标记之间，只在工作流有内联测试时写）和 v2 块（`<!-- tenon:test-report:begin -->`
与 `<!-- tenon:test-report:end -->` 之间）——追溯矩阵、套件与各套件最新运行的 `run_id`、覆盖率、基准对比、flaky 与已知失败、仍在挡出口的项。
标记之外的字节一个都不动；`tenon status` 靠 v2 块里是否有最新的 run id 判断报告要不要重新生成。`test code-size` 是内建
`code-size` 方向背后的确定性探针，输出一行 JSON 指标（`files_changed`、`lines_added`、`lines_deleted`、`largest_added_lines`）；
只统计源代码：路径范围与工作区候选一致（不含 `openspec/`、`.tenon/`、
`.pipeline/`、`docs/`、依赖与测试缓存），且不含 Markdown。方向模板与默认工作流都不设上限，退出码 0 就是通过，数值由 `code-size` 评审者判断；
没有上限时实测值照样记进运行记录，评审者在提示里读到它；想要上限的项目在工作流 YAML 的该测试下写 `pass.metrics`（例如给 `lines_added` 设 `max`），超限的运行以 `metric-threshold` 失败。`test diff-risk` 是内建 `diff-risk` 方向背后的探针，也是 `lite`
轨道的风险闸（见[路由与执行模式](routing-and-workflows.md#轻量轨道)）：只读仓库，从任务起点算起（已提交与未提交的改动都算），输出一行 JSON：
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
`tenon verify --ci` 的四种报告格式与用法错误已全部进目录（见 [CI 验证](ci-verification.md)）。跨厂商评审的路由与拒绝（`agent prompt` 的 `[ROUTE]` 行、`agent record` 的宿主拒绝与「声明」旁注）、`agent next` 的各行（角色、状态、重跑与宿主说明）、`agent prompt` / `agent record` 的其余错误，以及 `review request` / `review acknowledge` 的成功行、用法错误与警告也已进目录。还没进目录的文案仍是中文。`tenon transition` 遇到非法或未知 event 时，会在第二行用当前语言列出当前 step 的合法 event。

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

任务能否进入 AFK 只看它所在轨道的 `automation.eligible`。没写 `automation` 的轨道（所有平铺工作流也一样）不可进入：`tenon afk enqueue` 退出码 `3`，带 `--json` 时给出 `reason: "track-not-afk-eligible"`。`enqueue_after_spec: true` 的轨道（default 的 `pm`）在规格完成后自动入队。

高级命令可能处理本地敏感数据，先阅读对应安全说明。
