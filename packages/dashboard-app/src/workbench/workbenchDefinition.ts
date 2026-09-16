import type {
  WbDocumentContract,
  WbSkillRef,
  WbStepDef,
  WbTrackBranch,
  WbTransition,
  WbWorkflowDef,
} from '../api/governanceTypes'
import { isDefaultWorkflowName } from '@tenon/kernel/workflow/identifier'
import { cloneDocumentContract, pruneContractForSteps, pruneDanglingDocuments, withDocumentContract } from './documentContractEdits'
import { wavesOf, wavesToSkills } from './skillWaves'
export type {
  WbActionConfig,
  WbArtifactConfig,
  WbDocumentContract,
  WbFieldRef,
  WbGuardConfig,
  WbSkillRef,
  WbStepDef,
  WbTrackPredicate,
  WbTransition,
  WbWorkflowDef,
  WbDecompositionAskWhen,
  WbDecompositionAutoWhen,
  WbDecompositionMode,
  WbDecompositionPolicy,
  WbDecompositionStrategy,
  WbDecompositionTarget,
  WbInteractionMode,
  WbInteractionPolicy,
  WbReviewBudgetPolicy,
} from '../api/governanceTypes'

/**
 * 工作流定义的纯变换：所有编辑器动作都落到这里，返回新对象，不改入参。
 * 定义 = 服务端读回的 WbWorkflowDef（default 亦然）；前端不再持有任何内建副本。
 */

function mapStep(def: WbWorkflowDef, stepId: string, update: (step: WbStepDef) => WbStepDef): WbWorkflowDef {
  let changed = false
  const steps = def.steps.map((step) => {
    if (step.id !== stepId) return step
    const next = update(step)
    if (next !== step) changed = true
    return next
  })
  return changed ? { ...def, steps } : def
}

/** 写回前剔除读接口附带的投影字段。 */
export function definitionForWrite(def: WbWorkflowDef): Omit<WbWorkflowDef, 'source' | 'effectiveIo' | 'branches'> {
  const { source: _source, effectiveIo: _effectiveIo, branches: _branches, ...definition } = def
  return definition
}

// ── 分支：有 tracks → 每条 track 一个分支（steps ⊕ tracks，顶层 steps 为空）；无 tracks → 单条 pipeline（id ''）──

export const BASE_BRANCH = ''

function trackEntries(def: WbWorkflowDef | null): Array<[string, WbTrackBranch]> {
  return Object.entries(def?.tracks ?? {})
}

/** 分支列表：有 tracks 时按声明序列出每条 track（名称 = label ?? id）；否则只有单条 pipeline。 */
export function branchesOf(def: WbWorkflowDef | null): Array<{ id: string; label: string | null }> {
  const tracks = trackEntries(def)
  if (tracks.length === 0) return [{ id: BASE_BRANCH, label: null }]
  return tracks.map(([id, branch]) => ({ id, label: branch.label ?? id }))
}

/** 有效分支 id：请求的分支不存在时退到第一条 track（无 tracks → ''）。 */
export function resolveBranch(def: WbWorkflowDef | null, branch: string): string {
  const tracks = trackEntries(def)
  if (tracks.length === 0) return BASE_BRANCH
  const first = tracks[0]
  return def?.tracks?.[branch] !== undefined ? branch : first?.[0] ?? BASE_BRANCH
}

/** 分支视图：把所选分支的 steps、文档契约与物化 IO 提升成一个「单条 pipeline」定义，供编辑器所有读路径使用。 */
export function selectBranchDef(def: WbWorkflowDef, branch: string): WbWorkflowDef {
  const { tracks: _tracks, branches, effectiveIo, documentContract, ...rest } = def
  const id = resolveBranch(def, branch)
  const track = id === BASE_BRANCH ? undefined : def.tracks?.[id]
  const io = branches?.[id === BASE_BRANCH ? '_base' : id]?.effectiveIo ?? (id === BASE_BRANCH ? effectiveIo : undefined)
  const contract = track === undefined ? documentContract : track.documentContract
  return {
    ...rest,
    ...(io === undefined ? {} : { effectiveIo: io }),
    ...(contract === undefined ? {} : { documentContract: contract }),
    steps: track === undefined ? def.steps : track.steps,
  }
}

