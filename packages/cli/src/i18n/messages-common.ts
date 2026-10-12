/**
 * 最常撞见的错误与提示（跨命令共用）。键是稳定的消息码，改文案不改码；`zh` 与既有输出逐字一致，
 * `{name}` 形式的占位符在两种语言里必须成对出现（i18n 目录测试守着）。
 */
export const COMMON_MESSAGES = {
  'change.notFound': {
    zh: 'change 不存在: {name}',
    en: 'change not found: {name}',
  },
  'change.nameInvalid': {
    zh: "change-name 非法: '{name}' (仅允许 a-z A-Z 0-9 - _)",
    en: "invalid change name '{name}' (allowed: a-z A-Z 0-9 - _)",
  },
  'change.terminated': {
    zh: "任务 '{name}' 已终止，目录在 {dated}；终止的任务不再接受推进，要继续就新建任务并执行 tenon set <新任务> depends_on {name}",
    en: "task '{name}' was terminated and now lives in {dated}; a terminated task takes no more progress — create a new task and run tenon set <new-task> depends_on {name}",
  },
  'change.relocated': {
    zh: "change '{name}' 的目录已被搬到 {dated}，但它还没完结（archived=false）；归档必须排在 tenon transition {name} archived 之后",
    en: "the directory of change '{name}' was moved to {dated}, but the change is not finished (archived=false); archiving must come after tenon transition {name} archived",
  },
  'change.relocatedRecover': {
    zh: '  恢复：mv {dated} openspec/changes/{name} && tenon transition {name} archived && tenon task finish {name}',
    en: '  Recover: mv {dated} openspec/changes/{name} && tenon transition {name} archived && tenon task finish {name}',
  },
  'user.missing': {
    zh: '未设置用户身份；运行 tenon user set <邮箱> --name <名字>，或 git config --global user.email <邮箱>',
    en: 'no user identity is set; run tenon user set <email> --name <name>, or git config --global user.email <email>',
  },
  'owner.required.none': {
    zh: '任务 {name} 没有负责人；先接手：tenon owner take {name}',
    en: 'task {name} has no owner; take it over first: tenon owner take {name}',
  },
  'owner.required.other': {
    zh: '任务 {name} 的负责人是 {owner}；先接手：tenon owner take {name}',
    en: 'task {name} is owned by {owner}; take it over first: tenon owner take {name}',
  },
  'field.unknown': {
    zh: '未知字段: {field}',
    en: 'unknown field: {field}',
  },
  'field.managedByReview': {
    zh: "字段 '{field}' 由 tenon review request|acknowledge 管理，禁止通过 set/set-many/cas 写入",
    en: "field '{field}' is managed by tenon review request|acknowledge and cannot be written with set/set-many/cas",
  },
  'field.maxRoundsInvalid': {
    zh: "max_rounds 只接受 1 到 20 的整数（收到 '{value}'）：它是本任务验证步骤的轮次上限，调高由用户决定",
    en: "max_rounds only accepts an integer from 1 to 20 (got '{value}'): it is the round limit of this task's verification steps, and raising it is the user's decision",
  },
  'field.managedByArchive': {
    zh: "字段 '{field}' 由 tenon transition <change> archived 管理，禁止通过 set/set-many/cas 写入；完结须经该转换才会同时落 archived_at 与 phase_status",
    en: "field '{field}' is managed by tenon transition <change> archived and cannot be written with set/set-many/cas; finishing must go through that transition so archived_at and phase_status are written together",
  },
  'field.buildShaFrozen': {
    zh: "字段 'build_sha' 由 build 出口的 transition 冻结（freeze-build-sha 副作用），禁止通过 set/set-many/cas 写入；先把实现与测试做完，再执行该 transition 捕获当前修订",
    en: "field 'build_sha' is frozen by the transition that leaves build (the freeze-build-sha effect) and cannot be written with set/set-many/cas; finish the implementation and tests first, then run that transition to capture the current revision",
  },
  'field.managedByTask': {
    zh: "字段 '{field}'（任务结果）只由 tenon task finish / tenon task terminate 写入，禁止通过 set/set-many/cas 写入；结束任务请用这两条命令",
    en: "field '{field}' (the task result) is written only by tenon task finish / tenon task terminate and cannot be written with set/set-many/cas; use those two commands to end a task",
  },
  'field.managedBy': {
    zh: "字段 '{field}' 由 {owner} 管理，禁止通过 set/set-many/cas 写入",
    en: "field '{field}' is managed by {owner} and cannot be written with set/set-many/cas",
  },
  'setMany.badPair': {
    zh: "kv 格式错误(缺 '=' 或键为空): {pair}",
    en: "malformed key=value (missing '=' or empty key): {pair}",
  },
  'setMany.duplicate': {
    zh: "set-many 重复字段 '{field}'（同键多次赋值，拒写以免静默 last-wins）",
    en: "set-many repeats field '{field}' (assigned more than once; refused so the last value does not win silently)",
  },
  'setMany.empty': {
    zh: 'set-many 至少需要 1 个 key=value',
    en: 'set-many needs at least one key=value',
  },
  'list.separator': {
    zh: '、',
    en: ', ',
  },
  'status.none': {
    zh: '无活跃 change',
    en: 'no active changes',
  },
  'status.noneFinished': {
    zh: '无已完结 change',
    en: 'no finished changes',
  },
  'status.skipped': {
    zh: '跳过 {name}（读取失败: {error}）',
    en: 'skipping {name} (could not read it: {error})',
  },
  'check.pass': {
    zh: '所有检查通过',
    en: 'all checks passed',
  },
  'check.failTotal': {
    zh: '共 {count} 项未通过',
    en: '{count} check(s) failed',
  },
  'workflow.notFound': {
    zh: "workflow '{workflow}' 未找到（期望 .pipeline/workflows/{workflow}.yaml）",
    en: "workflow '{workflow}' not found (expected .pipeline/workflows/{workflow}.yaml)",
  },
  'workflow.stepNotInGraph': {
    zh: "step '{step}' 不在 workflow '{workflow}' 里",
    en: "step '{step}' is not in workflow '{workflow}'",
  },
  'workflow.eventUnsupportedCheck': {
    zh: "step '{step}' 不支持 event '{event}'；可选：{available}",
    en: "step '{step}' does not support event '{event}'; choose one of: {available}",
  },
  'init.presetInvalid': {
    zh: "非法 preset '{preset}'，允许: {allowed}",
    en: "invalid preset '{preset}'; allowed: {allowed}",
  },
  'init.nonInteractiveMissing': {
    zh: '非交互模式缺少必填项 {missing}（agent/CI 需显式提供；TTY 下省略会走交互向导）',
    en: 'non-interactive mode is missing required option(s) {missing} (agents and CI must pass them; on a TTY, omitting them starts the interactive wizard)',
  },
  'init.documentLocaleInvalid': {
    zh: "document locale 非法: '{locale}'（允许: zh-CN | en）",
    en: "invalid document locale '{locale}' (allowed: zh-CN | en)",
  },
  'init.presetEmpty': {
    zh: 'preset 不能为空（default 工作流需要 --preset {allowed}）',
    en: 'preset cannot be empty (the default workflow needs --preset {allowed})',
  },
  'init.workflowNoSteps': {
    zh: "workflow '{workflow}' 未声明任何 step",
    en: "workflow '{workflow}' declares no steps",
  },
  'init.agentMissing': {
    zh: '工作流引用了 agent 库中不存在的 agent：{error}',
    en: 'the workflow references agents that are not in the agent library: {error}',
  },
  'init.workflowRetired': {
    zh: "工作流 '{workflow}' 已退役；改用：tenon init <名字> --workflow default --track lite（轻量轨道）",
    en: "workflow '{workflow}' has been retired; use: tenon init <name> --workflow default --track lite (the lite track)",
  },
  'init.trackRetiredToLite': {
    zh: "轨道 '{track}' 已退役；改用：tenon init <名字> --workflow default --track lite（轻量轨道）",
    en: "track '{track}' has been retired; use: tenon init <name> --workflow default --track lite (the lite track)",
  },
  'init.trackRetired': {
    zh: "轨道 '{track}' 已退役；开发任务从上面的可选轨道里选一条，纯讨论不用建任务",
    en: "track '{track}' has been retired; pick one of the tracks above for a development task — a plain discussion needs no task",
  },
  'init.flatWorkflowTrack': {
    zh: "工作流 '{workflow}' 没有 tracks: 分支，只有一条与它同名的轨道，不用写 --track",
    en: "workflow '{workflow}' has no tracks: branches, only one track named after it; omit --track",
  },
  'init.domainInvalid': {
    zh: "--domain '{domain}' 不可用：须是工作流 '{workflow}' 里除本任务轨道 '{track}' 之外的另一条轨道（可选：{available}）",
    en: "--domain '{domain}' is not usable: it must be another track of workflow '{workflow}' besides this task's track '{track}' (available: {available})",
  },
  'init.domainNoOtherTrack': {
    zh: "工作流 '{workflow}' 里除本任务轨道 '{track}' 之外没有别的轨道（平铺工作流只有一条与它同名的轨道），没有可记的领域，不用写 --domain",
    en: "workflow '{workflow}' has no track besides this task's track '{track}' (a flat workflow has only one track named after it), so there is no domain to record; omit --domain",
  },
  'tracks.fileIgnored': {
    zh: 'tracks.yaml 已不再读取：把轨道写进工作流分支（见 docs/usage/zh-CN/custom-workflows-and-tracks.md）',
    en: 'tracks.yaml is no longer read: declare tracks as workflow branches (see docs/usage/custom-workflows-and-tracks.md)',
  },
  'tracks.notFound': {
    zh: "没有轨道 '{track}'（用 tenon tracks list 查看全部：工作流:轨道）",
    en: "no track '{track}' (run tenon tracks list to see every workflow:track)",
  },
  'tracks.ambiguous': {
    zh: "轨道 '{track}' 同时出现在多个工作流里：{candidates}；用 <工作流>:<轨道> 指定",
    en: "track '{track}' exists in several workflows: {candidates}; specify <workflow>:<track>",
  },
  'usage.missingArgument': {
    zh: "错误：缺少必需的参数 '{name}'",
    en: "error: missing required argument '{name}'",
  },
  'usage.unknownOption': {
    zh: "错误：未知选项 '{flag}'",
    en: "error: unknown option '{flag}'",
  },
  'usage.unknownCommand': {
    zh: "错误：未知命令 '{name}'",
    en: "error: unknown command '{name}'",
  },
  'usage.missingOption': {
    zh: "错误：必须指定选项 '{flags}'",
    en: "error: required option '{flags}' not specified",
  },
  'usage.optionArgMissing': {
    zh: "错误：选项 '{flags}' 缺少参数值",
    en: "error: option '{flags}' argument missing",
  },
  'usage.excessArguments': {
    zh: "错误：'{command}' 的参数过多（应为 {expected}，实际 {actual}）",
    en: "error: too many arguments for '{command}'. Expected {expected} but got {actual}.",
  },
  'usage.didYouMean': {
    zh: '（你是不是想用 {suggestion}？）',
    en: '(Did you mean {suggestion}?)',
  },
  'help.heading.usage': { zh: '用法:', en: 'Usage:' },
  'help.heading.arguments': { zh: '参数:', en: 'Arguments:' },
  'help.heading.options': { zh: '选项:', en: 'Options:' },
  'help.heading.commands': { zh: '命令:', en: 'Commands:' },
  'help.option': { zh: '显示帮助', en: 'display help for command' },
  'help.command': { zh: '显示命令帮助', en: 'display help for command' },
  'help.footerSetup': {
    zh: '首次安装：tenon setup --codex（或 --claude；安装完整打包插件并配就绪）——随后再用 init 起 change。',
    en: 'First install: tenon setup --codex (or --claude; installs the full packaged plugin and gets it ready), then use init to start a change.',
  },
} as const
