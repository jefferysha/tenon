# `tenon status <change> --json` 的 `step` 块

> 单个 `tenon` skill 每一步照做的全部输入。顺序只在一个函数里，不写在 skill 文案里。

---

## 1. Scope / Trigger

- 只有 `tenon status <name> --json`（带 change 名）才带 `step`。列表形态（`status --json` 无名、
  `list --json`）逐字不变，那两份输出是锚定的 schema。
- 已完结（`archived=true`，无论目录是否已被 `openspec archive` 搬走）的 change 不在
  `active_changes`，而在 `finished_changes`（多一个 `archived_at`）；与列表形态、`list --finished`
  同一口径。`tenon check` 对它只打一行「已完结，无需检查」、exit 0；只有 OpenSpec 治理的工作流（或目录已搬进
  archive/）才说「已完结（已归档）」，`status` 文本的 `finished` 行与之同一句（`commands/finishedLabel.ts`），
  `list --finished` 的列名是 `FINISHED_AT`（JSON 键 `archived_at` 不变）。
- 已完结的 change 恒带 `step`（键序与活跃 change 相同），`step.archived=true`：还有收尾动作时 `next`
  是 `finish-change`；没有可做的事（default 已搬进 archive/、simple 已提交或以 scope-expanded 放弃）时
  `next: [{action: stop, code: finished}]`——所有工作流同一形态。目录已被搬进 archive/ 时证据类分块
  （skills / tests / documents / fields / exits …）为空（`finishedStatusStep`）。`step.archived` = 当前
  用户收起了它，或状态机已完结。
- 已完结的 change 上 `tenon test status <c>`（不带 `--step`）按步骤列出每项测试的最后记录
  （JSON：`step: null`、`finished: true`、`items[].step`、`report: "tenon test report <c>"`），exit 0。
- `step` 投影不可用时（工作流读不到、指纹不匹配等）写一行 `WARN: step 投影不可用: …` 到 stderr，
  `active_changes` 照常输出、exit 0 —— 读状态不该因为投影失败而失败。

## 2. Signatures

```ts
// packages/cli/src/commands/statusStep.ts
buildStatusStep(deps, name, state, plan): Promise<StepBlock>
finishedStatusStep(deps, name, state, plan | null): Promise<StepBlock>        // 目录已搬进 archive/
// packages/cli/src/commands/statusStepFinish.ts
deliveryCommit(change, git, scope = 'deliverables' | 'step'): StepCommit | null · finishActions(change, governed, finish) · finishedStop(change)
// packages/cli/src/gitWorkspace.ts
probeGitFinish(cwd, change) · WORKSPACE_COMMIT_PATHS · LOCAL_ROOT_FILES
stepNextActions(input: StepNextInput): readonly StepAction[]   // 纯函数，顺序的唯一真相源
// packages/cli/src/commands/statusStepDocumentActions.ts（文档类动作的构造，顺序仍归 stepNextActions）
documentWriteActions(documents) · skillDocumentActions(skills, documents) · inputDocumentPolicy(documents)
// packages/cli/src/commands/stepExitReport.ts
evaluateStepExitReport(deps, name, dir, state, plan): Promise<StepExitReport>
// packages/cli/src/commands/statusStepParts.ts
stepSkills(deps, plan, stepId, completed) / stepDocuments(change, policy, stepId, items) / stepFields(state, step)
// packages/cli/src/commands/statusStepAgents.ts
agentStepViews(deps, name, dir, state, plan, stepId)
// packages/cli/src/commands/statusStepSpec.ts
specApplyReceiptFresh(repoRoot, changeDir): Promise<{ fresh: boolean; mode: string | null }>
```

## 3. Contracts

- 判定源一律复用既有的：技能证据 `completedWorkflowSkillsSinceStepEntry` + `resolveRequiredSkillSlots`，
  文档 `evaluateDocumentEvidence`，测试 `evaluateTestEvidence`，agent `projectStepAgents` /
  `nextAgentWave`，出口 guard `evaluateDefaultEventPreconditions`（default）或
  `evaluateWorkflowIrStepGuards` + `effectiveLifecyclePolicy`（自定义），评审回执 `reviewGateStatus`。
  这里只换形状，不新写一套 guard。
- `next` 是闭集：`stop`、`load-tenon`、`finish-change`、`read-documents`、`run-agent`、`load-skill`、
  `scaffold-document`、`record-document`、`register-field`、`set-field`、`validate-spec`、
  `apply-spec`、`run-test`、`fix`、`commit`、`request-review`、`await-review`、`choose-exit`、`transition`、
  `complete`。第一条命中的规则返回，同一条规则内同波的项一起返回。
