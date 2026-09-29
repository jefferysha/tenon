import type { WbDocumentContract, WbStepDef, WbTransition, WbWorkflowDef } from '../api/governanceTypes'
import { pruneDanglingDocuments, withDocumentContract } from './documentContractEdits'
import { mapStep } from './workbenchStep'

/**
 * 退回目标：本阶段做完之后退回到前面某一步重做。正向去向不在这里——它由阶段顺序决定，
 * 拖拽排序时就已经定了，界面上不该再配一遍。
 *
 * 数据上「退回」就是一条 `to` 指向靠前阶段的 transition。改目标时保留原有 `event` / `guards` /
 * `actions`：`verify-fail` 带着 mark-verification-failed 与 reset-pre-verify-review，换个目标把它们
 * 丢了会静默改变运行时行为。新建时事件名合成为 `<stepId>-back`——受治理工作流的必需退回边删不掉
 * （lint 挡住），所以 `verify-fail` / `requirements-changed` 这些既有名字不会因为改设置而丢失。
 */
export function backTransitionOf(def: WbWorkflowDef, stepId: string): WbTransition | null {
  const index = def.steps.findIndex((step) => step.id === stepId)
  const step = def.steps[index]
  if (index < 0 || !step) return null
  const earlier = new Set(def.steps.slice(0, index).map((candidate) => candidate.id))
  return step.transitions.find((transition) => earlier.has(transition.to)) ?? null
}

export function backTargetOf(def: WbWorkflowDef, stepId: string): string | null {
  return backTransitionOf(def, stepId)?.to ?? null
}

/**
 * `template` 是上一次被「不退回」摘掉的那条边。重新选退回目标时把它整条装回来，只换 `to`——否则
 * 「不退回 → 再选回来」会把 `verify-fail` 变成 `verify-back`、连带丢掉 mark-verification-failed，
 * 而事件名是有语义的（document-record-policy 按 `requirements-changed` 判定 ADR 活文档兼容面）。
 */
export function setStageBackInDef(def: WbWorkflowDef, stepId: string, to: string | null, template?: WbTransition): WbWorkflowDef {
  const index = def.steps.findIndex((step) => step.id === stepId)
  if (index < 0) return def
  const earlier = new Set(def.steps.slice(0, index).map((candidate) => candidate.id))
  return mapStep(def, stepId, (step) => {
    const at = step.transitions.findIndex((transition) => earlier.has(transition.to))
    if (to === null) return at < 0 ? step : { ...step, transitions: step.transitions.filter((_, current) => current !== at) }
    if (at < 0) return { ...step, transitions: [...step.transitions, { ...(template ?? { event: `${stepId}-back` }), to }] }
    return { ...step, transitions: step.transitions.map((transition, current) => (current === at ? { ...transition, to } : transition)) }
  })
}

/** 变动前每个阶段「去下一阶段」的那条边（同一目标有多条时取第一条）。 */
function forwardTransitions(steps: readonly WbStepDef[]): Map<string, WbTransition> {
  const forward = new Map<string, WbTransition>()
  steps.forEach((step, index) => {
    const next = steps[index + 1]
    const transition = next === undefined ? undefined : step.transitions.find((candidate) => candidate.to === next.id)
    if (transition !== undefined) forward.set(step.id, transition)
  })
  return forward
}

/**
 * 顺序变了之后按新顺序重接转移（排序与删阶段共用），产出与 lint 的 `transition-not-next-or-back` 同一个不变式：
 *   · 正向边只有一条，由顺序决定：变动前那条去下一阶段的边改指新的下一阶段，event / guards / actions 不动；
 *     没有就合成 `<id>-complete`；末阶段没有正向边。
 *   · 其余边只能退回：`retarget` 之后目标仍在本阶段之前才保留（原样带着 event / guards / actions），
 *     变成往后跳、指向自己或指向不存在的阶段一律删掉——否则旧的退回边会悄悄变成第二条正向边。
 *   · 被 `retarget` 改了目标的边若与本阶段已有的边同目标，丢掉改出来的那条；原本就有的边不合并。
 */
