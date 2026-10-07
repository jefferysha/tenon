# CI 校验

## 目标

让 Pull Request 自己证明它的测试证据。`tenon verify --ci` 只用已提交的文件，独立重算 `tenon test run`、`tenon review`
和任务状态在本机记下的东西；GitHub Action 在每个 PR 上运行它，把 SARIF 上传到 code scanning，并写出作业摘要。
伪造或过期的记录会让检查失败。

## 前置条件

- 仓库已经在用受治理的 Change 和测试体系（`.tenon/tests/catalog.yaml`、每个 Change 的测试计划、
  提交在按用户记录目录下的运行记录）。
- 运行器上有 Node.js 22 或更高版本；Action 会安装。
- `actions/checkout` 要带 `fetch-depth: 0`。受保护文件的批准要对着每个 Change 的起点提交核对，浅克隆答不了；
  这时检查以 `protected-diff-unavailable` 失败关闭，不会猜。

## CI 能证明什么、不能证明什么

CI 没有你本机的 HMAC 密钥。记录与批准用一把放在用户记录目录下 gitignore 的 `local/` 里的密钥封存（`env.key` 与
`test-seal.json`），所以 CI 无法证明某条记录是受信任机器上的 `tenon test run` 写出来的；其余的它都重新推导。

| CI 从已提交文件重新校验 | 没有本机密钥，CI 证明不了 |
| --- | --- |
| 记录链：链首、分叉、成环、游离或缺失的记录、文件名、内容摘要 | 记录由你信任的机器上的 `tenon test run` 写出。一条把每个摘要都重算过、与计划、目录和代码自洽的伪造链，CI 看不出来——除非它的链头被锚定（见下） |
| 记录自洽：所在 Change 与用户目录、结论与套件、留存用例与统计 | 评审批准由人给出。批准在本机封存里；Change 历史里的 `test:protected-approve` 行是明文，可以手写 |
| 计划、记录、目录一致：计划摘要台账、目录可解析、记录绑定的目录 / 计划 / 策略 / 工作流摘要仍然新鲜、登记的测试文件仍在 | 套件真的执行过、报告没有被伪造。报告与产物留在作者的机器上，CI 只有记录里的摘要 |
| 当前步骤策略下的用例级判定：套件已运行且通过、已登记用例出现在报告里、覆盖率、基准、flaky 上限、场景追溯 | 用户身份属实。身份是声明的，不是认证的 |
| 候选代码：记录绑定的工作区指纹等于本次检出的树的指纹 | |
| 自 Change 起点以来改动的受保护文件（目录、基线、已知失败、项目工作流）在 Change 历史里有批准行，且摘要等于当前内容 | |
| git notes 里的锚点（有的话） | |

每份报告都会打印这张对照，绿色的检查不会被读成超出它能证明的内容。想要根在运行器而不是作者机器上的证据，另起一个作业在运行器上重跑套件
（`TENON_TEST_TRUST=1 TENON_USER=ci@example.com tenon test run <change> --stage`）。重跑通过说明套件在你掌控的机器上能通过；
它写出的记录属于 CI 用户，并不会让已提交的记录更可信。

## 加到 Pull Request 上

Action 就在本仓库里，随每个发布一起发布。把它固定到包含 `.github/actions/tenon-verify` 的发布 tag 或提交 SHA（把下面的
`vX.Y.Z` 换掉）；它运行的 CLI 就是同一个发布里的单文件 bundle，运行时不下载任何东西。

```yaml
name: Tenon verify
on:
  pull_request:

permissions:
  contents: read
  security-events: write   # 把 SARIF 上传到 code scanning

jobs:
  tenon-verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: jefferysha/tenon/.github/actions/tenon-verify@vX.Y.Z
        with:
          expected-version: 'X.Y.Z'
```

同一份文件放在 `docs/examples/github-actions/tenon-verify.yml`。来自 fork 的 PR 令牌是只读的，SARIF 上传会被跳过而不让作业失败；
那里设 `upload-sarif: 'false'`。检查本身仍然运行，仍然会让作业失败。

Action 输入：

