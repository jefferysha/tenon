/**
 * 跨厂商评审与评审确认：`tenon agent prompt` 的 [ROUTE] 路由说明与宿主拒绝、`tenon agent record` 的宿主拒绝与
 * 登记行的旁注，`tenon review acknowledge` 的拒绝、成功行、豁免收尾与警告，以及 `tenon review request` 的
 * 用法错误、成功行、警告与 verify-fail 回退证据检查。`zh` 与这些命令原有的中文输出逐字一致。
 * `agent next` 与 prompt / record 的其余输出在 messages-agent.ts。
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
  // `tenon review acknowledge` 的成功行与收尾。`[REVIEW]` 标记、change 名、phase 与 event 由调用处保留。
  'review.acknowledged.owner': {
    zh: '已确认',
    en: 'confirmed',
  },
  'review.acknowledged.delegated': {
    zh: '已按用户委托的持续授权确认',
    en: 'confirmed under the continuous authority the user delegated',
  },
  'review.acknowledged.by': {
    zh: '（评审人 {reviewer}，负责人 {owner}）',
    en: ' (reviewer {reviewer}, owner {owner})',
  },
  'review.acknowledged.noOwner': {
    zh: '无',
    en: 'none',
  },
  'review.acknowledged.retransition': {
    zh: '，可重发 transition',
    en: '; you can re-issue the transition',
  },
  'review.waiversApproved': {
    zh: '已批准豁免 {count} 项：{list}',
    en: 'approved {count} waiver(s): {list}',
  },
  'review.protectedApproved': {
    zh: '已批准测试配置改动 {count} 项：{list}',
    en: 'approved {count} test configuration change(s): {list}',
  },
  'review.warn.idempotencyLedger': {
    zh: 'decision idempotency ledger 写入失败（approval receipt 已提交；重试会按当前状态重新判定）',
    en: 'could not write the decision idempotency ledger (the approval receipt is committed; a retry judges again against the current state)',
  },
  'review.warn.interaction': {
    zh: 'interaction projection 写入失败（canonical review acknowledgement 已提交）',
    en: 'could not write the interaction projection (the canonical review acknowledgement is committed)',
  },
  'review.warn.history': {
    zh: 'history 写入失败（canonical review acknowledgement 已提交）',
    en: 'could not write history (the canonical review acknowledgement is committed)',
  },
  'review.warn.markerClear': {
    zh: 'review marker 清理失败（approval receipt 已提交，可重试 acknowledge）',
    en: 'could not clear the review marker (the approval receipt is committed; you can retry acknowledge)',
  },
  // `tenon review request` 与 `review` 的用法错误。
  'review.usage': {
    zh: '用法：tenon review request <change> [--event <event>] | acknowledge <change> [--delegated] [--as reviewer]',
    en: 'usage: tenon review request <change> [--event <event>] | acknowledge <change> [--delegated] [--as reviewer]',
  },
  'review.request.delegatedOnAcknowledge': {
    zh: '--delegated 只可用于 review acknowledge；request 仍必须先完成真实 review 证据',
    en: '--delegated applies to review acknowledge only; request still needs the real review evidence first',
  },
  'review.request.asOnAcknowledge': {
    zh: '--as 只可用于 review acknowledge；request 只有负责人能发起',
    en: '--as applies to review acknowledge only; only the owner can start a request',
  },
  'review.requested.new': {
    zh: '已请求人工确认',
    en: 'human confirmation requested',
  },
  'review.requested.pending': {
    zh: '仍待确认',
    en: 'still waiting for confirmation',
  },
  'review.warn.projectionPendingFailed': {
    zh: 'interaction projection 写入失败（canonical review pending 已存在）: {error}',
    en: 'could not write the interaction projection (the canonical review pending already exists): {error}',
  },
  'review.warn.projectionPendingSkipped': {
    zh: 'interaction projection 未写入（缺 canonical run/workflow/state anchor；canonical review pending 未改变）',
    en: 'interaction projection not written (the canonical run/workflow/state anchor is missing; the canonical review pending is unchanged)',
  },
  'review.warn.projectionRequestFailed': {
    zh: 'interaction projection 写入失败（canonical review request 已提交）: {error}',
    en: 'could not write the interaction projection (the canonical review request is committed): {error}',
  },
  'review.warn.projectionRequestSkipped': {
    zh: 'interaction projection 未写入（缺 canonical run/workflow/state anchor；canonical review request 已提交）',
    en: 'interaction projection not written (the canonical run/workflow/state anchor is missing; the canonical review request is committed)',
  },
  // `review request --event verify-fail` 的回退证据检查。
  'review.verifyFail.empty': {
    zh: '空',
    en: 'empty',
  },
  'review.verifyFail.reportEmpty': {
    zh: "verify-fail 决策要求 verification_report 非空（当前='{current}'）",
    en: "the verify-fail decision requires a non-empty verification_report (current='{current}')",
  },
  'review.verifyFail.reportMissing': {
    zh: "verify-fail 决策要求 verification_report 文件存在（当前='{current}'）",
    en: "the verify-fail decision requires the verification_report file to exist (current='{current}')",
  },
  'review.verifyFail.phaseInvalid': {
    zh: "受 OpenSpec 文档契约治理的 workflow 当前 phase 非法（当前='{phase}'）",
    en: "the current phase of a workflow governed by the OpenSpec document contract is invalid (current='{phase}')",
  },
  'review.verifyFail.ready': {
    zh: 'verify-fail 回退证据已就绪',
    en: 'the verify-fail rollback evidence is ready',
  },
} as const