/** 把分支视图上的编辑写回完整定义：steps 与文档契约回到对应分支，其余工作流级字段照抄更新后的值。 */
export function writeBranchDef(def: WbWorkflowDef, branch: string, updated: WbWorkflowDef): WbWorkflowDef {
  const { steps, tracks: _tracks, effectiveIo: _io, branches: _branches, documentContract, ...rest } = updated
  const contract = documentContract === undefined ? {} : { documentContract }
  const id = resolveBranch(def, branch)
  if (id === BASE_BRANCH) {
    const { documentContract: _previous, ...base } = { ...def, ...rest }
    return { ...base, ...contract, steps }
  }
  const existing = def.tracks?.[id]
  if (existing === undefined) return def
  const { documentContract: _previousBranch, ...branchRest } = existing
  return { ...def, ...rest, steps: def.steps, tracks: { ...def.tracks, [id]: { ...branchRest, ...contract, steps } } }
}

/**
 * 新建轨道分支 = 复制 `from` 分支的 steps（深拷贝）。工作流原本没有 tracks 时，它的单条 pipeline 搬进第一条
 * track（id `main`），顶层 steps 清空（steps ⊕ tracks）。
 */
export function addTrackBranch(def: WbWorkflowDef, id: string, label: string, from: string = BASE_BRANCH): WbWorkflowDef {
  const source = selectBranchDef(def, from)
  const branch: WbTrackBranch = {
    ...(label === '' ? {} : { label }),
    ...(source.documentContract === undefined ? {} : { documentContract: cloneDocumentContract(source.documentContract) }),
    steps: cloneSteps(source.steps),
  }
  if (trackEntries(def).length === 0) {
    const { documentContract: topContract, ...single } = def
    if (def.steps.length === 0) return { ...single, steps: [], tracks: { [id]: branch } }
    const firstId = id === 'main' ? 'base' : 'main'
    const first: WbTrackBranch = { ...(topContract === undefined ? {} : { documentContract: cloneDocumentContract(topContract) }), steps: cloneSteps(def.steps) }
    return { ...single, steps: [], tracks: { [firstId]: first, [id]: branch } }
  }
  return { ...def, tracks: { ...(def.tracks ?? {}), [id]: branch } }
}

/** 删除轨道分支；删到最后一条时它的 steps 与文档契约回到顶层，工作流重新成为单条 pipeline。 */
export function removeTrackBranch(def: WbWorkflowDef, id: string): WbWorkflowDef {
  const { [id]: removed, ...rest } = def.tracks ?? {}
  if (removed === undefined) return def
  const { tracks: _tracks, ...withoutTracks } = def
  if (Object.keys(rest).length === 0) {
    return { ...withoutTracks, ...(removed.documentContract === undefined ? {} : { documentContract: removed.documentContract }), steps: removed.steps }
  }
  return { ...def, tracks: rest }
}

export function renameStepInDef(def: WbWorkflowDef, stepId: string, label: string): WbWorkflowDef {
  return mapStep(def, stepId, (step) => ({ ...step, label }))
}

export function setGateInDef(def: WbWorkflowDef, stepId: string, gate: WbStepDef['gate']): WbWorkflowDef {
  return mapStep(def, stepId, (step) => ({ ...step, gate }))
}

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

/** 列模型 → depends_on：同列并行、邻列串行。 */
export function setStepSkillWavesInDef(def: WbWorkflowDef, stepId: string, waves: readonly (readonly string[])[]): WbWorkflowDef {
  return mapStep(def, stepId, (step) => ({ ...step, skills: wavesToSkills(waves, step.skills) }))
}

/** 整体替换阶段技能（含 depends_on）；来自技能画布。 */
export function setStepSkillsInDef(def: WbWorkflowDef, stepId: string, skills: readonly WbSkillRef[]): WbWorkflowDef {
  return mapStep(def, stepId, (step) => ({ ...step, skills: [...skills] }))
}

/** 追加技能：缺省成为新的末列（串行接在最后）。 */
export function addSkillToDef(def: WbWorkflowDef, stepId: string, skillId: string): WbWorkflowDef {
  const step = def.steps.find((candidate) => candidate.id === stepId)
  if (!step || step.skills.some((skill) => skill.id === skillId)) return def
  const waves = wavesOf(step.skills)
  return setStepSkillWavesInDef(def, stepId, [...waves, [skillId]])
}

