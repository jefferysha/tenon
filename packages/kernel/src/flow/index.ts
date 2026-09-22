/**
 * kernel/flow 公共面（T3）：
 *   · loadManifest(path)            —— templates/manifest.yaml 窄解析 → ManifestData
 *   · createFlowEngine(manifest)    —— types.ts::FlowEngine 实现（+ ReviewGate.isReviewPhase）
 * integrate 阶段由 packages/kernel/src/index.ts re-export。
 */
export { loadManifest, ManifestError } from './manifest.js'
export { createFlowEngine } from './engine.js'
export type { ReviewGate } from './engine.js'
// manifest 全派生面（BACKLOG #18）——供 router hook #19 / guard skill 面消费
export { skillsFor } from './manifest.js'
export type { ExtendedManifestData, SkillActionAuthorityManifestV1, SkillTable, SkillTrackKey } from './manifest.js'
// transition 事件边表（BACKLOG #25b / GOAL B2）——事件名 → 转移边 + 注入面，供 cli/server 共消费。
export { TRANSITION_EVENTS, eventEdge } from './transition-table.js'
export type { EventEdge, EventName, TransitionContext } from './transition-table.js'
// default 轨事件政策（G2 P3）——前置 guard + 状态副作用迁到 typed handler：DefaultEventPolicy 表
// + checkDefaultEventPreconditions（老 checkTransitionPreconditions 的 drop-in）+ 文案渲染。
export {
  DEFAULT_EVENT_POLICY,
  checkDefaultEventPreconditions,
  defaultEventGuardFields,
  evaluateDefaultEventPreconditions,
  renderPreconditionViolation,
} from './default-event-policy.js'
export type {
  DefaultEventPolicy,
  DefaultGuardFieldRequirement,
  DefaultPreconditionResult,
} from './default-event-policy.js'
