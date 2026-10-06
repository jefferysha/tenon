/**
 * `tenon verify --ci` 的输出：报告里的固定文案（标题、列名、信任边界陈述、CI 独有发现的说明）与命令的错误提示。
 * `zh` 与该命令原有的中文输出逐字一致（`i18n/verify-messages.test.ts` 逐键对照）；`en` 是同一句话的英文。
 *
 * 前一半的键是 kernel 的 `CI_TEXT_KEYS`（`verify.<键>`，kernel 的渲染与发现生成只认键），后一半是 CLI 自己生成的文案。
 * `[FAIL]` / `[WARN]` / `[NOTE]` 标记、发现码、退出码、JSON 字段名、命令行选项不翻译。
 */
export const VERIFY_MESSAGES = {
  // ── kernel 渲染 ──────────────────────────────────────────────
  'verify.headline': {
    zh: 'Tenon CI 校验 {verdict}：{changes} 个任务，{errors} 个失败，{warnings} 个警告（{selector}）',
    en: 'Tenon CI verification {verdict}: {changes} changes, {errors} errors, {warnings} warnings ({selector})',
  },
  'verify.verdict.pass': { zh: '通过', en: 'passed' },
  'verify.verdict.fail': { zh: '未通过', en: 'failed' },
  'verify.severity.error': { zh: '失败', en: 'error' },
  'verify.severity.warning': { zh: '警告', en: 'warning' },
  'verify.severity.note': { zh: '提示', en: 'note' },
  'verify.chain.none': { zh: '无记录链', en: 'no record chain' },
  'verify.chain.records': { zh: '{count} 条', en: '{count} records' },
  'verify.chain.empty': { zh: '空', en: 'empty' },
  'verify.chain.broken': { zh: '已断', en: 'broken' },
  'verify.policy.none': { zh: '该步骤没有测试策略', en: 'the step has no test policy' },
  'verify.policy.pass': { zh: '策略通过', en: 'policy passed' },
  'verify.policy.fail': { zh: '策略未通过', en: 'policy failed' },
  'verify.changeLine': {
    zh: '任务 {change}  步骤 {step}  {policy}  记录链 {chains}  锚点 {anchor}',
    en: 'Change {change}  step {step}  {policy}  record chains {chains}  anchor {anchor}',
  },
  'verify.noFindings': { zh: '（没有发现）', en: '(no findings)' },
  'verify.noChangesInScope': {
    zh: '范围内没有受 Tenon 治理的任务，没有可校验的内容。',
    en: 'There is no Tenon-governed change in scope, so there is nothing to verify.',
  },
  'verify.verifiedHeading': { zh: '本次校验了：', en: 'Verified in this run:' },
  'verify.unverifiableHeading': {
    zh: 'CI 里无法证明（没有用户本机的 HMAC 密钥）：',
    en: 'Not provable in CI (there is no HMAC key from the user\'s machine):',
  },
  'verify.footer': {
    zh: '报告格式 {schema}；Tenon {tenon}；提交 {head}',
    en: 'Report format {schema}; Tenon {tenon}; commit {head}',
  },
  'verify.unknown': { zh: '未知', en: 'unknown' },
  'verify.fixSuffix': { zh: '；执行 {fix}', en: '; run {fix}' },
  'verify.md.colChange': { zh: '任务', en: 'Change' },
  'verify.md.colStep': { zh: '步骤', en: 'Step' },
  'verify.md.colPolicy': { zh: '策略', en: 'Policy' },
  'verify.md.colChains': { zh: '记录链', en: 'Record chains' },
  'verify.md.colAnchor': { zh: '锚点', en: 'Anchor' },
  'verify.md.colErrors': { zh: '失败', en: 'Errors' },
  'verify.md.colWarnings': { zh: '警告', en: 'Warnings' },
  'verify.md.findingsHeading': { zh: '发现', en: 'Findings' },
  'verify.md.colSeverity': { zh: '级别', en: 'Level' },
  'verify.md.colCode': { zh: '码', en: 'Code' },
  'verify.md.colTask': { zh: '任务', en: 'Change' },
  'verify.md.colMessage': { zh: '说明', en: 'Message' },
  'verify.md.verifiedHeading': { zh: '本次校验了', en: 'Verified in this run' },
  'verify.md.unverifiableHeading': { zh: 'CI 里无法证明', en: 'Not provable in CI' },
  'verify.md.unverifiableLead': {
    zh: '没有用户本机的 HMAC 密钥，以下几件事 CI 证明不了：',
    en: 'Without the HMAC key from the user\'s machine, CI cannot prove the following:',
  },
  // ── 信任边界 ────────────────────────────────────────────────
  'verify.trust.unverifiable.records': {
    zh: '记录由受信任的 `tenon test run` 写出：封存链头只在开发者本机，CI 没有 HMAC 密钥；一条重算过全部摘要、与计划和代码自洽的伪造链，CI 看不出来（有锚点时除外）',
    en: 'Records were written by a trusted `tenon test run`: the sealed chain head exists only on the developer\'s machine and CI has no HMAC key; a forged chain with every digest recomputed and consistent with the plan and the code cannot be told apart in CI (unless an anchor exists)',
  },
  'verify.trust.unverifiable.approvals': {
    zh: '评审批准由人给出：批准存在本机封存里，任务历史里的批准行是明文，可以手写',
    en: 'Review approvals were given by a person: the approval is stored in the local seal, and the approval line in the task history is plain text that can be written by hand',
  },
  'verify.trust.unverifiable.reports': {
    zh: '套件真的执行过、报告没有被伪造：报告与产物留在本机，CI 只有记录里的摘要；要在 CI 里证明，另起作业用 TENON_TEST_TRUST=1 tenon test run 重跑套件',
    en: 'The suites really ran and the reports were not forged: reports and artifacts stay on the local machine and CI only has the digests in the records; to prove it in CI, rerun the suites in a separate job with TENON_TEST_TRUST=1 tenon test run',
  },
  'verify.trust.unverifiable.identity': {
    zh: '用户身份属实：身份是声明的，不是认证的',
    en: 'The user identity is genuine: identities are declared, not authenticated',
  },
  'verify.trust.verified.chain': {
    zh: '记录链完整性：链首、分叉、成环、游离记录、文件名、内容摘要（每个用户目录各校一次）',
    en: 'Record chain integrity: genesis, forks, cycles, stray records, file names and content digests (checked once per user directory)',
  },
  'verify.trust.verified.consistent': {
    zh: '记录自洽：所在任务与用户目录、执行人、结论、用例统计互相一致',
    en: 'Record consistency: the change and user directory, the actor, the verdict and the case totals agree with each other',
  },
  'verify.trust.verified.plan': {
    zh: '计划 ↔ 记录 ↔ 目录：计划摘要台账、目录可解析、记录绑定的目录 / 计划 / 策略 / 工作流摘要仍然新鲜；计划登记的测试文件仍在',
    en: 'Plan <-> records <-> catalog: the plan digest ledger, a parseable catalog, the catalog / plan / policy / workflow digests bound into the records still fresh; the test files registered in the plan still exist',
  },
  'verify.trust.verified.policy': {
    zh: '当前步骤策略下的用例级判定：套件已运行且通过、已登记用例出现在报告里、覆盖率 / 基准 / flaky / 场景追溯',
    en: 'Case-level verdicts under the policy of the current step: suites ran and passed, registered cases appear in the report, coverage / benchmark / flaky / scenario traceability',
  },
  'verify.trust.verified.candidateOff': {
    zh: '候选代码：未比对（--candidate off）',
    en: 'Candidate code: not compared (--candidate off)',
  },
  'verify.trust.verified.candidate': {
    zh: '候选代码：记录绑定的工作区指纹等于本次检出的树',
    en: 'Candidate code: the workspace fingerprint bound into the records equals the checked-out tree',
  },
  'verify.trust.verified.candidateWarn': {
    zh: '候选代码：记录绑定的工作区指纹等于本次检出的树（不一致只给警告）',
    en: 'Candidate code: the workspace fingerprint bound into the records equals the checked-out tree (a mismatch is only a warning)',
  },
  'verify.trust.verified.protected': {
    zh: '受保护测试配置（目录、基线、已知失败、工作流）的改动在任务历史里有评审批准行，行里的摘要等于当前内容',
    en: 'Changes to protected test configuration (catalog, baselines, known failures, workflows) have a review approval line in the task history whose digest equals the current content',
  },
  'verify.trust.verified.integrity': {
    zh: '测试完整性信号（测试文件被删、用例或断言变少、新增跳过等）：读 diff 文本的启发式，只说明值得看一眼，不是证明；策略 `integrity: block` 才让它失败，缺省只提示',
    en: 'Test integrity signals (deleted test files, fewer cases or assertions, new skips, ...): heuristics over the diff text that only say something is worth a look, not proof; only a policy with `integrity: block` makes them fail, by default they are notices',
  },
  'verify.trust.verified.anchor': {
    zh: '锚点：refs/notes/tenon 上锚定的链头在已提交的记录链里',
    en: 'Anchor: the chain head anchored in refs/notes/tenon is in the committed record chain',
  },
  'verify.trust.verified.anchorNone': {
    zh: '锚点：没有找到锚点 note，未核对',
    en: 'Anchor: no anchor note was found, so it was not checked',
  },
  // ── 锚点 ────────────────────────────────────────────────────
  'verify.anchor.missing': {
    zh: '任务 {change} 的交付提交上没有 refs/notes/tenon 锚点（--require-anchor）',
    en: 'The delivery commit of change {change} has no refs/notes/tenon anchor (--require-anchor)',
  },
  'verify.anchor.emptyChain': {
    zh: '提交 {commit} 锚定了链头 {head}，但已提交的记录链是空的',
    en: 'Commit {commit} anchored the chain head {head}, but the committed record chain is empty',
  },
  'verify.anchor.unverifiable': {
    zh: '提交 {commit} 锚定的链头 {head} 不在保留的记录里（较老的记录已按保留上限清理）',
    en: 'The chain head {head} anchored by commit {commit} is not in the retained records (older records were pruned by the retention limit)',
  },
  'verify.anchor.rewritten': {
    zh: '提交 {commit} 锚定的链头 {head} 不在已提交的记录链里：链在锚定之后被重写',
    en: 'The chain head {head} anchored by commit {commit} is not in the committed record chain: the chain was rewritten after it was anchored',
  },
  'verify.anchor.behind': {
    zh: '提交 {commit} 锚定了链头 {head}，之后又追加了 {behind} 条记录；这些记录没有被锚定',
    en: 'Commit {commit} anchored the chain head {head}, and {behind} records were appended afterwards; those records are not anchored',
  },
  // ── 受保护文件批准 ──────────────────────────────────────────
  'verify.protected.kind.catalog': { zh: '测试目录', en: 'test catalog' },
  'verify.protected.kind.baseline': { zh: '基线', en: 'baseline' },
  'verify.protected.kind.known-failures': { zh: '已知失败清单', en: 'known-failures list' },
  'verify.protected.kind.workflow': { zh: '项目工作流', en: 'project workflow' },
  'verify.protected.status.added': { zh: '新增', en: 'added' },
  'verify.protected.status.modified': { zh: '修改', en: 'modified' },
  'verify.protected.status.deleted': { zh: '删除', en: 'deleted' },
  'verify.protected.line': { zh: '{kind} {path}（{status}，{digest}）', en: '{kind} {path} ({status}, {digest})' },
  'verify.protected.unapproved': {
    zh: '{line} 在本任务里改动过，任务历史里没有对应的评审批准行',
    en: '{line} was changed in this task and the task history has no matching review approval line',
  },
  'verify.protected.unbound': {
    zh: '{path} 的批准行没有记录内容摘要（旧版本写的），无法确认批准之后文件没有再变',
    en: 'The approval line for {path} records no content digest (written by an older version), so it cannot be confirmed that the file did not change after the approval',
  },
  'verify.protected.changed': {
    zh: '{path} 的当前内容（{current}）与批准过的内容（{approved}）不同',
    en: 'The current content of {path} ({current}) differs from the approved content ({approved})',
  },
  // ── 记录自洽 ────────────────────────────────────────────────
  'verify.record.keptTooMany': {
    zh: '套件 {suite} 留存了 {count} 个 {status} 用例，超过统计的 {total} 个',
    en: 'Suite {suite} retains {count} {status} cases, more than the {total} counted in its totals',
  },
  'verify.record.wrongChange': {
    zh: '记录属于任务 {recordChange}，却放在任务 {change} 的目录里',
    en: 'The record belongs to change {recordChange} but sits in the directory of change {change}',
  },
  'verify.record.wrongActor': {
    zh: '记录的执行人 {actor} 与所在的用户目录 {slug} 不符',
    en: 'The actor {actor} of the record does not match the user directory {slug} it sits in',
  },
  'verify.record.resultMismatch': {
    zh: '记录结论 {result} 与各套件结论（应为 {expected}）矛盾',
    en: 'The record verdict {result} contradicts the suite verdicts (expected {expected})',
  },
  // ── CLI 自己生成的发现 ──────────────────────────────────────
  'verify.listSep': { zh: '、', en: ', ' },
  'verify.ownerChainMissingOne': {
    zh: '任务负责人 {owner} 没有测试记录；判定用的是 {user} 的记录链',
    en: 'The task owner {owner} has no test records; the record chain of {user} was used',
  },
  'verify.ownerChainMissingMany': {
    zh: '任务负责人 {owner} 没有测试记录，而有 {count} 个用户各有一条记录链，无法决定用哪条判定',
    en: 'The task owner {owner} has no test records, and {count} users each have a record chain, so it is undecidable which one to evaluate',
  },
  'verify.ownerUnknownChainMany': {
    zh: '任务负责人未知，而有 {count} 个用户各有一条记录链，无法决定用哪条判定',
    en: 'The task owner is unknown, and {count} users each have a record chain, so it is undecidable which one to evaluate',
  },
  'verify.chainBroken': {
    zh: '用户 {user} 的测试记录被改动（{reason}：{files}）',
    en: 'The test records of user {user} were tampered with ({reason}: {files})',
  },
  'verify.chainReason.noGenesis': { zh: '找不到链首记录', en: 'the genesis record cannot be found' },
  'verify.chainReason.unreadable': { zh: '有记录文件无法读取或格式非法', en: 'a record file is unreadable or malformed' },
  'verify.chainReason.digest': { zh: '记录内容与摘要不符（被改动）', en: 'record content does not match its digest (edited)' },
  'verify.chainReason.fork': { zh: '记录链出现分叉', en: 'the record chain forks' },
  'verify.chainReason.cycle': { zh: '记录链成环', en: 'the record chain is cyclic' },
  'verify.chainReason.stray': {
    zh: '有记录不在当前链上（中间记录缺失或被替换）',
    en: 'a record is not on the current chain (a middle record is missing or was replaced)',
  },
  'verify.recordProblem': { zh: '{file}：{message}', en: '{file}: {message}' },
  'verify.planFileMissing': {
    zh: '测试计划登记的文件 {file} 不在本次检出的树里',
    en: 'The file {file} registered in the test plan is not in the checked-out tree',
  },
  'verify.protectedDiffUnavailable': {
    zh: '读不出本任务的改动，无法核对受保护测试配置的批准：{why}',
    en: 'The changes of this task cannot be read, so the approvals of protected test configuration cannot be checked: {why}',
  },
  'verify.shallowReason': {
    zh: '浅克隆缺少任务起点之前的历史（actions/checkout 需要 fetch-depth: 0）',
    en: 'the shallow clone lacks the history before the task started (actions/checkout needs fetch-depth: 0)',
  },
  'verify.changeUnreadable': {
    zh: '任务状态或冻结的工作流读不出：{reason}',
    en: 'The task state or its frozen workflow cannot be read: {reason}',
  },
  'verify.workflowUnresolved': {
    zh: "任务绑定的工作流 '{workflow}' 解析不出",
    en: "The workflow '{workflow}' bound to the task cannot be resolved",
  },
  'verify.stepNotInWorkflow': {
    zh: "step '{step}' 不在 workflow '{workflow}' 里",
    en: "step '{step}' is not in workflow '{workflow}'",
  },
  'verify.currentPhase': { zh: '当前阶段', en: 'the current step' },
  'verify.noTestPolicy': {
    zh: '工作流在 {phase} 及之前没有声明任何测试策略，没有可校验的用例级判定',
    en: 'The workflow declares no test policy at {phase} or before, so there is no case-level verdict to verify',
  },
  'verify.changeAbandoned': {
    zh: '任务 {change} 已被放弃：它沿 {event} 边从 {from} 转入终态 {to}，放弃不需要测试证据，所以不判定它的测试证据（受保护文件的批准照查）；接手它的任务单独判定。这个判断依据任务提交的转换链，链是自洽的但没有封存',
    en: 'Change {change} was abandoned: it left {from} through the {event} edge into the terminal step {to}. An abandon needs no test evidence, so its test evidence is not judged (protected-file approvals are still checked); the change that replaced it is judged on its own. This rests on the transition chain the task committed, which is self-consistent but not sealed',
  },
  'verify.finishedJudgedAtHead': {
    zh: '任务 {change} 已经完结，但 CI 对它的判定对象是本次检出的树，不是它完结时的提交：完结之后的提交（改过的代码、后来的任务新增的测试文件、改过的测试目录）也会让它的证据出错。要按交付时的样子校验它，检出它的交付提交再运行；或者只选这个 PR 带来的任务（--since <合并基点>）',
    en: 'Change {change} is finished, but CI judges it against the checked-out tree, not against the commit it finished on: commits made after it finished (changed code, test files added by later changes, edited test catalogs) also break its evidence. To verify it as it was delivered, run CI on its delivery commit, or select only the changes this pull request carries (--since <merge base>)',
  },
  'verify.candidateUnchecked': {
    zh: '没有比对记录绑定的工作区指纹与本次检出的树（--candidate off）',
    en: 'The workspace fingerprint bound into the records was not compared with the checked-out tree (--candidate off)',
  },
  'verify.testStatus': {
    zh: '测试 {label}（{id}）状态 {status}',
    en: 'Test {label} ({id}) is {status}',
  },
  'verify.candidateMismatch': {
    zh: '套件 {suites} 的最近一次运行绑定的代码与本次检出的树不同（代码在测试之后变了，或检出的树与测试时的工作区不一致）{hint}',
    en: 'The code bound to the latest run of suite {suites} differs from the checked-out tree (the code changed after the tests ran, or the checkout differs from the tested workspace){hint}',
  },
  'verify.candidateChangedLater': {
    zh: '；记录之后的第一个提交 {commit}（测试时的工作区通常就提交在这里）之后又改过候选文件：{files}',
    en: '; candidate files changed after commit {commit}, the first commit after the run (where the tested workspace was most likely committed): {files}',
  },
  'verify.candidateNothingLater': {
    zh: '；记录之后的第一个提交 {commit} 之后没有再改过候选文件，差异不在后来的提交里，而在测试时的工作区本身：被 gitignore 或未跟踪的文件、可执行位、行尾，或者 0.3.0 及更早版本绑进记录的宿主本地文件（.claude/settings.local.json、CLAUDE.local.md）；用当前版本在最终的树上重跑',
    en: '; no candidate file changed after commit {commit}, the first commit after the run, so the difference is not a later commit but the tested workspace itself: git-ignored or untracked files, executable bits, line endings, or host-local files (.claude/settings.local.json, CLAUDE.local.md) that Tenon 0.3.0 and earlier bound into the records; rerun with the current version on the final tree',
  },
  'verify.candidateWorkspaceCauses': {
    zh: '；这个检出里找不到测试之后的提交，无法指出差在哪个文件。常见原因：测试之后改了代码，或测试时的工作区与干净检出不同（被 gitignore 或未跟踪的文件、可执行位、行尾，或者 0.3.0 及更早版本绑进记录的宿主本地文件）',
    en: '; the commit that followed the run cannot be found in this checkout, so the differing file cannot be named. Usual causes: the code changed after the tests ran, or the tested workspace differs from a clean checkout (git-ignored or untracked files, executable bits, line endings, or host-local files that Tenon 0.3.0 and earlier bound into the records)',
  },
  'verify.candidateTrackedHostLocal': {
    zh: '；这个检出里 git 跟踪着宿主本地清单上的路径（它们是仓库的一部分，计入候选，改了就动候选）：{files}',
    en: '; git tracks paths on the host-local list in this checkout (they are part of the repository, so they count toward the candidate and editing them moves it): {files}',
  },
  'verify.candidateExtraHere': {
    zh: '；本次检出里候选范围内有被 gitignore 或未跟踪的文件：{files}',
    en: '; this checkout holds git-ignored or untracked files inside the candidate scope: {files}',
  },
  'verify.listMore': { zh: '（另有 {count} 个）', en: ' (+{count} more)' },
  // ── 命令的错误提示（前缀 ERROR: 由调用处加）──────────────────
  'verify.ciOnly': {
    zh: '目前只有 CI 模式：请加 --ci（在没有用户本机封存的环境里对已提交内容独立校验）',
    en: 'Only CI mode exists for now: add --ci (independent verification of committed content where there is no local seal)',
  },
  'verify.selectorExactlyOne': {
    zh: '需要且只能选一个任务范围：--change <name> | --all-open | --since <ref>',
    en: 'Pick exactly one change scope: --change <name> | --all-open | --since <ref>',
  },
  'verify.formatInvalid': {
    zh: "--format 只支持 {formats}（收到 '{value}'）",
    en: "--format supports only {formats} (got '{value}')",
  },
  'verify.candidateInvalid': {
    zh: "--candidate 只支持 error | warn | off（收到 '{value}'）",
    en: "--candidate supports only error | warn | off (got '{value}')",
  },
  'verify.alsoInvalid': {
    zh: "--also 的形式是 <format>=<file>，format 为 {formats}（收到 '{value}'）",
    en: "--also takes <format>=<file>, with format one of {formats} (got '{value}')",
  },
  'verify.writeFailed': { zh: '写输出文件失败：{reason}', en: 'failed to write the output file: {reason}' },
  'verify.changeNameInvalid': { zh: "change-name 非法: '{name}'", en: "invalid change name: '{name}'" },
  'verify.changeMissing': {
    zh: 'change 不存在: {name}（既不在 openspec/changes/ 也不在 openspec/changes/archive/）',
    en: 'change not found: {name} (neither in openspec/changes/ nor in openspec/changes/archive/)',
  },
  'verify.sinceUnresolved': {
    zh: '--since {ref}：解析不到这个引用，或它与 HEAD 没有共同祖先（浅克隆请用 fetch-depth: 0）',
    en: '--since {ref}: the ref cannot be resolved, or it has no common ancestor with HEAD (use fetch-depth: 0 for a shallow clone)',
  },
  'verify.rangeUnreadable': {
    zh: '读不出 {base}..HEAD 的改动文件',
    en: 'cannot read the changed files of {base}..HEAD',
  },
} as const
