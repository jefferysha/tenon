# 发布说明

Tenon 的发布说明用于回答三个问题：这一版改变了什么、用户需要做什么、如何确认升级成功。

本页只记录已经进入公开发行包的能力，不把规划、内部 ADR 或尚未合并的实验写成已交付事实。

## 阅读方式

每个版本条目都按“新增、变化、修复、升级动作、验证、兼容性”组织。

命令、事件名、phase id、配置 key 和文件路径保留英文，以便与 CLI 输出逐字对应。

面向用户的解释、影响与操作步骤默认使用中文。

## v0.3.1 · 2026-10-07

v0.3.0 的修复版，来自它的真实宿主验收。作者的工作区里有宿主本地文件时，`tenon verify --ci` 现在能在干净克隆上复现你的测试记录，也不再判定被有意放弃的任务失败。跨厂商评审的 CLI 提示、英文轨道标签和登录命令修好了，新增 `tenon --version`。

### 修复

- 干净克隆不再因为从不提交的宿主本地文件让 `tenon verify --ci` 报 `candidate-mismatch`：`.claude/settings.local.json`、项目根目录的 `CLAUDE.local.md` 和 `.claude/worktrees/`。0.3.1 写下的测试记录绑的指纹不含这些文件，而且只在 git 没有跟踪它们时才不含：被跟踪的路径仍然计入。除此之外不按名称排除任何东西。见[候选代码不一致](ci-verification.md#候选代码不一致)。
- `candidate-mismatch` 的提示会写出它能确定的路径：记录之后的第一个提交之后又改过的候选文件，本次检出里候选范围内被 gitignore 或未跟踪的文件，以及被跟踪的宿主本地路径。交付提交自己带的文件不再被怪到头上。
- 沿 `scope-expanded` 放弃边离开的任务（例如升级到 `default` 的 `standard` 任务）不再被 `verify --ci` 判定测试证据，报告里留一条 `change-abandoned` 提示。受保护文件的批准照查，按正常级别报告。只有任务提交的转换链里真的有这条放弃边才算；状态里只写着 `phase: escalated` 的任务照旧判定。
- `tenon evidence export` 是确定性的：每个时间戳都取自证据本身（记录链里最晚一条记录的完成时间），不取时钟，所以导出两次打印的字节相同。
- 跨厂商评审的几行（`agent prompt` 的路由说明、`agent record` 对宿主的拒绝）和 `review acknowledge` 的拒绝信息跟随 `TENON_LANG`；之前它们一直是中文。
- 英文 Dashboard 里选中的轨道标签保持完整可见：用 `track=backend` 直接打开页面不再把标签截在渐隐里，名称变宽（切换语言）或页签条变窄时它会重新滚进可见范围。你自己滚动、点击或聚焦过的标签，不会被尺寸变化拉回去。
- 登录页和 Dashboard 里的 `--open` 不再被画成 `––open`：等宽字体里的命令、路径和 id 关掉了字体连字。文本本身一直是 ASCII。
- `tenon --version`（及 `-V`）打印命令所在插件载荷的版本号。

### 变化

- 手动 `/tenon <请求>`（以 `/` 开头的提示词不经路由钩子）由 `tenon` 技能选通道：用户点名的工作流或轨道优先，实现类请求用 `standard`，只有重型或跨领域的工作（架构、鉴权、迁移、依赖、契约）用 `default`，项目自定义的工作流只在用户点名时用。
- `step.next` 里只剩一条 `transition`、且它是 `scope-expanded` 升级时，技能直接执行，interactive 模式也一样：先用一句话告诉你为什么升级、接下来做什么，然后动手。
- 已完结的任务因为 CI 对它的判定对象是本次检出的树、而不是它完结时的提交而失败时，`tenon verify --ci` 会多给一条 `finished-judged-at-head` 提示。判定结果与之前相同。

### 文档

- 读测试记录的受支持办法是普通读取工具（`cat`、`ls`、`jq`、`grep`、`head`、`tail`、`wc`、`find -name`）或编辑器的 Read 工具。经内联解释器代码（`node -e`、`python -c`）或 `xargs` 的读取，以及后面链着任何写入的读取，都会被写入门拒绝；这道门本身没有改。见[安全模型](security-model.md)。

### 升级动作

运行 `tenon update --codex`（或 `--claude`），新开宿主会话。无需其他操作。

如果 `verify --ci` 对 0.3.0 或更早版本写下的记录已经报 `candidate-mismatch`，而写它们的工作区里有上述某个宿主本地文件，用 0.3.1 对该任务运行一次 `tenon test run <change> --stage`，再提交新记录。

### 兼容性

N-1 是 v0.3.0。N-1 兼容门禁（`tools/test-bundle.sh`）每次运行都在两个方向上让它与本版本互相读写。

- 记录 schema 没有改：v0.3.1 的记录仍然只绑一个工作区指纹。工作区里没有未跟踪的宿主本地文件时，两种指纹相等，v0.3.0 把这条记录读作新鲜。
- 写它的工作区里有未跟踪的宿主本地文件时，v0.3.0 和 v0.2.1 会把 v0.3.1 的记录读作过期（「代码已变化」，退出码 `2`），不会读作损坏。用你回退到的版本重跑套件即可。
- v0.3.0 的记录继续有效：v0.3.1 认两种指纹，所以 v0.3.0 写下的记录在写它的那台机器上是新鲜的。
- `verify --ci` 多了两个提示级的发现代码：`change-abandoned` 和 `finished-judged-at-head`。除 `--version` 外，没有改变任何命令、选项、项目文件或 Dashboard API。

### 验证

```bash
tenon --version
tenon doctor
tenon runtime status
```

`tenon --version` 打印 `0.3.1`。`tenon doctor` 里 `identity:release` 列出宿主插件、runtime 和 Dashboard server 都是 0.3.1。`tenon runtime status` 显示当前 release 为 `valid=yes`。在一个由 0.3.1 写下记录的项目的干净克隆里，`tenon verify --ci --change <name>` 不再因为上述宿主本地文件报 `candidate-mismatch`。

## v0.3.0 · 2026-10-06

v0.3 让 Tenon 在普通项目里能用，也更难被糊弄。小改动现在走四步的 `standard` 标准通道，默认测试流程只要求 `unit`。任务提交的测试证据可以在 CI 里只凭仓库重新校验（`tenon verify --ci` 与一个 GitHub Action），由本机信任根和完整性报告守着，评审者还可以被要求在另一家厂商的 CLI 上运行。Dashboard 需要登录，工作流画在分色带的画布上并带 Signal 流动动画，30 个项目的快照小于 1 MB，英文界面的阻断标签不再解析中文文本，CI 里还有 axe 无障碍检查。`tenon support bundle` 与 `tenon logs` 负责诊断。本版本包含 v0.2.1 的 launcher 修复。升级项目前请先读「行为变化与升级影响」。

### 标准通道

- `standard` 是内建的工作流与轨道：`open → build → verify → done`，没有 Explore 阶段，也没有 OpenSpec 文档。Build 跑单测和改动风险探针，Verify 只有一道评审门，评审者是 `code-review` 和 `security`（后者只在碰到鉴权、依赖或契约路径时挂载）。
- 实现类请求（修、加、重构，中英文都认）路由到 `standard`；带重型信号的请求（架构、schema、鉴权、依赖升级、发布）仍走 `default`。见[标准通道](routing-and-workflows.md#标准通道)。
- 看上去在改代码、却没有任何轨道命中的提示，会收到一行「未被治理」的说明。
- `tenon test diff-risk [<change>] [--json]` 是 Build 要求的改动风险探针：源码文件多于 8 个、动了契约、鉴权、依赖或迁移路径、删了测试、改了测试配置，任一项都不通过（阈值是 `pass.metrics`）。
- 探针不过时，`step.next` 只剩一条带 `escalate` 载荷的 `scope-expanded` 转换，提示改开 `default` 任务。
- `tenon step run <change> [--json]` 一次做完 `step.next` 里确定性的部分（铺文档骨架、登记已写好的文档、读取回执、生成测试计划初稿），遇到需要宿主或作者的动作就停下。
- `tenon document record <change> --all` 登记当前步骤所有文件已写好的文档；没写完的会列出并跳过。
- 新增官方评审者 `code-review`：对照宿主附在提示末尾的目标与验收标准看 diff，不需要规格文档。官方智能体现在是十个。
- 评审者可以声明 `attach_on`（`auth`、`dependency`、`contract`、`migration`），任务碰到这些路径类才挂到步骤上。官方 `security`（1.1.0）只在 `[auth, dependency, contract]` 时挂载，这个默认值写在 CLI 里，不在 agent 文件里。
- Verify 只跑一遍项目的 Playwright 套件：默认工作流里内联的 `playwright` 步骤测试没有了，`e2e` 评审者（1.1.0）也不再重跑。
- 一条集成测试把三个文件的缺陷修复从头走到尾，断言最多 25 次 `tenon` 调用、2 次用户回复。

### CI 校验与证据导出

- `tenon verify --ci (--change <name> | --all-open | --since <ref>)` 不用你的本机密钥就能重新校验已提交的证据：记录链、计划与记录与目录一致、用例级判定、候选代码、变更过的测试配置的批准行、锚点和测试完整性。退出码 `0` 通过，`2` 有错误级发现，`1` 是用法错误。
- 格式有 `text`、`json`、`sarif`（2.1.0）和 `markdown`（作业摘要），用 `--format`、`--out`、`--also` 输出。每份报告都列出没有本机密钥时 CI 证明不了什么。
- 测试完整性按步骤的 `integrity` 策略判定：`block` 把信号变成错误 `test-integrity`（退出码 `2`；浅克隆读不出改动行，则以 `files-diff-unavailable` 失败），缺省的 `notice` 只给一条永远不让运行失败的提示。
- 输出语言跟随 CLI 语言（`TENON_LANG=en|zh`，其次 `LC_ALL`、`LC_MESSAGES`、`LANG`；都没设时是中文）：文本、Markdown、SARIF 消息、JSON 的 `message` 字符串和用法错误。发现码、级别、退出码和 JSON 字段名不变。
- 复合 GitHub Action `.github/actions/tenon-verify` 在 Pull Request 上运行它，用所固定发布里的 CLI bundle，追加作业摘要并把 SARIF 上传到 code scanning。它的 `language` 输入（`zh` 或 `en`）决定报告语言。见 [CI 校验](ci-verification.md)。
- `tenon evidence export <change> --format agent-trace|otel|git-notes|trailer` 输出 Agent Trace v0.1 记录、OTLP/JSON GenAI span（不会发往任何地方）、`refs/notes/tenon` 里的 git note，或 `Tenon-Change:` / `Tenon-Evidence:` 提交尾注。默认只打印，`--apply` 才写 note 或 amend `HEAD`。
- `--anchor`（git-notes）把记录链头抄进 note；`verify --ci` 报告 `anchor-mismatch` 或 `anchor-behind`，`--require-anchor` 让缺失或落后的锚点变成错误。

### 测试完整性与证据可信根

- `test_policy.integrity: notice | block`（默认 `notice`）与 `tenon test integrity <change> [--step <id>] [--json]` 报告任务开始以来证据变弱的十种信号（用例变少、跳过变多、测试被删或被缩短、断言被删、快照被改写、基线被改、新增已知失败、覆盖率门槛调低）。
- `notice` 在 `status` 和 Dashboard 测试页签里给一条 `test-integrity` 提示；`block` 在该步骤把它变成阻断。
- 报告必须比本次运行开始得更晚，并连同摘要复制进该次运行的产物目录，否则这次运行以 `report-untrusted` 失败。工作区指纹只忽略目录或工作流里声明的输出路径。
- 本机封存（`<用户目录>/local/test-seal.json`，旁边是 HMAC 密钥，gitignore）保存每条记录链的链头、你的批准和信任决定。链头没被封存的链是 `record-unsealed`，下一次运行另起新链。
- 任务 diff 里出现 `.tenon/tests/catalog.yaml`、`baselines/**`、`known-failures.yaml`、`.pipeline/workflows/*.yaml` 的改动，会挡住每个 `gate: review` 步骤，直到你确认；`tenon review request` 逐项列出，`--delegated` 被拒绝。已知失败必须指向一个用例，期限不超过 30 天。
- `tenon test trust [<change>] [--yes] [--status] [--json]`：`tenon test run` 拒绝运行你还没有在本机信任的目录命令与内联测试命令。CI 用 `TENON_TEST_TRUST=1` 声明信任。
- 写入门识别 13 种写入证据文件的 shell 写法（`python -c`、`curl -o`、`tar -x`、`git apply`、`xargs sh -c`、`tee`、重定向等），并拒绝 agent 的命令里出现 `tenon test trust`。匹配是静态、尽力而为的，其余由封存兜住。
- 在没改的代码上已有结论的评审者，不能靠重跑换成通过：`tenon agent prompt` 会拒绝（退出 `2`），除非加 `--rerun-reason <text>`，该候选上最严的结论算数。Dashboard 显示 `reruns`。

### 跨厂商评审

- 工作流步骤可以要求评审者在 `host: codex | claude | any` 上运行（Claude 写、Codex 审）；智能体文件可以用 `host:` 建议一个（`tenon agent new --host`）。步骤的声明有约束力，智能体的只负责路由。
- 在另一个宿主或纯终端里，`tenon agent prompt` 把提示写到 `openspec/changes/<change>/.pipeline-agent-reports/<run-id>.prompt.md`，打印 `codex exec …` 或 `claude -p …` 命令和 `tenon agent record` 那一行。Tenon 从不启动另一家的 CLI：由你，或当前宿主里的 agent 去运行。
- `tenon agent record <change> <run-id> --host <host>` 记录宿主（`detected` 或 `declared`）。裁决绑定被评审代码的内容哈希和宿主：宿主不对或未知的登记被拒绝（退出 `2`）。
- 工作流页可以编辑评审者的 `host`。智能体运行抽屉并排显示记录的宿主和要求的宿主、绑定的候选；要求的宿主上还没有有效运行时，对任务当前及之后的步骤给出可复制的 `tenon agent prompt <change> <agent>` 命令。Dashboard 从不运行它。

### 测试流程

- 默认策略只要求 `unit`。`typecheck`、`integration`、`regression`、`e2e`、`playwright`、`a11y`、`visual`、`benchmark`、`smoke` 在项目里有时才运行；覆盖率门槛只作用于目录条目声明了 `coverage` 的套件；全量运行的 `unit` 套件满足 `regression`。
- `tenon test catalog not-applicable <kind> --reason <text> | --rm` 声明整个项目都不适用的种类；经过一次人工 `review acknowledge`（不能 `--delegated`）才生效。
- 项目没有目录时 `tenon init` 会运行 `tenon test discover --write`，`tenon test register <change> --auto` 认领无主测试文件、生成计划初稿并登记。JavaScript 单测的 glob 现在覆盖 `src/`、`test/`、`tests/`、`__tests__/` 和根目录的 `*.test.*`。

### Dashboard

- 登录：没有会话时，`GET /` 和所有 `/api/*` 请求都返回 `401`，只有 `/api/health` 与 `/assets/*` 例外。`tenon dashboard --open` 铸一条一次性登录链接（2 分钟、只能用一次）并由 server 自己打开浏览器，不往磁盘写任何 token。见[登录](dashboard-and-local-api.md#登录)。
- 登录页用 Dashboard 的设计 token 画成，浅色、暗色都有。它只用一种语言：浏览器的 `Accept-Language` 把英文排在中文之前时是英文，否则是中文，并带一个可复制的命令。
- 用过、无效或过期的链接有自己的页面，样式相同，同样给出这条命令和一个「继续」链接。
- 批准评审需要有人在场：第二次点击才会申请一枚一次性 nonce（30 秒），它绑定你的会话、任务和评审修订号。终端里的 `tenon review acknowledge` 不变。
- Signal 取代逐边脉冲：一条恒速传送带，四层彗星从当前节点出发，停在评审门前。`prefers-reduced-motion` 时只显示静态高亮；画布离屏或标签页隐藏时动画暂停。
- 总览是无框的列，按宽度适配，每列一根脊线，每个并行波次一道括线，语义缩放，点列头聚焦到该阶段；节点高 40 px，带状态符号，阶段条 3 px。
- 页面：工作台的「下一步」把同类阻断合并成 40 px 的行；测试页签有四个等宽数字、「完整性」区块和「N 可选」；技能页的引用来自编排接口；计数变化纵向滚动。
- 测试页签把不阻塞的提示（已修好的已知失败、基准波动、未检查的文件）放进单独的「提示」区块，「阻塞」表和它的计数只含真正的阻塞。
- 英文的计数词随数量变化：测试页签的汇总写 Suite 或 Suites、Case 或 Cases。
- 轨道页签条在还有隐藏页签的一侧渐隐，英文长名字不会被从中间截断；选中的和键盘聚焦的页签会被滚到渐隐区之外。
- 规模：每个项目一个快照缓存单元，写请求只清掉它点名的项目。Dashboard 读 `GET /api/snapshot?view=list` 与 `/api/stream?view=list`（先发完整帧，之后只发 `snapshot-delta`），任务的证据从 `GET /api/change/:name/snapshot` 读。
- 30 个项目 × 30 个任务时列表体约 0.6 MB，原来的单份快照是 11 MB；写入后重建列表的 p95 保持在 1.5 s 以内（`bench-snapshot-large` 把关）。
- 英文：step-exit 阻断带 `code`、`subject`、`state`、`count`，据此生成标签，不再解析中文整句（整句留作 tooltip）。`<html lang>` 在首帧前就跟随所选语言。
- 英文界面里，内建工作流（`default`、`standard`、`design-system`）的阶段、轨道和测试种类名，在存下来的名字仍是出厂中文名时显示英文；你改过的、自建的名字原样显示，也不会写回。表格按内容定宽，所以「Integration」这类词不再被截断。
- `e2e/dashboard/a11y.spec.ts` 在亮、暗两种主题下用 axe-core 扫主要页面，出现任何 `serious` 或 `critical` 违规即失败。
- 无障碍修复：键盘聚焦的轨道页签的焦点环不再被页签条裁掉；技能编排器里已放置的行现在是禁用的，而不只是变淡；技能和智能体编排器里可用的「完成」按钮（以及其他实心强调色底）在暗色下对比度只有 1.96:1，现在改用主按钮配色（4.84:1）。

### 支持、日志与语言

- `tenon support bundle [--out <path>] [--json]` 写出本地 `.tar.gz`（权限 `0600`，不超过 5 MiB）：版本、`doctor`、`runtime status`、配置摘要、最近的 Dashboard 日志。token、cookie、登录码、邮箱、home 路径和用户名会先被抹掉；命令列出包里有什么。什么都不会上传。
- Dashboard server 写 `<state>/logs/dashboard.log`（轮转，三个文件各 1 MiB，凭证已脱敏），用 `tenon logs [--follow] [--lines <n>]` 读取。
- `TENON_LANG=en|zh`（其次 `LC_ALL`、`LC_MESSAGES`、`LANG`）决定 CLI 帮助和常见错误的语言；JSON 字段与退出码不变。非法的 `tenon transition` 事件现在会列出当前步骤的合法事件。

### CI 与平台

- CI 在三处阻塞：`verify`（Node 22，Chromium）、`node-matrix` 作业和独立的 WebKit 作业。`npm test` 带 `TENON_E2E=1`。
- `node-matrix` 在 Node 20、22、24 上运行测试体系、reporter 与解析器套件、`tools/` 下的 `node:test` 脚本和 Dashboard 的 Chromium e2e，不是整套测试。Tenon 本身需要 Node 22 或更新；Node 20 在矩阵里，是因为被测项目可能仍在 Node 20 上跑自己的 `node:test`，reporter 与解析器必须读得懂它的输出。
- 测试目录可以设置 `profile: coarse`：机器画像是 OS、架构、核数、Node 主版本加 `profiles_env`（例如 `linux-x64-4c-node22-1a2b3c4d`），同规格的托管运行器共用一份基准基线。
- `tenon doctor` 报告 `env:platform`（macOS、Linux、WSL 为绿，原生 Windows 为红并指向 WSL 2，其他为黄），见[支持矩阵](installation.md#支持的平台)。Node 20 不支持运行 Tenon。
- `tenon test run` 把正在运行的 `tenon` 放到测试进程 `PATH` 的最前，所以 `tenon test code-size --json` 不再以 127 退出。

### 修复

- v0.2.0 的 2000 行 `code-size` 上限从未进入冻结计划，2036 行的候选也能通过。现在新任务在 `lines_added` 超过 2000 时测试失败。
- `tenon test catalog add --report-format exit-code` 可以用了，服务就绪失败会说明原因。
- Dashboard 的智能体详情与删除能看到项目级工作流的引用，仍被引用的智能体不能删。
- 等待中的 interaction 或 confirm 标记不再挡住运行中子代理的工具。
- 交付提交不再带 `.pipeline-owned.json`、`test-results/`、`playwright-report/` 和根目录的 `coverage/`；删除或归档任务会清掉它生成的宿主智能体文件；完结的 design-system 任务会提交 `DESIGN.md`。
- 智能体文件里的技能带 `tenon:` 前缀（裸的 `deep-research` 曾被拒绝）；`tenon agent validate` 拒绝骨架占位符。没有文件归属的用例显示「未报告文件」，不再是 `(unknown)`。
- `tenon update` 会提示 `AGENTS.md` 里 Tenon 受管块已过期的项目运行 `tenon sync --migrate`。

### 行为变化与升级影响

- **确认评审只认负责人。** 非负责人运行 `tenon review acknowledge` 会被拒绝。用 `--as reviewer`（历史里记 `as=reviewer owner=<id>`）或 `tenon owner take <change>`。Dashboard 的「批准」不变。
- **Dashboard 需要登录。** 匿名请求得到 `401`，只有 health 和静态资源例外，server 重启会让你退出登录。运行 `tenon dashboard --open`；原来用 `curl` 的地方改用 CLI 读取；没有浏览器时在终端运行 `tenon dashboard --port <端口>` 取登录链接。
- **带 `profile:` 的目录会被旧版 Tenon 拒绝**，带 `not_applicable:` 的也一样。等所有读这个仓库的人都更新之后再加；不带它们的目录读法和以前一样。
- **默认测试流程只要求 `unit`。** 更新前已开始的任务沿用冻结的计划。想要求别的种类，在你的工作流 `test_policy` 里声明。discover 认不出你的 `npm test` 时，登记一个 `unit` 套件（`tenon test catalog add`）或声明 `unit` 不适用，否则 Spec 会以 `test-kind-missing` 停住。
- **`code-size` 上限开始生效**，对新任务而言（见「修复」）：拆分任务，或调高工作流里的 `pass.metrics`。
- **`scope-expanded` 是放弃边**，`simple` 与 `standard` 都是：从它离开不要求测试、评审者、文档或技能证据，工作区保持未提交，交给新的 `default` 任务。无需操作。
- **路由把小的实现类提示送到 `standard`**，不再启动七阶段的 `default`。要留在 `default`，在提示里点名轨道（例如「用 backend 轨道」）。
- **`security` 评审者只在 diff 碰到鉴权、依赖或契约路径时才挂载。** 想让它每个任务都在：`tenon agent copy security <名字>`，删掉 `attach_on` 那一行，在你的工作流里用这个副本。
- **一台机器上第一次 `tenon test run` 需要你信任。** 它以退出码 `1` 停下并列出命令；请在你自己的终端运行 `tenon test trust`（agent 不能代你）。命令一变就会再问。
- **什么算通过需要你确认。** 目录、基线、已知失败或项目工作流的改动会挡住评审门，直到你用 `tenon review acknowledge` 或 Dashboard 批准。已知失败的条目必须指向一个用例，超过 30 天的到期日不被承认。代码没变时，评审者不加 `--rerun-reason` 就不能重跑。
- **更新之前写下的记录视为未运行**（`record-unsealed`）。进行中的任务运行一次 `tenon test run <change> --stage`。
- **没有声明的输出目录计入候选代码。** 在目录里声明报告、覆盖率和产物路径，否则运行时写出 `coverage/` 会让它自己的记录过期。
- **CLI 语言跟随 locale。** 没有 locale 信号，或是 `C` / `POSIX` 时输出仍是中文；`LANG=en_US.UTF-8` 这类系统 locale 现在得到英文的帮助和消息。`TENON_LANG=zh` 可以固定中文。脚本应该读 `--json`。

### 升级动作

运行 `tenon update --codex`（或 `--claude`），新开宿主会话，然后：

- 用 `tenon dashboard --open` 登录 Dashboard。
- 在每个项目里，在你自己的终端运行一次 `tenon test trust`；更新前已开始的任务，再运行一次 `tenon test run <change> --stage`。
- Codex 项目：`tenon update` 提示 `AGENTS.md` 里的受管块已过期时，运行 `tenon sync --migrate`。
- 可选：把 `tenon-verify` Action 加到 Pull Request 上（[CI 校验](ci-verification.md)），并在运行 `tenon test run` 的 CI 作业里设置 `TENON_TEST_TRUST=1`。

如果每条命令已经报 `Node identity changed`，对使用的每个宿主各运行一次版本化安装命令：

```bash
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.3.0/install.sh | /bin/bash -s -- --claude
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.3.0/install.sh | /bin/bash -s -- --codex
```

全新安装 v0.3.0 只需要前两步。

### 兼容性

N-1 是 v0.2.1。N-1 兼容门禁（`tools/test-bundle.sh`）每次运行都在两个方向上让它与本版本互相读写。

- v0.3 在正常使用中写下的数据都能被 v0.2.1 读取，所以可以用 `tenon runtime repair --rollback` 回滚，也可以和还没更新的同事在同一个仓库里继续工作。能读不等于有效：一个版本写下的运行在另一个版本里仍可能显示为过期（见下面未声明输出那一条）。
- 除非设了 `TENON_RECORD_RETENTION=<n>`，测试运行记录不会被清理。v0.2.1 会把这样被限制条数的链报告为被改动，所以只在所有人都已是 v0.3 或更新时才设它。
- agent 运行的宿主与重跑原因记在运行台账旁边的 `.pipeline-agent-run-meta.jsonl` 里，v0.2.1 不读这个文件。
- v0.2.1 写下的记录在 v0.3 里读作完好的链，但没有本机封存（`record-unsealed`）。更新之后运行一次 `tenon test run <change> --stage`。
- v0.3 把没有声明过的 `coverage/`、`test-results/`、`playwright-report/` 算进工作区。一个版本写下的运行在另一个版本里可能显示为过期。重跑，或在目录里声明这些输出。
- 你主动选用时需要 v0.3 的能力（v0.2.1 会把文件判为非法或忽略该设置）：目录里的 `profile: coarse` 或 `not_applicable:`；工作流 `test_policy` 里的 `integrity: notice|block`；工作流评审者上的 `host:`；自定义 agent 文件里的 `attach_on` 或 `host`（`tenon agent copy security <名字>` 写出的副本也带它）；以及 `TENON_RECORD_RETENTION`。
- standard 通道的任务（`track: standard`）只有 v0.3 能用。v0.2.1 能列出它们、显示状态，但 `check`、`test`、`agent`、`document` 会拒绝（`未注册的 track 'standard'`），`status --json` 也没有 step 投影。回滚之前先完结或归档它们。
- Dashboard 的完整快照形状不变；`?view=list` 与 `GET /api/change/:name/snapshot` 是新增，除 health 和静态资源外所有路由都需要会话。

### 验证

```bash
tenon runtime status
tenon doctor
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18765/api/snapshot
tenon support bundle --out /tmp/tenon-support.tar.gz
tenon verify --ci --all-open
```

`tenon runtime status` 显示当前 release 为 `valid=yes`。doctor 没有红灯：`identity:release` 列出宿主插件、runtime 和 Dashboard server 都是 0.3.0，`env:platform` 在 macOS、Linux、WSL 上为绿，launcher 目录不在 `PATH` 上时 `env:path-tenon` 为黄。Dashboard 在运行时，`curl` 打印 `401`，因为请求没有带会话；`tenon dashboard --open` 会打开已登录的页面。support bundle 列出包含的文件和脱敏次数，权限为 `0600`。没有任务在范围内或每个任务都通过时，`verify --ci` 退出 `0`；记录、批准或候选代码对不上时退出 `2` 并给出发现。

## v0.2.1 · 2026-10-01

v0.2.0 的热修复版。macOS 重启之后，每条 `tenon` 命令和每个 hook 都报
`tenon runtime Node identity changed; rerun tenon setup --codex or tenon setup --claude`，而这条提示让你运行的命令又被同一道检查拒绝，安装无法自己修复。

### 修复

- 稳定 launcher（`~/.local/bin/tenon` 与 `tenon-hook`）把 Node 可执行文件及其每一级父目录的设备号（`st_dev`）钉了进去。macOS 在每次重启后会给同一个卷分配新的设备号，所以这个值撑不过一次重启。launcher 不再保存它。它仍然拒绝 Node 路径上的符号链接，仍然钉住二进制及其父目录的 inode、权限位、属主（二进制还有大小），也仍然拿 Node 的 SHA-256 与 setup 时记录的摘要比对。Linux 同样修改。
- launcher 的 Node 检查不通过时不再把你锁在外面。Node 字节没变、只是身份信息变了：`tenon setup`、`update`、`doctor`、`runtime` 仍能运行，`tenon setup --claude`（或 `--codex`）即可重新钉住，其他命令只打印一行写明这条修复。Node 被替换或删除：那一行是一条完整命令，用你 `PATH` 上的 Node 运行 bootstrap：`env TENON_RUNTIME_ROOTS=… node …/bootstrap/active.mjs cli setup --claude`（Codex 用 `--codex`）。
- hook 最多每 30 分钟打印一次这条消息，其余时候无输出地以 0 退出，从不阻断宿主。
- 新版本会自己修复 v0.2.0 格式的 launcher。v0.2.0 运行的 `tenon update` 会把旧格式再写一遍，所以更新后的第一条 Tenon 命令或第一次会话启动，会用 `setup` 同一个写入器重写两个 launcher。前提是：它们是 Tenon 自己写的普通文件（不是符号链接）、导出相同的 roots，并且钉的是当前运行的 Node 及其记录的 SHA-256。命令行在修复时打印一行说明，修复失败则打印一行提示运行 `tenon setup --claude` / `--codex`；hook 全程静默，也不会等待它。其他情况一律不改动。
- `tenon doctor` 新增检查 `runtime:launcher`：launcher 仍钉着设备号时为 WARN，否则 PASS。
- 载荷摘要缓存也不再用设备号作键，所以重启后的第一次分发不会重新哈希整个载荷。

### 升级动作

如果每条命令都已经报 `Node identity changed`，对使用的每个宿主各运行一次版本化安装命令。它不经过出问题的 launcher：

```bash
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.2.1/install.sh | /bin/bash -s -- --claude
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.2.1/install.sh | /bin/bash -s -- --codex
```

如果 v0.2.0 对你还能用，运行 `tenon update --codex`（或 `--claude`）即可。正在运行的更新程序仍是 v0.2.0，它会把旧 launcher 再写一遍；更新之后的第一条 Tenon 命令或新会话会自动把它们切换成重启安全格式。也可以手动运行 `tenon setup --codex`（或 `--claude`）。全新安装 v0.2.1 无需额外操作。

### 兼容性

没有改变任何公开命令、选项、项目文件或 Dashboard API。新增的只有 `runtime:launcher` 检查和一个内部修复命令；launcher 文本变了（不含设备号、失败提示更明确）。项目和 runtime 状态不受影响。

### 验证

```bash
tenon runtime status
tenon doctor
grep -c '%d' ~/.local/bin/tenon
```

runtime 报告 active release，doctor 为绿，包括 `runtime:launcher`。`grep` 输出 `0`。下次重启后 `tenon runtime status` 仍然可用。

## v0.2.0 · 2026-09-30

能力补齐版。智能体改为在终端编写并注册，整条工作流可以在一张画布上看全，每个任务都要登记并运行自己的全部测试。默认工作流随之改变：
步骤挂上了执行者，并且要求测试，升级项目前请先读「升级动作」。

### 智能体

- 智能体在终端注册：`tenon agent list`、`show`、`new`、`add`、`validate`、`copy`、`rm`、`export`。每个智能体声明 `role`（`executor` 或 `reviewer`）和可选的 semver `version`。`new` 在交互终端里补问缺项，参数齐全时可完全非交互；`rm` 拒绝删除仍被工作流步骤使用的智能体并列出这些步骤。Dashboard 不再新建智能体，只展示。
- 来源分三层。官方智能体随插件发行（`builder`、`researcher`、`architecture`、`backend-quality`、`code-size`、`e2e`、`frontend-quality`、`security`、`spec-consistency`，名称、版本、角色与摘要记录在 `templates/agents/manifest.json`），只读。自定义智能体在用户配置里。项目智能体在 `.tenon/agents/`，进 git，团队共享。同名时项目级优先于自定义；任何来源都不能占用官方名称，这类冲突会被列出且不会被使用。
- 技能 `tenon:agent-author`：在 Claude Code 或 Codex 里按你的描述起草智能体（职责、只做与不做、方法、自检、以 `tenon-result` 块结尾的报告），校验后用 `tenon agent add` 注册。它不写任何 Tenon 状态。
- 任务冻结智能体时，Tenon 为当前宿主生成原生子代理文件：`.claude/agents/tenon-<name>.md` 或 `.codex/agents/tenon-<name>.toml`。`tenon agent prompt` 随后返回 `subagent_type: tenon-<name>`，宿主用该专属子代理执行（Claude Code 强制执行 `tools` 白名单；Codex 没有按 agent 的工具白名单，只为写不了文件、跑不了命令的 agent 设只读沙箱）。无法生成文件时回退为通用子代理，并在运行记录里标明。这些文件登记在 `.pipeline-owned.json`；没有运行中任务再使用时被清理（在 Dashboard 里归档任务同样清理）；`tenon uninstall` 只删除自己生成且你没改过的文件。
- 默认工作流现在挂了执行者：每个 Explore 运行 `researcher`，每个 Build 在评审者之前运行 `builder`（每个相互独立的任务一个子代理，合并为一份报告），每个 Verify 声明 `code-size` 测试（`tenon test code-size --json`，`lines_added` 不超过 2000 即通过）和必需的 `code-size` 评审者。chat 与 free 的 Verify 另外运行 `security` 作为建议性评审者。
- 库页面按角色分组列出智能体，行内显示来源与版本；详情显示字段、渲染后的正文、使用它的步骤和最近运行；自定义与项目智能体可编辑正文，官方智能体可「复制为自定义」。

### 编排

- 技能按波次执行。声明了 `depends_on` 的技能在其依赖之后运行，同一波内并行，波次之间串行；未声明 `depends_on` 的技能保持按声明顺序串行，与之前一致。技能门、`tenon status` 与画布读取同一份顺序。
- 内核把一个工作流（或任务冻结的计划）投影成编排：每个阶段按 runner 实际顺序列出执行者、技能、测试、评审者，以及门禁、回流边和文档流向。OpenSpec 注入的技能与 manifest 叠加的技能在内核计算，不再由页面推算。只读接口：`GET /api/workflows/:name/orchestration?track=` 与 `GET /api/change/:c/orchestration?root=`。
- 工作流页左栏第一行是「总览」，右栏是全宽画布：每个阶段一列（执行者 → 技能 → 测试 → 评审者），门禁图标在列头，回流为虚线弧，悬停显示文档流向；可缩放、适应视图、全屏。工作台任务详情有同一张画布作为「总览」页签，节点带运行状态，当前阶段高亮，读的是任务冻结的计划。
- 单个阶段的右栏只有四段：输入 → 技能 → 输出 → 门禁。「技能」画布用泳道同时显示执行者、技能、测试与评审者；「退回」并入门禁段。
- 门禁只有「评审」（由人确认）和「自动」（声明的输出全部设置后才能离开）两种。`gate: null` 与省略 gate 都是「自动」，所以工作流页只提供两档。输出检查只作用于前进边；`verify-fail`、`requirements-changed` 等回流边不受它阻塞；引擎自己写入的输出（`build_sha`、`archived`）不在检查范围内。

### 测试体系

- 每个任务都要登记自己的全部测试。项目有一份测试目录 `.tenon/tests/catalog.yaml`（进 git，人可编辑）：每个套件有 kind、runner、命令、报告格式与路径、可选覆盖率、产物路径、服务、重试、基准设置，以及如何只选变更文件。`tenon test discover [--write]` 识别 vitest、jest、mocha、node:test、Playwright、tsc、eslint、pytest、go，给出带可解析报告参数的建议套件，`--write` 追加尚未在目录里的套件。
- 每个 change 有一份测试计划 `openspec/changes/<change>/test-plan.yaml`，只由 `tenon test` 命令写入：本任务用到的套件、新增或修改的测试文件，以及 OpenSpec 场景和 `tasks.md` 条目到测试用例的映射。手改计划会变成 `test-plan-tampered`。
- 新增或修改的测试文件必须全部登记。`tenon test sync` 与阶段出口读取 change 自开始以来的 diff（含暂存、未暂存与未跟踪文件），未登记即以 `test-file-unregistered` 阻塞；读不到 diff 时以 `files-diff-unavailable` 阻塞而不是放行。只有场景和 `tasks.md` 中实现（build）段的任务需要映射到用例，其他任务是可选的。
- 工作流按轨道、按阶段声明 `test_policy`：必须登记哪些种类、必须运行哪些（`changed` 或 `full` 范围）、覆盖率门槛、是否要求基准基线、flaky 上限、必需浏览器以及场景覆盖。`default` 给每条轨道提供默认值（例如 frontend 在 spec 登记 `unit` 与 `playwright`，Verify 运行 `unit`、`regression` 与 chromium、webkit 的 `playwright`，并要求 80% 行覆盖率）。没有策略的阶段与旧的内联 `tests[]` 行为不变。阻塞项有稳定的代码（`test-catalog-missing`、`test-plan-missing`、`test-kind-missing`、`test-not-run`、`test-failed`、`test-stale`、`no-tests-ran`、`coverage-below`、`scenario-uncovered` 等）并带修复命令。
- 命令：`tenon test discover`、`catalog`、`plan`、`register`、`unregister`、`waive`、`sync`、`run`、`status`、`baseline`、`known`、`report`。`tenon test run <change>` 可按套件、种类、阶段、变更文件或全部运行。`tenon status` 在 `step.next` 里依序给出：发现 → 生成计划 → 映射场景 → 登记文件 → 运行本阶段测试 → 写报告。
- 结果按用例解析：JUnit（含 pytest 与 surefire）、Playwright JSON、Vitest JSON、Jest JSON、`go test -json`、TAP；基准读取 benchmark JSON、hyperfine、k6 与 Lighthouse。没有报告、报告不可读、0 个用例或全部跳过（`no-tests-ran`，所以 `"test": "exit 0"` 不再算通过）、退出码与报告不一致、已登记文件或已映射用例没有出现在报告里，一律判失败。
- `tenon test discover` 给出的 node:test 套件使用 Tenon 随附的 JUnit reporter（落在本次运行的产物目录，不往项目里写任何文件），Node 20、22、24 上每个用例都带文件归属。报告里没有文件时，用例的文件记为未知，已登记的用例只在该名称于本次运行中唯一时按名称匹配。
- 套件可声明服务。服务每次运行只启动一次，在自己的进程组里，按 URL、端口或日志文本探测就绪，结束后连同孙进程一起回收。启动前 URL 或端口已经有响应会被拒绝，因为测试会打到旧服务上。
- 失败用例按套件的 `retries` 重试；重试后通过的用例标记为 `flaky` 并计数，受步骤策略的上限约束。
- 覆盖率读取 istanbul summary、lcov、cobertura，按策略门槛判定；`changed_lines` 来自 diff。
- 基准先预热再运行 N 次，保留中位数、p95 与离散度。基线按机器画像存于 `.tenon/tests/baselines/<套件>/<画像>.json` 并提交。同画像下退化超过阈值即阻塞；该画像没有基线时通过并提示建立基线的命令（策略要求基线时则阻塞）；不同画像之间从不比较。
- 已知失败清单 `.tenon/tests/known-failures.yaml`（原因、可选链接、到期日）：清单里仍失败的用例不阻塞，新失败阻塞，已修好的用例会提示移出命令，过期条目按普通失败处理。
- 只有 Playwright 脚本计入浏览器证据。截图、trace、视频与 HTML 报告按文件复制进本次运行，建立带大小与摘要的索引，可逐个打开或下载。
- 记录为 v2（套件运行、用例、覆盖率、指标、服务、产物索引），并与代码指纹、目录条目、计划、工作流绑定。记录只由 `tenon test run` 写入，按哈希链串联（`.tenon/users/<slug>/tests/<change>/<run-id>.json`，`prev_digest`）。gate hook 拒绝对记录、计划、基线与已知失败的写入和 shell 重定向。改动记录会让链断裂，该次运行视为未运行。对缺失种类或用例的豁免需要人：`tenon review request` 会列出，用户的确认只批准这些项。
- `tenon test report` 把追溯矩阵（场景或任务 → 用例 → 最近结果）写进验证报告。声明了 `reads_tests` 的评审者还会拿到失败与 flaky 用例、覆盖率和基准差异。
- Dashboard「测试」视图（只读，页面不运行也不登记测试）：项目页列出目录套件、各机器画像的基线与已知失败；工作台任务有「测试」页签（策略矩阵、场景追溯、未登记文件、用例级失败）和运行抽屉（失败用例、产物、覆盖率、对比基线的基准、日志）；工作流页用表单编辑每个阶段的测试策略；库里按 runner 展示测试模板。接口：`GET /api/tests/catalog`、`baselines`、`plan`、`records`、`record`、`artifact`。
- Tenon 自己的仓库把全部套件登记在 `.tenon/tests/catalog.yaml`；CI 在 Chromium 上跑 Dashboard 浏览器测试，并对照 CI 画像跑 `tenon status` 与快照生成的基准。

### 表单

- 新建工作流：选择起点（空白、复制内建 `default` 或 `simple`、已有工作流、或导入 YAML）、名称与 OpenSpec 开关；右侧预览轨道与阶段；名称唯一性与合法性即时校验。
- 新建 / 编辑模板：名称、分类、适用框架（多选）与带「编辑 / 渲染」切换的 Markdown 正文；占位变量说明放在 Tooltip。库里的测试模板按 runner 只读展示。
- 新建项目在模板与客户端之间多了第五步「资源」：可选组件库、图标集与 DESIGN.md。它与模板步骤同构（点行在右侧预览将写入的内容，预览头部加入或移除，按上一步所选框架过滤，可切到全部）。DESIGN.md 由流式的 design 步骤写入，已有的 `DESIGN.md` 不会被覆盖。默认前端 spec 提示词指向 `tenon resources`。
- 技能页的「引用」列包含 OpenSpec 注入与 manifest 叠加的技能。
- 所有新建类对话框行为一致：固定高度、Enter 提交、Esc 关闭（有输入时先确认）、字段下方即时校验、说明进 Tooltip。

### 修复

- Codex：`AGENTS.md` 的受管块仍在描述已删除的各 phase 技能，现改为描述单一的 `tenon` 技能。`tenon sync` 会把该块报告为 `absent`、`current`、`stale` 或 `invalid`，`tenon sync --migrate` 就地刷新过时的块，只改动标记之间的行。
- Playwright 等目录产物原先被记成一个目录，Dashboard 拒绝打开（403）。现在逐个文件建立索引、逐个打开；下载的产物保留原文件名，而不是 `artifact.zip`。
- 写入门 hook 原先按整段工具输入匹配，写一份只是提到测试记录路径的文档也被拒绝。现在只看写入目标（`file_path`、`notebook_path`，或 `apply_patch` 的文件头）。
- 智能体的 `hosts` 限制原先从不生效，因为 `tenon` 技能没有传 `--host`；现已补上。
- 继承了 `TENON_USER`、`TENON_RUNTIME_HOME`、`TENON_BASE_BRANCH` 或 `TENON_CHANGE_NAME` 的测试运行（例如在 Tenon 会话里跑 `npm test`）不再因身份断言失败，也不再写入真实运行时目录；Vitest 对每个测试文件隔离这六个变量。临时目录清理带重试，迟到的写入不再表现为 `ENOTEMPTY`。Vitest worker 上限为 `min(8, cores)`，完整的 `npm test` 在本机与 CI 表现一致。
- 文档：已退役的 1.x Release 与标签仍在发布，保留到 v0.x 真实宿主验收之后；`tenon user` 与 `tenon owner` 补进 CLI 参考与契约；AFK 的 fail-closed 报错写明真实缺口（调用方没有注入 `deps.preparation`）。

### 升级动作

从 v0.1.10 升级：运行 `tenon update --codex`（或 `--claude`），然后新开宿主会话并刷新 Dashboard。N-1 兼容门禁在两个方向上用已发布的 v0.1.10 读写本版本的数据。

从 1.x 迁移：为使用的每个宿主各运行一次版本化安装命令：

```bash
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.2.0/install.sh | /bin/bash -s -- --claude
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.2.0/install.sh | /bin/bash -s -- --codex
```

然后对每个使用默认工作流的项目：

- 默认工作流现在要求测试。在项目里运行一次 `tenon test discover --write`，检查 `.tenon/tests/catalog.yaml` 并提交。没有目录时，新任务会在第一个带测试策略的阶段以 `test-catalog-missing` 被挡住，`tenon status` 会给出这条命令。
- Codex 项目运行一次 `tenon sync --migrate`，刷新 `AGENTS.md` 里的受管块。
- 已经开始的任务保留冻结时的计划：不会获得新的执行者、测试策略或门禁行为，按开始时的规则完成。新任务使用新规则。
- 要使用自己的智能体：运行 `tenon agent new`（或用 `tenon:agent-author` 技能），再到工作流页把它挂到某个步骤。

### 兼容性

- CLI 的新增是新命令和新的可选字段。没有 `role` 的智能体文件照常读取（角色按工具推断，`tenon agent validate` 会提示补上）；v1 测试记录与声明了内联 `tests[]` 的步骤仍可读、仍生效；`gate: null` 继续可用，含义是「自动」。
- 新增的项目文件：`.tenon/tests/`（目录、基线、已知失败）、`.tenon/agents/`，以及每个 change 的 `openspec/changes/<change>/test-plan.yaml`。宿主智能体文件 `.claude/agents/tenon-*.md` 与 `.codex/agents/tenon-*.toml` 由 Tenon 生成和清理，不属于任务的交付提交。
- Dashboard 不运行也不登记测试，也不调用模型；登记在终端完成。

### 验证

```bash
tenon doctor
tenon runtime status
tenon test catalog validate
```

两个宿主的 inventory、active managed runtime 与 Dashboard 都报告 0.2.0。`tenon test catalog validate` 用于已有目录的项目。打开 Dashboard：工作流页第一步是「总览」，库里按角色分组列出九个官方智能体，已有目录的项目在「测试」下显示其套件。

## v0.1.10 · 2026-09-25

以真实用户任务逐条走查驱动的 Dashboard 可用性版本。

### 新建项目

- 新建项目改为四步向导：位置 → 模板 → 客户端 → 确认。
- 目录用系统文件夹对话框选择（`POST /api/fs/choose-folder`）；没有对话框时改用页面内目录浏览（`GET /api/fs/list`），手输路径只是次要入口。
- 位置步骤即时校验：目录不存在、不是 git 仓库（带「初始化 git」开关）、已在列表中（可直接打开）、已有指令文件。
- 只有 `AGENTS.md` 写入正文；`CLAUDE.md` / `GEMINI.md` 只写一行 `@AGENTS.md`；已有文件可追加、覆盖或跳过。
- 创建过程逐步回报（`POST /api/projects/create/stream`），失败回滚并可重试；完成后停在结果页，由你点「打开项目」。

### 项目

- 项目页以客户端为中心：只列该项目已启用的客户端，读同一文件的客户端合并为一行，其余从「+」添加；启用集合存在项目的 `.tenon/clients.json`（`GET/POST /api/projects/clients`）。
- 项目级 / 用户级是所选客户端内的切换；打开或预览都不写文件；缺少 `CLAUDE.md` 时可一键用 `@AGENTS.md` 引用创建。
- 可把项目移出列表（不删文件）；加载失败显示内联错误与重试。

### 工作台

- 任务是否可进入下一阶段与 `tenon status` 出口同一判定（技能、文档、测试、tasks 勾选）；「需要你」只统计待评审，各视图一致。
- 每个任务有「下一步」：每个阻塞一行短标签、可复制的状态命令，以及在 agent 对话里恢复任务的 `/tenon 继续 <change>`。
- 输入、输出、测试改为表格；阶段条为纯色分段；筛选保持一行。
- 删除未被 git 跟踪的任务会明确「不可恢复」并要求输入名称；归档可撤销。

### 工作流、库、技能

- 列出全部内建工作流（含 `simple`）；OpenSpec 注入的技能在画布上可见；添加阶段只需名称；被任务使用的工作流拒绝删除并列出任务。
- 技能画布持续脉冲，每条边至少 480ms，短画布也能看清。
- 库里复制得到「… 副本」并直接进入编辑；所有列表默认打开第一项，不再留空白。
- 技能来源失败会写明原因（例如没有已安装的发布包）。
- 视图 id 改为 `workspace` / `workflow`，旧的 `progress` / `workbench` 链接自动跳转；桌面端去掉顶栏项目切换器，连接点只在断线时显示。

## v0.1.9 · 2026-09-24

Dashboard 审美版。一次审美层面的深度评估（视觉语言、色彩、排版、组件质感、交互、动效）与一流开发者产品的参考调研后，
对设计基础、浮层、动效和各页面做了统一提升。

### 设计基础

- 强调色采用原型的墨绿 `#236a50`；暗色表面分四档明度，主按钮改为中绿底白字；选中统一为中性偏绿底 + 左侧 2px 内边条，
  不再有蓝色选中与第二强调色。
- 圆角四档：控件 8、列表与菜单 10、对话框与抽屉 14、行内代码 4；药丸只留给计数徽标、头像与状态点。
- 阴影三级：卡片发丝阴影、菜单与弹层双层阴影、对话框与抽屉深阴影；浮层不再有 currentColor 黑边。
- 拉丁字体改为 Inter（仅 latin 子集，约 48 KB），中文继续使用系统字体；数字等宽对齐；字重收敛为 400 / 500 / 600。

### 动效

- 统一时长与缓动：按下 80ms、悬停 140ms、选中与菜单 160–180ms、对话框与抽屉 240ms、退场 120ms。
- 菜单、弹层、选择框淡入并从 0.98 放大；对话框从 0.97 放大并上浮；抽屉从右侧滑入；Toast 先淡出再消失；
  导航、筛选芯片与分段控件的选中底色以滑块滑到新位置。
- 画布脉冲改为一条时间线：各边同速（420px/s）依次传递，两端淡入淡出，到达节点时节点闪光，终点实心圆点出现光环；
  切换阶段时画布不再横扫。
- 减少动效时只保留 100ms 的淡入淡出与颜色变化。

### 页面

- 顶栏导航紧跟项目切换器；待决策数字挂在「工作台」角上；连接状态只留状态点。
- 侧栏去掉框中框；1360px 以下折叠为图标栏。
- 工作流页：门禁为分段控件、说明在提示中；「退回」为统一的下拉；保存条只在有改动时滑出；编辑浮层合为一个表面，
  「+」与拖拽柄悬停才出现，文件列表单行；回流弧带方向箭头。
- 工作台空态命令单行可复制；阶段推进时进度段从左填充。
- 项目页宿主与文件两表列宽统一；指令编辑区随内容增高，「编辑 / 渲染」为分段控件。
- 库与技能页减轻字重与装饰；技能页链接仅悬停着色；空白详情不再显示文字。

### 升级动作

从 v0.1.8 升级：运行 `tenon update --codex`（或 `--claude`），然后新开宿主会话并刷新 Dashboard。N-1 兼容门禁在两个方向
上用已发布的 v0.1.8 读写本版本的数据。

从 1.x 迁移：为使用的每个宿主各运行一次版本化安装命令：

```bash
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.1.9/install.sh | /bin/bash -s -- --claude
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.1.9/install.sh | /bin/bash -s -- --codex
```

### 兼容性

- 仅 Dashboard 视觉与交互变化；CLI、状态与数据格式不变。

### 验证

```bash
tenon doctor
tenon runtime status
```

两个宿主的 inventory、active managed runtime 与 Dashboard 都报告 0.1.9。

## v0.1.8 · 2026-09-24

Dashboard 体验版。一次专业 UI/UX 评测（视觉、组件、图形、动效、动线、流畅性、冗余、信息架构、响应式、可访问性）
后的全面优化，外加服务端快照性能优化。

### 更快

- 服务端只构建一份共享快照，供 `/api/snapshot`、实时推送首帧、轮询广播与 AFK 视图共用；指纹不变时直接复用，
  服务端的每次写操作后立即失效。`/api/snapshot` 支持 `ETag` / `304`。页面打开时只构建一次快照；缓存命中后各页面
  约 0.1 秒内显示完整内容（此前 3–5 秒）；空闲时服务端事件循环占用从约 76% 降到约 1%。
- 工作流、库与技能页不再等待快照；工作台与项目页首次加载显示骨架，不再误显示「还没有项目」。

### 工作台

- 筛选保持单行、不换行：状态芯片（全部 / 需要你 / 进行中 / 待复核 / 已完成）与负责人、工作流、轨道、阶段下拉，
  放不下的收进「更多」；只有一个取值的维度隐藏。顶部「待决策」徽标与「需要你」使用同一计数，点击直接筛出。
- 归档、接手、删除移到标题旁与卡片上的「⋯」菜单，聚合视图也可用；底部动作条移除。
- 阶段显示名称而不是 id；「可进入下一步」用琥珀色；单阶段工作流不画进度条；选中的任务写入地址（含项目标识，
  同名任务不再选错）。

### 工作流页与画布

- 画布按 1:1 显示、高度随并行数增长，不再把字缩小；尺寸变化后重新取景；内容放不下时从左对齐可平移。
  深色主题下缩放控件不再是白块。脉冲只在技能运行中或刚编辑后播放。
- 内建 default 工作流不再每个阶段都显示警告（此前全部是误报）；警告改为图标 + 提示。
- 门禁说明可用键盘打开；保存条显示「未保存 N 处」；编辑浮层主按钮为「完成」，点行预览、点「+」加入。
- 地址支持 `wf`、`track`、`step` 深链。

### 项目、库与技能页

- 宿主表改为等分表；指令文件「预览变更」后在差异抽屉里「应用」；删除进入「⋯」菜单；Markdown 预览不再显示
  HTML 注释。
- 库只显示名称（id 放提示）；「复制」改为「复制为自定义」；内建项只用锁图标；智能体按执行者 / 评审者分组；
  加载时不再误显示为空。
- 技能页支持搜索、点行查看详情，状态只标变化与失败；修复服务端返回 `modelInvocable` 时整页报「响应格式无效」。

### 设计系统与可访问性

- 浅色主题辅助文字对比度达到 WCAG AA；禁用按钮换底色而不只是变淡；按钮与芯片点击区不小于 40px。
- 只保留一套基于 Radix 的对话框；删除类确认为 alertdialog，初始焦点在「取消」。
- 去掉重复的面包屑、页眉小标题与名称；设置改为主题 / 语言两行分段控件；断线横幅完整显示。

### 升级动作

从 v0.1.7 升级：运行 `tenon update --codex`（或 `--claude`），然后新开宿主会话并刷新 Dashboard。N-1 兼容门禁在两个方向
上用已发布的 v0.1.7 读写本版本的数据。

从 1.x 迁移：为使用的每个宿主各运行一次版本化安装命令：

```bash
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.1.8/install.sh | /bin/bash -s -- --claude
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.1.8/install.sh | /bin/bash -s -- --codex
```

### 兼容性

- 在服务端之外改动、且快照指纹覆盖不到的内容（例如直接编辑工作流文件、用 `git config` 改身份），Dashboard 最多
  30 秒后可见；经 Dashboard 或 CLI 的写入立即可见。
- 地址参数新增 `status`、`step`、`wf`、`track`；聚合视图的 `change` 带项目标识，旧链接仍按名称匹配。

### 验证

```bash
tenon doctor
tenon runtime status
```

两个宿主的 inventory、active managed runtime 与 Dashboard 都报告 0.1.8。

## v0.1.7 · 2026-09-24

第六轮真实会话验收修复版。v0.1.6 上三条轨道全部走完、没有 verify-fail、每个评审门一次确认即放行；本版修复其中
发现的最后一处流程问题。

### 流程

- 交付步收尾后用户回复「继续」时，续轮本身会在 change 目录追加交互、技能调用与技能确认台账；v0.1.6 据此再次要求
  一次同名的交付提交，模型跳过后在未提交的工作区上流转。判定「还有没有待提交的交付物」现在排除 hook 追加的全部
  四本台账（历史、交互、技能调用、技能确认），它们随下一次提交入库。

### 升级动作

从 v0.1.6 升级：运行 `tenon update --codex`（或 `--claude`），然后新开宿主会话。N-1 兼容门禁在两个方向上用已发布的
v0.1.6 读写本版本的数据。

从 1.x 迁移：为使用的每个宿主各运行一次版本化安装命令：

```bash
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.1.7/install.sh | /bin/bash -s -- --claude
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.1.7/install.sh | /bin/bash -s -- --codex
```

### 验证

```bash
tenon doctor
tenon runtime status
```

两个宿主的 inventory、active managed runtime 与 Dashboard 都报告 0.1.7。

## v0.1.6 · 2026-09-24

第五轮真实会话验收修复版。v0.1.5 上三条轨道全部走完、每个评审门一次确认即放行；本版收尾剩余的小问题。

### 流程

- build 步的技能加载、执行者与评审者动作以及 `pre_verify_review_result` 字段带上 `review_bar`：下一步（verify）
  声明的评审者及其 `block_at` 与关注点。build 内的自审与子代理评审按同一口径修完阻断项，避免到 verify 才被拦下
  而回退。
- 交付步第二次提交使用 `chore(<change>): update deliverables`，与首次 `feat(<change>): deliver` 区分。
- 交付值已知时（如 `pr_url=no-remote`）先写入再做最后一次交付提交；需要先提交才能得到 PR 地址时，写入后补一次
  提交。交付步流转前工作区干净。
- 入口技能以用户使用的语言回复（命令、字段名与路径保持原样）。

### 升级动作

从 v0.1.5 升级：运行 `tenon update --codex`（或 `--claude`），然后新开宿主会话。N-1 兼容门禁在两个方向上用已发布的
v0.1.5 读写本版本的数据。

从 1.x 迁移：为使用的每个宿主各运行一次版本化安装命令：

```bash
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.1.6/install.sh | /bin/bash -s -- --claude
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.1.6/install.sh | /bin/bash -s -- --codex
```

### 兼容性

- `next` 的 build 动作新增可选字段 `review_bar`。

### 验证

```bash
tenon doctor
tenon runtime status
```

两个宿主的 inventory、active managed runtime 与 Dashboard 都报告 0.1.6。

## v0.1.5 · 2026-09-24

第四轮真实会话验收修复版。在 v0.1.4 上三条轨道都已走完并保持工作区干净，本版修复其中发现的引导与确认问题。

### 评审确认

- 用户回复「按推荐」等确认语后，hook 写入评审回执时明确告知模型：已记录对哪个任务、哪个事件的确认，照 `next`
  推进，不要再要求「确认继续」。v0.1.4 中模型会误称确认未生效并空等一轮。
- 会话恢复上下文只报告仍存在且未确认的评审门；已确认未流转的显示「评审已确认」。
- 入口技能列出全部能确认评审门的回复；「按推荐」只表示确认该门，字段取值以 `next` 的 `recommended` 为准，
  想用其他取值必须先问用户。

### 流程

- 规划步提示缺少测试脚本时，要求把测试脚本与测试同步写进提案与设计；`spec-consistency` 评审不再把仅为满足
  必需测试而补的脚本视为规格不一致。v0.1.4 中这会导致 verify-fail 并回退 spec。
- 交付步先提交再勾选任务；应用规格等后续改动在 `pr_url` 之前再提交一次。
- `read-documents` 动作标明本步可编辑的输入文档（`editable`）与说明；其余只读，需求变化走
  `requirements-changed`。文档内容必须读入上下文，不能丢弃输出。
- 不使用 OpenSpec 的工作流完结后显示「已完结」，不再声称「已归档」；`list --finished` 列名改为 `FINISHED_AT`。

### 升级动作

从 v0.1.4 升级：运行 `tenon update --codex`（或 `--claude`），然后新开宿主会话。N-1 兼容门禁在两个方向上用已发布的
v0.1.4 读写本版本的数据。

从 1.x 迁移：为使用的每个宿主各运行一次版本化安装命令：

```bash
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.1.5/install.sh | /bin/bash -s -- --claude
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.1.5/install.sh | /bin/bash -s -- --codex
```

### 兼容性

- 人读输出变化：非 OpenSpec 工作流的 `check` 完结文案、`status` 的 `finished` / `finished_at` 行、`list` 的
  `FINISHED_AT` 列。JSON 输出不变。

### 验证

```bash
tenon doctor
tenon runtime status
```

两个宿主的 inventory、active managed runtime 与 Dashboard 都报告 0.1.5。

## v0.1.4 · 2026-09-24

第三轮真实会话验收修复版。在 v0.1.3 上用真实 Claude Code 会话走完 backend、free 与 simple 轨道，本版修复其中发现的问题。

### 交付物提交

- 交付步（字段含 `pr_url` 或 `prd_path` 的步骤）的 `next` 新增 `commit` 动作，在 `pr_url` 之前提交全部交付物：代码、
  文档、已应用的主规格、`.tenon/users/<用户>/tests` 下的测试记录与状态目录 `.gitignore`。v0.1.3 中默认工作流走完后
  这些改动都留在工作区。
- 提交范围是整个工作区，但排除仓库根的本机门禁标记（`.pipeline-pending-*`）与旧版本遗留的本机文件；
  只剩这些文件时不再发出提交。走完 backend 与 free 后 `git status` 为空（被忽略文件除外）。
- 入口技能只在 `next` 给出 `commit` 或 `finish-change` 时提交。

### 流程

- 后续步骤的必需测试缺少 npm 脚本时，在规划步（spec）就提示，写进计划；build 中才发现时，提示只需补
  `package.json` 脚本、不要改已登记的规格文档，不再引发回退 spec。
- build 步先要求 `build_mode` / `isolation`，再提示测试配置。
- 已完结任务的 `status --json` 总是带 `step`，结构与活跃任务一致，`next` 为 `stop`（`code: finished`）。
- 主规格的 Purpose 与 Requirements 之间保留空行；解封提示同一轮只输出一次。

### 升级动作

从 v0.1.3 升级：运行 `tenon update --codex`（或 `--claude`），然后新开宿主会话。N-1 兼容门禁在两个方向上用已发布的
v0.1.3 读写本版本的数据。

从 1.x 迁移：为使用的每个宿主各运行一次版本化安装命令：

```bash
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.1.4/install.sh | /bin/bash -s -- --claude
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.1.4/install.sh | /bin/bash -s -- --codex
```

### 兼容性

- 交付提交包含工作区中的全部未提交改动；在同一仓库里有无关的未提交文件时，请先自行处理。
- 已完结任务的 stop 代码由 `run-archived` 改为 `finished`。

### 验证

```bash
tenon doctor
tenon runtime status
```

两个宿主的 inventory、active managed runtime 与 Dashboard 都报告 0.1.4。

## v0.1.3 · 2026-09-24

第二轮真实会话验收修复版。在 v0.1.2 上用真实 Claude Code 会话完整走完 backend 与 free 轨道，并按 1440 宽度复查
Dashboard，本版修复其中发现的问题。

### 数据驱动流程（`step.next`）

- `ship`：`tasks.md` 未完成项排在 `apply-spec` 与文档写入之前，以 `fix` 动作出现并列出每一项；勾选一项后剩余项
  不再被隐藏。
- `finish-change` 的提交命令一次成功：只列 git 接受的路径（未被跟踪的原 change 目录不再列入），存在且未跟踪的
  `.pipeline/.gitignore`、`.tenon/.gitignore`、`openspec/.gitignore` 一并提交，旧版本已提交的心跳文件在提交中
  取消跟踪。非 git 仓库时 `commit` 为 `null`。
- `simple` 等不使用 OpenSpec 的工作流在 `verify-pass` 后如有未提交改动，同样给出 `finish-change` 提交动作。
- `build_mode`、`isolation` 等选择字段在读完输入文档后、动手实现前就出现在 `next` 中。
- `chat`、`pm`、`free` 轨道的 `build` 步声明必需评审者 `spec-consistency`：`pre_verify_review_result` 必须在
  评审有真实结论后才能写成 `pass`。进行中的任务保留原冻结计划。
- 必需测试的 npm 脚本在项目中不存在时，`tenon test run` 报「未配置」而不是失败，不写记录；`step.tests[].status`
  为 `unconfigured`，并在 `build` 步就提示配置。
- 已完结任务的 `status --json` 形态一致；`tenon test status` 对已完结任务列出各步最后一次记录。
- `tenon spec apply` 新建能力主规格时从提案写入 Purpose，不再留下 `TBD`；提案仍是骨架时报 `purpose-missing`。

### 宿主与 hook

- 用户在消息中点名已知轨道（「走 free 轨道」「track=free」「use the backend track」等）时，路由以点名为准，
  dispatch 标注 `track_basis: user-named`；否定、未知或多个点名时回退评分并提示。
- 解封提示列出实际能解封的回复（含「按推荐」「好的」）与不能解封的回复，并由测试逐句核对与分类器一致。
- 新增 `openspec/.gitignore` 忽略 `.pipeline-terminal-activity.*` 心跳，工作区不再因心跳变脏。
- 粘贴超长内容时 UserPromptSubmit hook 不再超时：v0.1.2 在 64 KB 日志上即超过 30 秒，现在 1 MB 也在 0.5 秒内；
  超过 64 KiB 的 prompt 只保留首尾各 8 KiB 用于路由判定。

### Dashboard

- 工作台的「含已完结 / 已归档 / 未提交删除」单独一行，工作流筛选不再被挤成竖排。
- 资源目录每组筛选行首显示组名（类别 / 框架 / 样式 / 许可）。

### 升级动作

从 v0.1.2 升级：运行 `tenon update --codex`（或 `--claude`），然后新开宿主会话。N-1 兼容门禁在两个方向上用已发布的
v0.1.2 读写本版本的数据。

从 1.x 迁移：为使用的每个宿主各运行一次版本化安装命令：

```bash
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.1.3/install.sh | /bin/bash -s -- --claude
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.1.3/install.sh | /bin/bash -s -- --codex
```

### 兼容性

- `next` 动作顺序变化：选择字段与测试配置提前。`finish-change.commit` 新增 `untrack`，`command` 与 `commit`
  可能为 `null`。
- 已经写成 `TBD` 的主规格不会被改写。

### 验证

```bash
tenon doctor
tenon runtime status
```

两个宿主的 inventory、active managed runtime 与 Dashboard 都报告 0.1.3。

## v0.1.2 · 2026-09-24

验收修复版。对 v0.1.1 做了系统性真实场景自测（真实 Claude Code 会话完整走完 7 个阶段、逐项命令行能力覆盖、
Dashboard 逐页浏览器操作），本版修复其中发现的缺陷。

### 宿主与 hook

- 交互门不再拦截 `ToolSearch`。Claude Code 中 `AskUserQuestion` 是延迟加载工具，必须先经 `ToolSearch` 载入；
  v0.1.1 在技能要求提问时会形成「必须先问、却不能发问」的死锁。拦截提示改为给出可执行的提问方式。
- hook 的 JSON 解析改为线性：v0.1.1 在 macOS 自带 bash 3.2 上对长命令是平方级耗时，21 KB 的 heredoc 就让测试
  提醒 hook 耗时 67 秒并被宿主以超时取消。现在 166 KB 输入约 1 秒；超过 64 KiB 的命令不再判为只读。
- 测试提醒只匹配当前步骤、当前轨道声明的测试，`free` 轨道不再被提醒运行并不存在的测试。
- 入口技能激活会话时携带宿主会话 id；有待确认评审时，「确认继续」「继续执行」会接续当前任务，而不被路由成新任务。
- `.pipeline/.gitignore` 忽略 `cache/`、`terminal-sessions/` 与 `codex-skill-receipts.jsonl` 等纯本地状态。

### 数据驱动流程（`step.next`）

- `pre_verify_review_result` 只有在本步骤声明的测试、执行者与必需评审者都有真实结果时才能写成 `pass`；`next`
  不再推荐 `pass`，也不再推荐一个接受后又要求 `direct_override` 的 `build_mode`。
- `phase_status`、`verified_at`、`updated_at` 由流转管理，`tenon set` 拒绝直接写入。
- 必需评审者失败时，`next` 直接指向修复或 `verify-fail`，不再要求填写结果字段。
- 并行 agent 按依赖分层编号波次；有 agent 仍在运行时 `next` 如实提示，`tenon agent next` 不再误报「全部完成」。
- `ship`：`tasks.md` 未完成项作为出口阻塞出现在 `next` 中；仓库没有远端时 `pr_url` 可填 `no-remote`
  （CLI 复核确实无远端），其余取值必须是 http(s) 地址。
- 已完结任务列在 `finished_changes`；`tenon check` 对其报告「已完结，无需检查」并以 0 退出。
  `finish-change` 附带提交归档搬移的路径与提交信息，工作区不再留下未提交改动。
- `document record` 拒绝仍含模板占位符的骨架文档，并列出所在行。

### 命令行

- 工作流 YAML 顶层键顺序无关（文档示例中 `document_contract` 写在 `steps` 之后现在可解析）。
- `--preset` 只接受 `full|hotfix|tweak`；自定义工作流不再要求 preset。
- 不存在的任务名统一报「change 不存在」，不再泄漏原始文件错误；输出被管道提前关闭时安静退出。
- `tenon test code-size` 只统计源代码；评审结论与测试记录一样绑定工作区指纹，改码后旧评审会过期。
- 人读的 `tenon workflow plan` 列出每步的输入、输出、测试与 agent；`doctor` 与 `last-update.json` 对变化技能的
  计数一致。

### Dashboard

- 评审者 / 执行者编辑器在父组件重渲染时不再清空草稿（v0.1.1 中添加的评审者可能保存不下来）。
- 首次加载显示加载中，而不是「还没有项目」；中栏搜索框不再被压扁，筛选行换行显示完整。
- 预览不再把 YAML frontmatter 当正文渲染；删除自定义模板、智能体与测试方向前需要确认；提示改为报告结果。
- 断线横幅完整显示在页头下方；项目页不再每 5 秒重读指令文件。
- 资源目录新增 v0 模板、Skiper UI（仅链接）与 coss ui。

### 升级动作

从 v0.1.1 升级：运行 `tenon update --codex`（或 `--claude`），然后新开宿主会话。N-1 兼容门禁在两个方向上用已发布的
v0.1.1 读写本版本的数据。

从 1.x 迁移：为使用的每个宿主各运行一次版本化安装命令：

```bash
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.1.2/install.sh | /bin/bash -s -- --claude
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.1.2/install.sh | /bin/bash -s -- --codex
```

### 兼容性

- `tenon status <change> --json` 新增 `finished_changes`；`set-field` 与 `agent next` 的 JSON 新增字段。
- `--preset` 传入未知值、`agent prompt` 指定未声明的 agent 现在以 1 退出。
- 进行中任务里仍含占位符的已登记文档不受影响；再次登记时需先填写。

### 验证

```bash
tenon doctor
tenon runtime status
```

两个宿主的 inventory、active managed runtime 与 Dashboard 都报告 0.1.2。

## v0.1.1 · 2026-09-23

正确性修复版。在真实宿主上验收 v0.1.0 时发现：默认工作流五条轨道里有三条走不通，另有几处 Tenon 没有核实就把步骤报成了完成。

### 阻断修复：宿主拒绝执行的强制技能

- v0.1.0 的 `pm`、`frontend`、`backend` 三条轨道都出不了 `explore`，`pm` 还卡在 `spec`、`verify` 与 `ship`。
  这些步骤的强制技能里有上游技能在 `SKILL.md` 中声明了 `disable-model-invocation: true`：宿主拒绝代模型调用，
  留不下回执，每次流转都报 `step-skills-incomplete`。
- 替换：`grill-with-docs` 换成它自己委托的 `grilling` + `domain-modeling`；`improve-codebase-architecture` 换成
  `codebase-design`，内建 `architecture` agent 同步更换。`pm` 不再强制 `handoff`（改用
  `tenon handoff <change> [--bundle]`）、`to-spec` 与 `to-tickets`：applied-spec 文档与 spec 步骤的任务门禁已经覆盖
  它们原本的作用。被移出的技能仍随包分发，作为人工指引。
- 此类缺陷不会再发版：发布候选的技能校验以 `mandatory-skill-not-invocable` 失败；`tenon doctor` 新增
  `skills:invocable`，强制技能的全部备选都被证明不可调用时为红，读不到其 `SKILL.md` 时为黄；Dashboard 拒绝保存
  把这类技能设为强制的工作流。

### 不再误报通过

- `tenon check`、`tenon transition` 与 `tenon status` 对步骤技能与出口规则共用同一份判定。v0.1.0 中三者会对同一份
  状态给出不同结论：在 pm 的 `ship`，`check` 失败，`status` 却显示出口就绪，`transition` 也放行。现在任务不能在缺少
  交付物时完成，例如 `prd_path` 为空的 pm 任务。
- 任何轨道上，spec 预演都不再满足 applied-spec 义务。
- 被步骤文档契约点名为产出者的强制技能，只有在本次步骤访问中登记了它产出的文档才算完成，仅有调用回执不再算数。

### 只按 `next` 就能走完任务

`tenon status <change> --json` 的 `next` 现在只给出命令真正接受的动作，只按它执行的 runner 可以把默认任务从
`open` 走到 `tenon list --finished`：

- 已登记后又被修改的输入文档会重新登记，不再无限重复读取；
- 脚手架生成的文档在同一波里登记，脚手架步骤会收敛；
- 未登记的 `role: update` 槽是许可而非义务，不再索要任何动作；
- 评审门后的单条回退边与前进边一样先发起评审请求；
- 归档步骤先给出 `complete`（即 `archived` 流转），再给出带完整 `openspec archive` 命令的 `finish-change`；
- `build_sha` 由 Build 的出口流转写入，不再要求 runner 填写；
- 覆盖率门禁的修复提示与其解析器实际读取的内容一致。

### 负责人与已完结任务

- `tenon set`、`set-many` 与 `cas` 与其他写操作一样要求身份、拒绝非负责人，并拒绝已完结的任务。
- 完结就是流转 `tenon transition <change> archived`，它同时写入 `archived_at`；手动写 `archived` 或 `archived_at`
  会被拒绝。
- 已完结的任务仍可用 `tenon status` 查看，并在标记完结的那一刻就出现在 `tenon list --finished`，不必等目录移动。
- 被「归档」隐藏的任务与已完结的任务给出不同提示：前者指向 `tenon task unarchive`，后者说明任务已完结、需要新建任务。

### 安装与升级

- `tenon spec apply` 会为尚不存在的能力创建主规格目录。
- `tenon doctor` 把检查结论归属到当前使用的宿主，只有加 `--verify-release` 时才访问远端。
- 上游技能 lock 与 v0.1.0 的格式逐字节一致：v0.1.0 的校验器能读 v0.1.1 写出的 lock，反之亦然。技能能否被调用
  改为从其 `SKILL.md` 字节读取，不再经过 lock。
- 安装文档说明如何放宽 `CLAUDE_CODE_PLUGIN_GIT_TIMEOUT_MS`：Claude Code clone 插件市场的默认超时为 120 秒，
  clone 超时会让该宿主处于未装插件状态。

### 升级动作

从 v0.1.0 升级：运行 `tenon update --codex`（或 `--claude`），然后新开宿主会话。N-1 兼容门禁在两个方向上用已发布的
v0.1.0 读写本版本的数据。

从 1.x 迁移：为使用的每个宿主各运行一次版本化安装命令：

```bash
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.1.1/install.sh | /bin/bash -s -- --claude
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.1.1/install.sh | /bin/bash -s -- --codex
```

### 兼容性

- 进行中的任务：产出型强制技能在更早一次步骤访问中登记的文档，不再计入当前访问；`next` 会以 `record-document`
  （带技能名）要求重新登记。
- 以下强制技能仍以调用即算完成，因为在该步骤没有文档槽把它们点名为产出者：`openspec-explore`、`grilling`、
  `domain-modeling`、`codebase-design`（explore）；`brainstorming`（pm 的 spec）；`test-driven-development`、
  `frontend-design`、`prototype`（build）；`browser-qa`、`web-design-guidelines`、`design-taste-frontend`、
  `e2e-testing`（verify）；`finishing-a-development-branch`（ship）。把它们绑定到产物，需要在后续版本中对文档契约
  另行决策。

### 验证

```bash
tenon doctor
tenon runtime status
```

`skills:invocable` 为绿；两个宿主的 inventory、active managed runtime 与 Dashboard 都报告 0.1.1。

## v0.1.0 · 2026-09-22

版本号从 0.1.0 重新开始。Tenon 还不成熟，1.x 这个号码宣称了它并不具备的稳定度。
本版同时交付 v1.1.5 之后完成的能力。

### 版本号重置

- 版本号从 0.1.0 重新开始，之后按 0.1.x / 0.x 递增。已发布的 v1.0.0–v1.0.9 与 v1.1.0–v1.1.5 的 Release
  与标签已经删除，这 16 个号码永不复用：release candidate 会直接拒绝它们。
- 安装顺序把已退役的 1.x 排在其他所有正式版本之下：0.1.0 相对 1.1.5 是升级，而更新的 0.x 不会被更旧的
  0.x 静默覆盖。`tenon update` 会写明自己正在离开的已退役版本，迁移不会静默发生。

### 升级动作

为使用的每个宿主各运行一次版本化安装命令，然后新开宿主会话：

```bash
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.1.0/install.sh | /bin/bash -s -- --claude
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.1.0/install.sh | /bin/bash -s -- --codex
```

在 1.x 上运行 `tenon update` 只会报告降级到 0.1.0，并且不做任何改动：那段拒绝逻辑属于已经发布的 1.x，
无法事后修补，所以上面的一行命令才是迁移路径；1.x 机器上的每日自动更新记录的也是同一条拒绝。
迁移完成后，`tenon update --codex`（或 `--claude`）重新成为常规升级入口。

### 一个仓库多个用户

- Tenon 依次从 `TENON_USER`、`<config>/user.json`、仓库自身配置的用户邮箱解析声明式身份，不需要登录；
  新写入的记录都带上执行者。
- 每个任务都有创建者与负责人，其他用户通过「接手」成为负责人；推进不属于自己的任务会被拒绝。
- 每个用户的状态存放在 `.tenon/users/<slug>/`，同一仓库里的两个人不再互相覆盖当前任务与授权状态。
  Dashboard 顶栏显示当前用户，工作区列表可按负责人筛选。

### 任务归档与删除

- 归档 / 取消归档 只对当前用户隐藏任务，随时可逆。
- 删除只动工作区、不自动提交，Dashboard 会在确认前说明这是「未提交删除」。
- 对应命令：`tenon task delete|archive|unarchive <name>` 与 `tenon list --archived`。

### 工作流即数据

- `openspec: true` 是工作流里唯一的 OpenSpec 开关。
- 每条轨道自己声明 `document_contract`：哪个步骤产出、更新或要求哪份文档。内核里固定的按阶段文档表已删除，
  全局默认工作流把这些表完整写出来。
- Dashboard 工作流页面可编辑每个步骤的输入、技能、执行者、输出、评审者与门禁（评审或自动）；工作流的步骤、
  轨道与门禁存在全局，不再绑定单个项目。

### 一个技能取代七个

- 单个 `tenon` 技能按 `tenon status <change> --json` 的 `step` 块驱动每一步，其中直接给出待执行的 agent
  与必需测试。
- `tenon spec apply` 把 delta spec 应用到主规格。

### 每步的执行者与评审者

- 步骤可声明执行者与评审者：`tenon agent next|prompt|record`。随包提供九个内建 agent（builder、researcher、
  architecture、frontend-quality、backend-quality、code-size、security、spec-consistency、e2e）。
- 评审结论由 Tenon 依据发现项与阻断级别计算，每次运行都留存证据；任务创建时冻结该任务的 agent 集合。
- agent 一律在宿主内运行（Claude Code 的 Agent 工具或 Codex 子 agent），Dashboard 从不调用模型。

### 每步的测试证据

- 步骤可声明测试的命令、输入与输出，统一通过 `tenon test run <change> <test-id>` 执行；必需测试记录缺失或
  过期时，流转门禁拒绝推进。
- 随包提供九个内建测试方向：unit、integration、e2e、playwright、typecheck、regression、benchmark、
  code-size、design-system。运行日志、trace 与截图按运行留存在当前用户的本地目录。

### 指令文件、模板与项目

- Tenon 依据 32 个内建模板块写项目级与用户级指令文件（AGENTS.md、CLAUDE.md、GEMINI.md）；文件在 Tenon 之外
  被改动时报告冲突，不覆盖。
- 库页面集中管理 agent、模板、资源目录与测试方向，内建条目只读、可复制后编辑；「新建项目」一个按钮完成新建或接入。

### 设计体系与资源目录

- 项目的设计体系写在 `DESIGN.md`，由 `tenon design` 与设计体系工作流产出；设计体系未就绪时，拒绝创建前端任务。
- 资源目录随包提供 163 条内建条目（`tenon resources`），供步骤声明可用的库与参考。

### 上游技能

- setup 与 update 按 `skills/sources.yaml` 安装 53 个上游技能到插件根目录；lock 文件记录每个技能的 commit、
  目录摘要与许可证，抓取失败不改变当前发行版。
- 因此安装后的 payload 增长到约 48 MB。以文件 stat 为键的摘要缓存把实测 hook 派发开销控制在相对 v1.1.5
  约 7 ms 以内。

### 兼容性

- v0.1.0 之前没有更早的 0.x 正式版本，因此本次发布显式跳过 N-1 兼容门禁，并且是可见的跳过：fixture 点名
  v0.1.0，工具以约定的退出码报告跳过。v0.1.1 起以 v0.1.0 为基线。
- 也因此，v0.1.0 没有验证过读取 1.x 创建的任务。迁移前请先完结或归档进行中的 1.x 任务，否则可能需要重建。

### 验证

```bash
tenon doctor
tenon runtime status
```

两个宿主的 inventory、active managed runtime 与 Dashboard 都报告 0.1.0；再次运行 `tenon update --codex`
会提示当前发行版已精确生效。

## v1.1.5 · 2026-09-15

在 v1.1.4 上继续同一个真实 Codex 任务时发现并修复的问题。

### 规格

- 中文 delta spec 不再拖到 Verify 才发现 OpenSpec strict validate 要求每条 requirement 含英文 `SHALL` 或 `MUST`。
  两种语言的 scaffold 提示与 `tenon-spec` 技能现在都写明这条规则；官方 CLI 可用时，技能在请求 spec 评审前先运行
  `openspec validate <change> --strict`。此前 Codex 任务用「必须」写 requirement，通过了 spec 评审，却在 Verify 被退回。

### 评审门

- 待确认评审时，未被识别为确认的回复会提示应当如何回复，与交互门一致。此前在 `verify-fail`，agent 给出的选项
  「修复」被门静默忽略。
- `tenon-verify` 要求 agent 在 `verify-fail` 暂停时写明回复「确认继续」。

### 升级动作

为使用的每个宿主安装新版本，然后新开宿主会话：

```bash
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v1.1.5/install.sh | /bin/bash -s -- --claude
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v1.1.5/install.sh | /bin/bash -s -- --codex
```

## v1.1.4 · 2026-09-15

在 v1.1.3 上用 Codex 执行真实任务时发现并修复的问题。

### Codex 技能证据

- Codex 生成的两种 exec 程序写法中，完整读取 `SKILL.md` 都会被认作技能证据。此前 Tenon 只识别
  `const r = await tools.exec_command({...}); text(r);`，写成 `text(await tools.exec_command({...}));` 的读取
  不产生证据：之后第一次 `tenon document record` 必然报 `current StepVisit lacks exact host confirmation`，
  agent 只能重新读取技能。两种写法都必须完整转发恰好一个 awaited 调用的结果；`.output`、未 await、
  包裹转换和附加语句仍然拒绝。
- 该错误现在会说明恢复方法：在当前阶段重新调用产出技能（Claude Code 用 Skill 工具；Codex 用单独一条
  `cat` 读取其 `SKILL.md`，`max_output_tokens` 要足够容纳整个文件，被截断的读取不算证据），再重试登记。
  此前 Codex agent 两次用 1000–2000 token 的输出上限读取 20 KB 的 `tenon-explore` 技能，之后才猜到要调大。

### 升级动作

为使用的每个宿主安装新版本，然后新开宿主会话：

```bash
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v1.1.4/install.sh | /bin/bash -s -- --claude
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v1.1.4/install.sh | /bin/bash -s -- --codex
```

## v1.1.3 · 2026-09-15

在慢速代理网络上为 Codex 安装 v1.1.2 时发现并修复的问题。

### 安装器

- 与 GitHub 的连接中断或变慢不再导致安装失败。稳定版本证明原本只执行一次 `git ls-remote` 与浅克隆
  `git fetch`，一次 `ETIMEDOUT` 或 TLS 重置（`SSL_ERROR_SYSCALL`）就会让 `install.sh` 失败。现在两个调用在
  传输失败时最多重试三次并短暂退避；标签或引用不存在时仍立即失败，每个结果的校验与之前完全相同。

### 交互门

- 用户确认解封待确认的交互后，会在对话中明确告知。此前在 Codex 中，先被拦截过的 agent 在用户回复「确认继续」
  后仍以为门禁未解，没有重试被拦截的操作就停下。

### 升级动作

为使用的每个宿主安装新版本，然后新开宿主会话：

```bash
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v1.1.3/install.sh | /bin/bash -s -- --claude
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v1.1.3/install.sh | /bin/bash -s -- --codex
```

## v1.1.2 · 2026-09-15

在 v1.1.1 上继续用 Claude Code 与 Codex 执行真实任务时发现并修复的问题。

### 交互门

- 交互式技能（`brainstorming`、`grilling`、`grill-with-docs`、`prototype`、`huashu-design`）在每次进入阶段后只向用户
  确认一次。Codex 需要重新读取产出技能才能登记文档；对交互式产出技能，这次重读会再次锁住同一个问题，
  导致 Codex 中 explore 无法登记设计文档与 ADR。现在用户确认后会写入 `InteractionConfirmed` 历史行，
  在重新进入该阶段之前，门禁不再为同一技能加锁。
- 门禁提示会写明可解封的回复（「确认继续」「继续执行」或「同意继续」）。有待确认的问题时，未被识别为确认的
  回复会明确告知 agent，不再被静默忽略。

### 升级动作

为使用的每个宿主安装新版本，然后新开宿主会话：

```bash
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v1.1.2/install.sh | /bin/bash -s -- --claude
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v1.1.2/install.sh | /bin/bash -s -- --codex
```

## v1.1.1 · 2026-09-15

在 Claude Code 与 Codex 中用已发布的 v1.1.0 真实执行任务时发现并修复的问题。

### 宿主兼容

- Claude Code 能重新加载插件。Claude Code 2.1 会自动加载标准 `hooks/hooks.json`，清单再次引用同一文件
  会被拒绝，导致 Tenon 的技能与 hook 全部不可用。Claude 清单不再声明 `hooks`。
- Claude Code 中可以登记文档。Claude Code 以 `tenon:<skill>` 报告插件技能，Skill 回执拒绝了这种名字，
  所有 `tenon document record` 都报 `current StepVisit lacks exact host confirmation`，default 工作流
  无法离开 `open`。
- Tenon 可以在 Codex 沙箱内运行。Codex 的 `workspace-write` 沙箱禁止执行 `/bin/ps`；状态锁改为只记录
  pid 的持有者，不再报 `withLock: current process start identity is unavailable`。
- 宿主报告 Tenon 插件加载失败时，`tenon doctor` 显示红灯。

### 工作流与 Dashboard

- Dashboard 新建的轨道可以完整执行。技能不再用只认识项目轨道注册表的 `tenon tracks show` 校验工作流
  分支轨道；轨道 id 未注册时，`tenon tracks show` 会说明分支轨道的查看方式。
- 已归档的运行不再显示进行中的阶段。
- 没有运行时产物的阶段返回空目录，不再在每次刷新时请求失败。

### 升级动作

为使用的每个宿主安装新版本，然后新开宿主会话：

```bash
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v1.1.1/install.sh | /bin/bash -s -- --claude
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v1.1.1/install.sh | /bin/bash -s -- --codex
```

用 `claude plugin list`（Tenon 已启用且无错误）与 `tenon doctor` 验证。

## v1.1.0 · 2026-09-15

### 工作流编辑器与工作台

- Dashboard 收敛为两个视图：工作台（项目、Change、阶段轨、带运行状态的阶段技能流、输入/输出文件、
  运行时产物）与工作流编辑器。
- 工作流按用户全局存储，不再绑定项目。每个工作流包含自己的轨道分支；阶段可拖拽排序，门禁只有
  `review` 与 `auto`，并可声明退回到哪个阶段。技能在画布上编排：落在同一列为并行，落在右侧为串行。
- 运行时产物保留产出者、版本与血缘；文档与字段产出走同一提交路径。

### 评审决策与门禁安全

- 待决 review 可以在终端或工作台右栏批准。两端共用同一个确认应用，除入口渠道
  （`review_acknowledged_via`）外，canonical 状态、交互记录与 history 完全一致。
- 所有被拒绝的确认都不写入任何数据。Dashboard 请求携带 expected revision 与幂等 key；过期或冲突
  请求返回带稳定 code 的 409，意外错误返回不含内部细节的 500。`tenon review acknowledge` 对缺少复核
  请求、revision 冲突、幂等冲突、无效命令分别以 `2`、`3`、`4`、`1` 退出。
- 所有入口离开 review 阶段都必须具备精确 receipt 与匹配 binding。`tenon set/set-many/cas` 不能再修改
  `phase`；`tenon state import-legacy` 保留受 transition 控制的字段并报告被忽略的字段。
- 本地 HTTP transition 入口永远不能满足 loop human gate。review 待决期间，读取 Dashboard token 与调用
  本机 API 会被记录为脱敏的自审批观测，AFK 模式下同样记录。

### 安全

- `fast-uri` 升级到不含高危公告的版本。

### 升级动作

安装不可变的 `v1.1.0` 入口，或运行 `tenon update --codex`（或 `--claude`）。完成后新开宿主会话以加载
更新后的 Skills 与 hooks。`v1.0.9` 保持不可变，可用于回滚。

## v1.0.9 · 2026-09-02

### Dashboard 稳定性与 Pipeline 可见性

- 适配器安装的有限事件流会在完成后确定性关闭；malformed、传输不可用会明确报错，安装按钮
  不会永久停留在忙碌状态。切换项目时会解绑旧流，旧项目的迟到事件不会串到新项目。
- Definition catalog 的 SSE 在浏览器于初始加载期间离开时也会清理；慢速投影会串行化，避免
  revision 乱序到达或回退页面上已经看到的定义。
- Change 创建会等待 catalog 对账，并明确展示 loading、unavailable、empty 状态。创建前会预览
  选定 Pipeline 的每个 Stage、串行/并行模式、Skill 顺序和声明的依赖关系。
- 适配器请求的布尔字段现在严格校验类型，不再把字符串隐式当作值，保证 dry-run 与确认语义
  对 API 客户端保持明确。

### 兼容性与范围

- 已有 Change 继续使用冻结的 Workflow/Track/Pipeline 身份；GUI 当前展示由 Workflow/Track 派生的
  canonical Pipeline。独立命名的 Pipeline blueprint 仍通过 planner-v2 使用，待持久化 Pipeline
  Registry 契约落地后再进入编辑器。

### 升级动作

安装不可变的 `v1.0.9` 入口，日常更新继续运行 `tenon update --codex`（或 `--claude`）。之前的
`v1.0.8` 发布保持不可变，可作为回滚版本。

## v1.0.8 · 2026-09-02

### 编排输入与 Pipeline Runtime

- Skill 依赖会在执行前物化为版本化的 `skill-input-manifest/v2` 和受限输入包；Executor
  与 Validator 接收同一个经过摘要校验的输入。输入投递被拒绝时会 fail-closed，绝不会调用 Skill。
- Skill 的规范化产物会原子写入 `.tenon-artifacts/`，并登记 `artifact://` 引用、Schema、字节数
  和 SHA-256 摘要；下游 Skill 通过 Manifest 契约读取，而不是依赖模型自行寻找文件。
- 自定义 Workflow、Track、Pipeline、Stage 和 Skill 依赖遵守声明的串行/并行模式及资源声明；
  重叠的写入资源不会并发执行。

### 安全与依赖维护

- Browserslist 通过仓库 override 和锁文件固定到首个修复版本 `4.28.7`，消除高危公告，未放宽审计门禁。

### 升级动作

安装不可变的 `v1.0.8` 入口，日常更新继续运行 `tenon update --codex`（或 `--claude`）。已存在的
Change 会继续使用冻结的 Workflow/Track/Pipeline，只有显式 replan 才会切换定义。

## v1.0.7 · 2026-08-11

### 跨版本 installer bridge 恢复

- 公开 installer 只有在旧稳定版本的 durable WAL 已精确到达宿主阶段 `plugin-installed`，并且当前插件与 Marketplace 仍逐项匹配旧版本的 plugin version、稳定 tag、commit、官方 source/type/origin、ref 与 clean checkout 时，才会接管它。
- 任何其他 phase、malformed/unknown 数据、同版但 tag/commit 不等于当前已证明 target 的 WAL、更高目标版本，或任意宿主 inventory drift，都会在 host mutation 前 fail-closed，并保留原 WAL 供诊断或恢复；精确匹配当前 target 的同版 WAL 仍沿用既有恢复路径。
- 旧事务会被原子替换为 current-target 事务，并以已验证的宿主状态作为 before 快照；现有 exact provenance、trusted host、锁、原子性与 packaged setup 校验保持不变。不增加 retry/fallback，也不弱化 stable Release/object proof。

### 升级动作

当前公开入口使用不可变 `v1.0.7`；日常升级仍运行 `tenon update --codex`（或 `--claude`）。

## v1.0.6 · 2026-08-11

### Stable Git proof 网络预算

- 慢链路实测显示公开 stable tag/object proof 可能超过此前 30 秒 Git 预算：proxy `ls-remote`/fetch 为 6.9 秒/11.3 秒，直连 fetch 达到 22.9 秒，而正式事务中仍偶发更长阶段。
- Git 远端 `ls-remote` 与 fetch 现在采用有界 60 秒预算；GitHub Release API metadata 和 npm bootstrap raw installer 下载仍为 30 秒；本地 init/rev-parse/cat-file proof 仍为 10 秒，宿主 observation 默认仍为 5 秒。
- exact stable tag/object/commit、digest、trusted executable、官方 HTTPS host、大小限制与原子性校验保持不变；不重试、不使用 source/branch/cache fallback，失败继续在 mutation 前 fail-closed。

### 升级动作

当前公开入口使用不可变 `v1.0.6`；日常升级仍运行 `tenon update --codex`（或 `--claude`）。

## v1.0.5 · 2026-08-11

### Doctor 发布身份证明

- `tenon doctor` 的发布身份探针现在会传递远端 Git tag/object proof 的有界 30 秒预算，以及本地证明命令的 10 秒预算。
- 宿主 observation 命令仍保留默认 5 秒超时；不增加 retry、不使用 source/branch/cache fallback，也不弱化 trusted-executable 或其他安全校验。

### 升级动作

当前公开入口使用不可变 `v1.0.5`；日常升级仍运行 `tenon update --codex`（或 `--claude`）。

## v1.0.4 · 2026-08-11

### 公开安装与更新网络预算

- shell installer 的 GitHub Release metadata/tag proof、`tenon update` 的 Release metadata 请求，以及 npm bootstrap 的 installer 下载，统一采用有界 30 秒网络预算。
- exact stable Release、tag/object、digest、host trust、官方 HTTPS host、大小限制与原子性校验保持不变。
- 仍然不重试、不使用 source/branch/cache fallback；失败继续在 mutation 前 fail-closed。

### 升级动作

当前公开入口使用不可变 `v1.0.4`；日常升级仍运行 `tenon update --codex`（或 `--claude`）。

## v1.0.3 · 2026-08-11

### Stable Release 证明诊断

- 远端 tag/object proof 的网络预算从 10 秒提升为有界 30 秒；本地证明命令仍保持 10 秒预算。
- timeout 失败现在保留 `ETIMEDOUT` 等可诊断的 stderr 信息，不再返回空错误详情。
- 安全验证、原子发布以及无 retry、无 fallback 语义保持不变。

### 升级动作

日常升级仍使用 `tenon update --codex`（或 `--claude`），并继续绑定经过验证的稳定 Release tag。

## v1.0.2 · 2026-08-08

### 版本化安装与更新

- 公开一键安装固定使用不可变 `v1.0.2` 预构建资产，不从 `main` 安装，也不编译源码。
- `tenon update --codex` 解析官方最新稳定 GitHub Release，冻结 tag 与 commit，再通过宿主官方命令重绑定 Codex Marketplace。
- 宿主、managed runtime 与 Dashboard 精确同版时零 mutation；降级或无法验证 Release 身份时在 mutation 前失败。
- setup 始终等待 Dashboard readiness；curl/CI 安装和所有更新不自动打开浏览器，并打印已验证 URL 与 `tenon dashboard --open`。

### 升级动作

v1.0.1 用户先一次性运行不可变的 `v1.0.2/install.sh` 一行命令；旧 launcher 无法在一次旧 updater
调用中安全自重绑新 tag。从 v1.0.2 起，每次只运行一条 `tenon update --codex`。新开 Codex 会话
加载已发布 Skills/hooks 后，运行 `tenon doctor --json`。

## v1.0.1 · 2026-07-26

### 正常对话入口契约

- `product/identity.json` 新增 `entrySkill: "tenon"`，它是唯一公开入口。
- Codex 正常对话统一调用 `tenon:tenon`，不保留第二入口别名。
- 根 `AGENTS.md` 与 Codex 静态 adapter 消费同一份生成 managed block。
- `tenon doctor` 会验证入口 Skill，并把仍启用的冲突工作流插件报告为红灯。
- `tenon setup --codex -y` 会先通过 Codex 官方插件管理器移除该精确旧登记，再激活 Tenon。

### 仓库与发布卫生

- CI 与 Release 对所有受版本控制路径和文本执行外部参考项目身份扫描。
- 扫描不区分大小写、没有豁免，诊断信息也不会回显受限名称。
- Release payload 构建前执行同一门禁，避免源码干净但发行包污染。

### 升级动作

运行 `tenon update --codex`，随后运行 `tenon setup --codex --auto-update -y`。新开 Codex 会话后执行
`tenon doctor --json`。

## v1.0.0 · 2026-07-26

### 中文治理文档

- 新 Change 的治理文档默认固定为 `zh-CN`。
- `tenon init`、`tenon document scaffold` 与 default OpenSpec fallback 使用同一 Document Presentation Registry。
- 用户可以在创建时显式选择 `--document-locale en`。
- 已固定 locale 的 Change 不允许在中途静默切换语言。
- 历史 Change 会从现有 H1 文字信号推断语言。
- 语言信号混合或不足时命令失败并要求显式选择，不会猜测覆盖。

### 执行模式

- Discussion 用于不需要状态机的普通问答。
- Simple 使用 `change → verify → done`，不生成完整 OpenSpec 文档链。
- Default 使用 `open → explore → spec ⇄ build ⇄ verify → ship → archive`。
- Free 显式绑定 workflow，不叠加 PM、前端或后端 Track。
- Custom 完全遵守自身声明的 DAG、Skill、gate 与 document contract。

### 文档站

- 仓库首页 README 默认中文，并提供 `README.en.md`。
- 文档站提供中文根路由与 `/en/` 英文镜像。
- 本地搜索基于公开 content manifest 构建。
- GitHub Pages 只从 `main` 分支部署。
- Pull Request 只构建和检查，不执行生产部署。
- 发布 artifact 经过闭集 allowlist、敏感信息扫描和 project base 检查。
- `llms.txt` 只索引公开页面。
- 内部 ADR、Superpowers 计划、review receipt 与本地控制面状态不会进入公开站点。

### 安装与更新

- Codex 使用 `tenon setup --codex`。
- Claude 使用 `tenon setup --claude`。
- 更新使用对应宿主的 `tenon update --codex` 或 `tenon update --claude`。
- 托管 runtime 以内容摘要发布，稳定 launcher 指向已验证版本。
- 更新失败时保留上一版，可用 `tenon runtime repair --rollback` 恢复。
- Dashboard 默认监听 `127.0.0.1:18765`。

## 升级动作

1. 在现有仓库确认工作区状态。
2. 运行对应宿主的 `tenon update` 命令。
3. 运行 `tenon runtime status` 查看活动版本。
4. 运行 `tenon doctor` 检查安装、Skill 与宿主适配。
5. 在项目中运行 `tenon list --json` 验证 CLI 可读状态。
6. 打开 Dashboard 时确认地址为 `127.0.0.1:18765`。

## 验证

- `tenon --help` 能显示命令族。
- `tenon runtime status` 能显示活动 runtime。
- `tenon doctor` 不报告缺失的内建 Skill。
- `tenon setup --codex` 重复运行保持幂等。
- `tenon update --codex` 不修改项目的 canonical Change 状态。
- 新建测试 Change 时 proposal、design 与 tasks 默认中文。
- 显式英文 Change 的新文档保持英文。

## 兼容性

canonical Change codec 不因文档 locale 增加新字段。

locale 固定信息保存在 `.pipeline-document-locale.json` sidecar，因此旧版 runtime 仍可读取 canonical state。

发行资产继续包含 default、simple、free 与 custom workflow 所需的模板和 Skill。

## 已知边界

GitHub Pages 的真实公开 URL 只有在 `main` workflow 成功部署后才能确认。

本地预览通过不等于远程部署成功；应以 Actions 的 deploy job 和 Pages environment 为准。

Dashboard 的界面语言与治理文档 locale 是两个独立边界，不互相覆盖。

## 回滚

如果升级后的 runtime 无法启动，先运行 `tenon runtime status` 收集版本信息。

随后运行 `tenon runtime repair --rollback` 切回上一份已验证内容摘要。

回滚 runtime 不会删除项目中的 Change、OpenSpec 文档或证据账本。

## 版本记录规范

未来发布必须在本页增加中文条目，并同步英文镜像。

条目必须对应真实提交、构建和验证证据。

未验证的规划只能写入 roadmap，不得提前进入发布说明。

每次发布还应检查安装命令、更新命令、Dashboard 端口和 Pages 路径是否与源码真相一致。

## 下一步

继续阅读[更新、恢复与卸载](./updates-recovery-and-uninstall.md)，了解完整的运行时维护与恢复流程。
