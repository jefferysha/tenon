import type {
  WbDocumentContract,
  WbFieldRef,
  WbSkillRef,
  WbStepDef,
  WbTrackBranch,
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

/** 列模型 → depends_on：同列并行、邻列串行。 */
export function setStepSkillWavesInDef(def: WbWorkflowDef, stepId: string, waves: readonly (readonly string[])[]): WbWorkflowDef {
  return mapStep(def, stepId, (step) => ({ ...step, skills: wavesToSkills(waves, step.skills) }))
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

/** 技能的轨道条件；undefined = 全部轨道。 */
export function addFieldOutputInDef(def: WbWorkflowDef, stepId: string, field: WbFieldRef): WbWorkflowDef {
  return mapStep(def, stepId, (step) => {
    if (step.outputs.some((output) => output.field === field.field)) return step
    const artifacts = field.type === 'file_path'
      ? [...(step.artifacts ?? []), { field: field.field, type: 'file_path' as const, producerPolicy: 'effective-step-skills' as const }]
      : step.artifacts
    return { ...step, outputs: [...step.outputs, { ...field }], ...(artifacts === undefined ? {} : { artifacts }) }
  })
}

export function removeFieldOutputInDef(def: WbWorkflowDef, stepId: string, field: string): WbWorkflowDef {
  const next = mapStep(def, stepId, (step) => {
    const artifacts = step.artifacts?.filter((artifact) => artifact.field !== field)
    const rest = { ...step, outputs: step.outputs.filter((output) => output.field !== field) }
    if (artifacts === undefined) return rest
    return artifacts.length === 0 && (step.artifacts?.length ?? 0) > 0 ? { ...rest, artifacts: [] } : { ...rest, artifacts }
  })
  // 下游把它当输入的声明一并撤掉，否则 kernel 会拒「inputs 不对应更早 step 的 outputs」。
  const index = next.steps.findIndex((step) => step.id === stepId)
  const stillProduced = next.steps.slice(0, index).some((step) => step.outputs.some((output) => output.field === field))
  if (stillProduced) return next
  return {
    ...next,
    steps: next.steps.map((step, position) => position <= index ? step : { ...step, inputs: step.inputs.filter((input) => input.field !== field) }),
  }
}

export function setFieldInputInDef(def: WbWorkflowDef, stepId: string, field: WbFieldRef, on: boolean): WbWorkflowDef {
  return mapStep(def, stepId, (step) => {
    const has = step.inputs.some((input) => input.field === field.field)
    if (on === has) return step
    return { ...step, inputs: on ? [...step.inputs, { ...field }] : step.inputs.filter((input) => input.field !== field.field) }
  })
}

function contractOf(def: WbWorkflowDef): WbDocumentContract {
  return def.documentContract ?? { version: 'v1', slots: [], reads: [] }
}

function withContract(def: WbWorkflowDef, contract: WbDocumentContract): WbWorkflowDef {
  if (contract.slots.length === 0 && contract.reads.length === 0) {
    const { documentContract: _dropped, ...rest } = def
    return rest
  }
  return { ...def, documentContract: contract }
}

/** 文档槽位归本阶段产出；producers 缺省取本阶段技能（无技能时留空，保存时 kernel 会要求非空）。 */
export function addDocumentSlotInDef(def: WbWorkflowDef, stepId: string, kind: string): WbWorkflowDef {
  if (def.openspecContract === 'required') return def
  const contract = contractOf(def)
  if (contract.slots.some((slot) => slot.kind === kind)) return def
  const step = def.steps.find((candidate) => candidate.id === stepId)
  const producers = step?.skills.map((skill) => skill.id) ?? []
  return withContract(def, { ...contract, slots: [...contract.slots, { kind, ownerStep: stepId, producers }] })
}

export function removeDocumentSlotInDef(def: WbWorkflowDef, kind: string): WbWorkflowDef {
  if (def.openspecContract === 'required') return def
  const contract = contractOf(def)
  return withContract(def, {
    ...contract,
    slots: contract.slots.filter((slot) => slot.kind !== kind),
    reads: contract.reads.map((read) => ({ ...read, kinds: read.kinds.filter((candidate) => candidate !== kind) })).filter((read) => read.kinds.length > 0),
  })
}

export function setDocumentReadInDef(def: WbWorkflowDef, stepId: string, kind: string, on: boolean): WbWorkflowDef {
  if (def.openspecContract === 'required') return def
  const contract = contractOf(def)
  const existing = contract.reads.find((read) => read.step === stepId)
  const kinds = new Set(existing?.kinds ?? [])
  if (on) kinds.add(kind); else kinds.delete(kind)
  const reads = contract.reads.filter((read) => read.step !== stepId)
  if (kinds.size > 0) reads.push({ step: stepId, kinds: [...kinds] })
  return withContract(def, { ...contract, reads })
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
 * 从 default 复制成自定义工作流：保住 OpenSpec 七阶段契约（openspec_contract: required），
 * artifact 的 producer policy 从 default 专用的 effective-phase-skills 改为 custom 契约允许的 effective-step-skills。
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
    openspecContract: 'required',
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