function relinkTransitions(
  steps: readonly WbStepDef[],
  forward: ReadonlyMap<string, WbTransition>,
  retarget: (to: string) => string | null = (to) => to,
): WbStepDef[] {
  return steps.map((step, index) => {
    const next = steps[index + 1]
    const earlier = new Set(steps.slice(0, index).map((candidate) => candidate.id))
    const linear = forward.get(step.id)
    const untouched = new Set(step.transitions.filter((transition) => transition !== linear && retarget(transition.to) === transition.to).map((transition) => transition.to))
    const retargeted = new Set<string>()
    const transitions = step.transitions.flatMap((transition): WbTransition[] => {
      if (transition === linear) return next === undefined ? [] : [{ ...transition, to: next.id }]
      const to = retarget(transition.to)
      if (to === null || !earlier.has(to)) return []
      if (to === transition.to) return [transition]
      if (untouched.has(to) || retargeted.has(to)) return []
      retargeted.add(to)
      return [{ ...transition, to }]
    })
    if (next !== undefined && linear === undefined) transitions.push({ event: `${step.id}-complete`, to: next.id })
    return { ...step, transitions }
  })
}

export function reorderStagesInDef(def: WbWorkflowDef, fromId: string, toId: string, after: boolean): WbWorkflowDef {
  if (fromId === toId) return def
  const fromIndex = def.steps.findIndex((step) => step.id === fromId)
  const toIndex = def.steps.findIndex((step) => step.id === toId)
  if (fromIndex < 0 || toIndex < 0) return def

  const steps = [...def.steps]
  const moved = steps[fromIndex]
  if (!moved) return def
  steps.splice(fromIndex, 1)
  const anchor = steps.findIndex((step) => step.id === toId)
  steps.splice(after ? anchor + 1 : anchor, 0, moved)
  return { ...def, steps: relinkTransitions(steps, forwardTransitions(def.steps)) }
}

/**
 * 删阶段：指向它的退回边改指它原来的下一阶段（仍在来源阶段之前才留下），其余按 relinkTransitions 重接——
 * 它前一个阶段的正向边接到新的下一阶段。
 */
export function removeStageFromDef(def: WbWorkflowDef, stepId: string): WbWorkflowDef {
  const index = def.steps.findIndex((step) => step.id === stepId)
  if (index < 0) return def
  const successor = def.steps[index + 1]?.id ?? null
  const steps = relinkTransitions(
    def.steps.filter((step) => step.id !== stepId),
    forwardTransitions(def.steps),
    (to) => (to === stepId ? successor : to),
  )
  const base = { ...def, steps }
  if (def.documentContract === undefined) return base
  const contract: WbDocumentContract = {
    ...def.documentContract,
    slots: def.documentContract.slots.filter((slot) => slot.ownerStep !== stepId),
    reads: def.documentContract.reads.filter((read) => read.step !== stepId),
  }
  return withDocumentContract(base, pruneDanglingDocuments(steps, contract))
}

/**
 * 排序 / 删阶段丢掉的退回边：变动前有退回边、变动后没有的阶段 → 变动前那条。编辑器把它记进「不退回」的同一份
 * 记忆，重新选退回目标时整条装回来——拖走再拖回不会把 `verify-fail` 降成合成的 `verify-back`、丢掉 actions。
 */
export function displacedBackTransitions(before: WbWorkflowDef, after: WbWorkflowDef): Map<string, WbTransition> {
  const displaced = new Map<string, WbTransition>()
  for (const step of after.steps) {
    const previous = backTransitionOf(before, step.id)
    if (previous !== null && backTransitionOf(after, step.id) === null) displaced.set(step.id, previous)
  }
  return displaced
}

