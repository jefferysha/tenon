# 差异化（CI 半）：设计

范围：prd.md 的 `tenon verify --ci`、GitHub Action、证据导出（Agent Trace / OTel GenAI / git notes / 提交尾注）、可选的链头锚定。
跨厂商评审、测试完整性报告、sigstore 签名不在本分支（另一半）。依据：product-audit.md §4.3 bets 1、4、7；
evidence-trust/design.md（HMAC 封存、记录链）；v02-test-system/design.md（目录 / 计划 / 策略 / 记录 v2）。

## 0. 一句话与威胁模型

CI 里没有用户本机的 HMAC 密钥（本机目录 `local/env.key` 与 `local/test-seal.json` 被 gitignore），所以 CI **不能**证明「这些记录是 `tenon test run` 在一台受信的机器上写出来的」。
它能做的是：对**已提交的内容**独立重算一遍，把一切「不自洽」的伪造和误提交挡在合并之前——

- 改了记录没重算摘要、删了中间记录、记录挪进别的任务 / 别的用户目录、链分叉 / 成环：链校验挡住；
- 重算了整条链（摘要是无密钥 sha256，谁都能算）但内容与计划、目录、策略、代码对不上：计划 ↔ 记录 ↔ 目录的新鲜度绑定、
  用例级判定（已登记用例是否在记录里、失败是否被吞、覆盖率、场景追溯）、候选代码指纹挡住；
- 受保护文件（目录、基线、已知失败、工作流）在本任务 diff 里出现却没有评审确认的审计行：挡住；
- 链头被锚定到 git notes（另一个 ref，不在 PR 分支里）后，重写链会让锚点对不上：挡住。

**CI 不能证明**（输出里每次都写明，见 §1.2）：
1. 记录由受信的 `tenon test run` 写出（封存链头只在本机）。一条重算过全部摘要、与计划和代码自洽的伪造链，在没有锚点时 CI 看不出来；
2. 评审确认由人给出（批准在本机封存里；历史里的 `test:protected-approve` 行是明文，可以手写）；
3. 套件真的跑过、报告没被伪造（报告与产物在 gitignore 的本机目录，CI 只有记录里的摘要）；
4. 身份属实（身份是声明的，不是认证的）。

缓解：CI 里另起一个作业用 `TENON_TEST_TRUST=1 tenon test run` 重跑套件（证明套件在 CI 的机器上能过；它写出的记录属于 CI 用户，不会让已提交的记录更可信）；锚点写到受保护的 notes ref；
将来叠加 sigstore（另一半的任务）。

## 1. `tenon verify --ci`

```
tenon verify --ci [--change <c> | --all-open | --since <ref>] [--step <id>]
                  [--format text|json|sarif|markdown] [--out <file>] [--also <format>=<file>]...
                  [--candidate error|warn|off] [--require-anchor]
```

- `--ci` 必须带（没有它 exit 1，提示只有 CI 模式；名字留给以后的本机全量校验）。
- 选择器恰好一个：`--change <c>`（活跃或归档目录）、`--all-open`（`openspec/changes/*` 中非 `archive/`、`archived` 不为 true）、
  `--since <ref>`（`merge-base(<ref>, HEAD)..HEAD` 的提交改到的任务：任务目录 `openspec/changes/<c>/…`、归档目录 `openspec/changes/archive/<日期>-<c>/…`、
  用户记录目录下的 `<c>/…`）。没有选中任何任务 = exit 0，输出「范围内没有受治理的任务」。
- exit：0 通过；2 有 error 级发现；1 用法 / 环境错误（选择器缺失、任务不存在、写输出失败）。
- 输出：`text`（缺省，人读，含信任边界）、`json`（`tenon-verify-ci/v1`，稳定）、`sarif`（2.1.0，GitHub code scanning）、
  `markdown`（作业摘要）。`--out` 把主格式写文件（stdout 改打印 text 摘要）；`--also sarif=a.sarif` 可重复，一次运行出多份。

### 1.1 每个任务做哪些检查

