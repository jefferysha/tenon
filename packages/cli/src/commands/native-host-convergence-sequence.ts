import {
  hostFlag,
  type HostCommandPlanItem,
  type NativePipelineHost,
} from './plugin-host.js'
import type { StableReleaseTarget } from './stable-release.js'

/** Positional contract of `nativeUpdatePlan`; the managed WAL keys every host mutation by these. */
export const NATIVE_HOST_UPDATE_STEP_IDS = [
  'plugin-remove',
  'marketplace-remove',
  'marketplace-register',
  'plugin-install',
  'inventory-after',
] as const

export type NativeHostUpdateStepId = typeof NATIVE_HOST_UPDATE_STEP_IDS[number]

export interface NativeHostConvergenceStep {
  readonly id: NativeHostUpdateStepId
  readonly item: HostCommandPlanItem
  /** True when proving this step's postcondition means an existing registration is gone. */
  readonly destructive: boolean
  /**
   * True when the command only has an effect if the host currently owns the registration it
   * removes.  A caller that cannot prove the registration state (a read-only preview) must publish
   * such a step as conditional instead of promising the removal will happen.
   */
  readonly conditional: boolean
}

/**
 * `true` / `false` are proved pre-mutation facts about a registered tenon plugin.  `'unknown'` is
 * the only honest answer for a caller that never observes the host, and keeps every removal in the
 * sequence while marking it conditional.
 */
export type NativeHostPluginRegistration = boolean | 'unknown'

const DESTRUCTIVE_STEP_IDS: ReadonlySet<NativeHostUpdateStepId> = new Set([
  'plugin-remove',
  'marketplace-remove',
])

function planItem(
  plan: readonly HostCommandPlanItem[],
  index: number,
): HostCommandPlanItem {
  const item = plan[index]
  if (item === undefined) throw new Error('宿主安装计划与受管步骤不一致')
  return item
}

/**
 * A first install has nothing to remove.  Emitting `plugin remove` there would still open the
 * window this sequence exists to close: the host loses tenon before the network-dependent
 * re-registration has been proved.  The removal is therefore dropped whenever the authoritative
 * pre-mutation inventory shows no registered tenon plugin.  The marketplace removal is kept even
 * then, because a marketplace can legitimately stay registered without the plugin and the managed
 * step runner proves-and-skips a removal whose absence postcondition already holds.
 *
 * This is the single derivation of the host mutation order; the read-only plan preview asks for the
 * same sequence with `plugin: 'unknown'` so it can never advertise a removal the execution path
 * would not perform.
 */
export function nativeHostConvergenceSequence(
  plan: readonly HostCommandPlanItem[],
  registration: { readonly plugin: NativeHostPluginRegistration },
): readonly NativeHostConvergenceStep[] {
  if (plan.length !== NATIVE_HOST_UPDATE_STEP_IDS.length) {
    throw new Error('宿主安装计划与受管步骤不一致')
  }
  const steps: NativeHostConvergenceStep[] = []
  NATIVE_HOST_UPDATE_STEP_IDS.forEach((id, index) => {
    if (id === 'plugin-remove' && registration.plugin === false) return
    const destructive = DESTRUCTIVE_STEP_IDS.has(id)
    // A proved plugin registration is the only case where a removal is certain to run.  Every other
    // removal survives only as a step the managed runner proves-and-skips when nothing is there.
    const conditional = destructive
      && !(id === 'plugin-remove' && registration.plugin === true)
    steps.push({ id, item: planItem(plan, index), destructive, conditional })
  })
  return steps
}

/** The two commands that re-register the release; also the manual recovery path for a user. */
export function nativeHostRestoreCommands(
  plan: readonly HostCommandPlanItem[],
): readonly HostCommandPlanItem[] {
  if (plan.length !== NATIVE_HOST_UPDATE_STEP_IDS.length) {
    throw new Error('宿主安装计划与受管步骤不一致')
  }
  return [planItem(plan, 2), planItem(plan, 3)]
}

export interface HostConvergenceInterruption {
  readonly host: NativePipelineHost
  readonly stepId: string
  readonly reason: string
  readonly target: StableReleaseTarget
  /** Steps whose postcondition was proved before the interruption, in execution order. */
  readonly provenDestructiveStepIds: readonly NativeHostUpdateStepId[]
  /** True when the host owned a registered tenon plugin before this convergence started. */
  readonly hadInstalledPlugin: boolean
  readonly restoreCommands: readonly HostCommandPlanItem[]
  readonly resumeCommand: string
}

function commandText(item: HostCommandPlanItem): string {
  return [item.cmd, ...item.args].join(' ')
}

/**
 * An interrupted convergence must never leave the user guessing.  Report the proved host state and
 * the exact commands that restore it, because the failure mode this guards (offline / rate-limited
 * marketplace registration) is precisely the one where the user cannot look anything up online.
 */
export function hostConvergenceInterruptionReport(
  input: HostConvergenceInterruption,
): readonly string[] {
  const flag = hostFlag(input.host)
  const lines = [`ERROR: ${flag} 宿主收敛在 ${input.stepId} 中断：${input.reason}`]
  const pluginGone = input.provenDestructiveStepIds.includes('plugin-remove')
  const marketplaceGone = input.provenDestructiveStepIds.includes('marketplace-remove')
  if (!pluginGone && !marketplaceGone) {
    lines.push(`[setup] 当前宿主状态：本次未证明任何删除步骤，${flag} 的 tenon 登记保持中断前的状态。`)
  } else {
    const absent = [
      ...(pluginGone ? ['tenon 插件'] : []),
      ...(marketplaceGone ? ['tenon marketplace'] : []),
    ].join('与')
    lines.push(
      `[setup] 当前宿主状态：${flag} 中的 ${absent} 已被移除且未重新登记；`
      + `在恢复前该宿主不会再加载 Tenon。`,
    )
    if (input.hadInstalledPlugin) {
      lines.push('[setup] 这次收敛移除的是宿主原有的 tenon 登记，必须完成下面任一恢复动作。')
    }
  }
  lines.push(
    `[setup] 恢复方式一（推荐）：网络恢复后重新运行 \`${input.resumeCommand}\`；`
    + '受管 WAL 会从中断的步骤继续，不会重复删除。',
  )
  lines.push(
    `[setup] 恢复方式二（手工，直接用宿主 CLI 重新绑定 ${input.target.tag}）：`,
  )
  for (const item of input.restoreCommands) lines.push(`[setup]   $ ${commandText(item)}`)
  return lines
}