| 输入 | 默认 | 含义 |
| --- | --- | --- |
| `since` | PR 上取 `origin/<目标分支>` | 校验与该引用的 merge-base 以来改到的 Change |
| `change` | | 只校验这个 Change |
| `all-open` | `false` | 校验全部未完结的 Change |
| `step` | | 按这个工作流步骤的测试策略判定，而不是 Change 的当前步骤 |
| `candidate` | `error` | `error`、`warn`、`off`；见「候选代码不一致」 |
| `require-anchor` | `false` | 要求有锚点 note，且链头等于锚点 |
| `fetch-notes` | `true` | 从 `origin` 取 `refs/notes/tenon`（尽力而为） |
| `upload-sarif` | `true` | 上传 SARIF 报告 |
| `sarif-category` | `tenon-verify` | code scanning 的类别 |
| `language` | | `zh` 或 `en`：作业摘要、SARIF 消息与日志的语言；留空沿用 CLI 的缺省（中文，除非 runner 的 locale 另有指定） |
| `node-version` | `22` | Node.js 版本 |
| `expected-version` | | 固定的发布版本必须恰好是它，否则失败 |
| `cli` | | 用别处的 CLI 入口代替发布里的 bundle |

输出：`exit-code`、`sarif-path`、`summary-path`、`report-path`。Action 的最后一步在 `exit-code` 不为 `0` 时让作业失败，
排在 SARIF 上传之后。

## 它检查什么

`tenon verify --ci` 只读已提交的文件，不加锁，除了你指定的输出文件不写任何东西。对每个选中的 Change 做下表的检查。
发现码就是 SARIF 规则 id 去掉 `tenon/` 前缀。

| 检查 | 发现码 |
| --- | --- |
| 每个用户目录的记录链 | `record-chain-broken` |
| 记录自洽 | `record-misplaced`、`record-inconsistent` |
| 计划、记录、目录一致；当前步骤的策略 | `test-plan-missing`、`test-plan-tampered`、`test-catalog-missing`、`test-not-run`、`test-stale`、`test-failed`、`registered-test-not-executed`、`coverage-below`、`scenario-uncovered`，以及 `tenon test status` 里的其余测试策略码 |
| 登记的测试文件仍在 | `plan-file-missing` |
| 候选树 | `candidate-mismatch` |
| 受保护文件的批准 | `protected-unapproved`、`protected-changed-after-approval`、`protected-approval-unbound`（警告）、`protected-diff-unavailable` |
| 锚点 | `anchor-mismatch`、`anchor-behind`（警告）、`anchor-unverifiable`（警告）、`anchor-missing`（只在 `--require-anchor` 时） |
| 被放弃的 Change（不判定测试证据） | `change-abandoned`（提示） |
| 对检出的树判定的已完结 Change | `finished-judged-at-head`（提示） |

被放弃的 Change 不判定测试证据。沿放弃边（`scope-expanded`，例如升级进终态 `escalated` 的 `standard` 任务）离开工作流的 Change
不需要任何测试证据，它通常和接手它的 `default` Change 在同一个 PR 里。CI 不判定它的测试证据：不管是 `--change` 选它还是 `--since`
把它带进来，报告里它只有一条提示 `change-abandoned`，没有测试策略或候选方面的发现。只认真的走过放弃边的 Change：CI 读 Change canonical
运行状态里的链头转换记录，要求它是放弃事件、转入的正是状态所在的终态、且冻结的工作流声明过这条边。状态里只写着
`phase: escalated`、背后没有放弃转换的，照常判定、照常失败。

放弃不会跳过、也证明不了两件事：

- **受保护文件的批准照查。** 放弃边不要求评审，所以只带着一个被放弃 Change 的 PR，否则可以不经任何批准就降低覆盖率阈值、改目录里的命令、
  新增已知失败或改工作流的 `test_policy`。CI 对被放弃的 Change 做和别的 Change 一样的批准检查，`protected-unapproved` 及同类发现照常定级，
  会让检查失败。检查拿这个 Change 自己历史里的批准行，去对它起点以来的全部改动，所以只有接手的 Change 做过（并批准过）的受保护改动，
  也会报在被放弃的 Change 上。这样的改动请放进 CI 会判定的 Change 里，或者在被放弃的 Change 上也批准一遍。
- **放弃这个判断没有封存。** 它依据作者提交的转换链：CI 校验它自洽（canonical 运行状态的 revision 摘要），但证明不了它出自真的
  `tenon transition`——能写 Change 目录的人就能写出一条自洽的链。这和上面表格对测试记录写明的限制相同，也是上面那条批准检查不可省的原因。

判定哪个步骤：Change 的当前步骤；它没有声明测试策略时，取它之前最近一个声明了的步骤（所以已完结的 Change 落在 verify）。
判定哪条链：Change 负责人的链。负责人没有记录、恰好只有另一个用户有记录时，用那一条并给出警告 `owner-chain-missing`。
其他用户的链只检查完整性。

