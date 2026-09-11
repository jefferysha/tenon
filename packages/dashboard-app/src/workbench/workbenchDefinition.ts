import type {
  WbDocumentContract,
  WbSkillRef,
  WbStepDef,
  WbTrackBranch,
  WbTransition,
  WbWorkflowDef,
} from '../api/governanceTypes'
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
  return def?.tracks?.[branch] !== undefined ? branch : tracks[0]![0]
}

/** 分支视图：把所选分支的 steps 与物化 IO 提升成一个「单条 pipeline」定义，供编辑器所有读路径使用。 */
export function selectBranchDef(def: WbWorkflowDef, branch: string): WbWorkflowDef {
  const { tracks: _tracks, branches, effectiveIo, ...rest } = def
  const id = resolveBranch(def, branch)
  const track = id === BASE_BRANCH ? undefined : def.tracks?.[id]
  const io = branches?.[id === BASE_BRANCH ? '_base' : id]?.effectiveIo ?? (id === BASE_BRANCH ? effectiveIo : undefined)
  return {
    ...rest,
    ...(io === undefined ? {} : { effectiveIo: io }),
    steps: track === undefined ? def.steps : track.steps,
  }
}

/** 把分支视图上的编辑写回完整定义：steps 回到对应分支，其余工作流级字段（文档契约等）照抄更新后的值。 */
export function writeBranchDef(def: WbWorkflowDef, branch: string, updated: WbWorkflowDef): WbWorkflowDef {
  const { steps, tracks: _tracks, effectiveIo: _io, branches: _branches, ...rest } = updated
  const base = { ...def, ...rest }
  const id = resolveBranch(def, branch)
  if (id === BASE_BRANCH) return { ...base, steps }
  return { ...base, steps: def.steps, tracks: { ...def.tracks, [id]: { ...def.tracks![id]!, steps } } }
}

/**
 * 新建轨道分支 = 复制 `from` 分支的 steps（深拷贝）。工作流原本没有 tracks 时，它的单条 pipeline 搬进第一条
 * track（id `main`），顶层 steps 清空（steps ⊕ tracks）。
 */
export function addTrackBranch(def: WbWorkflowDef, id: string, label: string, from: string = BASE_BRANCH): WbWorkflowDef {
  const branch: WbTrackBranch = { ...(label === '' ? {} : { label }), steps: cloneSteps(selectBranchDef(def, from).steps) }
  if (trackEntries(def).length === 0) {
    if (def.steps.length === 0) return { ...def, steps: [], tracks: { [id]: branch } }
    const firstId = id === 'main' ? 'base' : 'main'
    return { ...def, steps: [], tracks: { [firstId]: { steps: cloneSteps(def.steps) }, [id]: branch } }
  }
  return { ...def, tracks: { ...(def.tracks ?? {}), [id]: branch } }
}