- 顺序：停（归档 / 引用已删除技能 / 步骤不在计划里）→ 状态机已归档（治理归档或停）→ 重新加载
  tenon → 读输入文档 → 决定类字段（带枚举、走 `tenon set`：build_mode / isolation …，动手之前拍板，
  也先于测试配置）→ 未配置的必需测试（本步与下一步的；计划步——本步产出 `plan` / `superpower-plan`——
  是之后所有前进可达步骤的；`fix` `code: test-unconfigured`）
  → 执行者 → 本步技能 → 技能欠的文档 → 未勾任务（`fix`，blocker `source: tasks`，带 `items` 未勾项
  原文；tasks.md 自己还没产出（`missing`）时让位给文档写入，勾过一项后的 `stale` 不让位；交付步交付物未提交时
  这一档先发 `commit`，提交之后才勾——勾选不先于事实）→ 应用规格 → 产出与登记文档 → artifact
  登记 → 有推荐值的交付值（`pr_url=no-remote`）→ 交付物提交（交付步，`commit`）→ 其余自由文本交付值
  （`pr_url` / `prd_path`）→ 彩排规格 → 必需测试 → 评审者 → 结果字段 → 出口。
- `test-unconfigured` 的 message = `unconfiguredMessage` + 范围说明：计划步说「只需在 package.json 补上
  脚本；这类测试若还没有，把写这类测试列进本步的计划与 tasks」，并要求把新增的测试脚本 / 测试同步写进本步可改的
  proposal（What Changes / Impact）与 design、删掉相矛盾的表述（真机第四轮：design 仍写「不改 package.json」，
  verify 的 spec-consistency 判「多做」阻断 → verify-fail → build 改不了 proposal → 回 spec；
  `templates/agents/spec-consistency.md` 同时写明为满足必需测试补的脚本不算多做，最多报 `low`）；之后的步骤说「只需补 package.json 的
  scripts（以及这条脚本要跑的测试代码），不需要修改已登记的规格文档」。只改 package.json 不会让已登记
  的文档失效：文档台账按各自文件的 sha256 判定，与 package.json 无关；build 冻结的候选版本（build_sha）
  在 build-complete 才取，build 内改 package.json 不触发 `revision-stale`。真机第三轮的 build→spec
  回退来自模型把「补测试」写回已登记的 plan / design（只读输入变 `stale`，build 上没有合法 producer，
  只能 `requirements-changed`）。
- 交付步 = 本步字段含交付值（`pr_url` / `prd_path`，`writer: set`）。状态机未归档、交付物还有未提交的
  改动（`deliverablesDirty`：`git status` 在 `WORKSPACE_COMMIT_PATHS` 且再排除 `openspec/changes/<c>`
  时非空）时发 `{action: commit, change, commit: {paths, untrack, message}}`：`paths` =
  `WORKSPACE_COMMIT_PATHS`（`.` 加每个仓库根本机文件的 `:(exclude)<name>`：三个 `.pipeline-pending-*`
  门禁标记、旧版 `.pipeline-active` / `.pipeline-interaction-authority`），`untrack` 同 finish-change，
  `message`：首次 `feat(<c>): deliver`，当前分支历史里已有这条之后的补交是 `chore(<c>): update deliverables`
  （真机第五轮：两次同名）。执行与 finish-change 的提交三条命令相同。两档判「脏」：勾任务之前那次
  （`delivery`）不看 change 目录（勾选只改 tasks.md，不该再触发提交）；收尾那次（`settle`，
  `stepDirty`）看整个工作区、只去掉 hook 追加的 `openspec/changes/<c>/.pipeline-history.jsonl`（hook 只在
  技能调用与用户回复时追加，拿它判会让每次回复都多一次提交；它随下一次提交入库）。有 `recommended` 的
  交付值（无远端时 `pr_url=no-remote`）排在收尾提交之前，写下的状态文件随它入库；没有推荐值的（真实 PR
  URL 要先有提交）排在提交之后，写完之后状态文件的改动再触发一次提交。交付步出口（`transition` 之前）
  `git status --porcelain` 为空；`transition` 自己写的状态文件由完结的 finish-change 提交。不是 git 仓时不发。
- 进行中（`running`）的 agent 先于同一档的一切新动作：`run-agent` 带 `status: running`、`run_id`、
  `report_path`，宿主写报告后 `agent record` 那次运行，不重开。
- agent 的 `wave` 是依赖分层（kernel `agentWaves`，无 `depends_on` 的同为 0），与 `tenon agent next`
  同源。