测试完整性按当前步骤的策略判定，口径与本机转换门禁相同（步骤要运行测试，或声明了 `integrity: block`）。它读 Change 起点以来已提交的 diff，
找证据变弱的信号：测试文件被删、声明的用例变少、新增跳过标记、断言变少、快照被改写等（`tenon test integrity <change>` 全部列出）。
步骤 `test_policy` 里写了 `integrity: block` 时，任何信号都是 error 级发现 `test-integrity`，读不出 diff 也是
（`files-diff-unavailable`，例如浅克隆），所以失败关闭；缺省的 `integrity: notice` 下，信号是 note 级的 `test-integrity`，
不改变退出码，读不出 diff 则是提示 `files-unchecked`。这些信号是对 diff 文本的启发式判断：它们指出值得看一眼的地方，
既不证明测试被削弱，也不证明没有。

## 候选代码不一致

测试记录绑定了它运行时整个工作区的内容指纹，检查把它与本次检出的树的指纹比较。指纹不含 Tenon 自己的状态、依赖、目录里声明的测试输出，
以及一份简短、明确列出的**宿主本地文件**：编码 agent 宿主的每机配置，从不提交，所以任何克隆里都没有它们。

| 不进指纹的路径 | 是什么 |
| --- | --- |
| `.claude/settings.local.json` | Claude Code 的个人项目设置（权限允许列表、hook 日志）；你每回答一次权限提示 Claude Code 就改写它 |
| `CLAUDE.local.md`（项目根） | Claude Code 的个人项目记忆 |
| `.claude/worktrees/` | Claude Code 为子代理创建的项目检出 |

除此之外不按名字模式排除任何东西。`.claude/settings.json`、`.claude/commands/`、`CLAUDE.md`、`.mcp.json`、子目录里的 `CLAUDE.local.md`
以及一切只是长得像的文件都是共享的或清单之外的配置，照常属于候选；`.claude/agents/`、`.codex/`、`.agents/`、`.github/hooks/` 本来就不进指纹。
清单在 `packages/kernel/src/workspace/fingerprint.ts`（`HOST_LOCAL_FILES`、`HOST_LOCAL_DIRS`）。

**只有 git 没有跟踪的路径才被排除。** 清单上的路径只要被 git 跟踪（已提交或已暂存），就是仓库的一部分，指纹照算，作者本机和 CI 都一样。
没有这条规则，PR 可以把代码提交进 `.claude/worktrees/`、让测试命令去用它，之后再改它而候选不动。检查就是只对清单做 `git ls-files`。
真正不是 git 仓库的目录什么都不跟踪：git 在它和所有上级目录里都找不到仓库，且项目根目录没有 `.git` 条目。git 答不出来就什么都不排除：
git 缺失、索引损坏、`.git` 是 gitfile 但 `gitdir` 指向的目录不在了、`.git` 为空 / 损坏 / 读不了（上级仓库不会顶替它来回答），以及上级有仓库但在另一个文件系统上、git 不进去，都算答不出来。
检查也不理会 git hook 设下的、用来指定仓库的 `GIT_*` 环境变量（`GIT_DIR`、`GIT_INDEX_FILE` 等）。
在不区分大小写的文件系统上（探测项目根目录得知），路径与 git 的回答按忽略大小写匹配：git 报的是索引里的拼写，磁盘上的拼写可能不同，
所以被跟踪的 `.Claude/Settings.local.json` 算作被跟踪的 `.claude/settings.local.json`。在跟踪着这类路径的检出里出现 `candidate-mismatch` 时，
提示会把它们列出来。这是指纹的规则，不是单独的发现：被跟踪的路径和别的源文件一样改变候选；测试之后才把清单下的某个文件从未跟踪变成已跟踪，
检查会失败，因为克隆里它计入候选。

