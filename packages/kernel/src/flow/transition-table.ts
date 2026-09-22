/**
 * transition 事件边表（BACKLOG #25b / GOAL B2 单一真相源原则）——default 轨的「事件名 → 转移边」
 * 命名翻译，从 cli/server 曾各持一份的逐条镜像上提为唯一真相源（#25 报告点名的重复真相源：
 * packages/cli/src/events.ts + commands/transition.ts 与 packages/server/src/transition.ts 逐条对位）。
 *
 * 语义源（老仓 workflow-plugin，严格只读）：事件表 = skills/pipeline/scripts/manifest.py::
 * _DEFAULT_TRANSITIONS（前向边 + requirements-changed / verify-fail 回退边 + archive 终态自环）。
 *
 * 集成接缝：本表只做「事件名 → 目标相位」的命名翻译；转移「合法性」+ phase/phase_status/updated_at
 * 变换以 FlowEngine.transition（manifest 单一真相源）为准。default 轨的**事件前置 guard 与状态
 * 副作用**不在本文件——G2 P3 起迁到 flow/default-event-policy.ts 的 DefaultEventPolicy（typed
 * guard/action handler，与 custom 轨共用 guard-handlers/action-handlers 引擎；文案渲染在
 * renderPreconditionViolation）。TransitionContext（文件存在性 / git HEAD 注入面）留在本文件，供
 * default-event-policy 与 cli/server adapter 绑定项目根后注入。kernel 零第三方依赖。
 */
import type { GuardContext, Phase } from '../types.js'

export interface EventEdge {
  from: Phase
  to: Phase
}

/** 事件 → 转移边表（逐边对齐老仓 _DEFAULT_TRANSITIONS）。 */
export const TRANSITION_EVENTS = {
  'open-complete': { from: 'open', to: 'explore' },
  'explore-complete': { from: 'explore', to: 'spec' },
  'spec-complete': { from: 'spec', to: 'build' },
  'requirements-changed': { from: 'build', to: 'spec' },
  'build-complete': { from: 'build', to: 'verify' },
  'verify-pass': { from: 'verify', to: 'ship' },
  'verify-fail': { from: 'verify', to: 'build' },
  'ship-complete': { from: 'ship', to: 'archive' },
  archived: { from: 'archive', to: 'archive' },
} as const satisfies Record<string, EventEdge>

export type EventName = keyof typeof TRANSITION_EVENTS

export function eventEdge(event: string): EventEdge | undefined {
  return Object.prototype.hasOwnProperty.call(TRANSITION_EVENTS, event)
    ? TRANSITION_EVENTS[event as EventName]
    : undefined
}

/**
 * default 轨事件前置 guard / 状态副作用的注入面（DefaultEventPolicy 与 cli/server 绑定项目根后
 * 注入；全部可选）。路径 / cwd 由调用方绑定项目根：
 *   · cli   —— fileExists = guardCtx(name)?.fileExists；gitHeadSha / workspaceFingerprint = deps 绑定当前项目根。
 *   · server —— fileExists = (p) => deps.fileExists(root, p)；gitHeadSha / workspaceFingerprint 绑定 root。
 * 文件面能力缺失沿既有可选面处理；Verify-like revision guard 必须绑定 assessor，缺失时
 * 返回 typed revision blocker，不能把 Git SHA/workspace baseline 面静默跳过。
 */
export interface TransitionContext {
  /** 文件存在（相对项目根，已绑定）；缺省 = 降级跳过文件面（视为存在），字段面不降级。 */
  fileExists?: (relPath: string) => boolean
  /** `git rev-parse HEAD` stdout（trim 前；已绑定 cwd），仅供 legacy capture/观察适配器。 */
  gitHeadSha?: () => Promise<string>
  /** `isolation=in-place` 的内容寻址工作区基线；实际 Verify 信任由 assessor 裁决。 */
  workspaceFingerprint?: () => Promise<string>
  /** Trusted Build revision token capture. Missing capability fails the Build transition closed. */
  captureBuildRevision?: (isolation: string) => Promise<string>
  /** Trusted Build revision assessment. Missing capability fails Verify-like success closed. */
  assessBuildRevision?: import('../workflow/ir.js').GuardInput['assessBuildRevision']
  /** Current Verify-like step for provenance checks. */
  currentStep?: string
  /** 当前 Change 的主规格迁移证据；Ship 出口硬门禁，不注入时失败关闭。 */
  specMigrationStatus?: import('../workflow/ir.js').GuardInput['specMigrationStatus']
  /** 在 transition 持有 Change lock 时重验 tasks-through-phase，关闭 preview→commit TOCTOU。 */
  tasksThroughPhase?: (phase: Phase) => Promise<{ readonly pass: boolean; readonly failure?: string }>
  /**
   * 相位出口规则（flow/guard.ts EXIT_RULES）的文件面注入，与 `tenon check` 同一份。
   *
   * 那张表此前只有 check 一个调用点：`tenon check` 说 FAIL exit 2，同一状态上 transition 却
   * exit 0——pm 就这样带着 prd_path=null 走完 ship 与 archive。注入缺省时规则表仍按纯字段面评估
   * （prd_path / pr_url / verify_result 这些槽不降级），只有文件、覆盖与任务面跳过。
   * coverageProfile 不由调用方猜：它来自本次转换已绑定的 effective plan。
   */
  phaseExitGuard?: Omit<GuardContext, 'coverageProfile'>
}