读的全是已提交内容；不读用户身份、不读封存、不写任何东西（只读命令，不加锁）。

| # | 检查 | 来源 | 发现码（SARIF 里是 `tenon/<code>`） |
|---|---|---|---|
| A | 记录链完整性：每个用户的记录目录各校一次（链首、分叉、成环、游离、`<run-id>.json` 命名、内容摘要、chain-base 标记） | kernel `listRecordDirectory` + `verifyRecordChain` | `record-chain-broken` |
| A2 | 记录自洽：记录 `change` = 目录名；`actor.id` 的 slug = 用户目录名；`result` = 全部套件通过；留存用例各状态数 ≤ totals（`totals.cases` = 各状态之和已由记录解码器保证，坏了就是 `record-chain-broken`） | 新，纯函数 `recordInvariantProblems` | `record-misplaced`、`record-inconsistent` |
| B | 计划 ↔ 记录 ↔ 目录：计划摘要台账、目录可解析、计划引用的套件存在、记录的目录 / 计划 / 策略 / 工作流绑定新鲜 | kernel `evaluateTestEvidence`（策略判定，同一份代码） | `test-plan-*`、`test-catalog-missing`、`test-stale`… |
| B2 | 计划登记的测试文件在 PR 头的树里还在 | 新 | `plan-file-missing` |
| C | 当前步骤策略下的用例级判定：未运行 / 失败 / 已登记用例没出现在报告 / 覆盖率 / 基准 / flaky / 场景追溯 / 未登记文件 | `evaluateTestEvidence` | 全部既有阻塞码 |
| D | 候选代码：记录绑定的工作区指纹 = PR 头检出树的指纹。不同 → `candidate-mismatch`（替换对应套件的 `test-stale`），附「记录完成时间之后提交改过的候选范围文件」做线索 | `candidateFingerprint(repoRoot)` | `candidate-mismatch` |
| E | 受保护文件：自任务起点以来改动的目录 / 基线 / 已知失败 / 工作流，必须在任务历史里有 `test:protected-approve` 审计行点名该路径；行里带 `digests=` 的还要与当前内容摘要相等 | `protectedChangesSinceChangeStart` + 历史 | `protected-unapproved`、`protected-changed-after-approval`、`protected-approval-unbound`（warning） |
| F | 锚点：`refs/notes/tenon` 上 PR 范围内提交的 anchor 条目；链里必须含锚定链头；链头落后锚点之后的记录数 | notes | `anchor-mismatch`、`anchor-behind`（warning；`--require-anchor` 升为 error）、`anchor-missing`（仅 `--require-anchor`） |

「当前步骤」= 任务 `phase`；该步骤既无 `test_policy` 也无 `tests[]` 时取工作流里它之前最近一个声明了的步骤（已完结的任务因此落在 verify）；`--step` 显式指定。
评估哪条链：负责人（`assignee`）的 slug 目录；负责人没有记录且恰有一个别人的链时用那一条并给 warning `owner-chain-missing`；都没有就用空链（策略自己给 `test-not-run`）。其余用户的链只做 A / A2。

候选范围的指纹对环境敏感（被忽略的构建产物、文件 / 目录权限位、行尾转换）。`--candidate warn` 把 `candidate-mismatch` 降为 warning，`off` 不比对并给 note；
默认 `error`（这是本检查的意义）。Action 在检出之后立刻运行，文档写明常见误报来源。

### 1.2 发现、严重度与信任边界

`CiFinding { code, severity: error|warning|note, change|null, message, path?, fix?, source: 'ci'|'policy' }`。
策略阻塞：`blocking:true` → error，`blocking:false` → warning；策略提示 → note。SARIF 的 `ruleId` = `tenon/<code>`，
`locations[0].physicalLocation.artifactLocation.uri` = 相关文件（记录文件 / 计划 / 目录 / 受保护文件 / 任务 `.pipeline.yaml` 兜底），`region.startLine` = 1；
`partialFingerprints["tenon/v1"]` = sha256(code + change + subject) 的前 32 位，使同一问题在多次运行间归并。
报告里固定带 `trust`：`verified[]`（本次实际校验了什么）与 `unverifiable[]`（§0 的四条），text / markdown 末尾逐条打印，SARIF 放 run 级 `properties`。