Tenon 0.3.1 及之后写下的记录绑的是不含这些文件的指纹，所以干净克隆能复现，改这些文件也不会让记录过期。这个指纹还按 git 的方式记录权限位，
所以同样的提交内容在每台机器上算出同一个值：普通文件按属主的可执行位记成 644 或 755，目录没有权限位，符号链接只记目标。被它取代的原始权限位
并不稳定：符号链接在 macOS 是 0755、在 Linux 恒为 0777，文件和目录跟着 umask（umask 002 下是 775/664），所以带符号链接、或在不同 umask 下检出
的仓库，另一个平台的 runner 永远复现不了它的指纹。普通的树（目录 755、文件 644 或 755、Linux 上没有符号链接）上它等于 Tenon 0.3.0 的完整指纹，
而完整指纹没有变。0.3.0 及更早版本写下的记录绑的是
把它们算进去的指纹：在作者本机上这样的记录照样新鲜（Tenon 两种形式都认），但作者的工作区当时有其中某个文件时，干净克隆复现不了它——
用当前的 Tenon 运行一次 `tenon test run <change> --stage`，把新记录提交。在有这类文件、Linux 上有符号链接、或权限位不是 755/644 的项目里退回
0.3.0 或 0.2.x，会把 0.3.1 的记录读成过期（「代码已变化」），不会读成损坏；重新跑一遍套件即可。仓库里有符号链接或依赖 umask 的权限位时，
0.3.0 在一个平台上写下的记录在另一个平台上复现不了；用当前的 Tenon 运行一次 `tenon test run <change> --stage`。

仍然不一致，通常说明测试之后代码变了。记录里只有一个哈希，CI 看不到作者的工作区，说不出「差在哪个文件」；提示里给的是它能确定的：
先找到记录之后的第一个提交（用记录里存的 `git_head`，没有就用完成时间），再点名这个提交之后又改过的候选文件——测试时的工作区最可能就提交在
那个提交里，所以交付提交自己的文件不会被怪罪；那之后什么都没改，提示就直说，差异在测试时的工作区本身。提示还会点名本次检出里被 gitignore
或未跟踪的候选文件（例如构建产物）。它看不到的原因包括可执行位（git 只记属主的可执行位；其余权限位不进指纹）与行尾转换。让 Action 紧跟 checkout 运行、先于任何构建步骤，
并在目录里声明测试输出目录。`--candidate warn` 把这个发现降为警告，`--candidate off` 不比对并加一条提示。

### 已完结的 Change 对本次检出的树判定

CI 证明的是它检出的那棵树，所以已完结（done 或已归档）的 Change 也是对这棵树判定，不是对它完结时的提交。之后的提交改了代码、
新增了测试文件（`test-file-unregistered`）或改了测试目录，已完结的 Change 就会带着普通发现（`candidate-mismatch`、`test-stale` ……）失败，
报告再加一条提示 `finished-judged-at-head` 说明原因。这是有意的：若按每个 Change 自己的交付提交判定，之后提交的、没有任何受治理 Change
背书的改动就会悄悄过关。实际用法：PR 的末端必须由最后动过它的 Change 覆盖，所以一个 PR 带一个受治理的 Change（或一条最后一个 Change
交付最终树的链）；用 `--since <合并基点>` 只选这个 PR 带来的 Change；要按交付时的样子校验较早的 Change，检出它的交付提交，在那里运行
`tenon verify --ci --change <name>`。

## 在本机运行

```text
tenon verify --ci --since origin/main
tenon verify --ci --change add-login --format json --out tenon-verify.json
tenon verify --ci --all-open --also sarif=tenon.sarif --also markdown=summary.md
```

退出码：`0` 通过，`2` 至少一个 error 级发现，`1` 用法或环境错误（缺少选择器、Change 不存在、输出写不出）。格式：`text`（缺省，
人读，末尾恒带信任对照）、`json`（`tenon-verify-ci/v1`）、`sarif`（2.1.0，每条结果一个位置，`partialFingerprints` 稳定）、
`markdown`（作业摘要）。用了 `--out` 时 stdout 仍打印 text 摘要。

语言：所有格式（text 与 Markdown 报告、SARIF 的消息、JSON 里的 `message` 与 `trust` 字符串、用法错误）都跟 CLI 的语言走：
`TENON_LANG=en|zh`，其次 `LC_ALL`、`LC_MESSAGES`、`LANG`；没有信号或为 `C`/`POSIX` 时和以前一样是中文。GitHub Action 里设
`language` 输入（`zh` 或 `en`），它会作为 `TENON_LANG` 交给 CLI。发现码、级别、退出码、JSON 字段名和 `[FAIL]`/`[WARN]`/`[NOTE]`
标记不随语言变化。测试策略的发现在中文报告里是一句完整的话；英文里是该码的短标签加上它指向的对象（套件 id、文件路径），
修复命令不变。

## 把证据锚定到 git notes（可选）

锚点把记录链头的副本写进交付提交上的 git note。note 在 `refs/notes/tenon`，在 PR 分支之外，所以把链整条重写（重算每个摘要）之后，
锚定的链头就不在链里了。

```text
tenon evidence export add-login --format git-notes --anchor --apply
git push origin refs/notes/tenon
```