- 必需测试或必需评审者已经不通过时不发结果字段，直接去出口（回退边或 `fix`）。
- 结论字段（`pre_verify_review_result` / `verify_result`）与风险确认（`direct_override`）没有
  `recommended`；`set-field` 带 guard 的 `required`，`tenon set` 写 `pass` 前核对本步证据
  （commands/verdictFieldGate.ts）。`build_mode` 推荐无需豁免的值（full：`subagent-driven-development`，
  pm `prototype`；hotfix / tweak：`direct`）。
- `pr_url` 只接受 http(s) URL，或仓库没有 git 远端时的 `no-remote`（此时它就是 `recommended`）。
- `finish-change` 带 `command`（OpenSpec 治理的工作流是 `openspec archive <c> --skip-specs --yes --json`；
  非治理工作流为 `null`）与 `commit: { paths, untrack, message } | null`。执行顺序
  `git add -A -- <paths…>` → `untrack` 非空时 `git rm --cached -q --ignore-unmatch -- <untrack…>` →
  `git commit -m <message>`，每条都必须一次成功：OpenSpec 工作流恒列 `openspec/changes/archive`，原目录
  `openspec/changes/<c>` 只在 git 跟踪过它时列出（未跟踪的原目录搬走后 pathspec 匹配不到，exit 128）；
  `.pipeline/.gitignore`、`.tenon/.gitignore`、`openspec/.gitignore` 存在且未被上层规则忽略时一并列出；
  `untrack` = `openspec/changes/**` 下已跟踪、但按当前忽略规则应被忽略的 `.pipeline-terminal-activity.*`；
  非治理工作流以验证通过（`verify_result=pass`）完结且工作区有未提交改动（或有待 untrack 的心跳）时是
  `paths: WORKSPACE_COMMIT_PATHS`、`message: chore(tenon): finish <c>`，否则 `stop finished`；判「有未提交
  改动」与提交用同一组 pathspec（只剩门禁标记 = 干净，否则 `git commit` 以 nothing to commit 失败）。
  不是 git 仓时 `commit: null`。
- 终态自边由 kernel 推导（`implicitCompletionTransition`），`default` 的 `archive` 也在内：它
  投影成 `direction: completion` 的出口，`next` 给 `complete`。走完之后 `archived=true`，
  `next` 只剩 `finish-change`（治理归档命令）；两条命令的先后因此写在数据里，而不是靠人记。
- 执行者失败可以重跑；评审者不通过不重跑——评审结论是证据，代码没改重跑只会得到同一份结论，
  该走的是回退边。
- 回退边只在必需评审者不通过、且本步真的有回退边时出现；否则给 `fix` 加上全部前进边阻塞原因的
  并集。回退边与前进边过同一道门：`gate: review` 的步骤上，唯一的回退边走
  `request-review → await-review → transition`（review 回执逐边绑定，一次「回到实现」的决定不能
  顺便授权 verify-pass），多条回退边仍然交给人 `choose-exit`。
- 文档动作按台账状态派：`missing` 的产出发 `scaffold-document` + `record-document` 一对（骨架
  只写文件，登记才推进台账）；`stale` 的（产出 / 可改 / 只读输入都算）发 `record-document`；
  `unread` 的才发 `read-documents`，它带 `editable`（读清单里同时是本步 role update 的 kind，本步可改、改完重新
  登记）与 `note`（其余只读；需求语义变了走 `requirements-changed`；tasks 只勾当前步骤标题下的复选框；内容要读进
  上下文，不得丢弃输出）。`role: update` 的槽从没登记过时不发动作——它是「本步可以改
  它」，不是「本步必须产出它」，与文档取证层（update 槽不进 blockers）同一口径。
- 文档动作的 `producers` 恒取该文档在**当前步**合法的那组（`recordProducerCandidatesForPolicyStep`），
  读清单也不例外：登记命令认的就是这一组。当前步没有合法 producer 时不发登记动作，让出口 blocker
  如实说明。
- 技能状态与技能门同源（kernel `judgeStepSkillSlots`，经 `stepSkillGate.judgeStepSkills`）：
  `done` = 已调用，且契约 role produce 槽点名它的文档都已在本次步骤访问由它登记；`invoked` =
  已调用但还欠 `pending_documents`；`ready` / `waiting` 同前。只有 `done` 解锁后续技能。
  `invoked` 的技能在「本步技能」这一档之后立即下发它欠的 `scaffold-document`（缺文件时）+
  `record-document`，带 `skill` 字段、producers 收窄到与它等价的那几个——即使台账上那份文档是上一次
  访问登记的 `recorded`（verify-fail 回来的第二次 verify）。
- `mode`：`TENON_AFK=1` → `afk`；本任务有交互授权 → `continuous`；否则 `interactive`。