export function removeSkillFromDef(def: WbWorkflowDef, stepId: string, skillId: string): WbWorkflowDef {
  const step = def.steps.find((candidate) => candidate.id === stepId)
  if (!step?.skills.some((skill) => skill.id === skillId)) return def
  const waves = wavesOf(step.skills).map((wave) => wave.filter((id) => id !== skillId)).filter((wave) => wave.length > 0)
  return setStepSkillWavesInDef(def, stepId, waves)
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

function cloneSteps(steps: readonly WbStepDef[]): WbStepDef[] {
  return steps.map((step) => ({
    ...step,
    reviewLanes: step.reviewLanes === undefined ? undefined : [...step.reviewLanes],
    skills: step.skills.map((skill) => ({
      ...skill,
      depends_on: skill.depends_on ? [...skill.depends_on] : undefined,
    })),
    inputs: step.inputs.map((field) => ({ ...field })),
    outputs: step.outputs.map((field) => ({ ...field })),
    artifacts: step.artifacts === undefined ? undefined : step.artifacts.map((artifact) => ({ ...artifact })),
    guards: step.guards.map((guard) => ({ ...guard })),
    transitions: step.transitions.map((transition) => ({ ...transition })),
  }))
}

export function cloneWorkflowDef(def: WbWorkflowDef, name: string): WbWorkflowDef {
  const { source: _source, effectiveIo: _effectiveIo, branches: _branches, ...rest } = def
  return {
    ...rest,
    name,
    ...(def.tracks === undefined ? {} : {
      tracks: Object.fromEntries(Object.entries(def.tracks).map(([id, branch]) => [id, {
        ...branch,
        ...(branch.documentContract === undefined ? {} : { documentContract: cloneDocumentContract(branch.documentContract) }),
        steps: cloneSteps(branch.steps),
      }])),
    }),
    decomposition: def.decomposition === undefined ? undefined : {
      ...def.decomposition,
      auto_when: [...def.decomposition.auto_when],
      ask_when: [...def.decomposition.ask_when],
    },
    interaction: def.interaction === undefined ? undefined : { ...def.interaction },
    reviewBudget: def.reviewBudget === undefined ? undefined : { ...def.reviewBudget },
    documentContract: def.documentContract === undefined ? undefined : cloneDocumentContract(def.documentContract),
    steps: cloneSteps(def.steps),
  }
}

/**
 * 从 default 复制成自定义工作流：artifact 的 producer policy 从 default 专用的 effective-phase-skills
 * 改为 custom 契约允许的 effective-step-skills；每条分支的文档契约按阶段技能裁剪（default 的技能矩阵由
 * manifest 叠加、chat 轨只有驱动技能，副本按自定义规则校验 producer 必须是本阶段技能）。
 */
export function copyWorkflowDef(def: WbWorkflowDef, name: string): WbWorkflowDef {
  const cloned = cloneWorkflowDef(def, name)
  if (!isDefaultWorkflowName(def.name)) return cloned
  const customPolicy = (steps: WbStepDef[]): WbStepDef[] => steps.map((step) => step.artifacts === undefined ? step : {
    ...step,
    artifacts: step.artifacts.map((artifact) => ({ ...artifact, producerPolicy: 'effective-step-skills' as const })),
  })
  const { documentContract: _topContract, ...single } = cloned
  const topContract = pruneContractForSteps(cloned.steps, cloned.documentContract)
  return {
    ...single,
    ...(topContract === undefined ? {} : { documentContract: topContract }),
    steps: customPolicy(cloned.steps),
    ...(cloned.tracks === undefined ? {} : {
      tracks: Object.fromEntries(Object.entries(cloned.tracks).map(([id, branch]) => {
        const { documentContract: branchContract, ...plain } = branch
        const pruned = pruneContractForSteps(branch.steps, branchContract)
        return [id, { ...plain, ...(pruned === undefined ? {} : { documentContract: pruned }), steps: customPolicy(branch.steps) }]
      })),
    }),
  }
}

/** 空白工作流：一个阶段、无技能、无输出（编辑器会以「缺产出」提示补齐）。 */
export function blankWorkflow(name: string, stageLabel: string): WbWorkflowDef {
  return {
    name,
    steps: [{ id: 'stage-1', label: stageLabel, gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] }],
  }
}

/** 从 YAML 原文里取 `name:`（导入对话框预填名字用；服务端才是真正的解析器）。 */
export function workflowNameFromYaml(text: string): string {
  const match = /^name:\s*(\S+)\s*$/m.exec(text)
  return match?.[1] ?? ''
}

export function skillIdsOf(step: Pick<WbStepDef, 'skills'>): string[] {
  return step.skills.map((skill) => skill.id)
}

export type { WbSkillRef as SkillRefLike }