### 1.3 实现拆分

- kernel `ci-verify/`（纯函数，可单测）：`types.ts`、`rules.ts`（规则目录）、`record-checks.ts`（A2）、`anchor.ts`（anchor 解析 / 判定）、
  `approvals.ts`（历史审计行解析 + E）、`report.ts`（汇总 / 信任边界）、`sarif.ts`、`render.ts`（text / markdown）。
- kernel 小改：`TestEvidenceContext.seal?: 'local' | 'none'`（缺省 `local`，行为不变）→ `StepTestPolicyLoadInput.seal`；`none` 时不读封存、不传 `protected`，
  于是 `record-unsealed`、`protected-file-*` 两类依赖本机封存的判定被跳过，E 由 CI 自己用历史判定。
- cli `commands/verify-ci*.ts`（装配 + IO：选择器、git、逐任务收集、输出）、`program-verify.ts`（注册 `verify` 与 `evidence`）。

## 2. GitHub Action

`.github/actions/tenon-verify/action.yml`（composite）+ `run.sh`（所有逻辑，便于在本机用 bash 测）。

- **固定版本**：Action 随发布 tag 一起发布，tracked 的 CLI 单文件 bundle（`packages/cli/dist/tenon.mjs`）就在 action 仓库根（`github.action_path/../../..`）。
  用户 `uses: jefferysha/tenon/.github/actions/tenon-verify@vX.Y.Z`（或提交 SHA）= 固定了 CLI；不在运行时下载任何东西。输入 `expected-version`（可选）与 CLI 自报版本不符就失败。
  `cli` 输入可指向别处的 `tenon.mjs`（本仓自测用）。
- 步骤：setup-node（22，SHA 固定）→ `run.sh`：（`fetch-notes` 时）尽力 `git fetch origin refs/notes/tenon:refs/notes/tenon` →
  `node tenon.mjs verify --ci … --also sarif=… --also markdown=…` → 作业摘要写 `$GITHUB_STEP_SUMMARY` → 输出 `exit-code`、`sarif-path`；
  `github/codeql-action/upload-sarif`（SHA 固定，`upload-sarif` 默认 true，`continue-on-error` 以免 fork PR 的只读令牌让整个检查报错）→ 最后一步按 verify 的 exit code 失败。
- 缺省选择器：PR 事件取 `--since origin/${GITHUB_BASE_REF}`；否则 `--all-open`。需要 `fetch-depth: 0`（受保护文件检查要任务起点），浅克隆下 run.sh 直接报错说明。
- 示例工作流：`docs/examples/github-actions/tenon-verify.yml`，与 ci-verification.md 里的片段一致。
- 测试：vitest 集成测试在临时夹具仓库里直接运行 `run.sh`（伪造 `GITHUB_*` 环境）：通过时 exit 0 并产出 SARIF 与摘要；伪造记录时 exit 非 0 且 SARIF 含对应规则。

## 3. 证据导出 `tenon evidence export <change>`

```
tenon evidence export <change> --format agent-trace|otel|git-notes|trailer
    [--out <file>] [--commit <rev>] [--user <slug>] [--apply] [--anchor]
    [--contributor human|ai|mixed|unknown] [--model <provider/model>]
```

所有格式只读，默认打印到 stdout（或 `--out`）；`--apply` 才写仓库状态，且只对 `git-notes`（写 note）与 `trailer`（修订 HEAD 提交）有意义，其他格式带 `--apply` = exit 1。
链断了拒绝导出（exit 2）——不为坏链背书。取的是负责人（或 `--user`）的链，只读。

数据装配（cli `evidence-gather.ts`）→ `EvidenceBundle`（kernel 类型）：任务状态（workflow / track / phase / 负责人 / 创建时间）、
链摘要（用户 slug、链头、记录数）、逐记录摘要（run-id、步骤、起止、套件 / 用例 / 覆盖率）、计划 / 目录摘要、受保护文件审批行、
agent 运行台账、历史里的转换（步骤进出时间）、自任务起点以来改动文件及其新增行范围、git 修订。

