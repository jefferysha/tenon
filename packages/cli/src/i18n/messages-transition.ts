/**
 * `tenon transition` 的拒绝与提示。非法/未知 event 的报错都附带「当前 step 的合法 event」，两种语言都有。
 * 首行保持以前的形状（`illegal transition: a -> b`、`未知 event: x`），合法 event 另起一行，已有的逐行断言不受影响。
 */
export const TRANSITION_MESSAGES = {
  'transition.unknownEvent': {
    zh: '未知 event: {event}',
    en: 'unknown event: {event}',
  },
  'transition.illegal': {
    zh: "illegal transition: {from} -> {to}（event '{event}' 只能从 step '{expected}' 触发）",
    en: "illegal transition: {from} -> {to} (event '{event}' can only fire from step '{expected}')",
  },
  'transition.illegalFlow': {
    zh: 'illegal transition: {from} -> {to}',
    en: 'illegal transition: {from} -> {to}',
  },
  'transition.legalEvents': {
    zh: "  当前 step '{step}' 的合法 event：{events}",
    en: "  Legal events at step '{step}': {events}",
  },
  'transition.noLegalEvents': {
    zh: '(无)',
    en: '(none)',
  },
  'transition.eventUnsupported': {
    zh: "step '{step}' 不支持 event '{event}'；该 step 支持：{available}",
    en: "step '{step}' does not support event '{event}'; this step supports: {available}",
  },
  'transition.stepGuardFailed': {
    zh: "step '{step}' guard 未通过：",
    en: "step '{step}' guard failed:",
  },
  'transition.stepSkillsIncomplete': {
    zh: "step '{step}' 尚未完成声明的 skill：",
    en: "step '{step}' has not completed its declared skills:",
  },
  'transition.stepAgentsIncomplete': {
    zh: "step '{step}' 的 agent 未通过：",
    en: "step '{step}' agents have not passed:",
  },
  'transition.documentEvidenceFailed': {
    zh: 'OpenSpec 文档证据未通过（phase={phase}）：',
    en: 'OpenSpec document evidence has not passed (phase={phase}):',
  },
  'transition.testEvidenceFailed': {
    zh: '测试证据未通过（step={step}）：',
    en: 'test evidence has not passed (step={step}):',
  },
  'transition.reviewRequested': {
    zh: "phase '{phase}' 的 event '{event}' 已请求评审，正在等待用户确认；不要重复 review request，也不要自己运行 tenon review acknowledge。展示产物，等用户回复“确认继续”（由 hook 写回执）或在 Dashboard 确认；宿主没有 UserPromptSubmit hook 时由用户本人在自己的终端运行 tenon review acknowledge {name}。回执写入后再重发本次 transition",
    en: "event '{event}' of phase '{phase}' already has a review request and is waiting for the user; do not request it again and do not run tenon review acknowledge yourself. Show the artifacts and wait for the user to reply \"go ahead\" (or \"确认继续\"; the hook writes the receipt) or to confirm in the Dashboard; on a host without a UserPromptSubmit hook the user runs tenon review acknowledge {name} in their own terminal. Resend this transition once the receipt is written",
  },
  'transition.reviewRequired': {
    zh: "phase '{phase}' 的 event '{event}' 尚未取得人工确认；先运行 tenon review request {name} --event {event}，展示产物并等待用户“确认继续”，再重发本次 transition",
    en: "event '{event}' of phase '{phase}' has no human confirmation yet; run tenon review request {name} --event {event} first, show the artifacts, wait for the user to reply \"go ahead\" (or \"确认继续\"), then resend this transition",
  },
  'transition.reviewPendingOther': {
    zh: "  当前待确认的 review request 绑定的是 event '{pending}'，确认不能跨 event 使用",
    en: "  The pending review request is bound to event '{pending}'; a confirmation cannot be used for another event",
  },
  'transition.constraintDenied': {
    zh: 'automation constraint denied transition: {reason}',
    en: 'automation constraint denied transition: {reason}',
  },
  // 验证轮次上限：用完后受约束步骤的回退边被拒（`tenon review request --event <回退事件>` 与 `tenon transition <回退事件>` 共用）。
  'transition.roundsExhausted': {
    zh: "step '{step}' 的验证轮次已用完（{current}/{max}：已用 {current} 轮 / 上限 {max}，来源 {source}），回退边 event '{event}' 不再放行。"
      + '出路：调高上限是用户的决定，没有用户明确指示不要执行 tenon set {name} max_rounds <N>（N 须大于 {current}；设置会改变任务状态，已发起的评审请求随之失效，之后重新 tenon review request）；'
      + '或回到规格重新规划（当前步骤没有直达的边：要先调高上限，经回退边回到回退目标步骤，再在那一步上执行回到规格的事件，回到规格后验证轮次重新计数）；或终止任务。评审者仍不通过时，对前进边发起 review request，由用户决定是否接受剩余阻断',
    en: "the verification rounds of step '{step}' are used up ({current}/{max}: {current} used / limit {max}, source {source}); the back edge event '{event}' is no longer allowed. "
      + 'Ways out: raising the limit is the user\'s decision, so do not run tenon set {name} max_rounds <N> without the user\'s explicit instruction (N must be greater than {current}; setting it changes the task state, so a review request that is already open becomes invalid and tenon review request has to be run again); '
      + 'or go back to the spec to re-plan (this step has no direct edge for that: raise the limit first, take a back edge to the step it points to, then run the event that returns to the spec on that step; the verification rounds are counted again once the spec is reached); or end the task. If a reviewer still fails, run review request on the forward edge and let the user decide whether to accept the residual blockers',
  },
} as const
