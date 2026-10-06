/**
 * 跨厂商评审与评审确认的拒绝：`tenon agent prompt` 的 [ROUTE] 路由说明与宿主拒绝、`tenon agent record` 的宿主拒绝与
 * 登记行的旁注，以及 `tenon review acknowledge` 的拒绝。`zh` 与这些命令原有的中文输出逐字一致。
 */
export const REVIEW_MESSAGES = {
  'agent.route.header': {
    zh: "[ROUTE] 评审者 '{agent}' 须在 {host} 上运行（{why}）；当前宿主：{current}",
    en: "[ROUTE] reviewer '{agent}' must run on {host} ({why}); current host: {current}",
  },
  'agent.route.source.step': {
    zh: '工作流步骤要求',
    en: 'required by the workflow step',
  },
  'agent.route.source.agent': {
    zh: 'agent 定义建议',
    en: 'suggested by the agent definition',
  },
  'agent.route.enforced': {
    zh: '，登记的宿主不符则结论无效',
    en: '; a result registered from a different host is invalid',
  },
  'agent.route.currentTerminal': {
    zh: '终端',
    en: 'terminal',
  },
  'agent.route.prompt': {
    zh: '提示词：{file}',
    en: 'Prompt: {file}',
  },
  'agent.route.run': {
    zh: '运行：{command}',
    en: 'Run: {command}',
  },
  'agent.route.record': {
    zh: '登记（评审写完报告后）：{command}',
    en: 'Record (after the review has written its report): {command}',
  },
  'agent.hostUnsupported': {
    zh: "agent '{agent}' 不支持宿主 '{host}'",
    en: "agent '{agent}' does not support the host '{host}'",
  },
  'agent.record.hostFlagUnknown': {
    zh: "--host '{host}' 不是已知宿主（{known}）",
    en: "--host '{host}' is not a known host ({known})",
  },
  'agent.record.hostUnknown': {
    zh: '未知（终端里请用 --host 声明）',
    en: 'unknown (declare it with --host from a terminal)',
  },
  'agent.record.wrongHost': {
    zh: "评审者 '{agent}' 须在 {required} 上运行，这次登记的宿主是 {host}，结论无效、未登记；在 {required} 上运行：{run}；评审写完报告后：{record}",
    en: "reviewer '{agent}' must run on {required}; this record comes from {host}, so the result is invalid and was not recorded; run it on {required}: {run}; after the review has written its report: {record}",
  },
  'agent.record.declared': {
    zh: '(声明)',
    en: '(declared)',
  },
  'agent.record.generic': {
    zh: '(通用)',
    en: '(generic)',
  },
  'review.ownerRequired.none': {
    zh: '任务 {name} 没有负责人，评审确认默认只认负责人；以评审人身份确认请加 --as reviewer，要接手任务请先 tenon owner take {name}',
    en: 'task {name} has no owner, and a review confirmation is owner-only by default; to confirm as a reviewer add --as reviewer, to take the task over run tenon owner take {name} first',
  },
  'review.ownerRequired.other': {
    zh: '任务 {name} 的负责人是 {owner}，评审确认默认只认负责人；以评审人身份确认请加 --as reviewer，要接手任务请先 tenon owner take {name}',
    en: 'task {name} is owned by {owner}, and a review confirmation is owner-only by default; to confirm as a reviewer add --as reviewer, to take the task over run tenon owner take {name} first',
  },
  'review.asRoleInvalid': {
    zh: "--as 只支持 {role}（收到 '{got}'）",
    en: "--as supports only {role} (got '{got}')",
  },
  'review.noDelegatedAuthority': {
    zh: "当前 Change '{name}' 没有有效的用户委托 review 授权；请等待正常确认，或先由用户明确授权后续自主执行",
    en: "the current change '{name}' has no valid user-delegated review authority; wait for a normal confirmation, or have the user explicitly authorise autonomous execution first",
  },
} as const