### 3.1 Agent Trace（公开规范 v0.1，Cursor 等发起）

规范来自 agent-trace.dev 的 trace record schema（`$id https://agent-trace.dev/schemas/v1/trace-record.json`，draft 2020-12）。映射：

- `version`：`"0.1"`（schema 的 pattern 是 `^[0-9]+\.[0-9]+$`，规范正文示例写 0.1.0；取能通过发布 schema 的形式）；`id`：由 (change, 链头, 提交) 确定的 UUID（重复导出得到同一个 id）；
  `timestamp`：导出时刻（RFC 3339）；`vcs`：`{type:'git', revision:<40 位提交>}`；`tool`：`{name:'tenon', version}`。
- `files[]`：自任务起点以来**新增 / 修改的**文件，每个一条 conversation：`ranges` = 该文件新增行的连续区间；
  `contributor`：缺省 `{type:'unknown'}`——Tenon 知道哪些文件在受治理任务里改了，不知道哪几行是谁写的，不替人声明。`--contributor ai --model anthropic/claude-…` 由导出者显式断言。
- `conversations[].related[]`：`{type:'tenon-evidence', url:'tenon:evidence/<change>?head=<链头>'}`。
- `metadata['dev.tenon']`（反向域名命名，规范允许）：change、workflow、track、证据（链头、记录数、计划摘要、最近一次判定）、agent 运行摘要、是否截断（文件 ≤ 2000、每文件区间 ≤ 500）。
- 删除的文件、无新增行的文件不进（规范归因的是现存行）。

### 3.2 OTel GenAI 风格 span（OTLP/JSON，不联网导出）

`{resourceSpans:[{resource, scopeSpans:[{scope:{name:'tenon.evidence'}, spans}]}]}`，ID 为十六进制，时间为 unixnano 字符串，traceId / spanId 由 (change, 链头) 确定。
遵循 GenAI semantic conventions 的 span 形态：

| span | name | kind | 关键属性 |
|---|---|---|---|
| 任务 | `invoke_workflow <workflow>` | INTERNAL | `gen_ai.operation.name=invoke_workflow`、`gen_ai.workflow.name`、`tenon.change`、`tenon.track`、`tenon.evidence.chain_head` |
| 步骤（来自历史里的转换） | `tenon.step <id>` | INTERNAL | `tenon.step.id` |
| agent 运行 | `invoke_agent <agent>` | INTERNAL | `gen_ai.operation.name=invoke_agent`、`gen_ai.agent.name`、`gen_ai.provider.name`（宿主 claude → `anthropic`，codex → `openai`，未知则省略）、`tenon.agent.role/result/findings`、失败带 `error.type` |
| 测试套件运行 | `execute_tool tenon.test.<suite>` | INTERNAL | `gen_ai.operation.name=execute_tool`、`gen_ai.tool.name`、`gen_ai.tool.type=function`、`gen_ai.tool.call.id=<run-id>/<suite>`、`tenon.test.*` 计数、失败带 `error.type` |

父子关系：任务 → 步骤 → (agent 运行 | 测试套件运行)；找不到对应步骤的挂任务下。状态：失败 = ERROR(2)，通过 = OK(1)。
自定义属性一律 `tenon.` 前缀，不借用 `gen_ai.*` 名字。

### 3.3 git notes

note 在 `refs/notes/tenon`，挂在 `--commit`（缺省 HEAD）上，正文是 JSON：

```json
{ "schema": "tenon-evidence-note/v1",
  "changes": [ { "change": "demo", "user": "a-at-x.io",
                 "chain": { "head": "sha256:…", "records": 3, "last_run": "…", "last_finished_at": "…" },
                 "plan_digest": "sha256:…", "last_result": "pass",
                 "anchor": { "kind": "chain-head", "head": "sha256:…" }, "tenon": "0.2.0", "created_at": "…" } ] }
```