## 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| 当前用户已归档该任务 | `step.archived=true`，`next: [{action: stop, code: archived}]` |
| 计划引用已删除技能 | `next: [{action: stop, code: retired-skills}]`，文案与 CLI/HTTP 拒绝同一份 |
| 当前 step 不在计划里 | `next: [{action: stop, code: step-not-in-plan}]` |
| 本次步骤访问还没加载 `tenon` | `next: [{action: load-tenon}]`，先于一切 |
| 声明的输入文档未读（`unread`） | `read-documents` 带全部待读路径 |
| 已登记的文档被改（`stale`） | `record-document`，producer 取当前步接受的那组；不再发 `read-documents` |
| 本步产出还没有（`missing`） | `scaffold-document` + `record-document` 一对 |
| 技能已调用、欠本步产物（`invoked`） | 它欠的每份文档 `record-document`（缺文件先 `scaffold-document`），不再 `load-skill` |
| `role: update` 的槽还没登记过 | 不发动作（可以改 ≠ 必须产出） |
| 必需测试未通过 | `run-test`；失败的测试要先改代码再重跑 |
| 本步或下一步（计划步：之后任一步）的必需测试命令要的 npm 脚本不存在 | 读完输入、拍板决定字段后先 `fix`（`source: test`、`code: test-unconfigured`，message 说明两种配置方式）；本步的那条 `step.tests[].status=unconfigured` 带 `hint`；`tenon test run` 拒跑（exit 1，不落记录） |
| `delta-spec` 归本步且回执不新鲜 | 文档登记完之后 `validate-spec` |
| `applied-spec` 归本步且回执不新鲜 | 先 `apply-spec`，再登记 |
| 评审门上必需评审者打回且只有一条回退边 | `request-review` → `await-review` → `transition` |
| 多条前进边就绪 | `choose-exit` |
| 字段由转换副作用落值（`archived` / `build_sha` / `phase_status` / review 回执…） | 不发写入动作，走到那条转换；`tenon set` 拒写 |
| 执行者已 prompt 未 record | `run-agent` 带 `status: running` 与 `run_id`，不跳去 `load-skill` |
| 必需评审者打回 | 不发结果字段；回退边（评审门上走 request → await → transition）或 `fix` |
| ship 有未勾任务 | 先 `fix`（`source: tasks`，`items` 为截至本步仍未勾的任务原文），再 `apply-spec` / applied-spec 登记 / `set-field pr_url` |
| build 缺 build_mode / isolation | 读完输入文档后第一批就是 `set-field`，先于 test-unconfigured 的 `fix`、执行者与 `load-skill` |
| 交付步，交付物有未提交改动 | `commit`（`paths: WORKSPACE_COMMIT_PATHS`），先于没有推荐值的 `set-field pr_url` / `prd_path` |
| 交付步，有未勾任务且交付物有未提交改动 | 先 `commit`，再勾选任务的 `fix`（真机第四轮：先勾「提交代码」后提交） |
| 交付步，只有 hook 追加的历史或门禁标记有改动 | 不发 `commit` |
| 交付步，交付值已写、只剩 change 目录里的状态文件 | `commit`（`settle`，标题 `chore(<c>): update deliverables`） |
| 交付步，交付值有推荐值（`no-remote`） | 先 `set-field`，再收尾 `commit` |
| 已完结 | `finished_changes` 而非 `active_changes`；`check` 说无需检查；`step` 恒在、`archived=true`，`next` 是 `finish-change` 或 `stop finished` |
| 原目录从未被 git 跟踪 | `finish-change.commit.paths` 只有 `openspec/changes/archive` |
| simple 以 verify-pass 完结、工作区有改动 | `finish-change`，`command: null`，`commit.paths: WORKSPACE_COMMIT_PATHS` |
| 已完结、只剩仓库根门禁标记未跟踪 | `stop finished`（不发必定失败的提交） |

## 5. Tests

- `packages/cli/src/commands/statusStep.test.ts`：`stepNextActions` 的每条规则与相对顺序（纯输入）。
- `packages/cli/src/commands/status.test.ts`：列表与无名形态逐字不变。
- `packages/cli/src/spec-apply.integration.test.ts`：`spec apply` 的真实彩排与退出码。
- `packages/cli/src/next-action-runner.integration.test.ts`：验收锚——只照 `next` 做事的运行器把一个
  `default` 任务从 `open` 做到 `list --finished`，中途改掉一份已登记的文档、并被评审者打回一次。
  `next` 发出去却执行不了的动作会让它当场红；ship 走出口之前与收尾之后 `git status --porcelain` 都必须为空
  （交付提交不带门禁标记，两次交付提交标题不同），完结后的 `step` 键序与活跃时相同、`next` 为 `stop finished`；缺 `test:integration` 时 fix
  出现在 spec 且全程没有 `requirements-changed`。
