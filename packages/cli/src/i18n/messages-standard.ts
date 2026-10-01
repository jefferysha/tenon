/**
 * standard 通道新增的命令输出：`tenon step run`、`tenon document record --all`、`tenon test diff-risk`，
 * 以及 `tenon agent prompt` 对没挂载的评审者的拒绝。`zh` 与这些命令原有的中文输出逐字一致。
 */
export const STANDARD_MESSAGES = {
  'step.workflowUnavailable': {
    zh: "任务 '{name}' 的工作流不可用",
    en: "the workflow of task '{name}' is not available",
  },
  'step.run.header': {
    zh: '[STEP] {change} · {step}（{label}）',
    en: '[STEP] {change} · {step} ({label})',
  },
  'step.run.nothing': {
    zh: '没有可批量做的事，什么都没改。',
    en: 'Nothing can be done in batch; nothing was changed.',
  },
  'step.run.done': {
    zh: '已做 {ok}/{total} 项：',
    en: 'Done {ok}/{total}:',
  },
  'step.run.stopped': {
    zh: '停下：{reason}',
    en: 'Stopped: {reason}',
  },
  'step.run.next': {
    zh: '下一步（step.next）：',
    en: 'Next (step.next):',
  },
  'step.stop.host': {
    zh: '{what} 要宿主来做（加载技能 / 派发 agent）',
    en: '{what} is for the host to do (load a skill / dispatch an agent)',
  },
  'step.stop.work': {
    zh: '{what} 要实际工作，不是批量命令能代做的',
    en: '{what} takes real work that a batch command cannot do for you',
  },
  'step.stop.pathUndecided': {
    zh: '{kind} 的路径要作者定名（delta-spec：tenon document scaffold {change} delta-spec --capability <名>）',
    en: 'the author has to name the path of {kind} (delta-spec: tenon document scaffold {change} delta-spec --capability <name>)',
  },
  'step.stop.fileNotWritten': {
    zh: '{path} 还没写：骨架里的占位符要全部替换成真内容，然后再跑一次 tenon step run {change}',
    en: '{path} is not written yet: replace every placeholder in the skeleton with real content, then run tenon step run {change} again',
  },
  'step.stop.documentSkipped': {
    zh: '{subject}：{detail}；写完再跑一次 tenon step run {change}',
    en: '{subject}: {detail}; run tenon step run {change} again once it is written',
  },
  'step.detail.pathUndecided': {
    zh: '路径要作者定名',
    en: 'the author has to name the path',
  },
  'step.detail.fileNotWritten': {
    zh: '文件还没写',
    en: 'the file is not written yet',
  },
  'step.detail.readReceipt': {
    zh: '读取回执已登记',
    en: 'read receipts recorded',
  },
  'step.detail.planSeeded': {
    zh: '测试计划初稿已生成并登记本任务的测试文件',
    en: 'draft test plan generated and the test files of this task registered',
  },
  'step.detail.exitCode': {
    zh: '退出码 {code}',
    en: 'exit code {code}',
  },
  'step.stop.exitCode': {
    zh: '{command} 退出码 {code}',
    en: '{command} exited with code {code}',
  },
  'document.record.usage': {
    zh: '用法：tenon document record <change> <kind> <path> --producer <skill-id>；或 tenon document record <change> --all',
    en: 'usage: tenon document record <change> <kind> <path> --producer <skill-id>; or tenon document record <change> --all',
  },
  'document.record.allConflict': {
    zh: '--all 不带 kind / path，也不能与 --backfill 同用',
    en: '--all takes no kind / path and cannot be combined with --backfill',
  },
  'document.record.allNone': {
    zh: '[DOCUMENT] {change} · {step}：没有待登记的文档',
    en: '[DOCUMENT] {change} · {step}: no documents waiting to be recorded',
  },
  'document.record.allSummary': {
    zh: '[DOCUMENT] {change} · {step}：{recorded}/{total} 份已登记',
    en: '[DOCUMENT] {change} · {step}: {recorded}/{total} recorded',
  },
  'document.record.pathUndecided': {
    zh: '路径要作者定名（delta-spec 先 tenon document scaffold <change> delta-spec --capability <名>）',
    en: 'the author has to name the path (for delta-spec run tenon document scaffold <change> delta-spec --capability <name> first)',
  },
  'document.record.fileNotWritten': {
    zh: '文件还没写：先 tenon document scaffold {change} {kind} 再写内容',
    en: 'the file is not written yet: run tenon document scaffold {change} {kind} first, then write the content',
  },
  'document.record.placeholders': {
    zh: '骨架里还有 {count} 处占位符没替换（{first}）',
    en: '{count} placeholder(s) in the skeleton are not replaced ({first})',
  },
  'document.record.placeholdersSome': {
    zh: '骨架里还有 若干 处占位符没替换（{first}）',
    en: 'some placeholders in the skeleton are not replaced ({first})',
  },
  'document.record.noProducer': {
    zh: '这份文档在当前步骤没有合法的 producer',
    en: 'this document has no valid producer in the current step',
  },
  'document.record.recorded': {
    zh: '已登记（producer {producer}）',
    en: 'recorded (producer {producer})',
  },
  'document.record.exitCode': {
    zh: 'document record 退出码 {code}',
    en: 'document record exited with code {code}',
  },
  'diffRisk.nameRequired': {
    zh: '需要任务名：tenon test diff-risk <change>（测试进程里由 TENON_CHANGE_NAME 提供）',
    en: 'a task name is required: tenon test diff-risk <change> (inside a test process it comes from TENON_CHANGE_NAME)',
  },
  'diffRisk.nameInvalid': {
    zh: "非法任务名 '{name}'",
    en: "invalid task name '{name}'",
  },
  'diffRisk.readFailed': {
    zh: "无法读取任务 '{name}' 的改动（{error}）",
    en: "cannot read the changes of task '{name}' ({error})",
  },
  'diffRisk.label.filesChanged': { zh: '改动文件', en: 'files changed' },
  'diffRisk.label.contractFiles': { zh: '契约路径', en: 'contract paths' },
  'diffRisk.label.authFiles': { zh: '鉴权路径', en: 'auth paths' },
  'diffRisk.label.dependencyFiles': { zh: '依赖清单', en: 'dependency manifests' },
  'diffRisk.label.migrationFiles': { zh: '迁移路径', en: 'migration paths' },
  'diffRisk.label.deletedTests': { zh: '被删的测试', en: 'deleted tests' },
  'diffRisk.label.protectedTestFiles': { zh: '受保护的测试配置', en: 'protected test config' },
  'agent.reviewerUnattached': {
    zh: "评审者 '{agent}' 只在 {scope} 路径变化时挂载，本任务的改动没有碰到这些路径，不需要运行它",
    en: "reviewer '{agent}' attaches only when {scope} paths change; this task's changes touch none of them, so it does not need to run",
  },
} as const
