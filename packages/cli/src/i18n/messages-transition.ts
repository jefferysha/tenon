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
    zh: "phase '{phase}' 的 event '{event}' 已请求评审，正在等待用户确认；不要重复 review request。展示产物，用户回复“确认继续”后运行 tenon review acknowledge {name}，再重发本次 transition",
    en: "event '{event}' of phase '{phase}' already has a review request and is waiting for the user; do not request it again. Show the artifacts, and once the user replies \"go ahead\" (or \"确认继续\"), run tenon review acknowledge {name} and resend this transition",
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
} as const