/** 删除轨道分支；删到最后一条时它的 steps 回到顶层，工作流重新成为单条 pipeline。 */
export function removeTrackBranch(def: WbWorkflowDef, id: string): WbWorkflowDef {
  const { [id]: removed, ...rest } = def.tracks ?? {}
  if (removed === undefined) return def
  const { tracks: _tracks, ...withoutTracks } = def
  if (Object.keys(rest).length === 0) return { ...withoutTracks, steps: removed.steps }
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

function withContract(def: WbWorkflowDef, contract: WbDocumentContract): WbWorkflowDef {
  if (contract.slots.length === 0 && contract.reads.length === 0) {
    const { documentContract: _dropped, ...rest } = def
    return rest
  }
  return { ...def, documentContract: contract }
}

export function reorderStagesInDef(def: WbWorkflowDef, fromId: string, toId: string, after: boolean): WbWorkflowDef {
  if (fromId === toId) return def
  const fromIndex = def.steps.findIndex((step) => step.id === fromId)
  const toIndex = def.steps.findIndex((step) => step.id === toId)
  if (fromIndex < 0 || toIndex < 0) return def

  const linearTransitionIndex = new Map<string, number>()
  def.steps.forEach((step, index) => {
    const next = def.steps[index + 1]
    if (!next) return
    const transitionIndex = step.transitions.findIndex((transition) => transition.to === next.id)
    if (transitionIndex >= 0) linearTransitionIndex.set(step.id, transitionIndex)
  })
  const steps = [...def.steps]
  const moved = steps[fromIndex]
  if (!moved) return def
  steps.splice(fromIndex, 1)
  const anchor = steps.findIndex((step) => step.id === toId)
  steps.splice(after ? anchor + 1 : anchor, 0, moved)
  return {
    ...def,
    steps: steps.map((step, index) => {
      const next = steps[index + 1]
      const transitionIndex = linearTransitionIndex.get(step.id)
      if (transitionIndex === undefined) {
        return next
          ? { ...step, transitions: [...step.transitions, { event: `${step.id}-complete`, to: next.id }] }
          : step
      }
      if (!next) return { ...step, transitions: step.transitions.filter((_, current) => current !== transitionIndex) }
      return {
        ...step,
        transitions: step.transitions.map((transition, current) => (
          current === transitionIndex ? { ...transition, to: next.id } : transition
        )),
      }
    }),
  }
}

export function removeStageFromDef(def: WbWorkflowDef, stepId: string): WbWorkflowDef {
  const index = def.steps.findIndex((step) => step.id === stepId)
  const victim = def.steps[index]
  if (index < 0 || !victim) return def
  const next = def.steps[index + 1]
  const successor = next && victim.transitions.some((transition) => transition.to === next.id) ? next.id : null
  const contract = def.documentContract === undefined ? undefined : {
    ...def.documentContract,
    slots: def.documentContract.slots.filter((slot) => slot.ownerStep !== stepId),
    reads: def.documentContract.reads.filter((read) => read.step !== stepId),
  }
  const base = {
    ...def,
    steps: def.steps.filter((step) => step.id !== stepId).map((step) => ({
      ...step,
      transitions: step.transitions.flatMap((transition) => {
        if (transition.to !== stepId) return [transition]
        return successor === null || successor === step.id ? [] : [{ ...transition, to: successor }]
      }),
    })),
  }
  return contract === undefined ? base : withContract(base, contract)
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
    ...(def.tracks === undefined ? {} : { tracks: Object.fromEntries(Object.entries(def.tracks).map(([id, branch]) => [id, { ...branch, steps: cloneSteps(branch.steps) }])) }),
    decomposition: def.decomposition === undefined ? undefined : {
      ...def.decomposition,
      auto_when: [...def.decomposition.auto_when],
      ask_when: [...def.decomposition.ask_when],
    },
    interaction: def.interaction === undefined ? undefined : { ...def.interaction },
    reviewBudget: def.reviewBudget === undefined ? undefined : { ...def.reviewBudget },
    documentContract: def.documentContract === undefined ? undefined : {
      version: 'v1',
      slots: def.documentContract.slots.map((slot) => ({ ...slot, producers: [...slot.producers] })),
      reads: def.documentContract.reads.map((read) => ({ ...read, kinds: [...read.kinds] })),
    },
    steps: cloneSteps(def.steps),
  }
}

/**
 * 从 default 复制成自定义工作流：artifact 的 producer policy 从 default 专用的 effective-phase-skills
 * 改为 custom 契约允许的 effective-step-skills。
 *
 * **不写 `openspec_contract: required`。** default 受治理靠的是名字（kernel 的 document-contract 对
 * `name === 'default'` 直接套 OpenSpec 文档契约），它的 YAML 里从来没有这一行，`validateOpenSpecContractWorkflow`
 * 也从不对它跑。而 default 的 chat 轨是**有意**只声明 tenon-* 驱动的（见 kernel spec：chat is the
 * drivers-only flow），并不满足该契约的技能清单。曾经在复制时补盖这一行，等于替源定义断言了一件它自己
 * 做不到的事——校验第一次真跑就把复制挡在 400：`tracks.chat: openspec_contract: required 要求 'open'
 * 声明 OpenSpec proposal skill`。副本不再是 default，也就不再按名字受治理；要 OpenSpec 治理就自己在
 * YAML 里写 `openspec_contract: required` 并补齐各轨技能。
 */
export function copyWorkflowDef(def: WbWorkflowDef, name: string): WbWorkflowDef {
  const cloned = cloneWorkflowDef(def, name)
  if (def.name !== 'default') return cloned
  const customPolicy = (steps: WbStepDef[]): WbStepDef[] => steps.map((step) => step.artifacts === undefined ? step : {
    ...step,
    artifacts: step.artifacts.map((artifact) => ({ ...artifact, producerPolicy: 'effective-step-skills' as const })),
  })
  return {
    ...cloned,
    steps: customPolicy(cloned.steps),
    ...(cloned.tracks === undefined ? {} : { tracks: Object.fromEntries(Object.entries(cloned.tracks).map(([id, branch]) => [id, { ...branch, steps: customPolicy(branch.steps) }])) }),
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