`tenon verify --ci` 读最近 1000 个提交的 note。负责人那条链最新的锚定条目必须包含在链里：等于链头是 `verified`；
之后又追加了记录是警告 `anchor-behind`；链头不在链里是 `anchor-mismatch`。`--require-anchor` 把缺失或落后的锚点升为错误。
锚点多给的是攻击者必须同时写的第二个地方；它不证明链头来自受信任的机器，也不挡锚点之后追加的记录（除非设了 `--require-anchor`）。
限制谁能推送 `refs/notes/tenon`，这第二个地方才有意义。

## 导出证据

```text
tenon evidence export <change> --format agent-trace [--contributor ai --model anthropic/claude-opus-4-5]
tenon evidence export <change> --format otel
tenon evidence export <change> --format git-notes [--anchor] [--apply]
tenon evidence export <change> --format trailer [--apply]
```

一律打印到 stdout（或 `--out <file>`）；只有 `--apply` 才写仓库。记录链必须完好（否则退出码 `2`）。同样的证据导出同样的输出：
任何时候导出两次，打印的字节都一样。导出里的每个时间戳都来自证据本身——记录链里最晚一条记录的完成时间
（Agent Trace 的 `timestamp`、git note 条目的 `created_at`、OTel 的兜底时间），不是运行导出的那台机器的时钟。

- `agent-trace`：一条 [Agent Trace](https://agent-trace.dev) 记录（规范版本 `0.1`）。文件和新增行区间来自 Change 的 diff；
  贡献者缺省 `unknown`，除非你显式断言 `human`、`ai` 或 `mixed`——Tenon 不知道哪一行是谁写的。Tenon 自己的证据在
  `metadata["dev.tenon"]` 里。
- `otel`：形状符合 OpenTelemetry GenAI 约定的 OTLP/JSON span：Change 是 `invoke_workflow`，每次步骤停留是 `tenon.step`，
  每次 agent 运行是 `invoke_agent`，每次套件运行是 `execute_tool`。不会发往任何地方。
- `git-notes`：上面说的 JSON note，挂在 `--commit`（缺省 `HEAD`）上，与同一提交上其他 Change 的 note 合并。不会覆盖别人写的 note。
- `trailer`：`Tenon-Change:` 与 `Tenon-Evidence:`（链头摘要）。`--apply` 用 `git interpret-trailers` amend `HEAD`，
  有暂存改动或不是 `HEAD` 时拒绝，并且会换提交 id。note 要在 amend 之后再写。

## 预期结果

- Change 的证据自洽且新鲜的 PR 通过：退出码 `0`，作业摘要里每个 Change 一行，SARIF 上传为空（或只有提示级结果），并关闭之前的告警。
- 带有被改动、被删除、已过期或放错位置的记录、被删掉的已登记测试文件、没有批准行的受保护配置改动、或被重写的已锚定链的 PR，
  以退出码 `2` 失败，并在出问题的文件上给出 code scanning 告警。
- 每份报告无论红绿，都会列出没有本机密钥时 CI 证明不了的事。

## 验证

```bash
tenon verify --ci --change <change> --format json | head -40
tenon verify --ci --since origin/main --also sarif=/tmp/tenon.sarif
```

## 常见失败

| 现象 | 原因与处理 |
| --- | --- |
| `protected-diff-unavailable` | 浅克隆。用 `fetch-depth: 0` |
| 作者本机干净运行之后立刻出现 `candidate-mismatch` | 记录是 Tenon 0.3.0 或更早版本在有 `.claude/settings.local.json` 的工作区里写的，或被忽略的构建产物、可执行位、行尾不同；见「候选代码不一致」 |
| 报错旁边有提示 `finished-judged-at-head` | 已完结的 Change 对本次检出的树判定；见「已完结的 Change 对本次检出的树判定」 |
| `record-chain-broken` | 有记录被手工改过、删掉或加进来。在本机重跑 `tenon test run <change> --stage` 并提交新记录 |
| `protected-unapproved` | 目录、基线、已知失败或工作流的改动没有评审批准行。用 `tenon review request` 与 `tenon review acknowledge` 取得批准，再提交 Change 历史 |
| `anchor-mismatch` | 链在锚定之后被重写。这正是锚点存在的理由；不要为了让它消失而重新锚定 |
| 上传步骤因权限告警 | 令牌只读（fork 的 PR）。设 `upload-sarif: 'false'` |

## 下一步

加上工作流，开一个改到受治理 Change 的 PR，读作业摘要。每个选项见[CLI 参考](./cli-reference.md)，本机的信任边界见[安全模型](./security-model.md)。