同一提交上多个任务合并进 `changes[]`（同 change + user 的条目被替换）。不带 `--apply` 只打印 note 与等价的 `git notes` 命令；`--apply` 写入（`git notes --ref=tenon add -f -F -`）。
`anchor` 字段只在 `--anchor`（opt-in）时出现：它声明「这个链头在交付提交上被锚定」，`verify --ci` 才据此判定。

### 3.4 提交尾注

打印

```
Tenon-Change: <change>
Tenon-Evidence: sha256:<链头>
```

`--apply`：对 HEAD 做 `git commit --amend`（先用 `git interpret-trailers --if-exists replace` 改消息；有已暂存改动、或 `--commit` 不是 HEAD = 拒绝）。
不带 `--apply` 绝不碰提交。提醒：amend 会换 HEAD 的 sha，已写在旧 sha 上的 note 要在 amend 之后再写（先尾注、后锚定）。

## 4. 锚定（可选）与 `verify --ci`

- 写：`evidence export <c> --format git-notes --anchor --apply`（交付提交上）。要求链完好。
- 读：`verify --ci` 列 `git notes --ref=tenon list`，只看 `git rev-list --max-count=1000 HEAD` 内的提交，取每个 (change, user) 最新的带 `anchor` 的条目 A：
  - A.head 在当前链里（含 chain-base 标记的 base）→ 通过；链头 ≠ A.head → `anchor-behind`（warning，说明锚点之后追加了 N 条记录；`--require-anchor` 为 error）；
  - A.head 不在链里：有 chain-base 标记（保留上限清理过，可能被清理掉）→ warning `anchor-unverifiable`；否则 error `anchor-mismatch`（链被重写）；
  - 没有锚点：只在 `--require-anchor` 时 error `anchor-missing`，否则报告里写「未锚定」。
- 价值与限度：锚点把链头的副本放到 PR 分支之外的 ref，重写链就要同时写这个 ref（另一份权限）；它不证明链头本身来自受信机器，也不挡「锚点之后追加的伪造记录」（除非 `--require-anchor`）。notes 在 CI 默认不会被检出，Action 的 `fetch-notes` 负责拉取。

## 5. 兼容与文件格式

- 记录 v2 的闭集 schema **不动**（旧版本读新记录会判损坏）。候选核对用现有 `bindings.candidate`；尾注 / note / 锚点都在记录之外。
- `test:protected-approve` 审计行新增可选 `digests=<path>@<digest>,…`（旧读取方忽略多余 key=value；新 CI 读到没有 `digests` 的老行 → `protected-approval-unbound` warning，仅按路径放行）。
- 新命令只读为主；写入口只有 `evidence export --apply`，且只写 git notes / 修订 HEAD。

## 6. 验收映射

| 项 | 测试 |
|---|---|
| verify --ci 通过 / 篡改记录 / 删用例 / 过期候选 / 受保护审批缺失 | `verify-ci.integration.test.ts`：真 harness 产出记录 → 提交 → 克隆成「CI」（无本机封存、无身份）→ 逐项篡改提交 → 断言 exit / 发现码 |
| SARIF | 单测：`sarif.test.ts` 用 ajv 对内置的 SARIF 2.1.0 子集 schema 校验，并断言 GitHub 要求的字段 |
| Action | `verify-action.integration.test.ts` 跑 `run.sh`；静态检查 action.yml 的 SHA 固定与输入 |
| Agent Trace / OTel / note / 尾注 | `evidence-export.test.ts`（纯）+ `evidence-export.integration.test.ts`（CLI）：Agent Trace 用发布 schema（原样入库）校验；OTLP 子集 schema + 语义约束；note 与尾注形态；`--apply` 真写 git |
| 锚点 | 集成：导出锚点 → CI 通过；重算整条伪造链 → `anchor-mismatch`；锚点之后追加 → `anchor-behind` |

## 7. 不做

跨厂商评审、完整性报告、sigstore、策略「任务必须存在」类的 PR 规则、CI 内自动重跑套件（文档推荐，不内置）、Windows。
