import {
  DOCUMENT_KIND_CATALOG,
  DOCUMENT_KINDS,
  isDocumentKind,
  type DocumentKind,
} from '@tenon/kernel/workflow/document-contract-model'
import type { WbDocumentContract, WbStepDef, WbWorkflowDef } from '../api/governanceTypes'
import { skillsEquivalent } from '../workflow/producers'
import { wavesOf, wavesToSkills } from './skillWaves'

/**
 * 分支视图上的文档契约编辑（纯函数）：视图 = selectBranchDef 提升后的单条 pipeline，契约在 `documentContract`。
 * 规则与 kernel validateDocumentContract 对齐：每类文档一条 produce，update / require / reads 只能在它之后。
 */

type Slot = WbDocumentContract['slots'][number]

const EMPTY: WbDocumentContract = { version: 'v1', slots: [], reads: [] }

function contractOf(view: WbWorkflowDef): WbDocumentContract {
  return view.documentContract ?? EMPTY
}

function indexOf(steps: readonly WbStepDef[], stepId: string): number {
  return steps.findIndex((step) => step.id === stepId)
}

function isProjectKind(kind: string): boolean {
  return isDocumentKind(kind) && DOCUMENT_KIND_CATALOG[kind].scope === 'project'
}

function stageSkillsOf(steps: readonly WbStepDef[], stepId: string): string[] {
  return steps.find((step) => step.id === stepId)?.skills.map((skill) => skill.id) ?? []
}

/** 没有 slot 的契约不写（YAML 要求非空 slots）。 */
export function withDocumentContract(view: WbWorkflowDef, contract: WbDocumentContract): WbWorkflowDef {
  if (contract.slots.length === 0) {
    const { documentContract: _dropped, ...rest } = view
    return rest
  }
  return { ...view, documentContract: contract }
}

export function cloneDocumentContract(contract: WbDocumentContract): WbDocumentContract {
  return {
    version: 'v1',
    slots: contract.slots.map((slot) => ({ ...slot, producers: [...slot.producers] })),
    reads: contract.reads.map((read) => ({ ...read, kinds: [...read.kinds] })),
  }
}

/** 删掉悬空项：项目外文档的 update / require 需要更早的 produce；reads 需要更早的 produce / update。 */
export function pruneDanglingDocuments(steps: readonly WbStepDef[], contract: WbDocumentContract): WbDocumentContract {
  const slots = contract.slots.filter((slot) => {
    if (slot.role === undefined || isProjectKind(slot.kind)) return true
    const produce = contract.slots.find((candidate) => candidate.kind === slot.kind && candidate.role === undefined)
    return produce !== undefined && indexOf(steps, produce.ownerStep) < indexOf(steps, slot.ownerStep)
  })
  const reads = contract.reads.flatMap((read) => {
    const kinds = read.kinds.filter((kind) => slots.some((slot) =>
      slot.kind === kind && slot.role !== 'require' && indexOf(steps, slot.ownerStep) < indexOf(steps, read.step)))
    return kinds.length === 0 ? [] : [{ ...read, kinds }]
  })
  return { ...contract, slots, reads }
}

/** 复制 default：producers 裁剪到本阶段技能，没有 producer 的 produce / update 删掉，再删悬空项。 */
export function pruneContractForSteps(steps: readonly WbStepDef[], contract: WbDocumentContract | undefined): WbDocumentContract | undefined {
  if (contract === undefined) return undefined
  const slots = contract.slots.flatMap((slot): Slot[] => {
    if (slot.role === 'require') return [slot]
    const skills = stageSkillsOf(steps, slot.ownerStep)
    const producers = slot.producers.filter((producer) => skills.some((skill) => skillsEquivalent(skill, producer)))
    return producers.length === 0 ? [] : [{ ...slot, producers }]
  })
  const pruned = pruneDanglingDocuments(steps, { ...contract, slots })
  return pruned.slots.length === 0 ? undefined : pruned
}

/** OpenSpec 开关：关闭时删掉开关与每条分支的文档契约。 */
export function setOpenspecInDef(def: WbWorkflowDef, on: boolean): WbWorkflowDef {
  if (on) return { ...def, openspec: true }
  const { openspec: _openspec, documentContract: _contract, ...rest } = def
  if (rest.tracks === undefined) return rest
  return {
    ...rest,
    tracks: Object.fromEntries(Object.entries(rest.tracks).map(([id, branch]) => {
      const { documentContract: _branchContract, ...plain } = branch
      return [id, plain]
    })),
  }
}

/** 本分支某个技能能产出、本阶段还没声明、也不会在更晚阶段首次产出的文档类型。 */
export function documentKindsForOutput(view: WbWorkflowDef, stepId: string): DocumentKind[] {
  const index = indexOf(view.steps, stepId)
  if (index < 0) return []
  const branchSkills = view.steps.flatMap((step) => step.skills.map((skill) => skill.id))
  const slots = contractOf(view).slots
  return DOCUMENT_KINDS.filter((kind) => {
    if (!DOCUMENT_KIND_CATALOG[kind].producers.some((producer) => branchSkills.some((skill) => skillsEquivalent(skill, producer)))) return false
    if (slots.some((slot) => slot.kind === kind && slot.ownerStep === stepId)) return false
    const produce = slots.find((slot) => slot.kind === kind && slot.role === undefined)
    return produce === undefined || indexOf(view.steps, produce.ownerStep) < index
  })
}

function appendSkill(view: WbWorkflowDef, stepId: string, skillId: string): WbWorkflowDef {
  return {
    ...view,
    steps: view.steps.map((step) => step.id !== stepId || step.skills.some((skill) => skill.id === skillId)
      ? step
      : { ...step, skills: wavesToSkills([...wavesOf(step.skills), [skillId]], step.skills) }),
  }
}

/**
 * 加一条输出：分支里还没有 produce → produce，否则 update。producers = 目录候选 ∩ 本阶段技能；
 * 本阶段没有时把分支里已有的第一个候选技能加进本阶段（技能编排里可移除）。
 */
export function addDocumentOutputInDef(view: WbWorkflowDef, stepId: string, kind: DocumentKind): WbWorkflowDef {
  if (!documentKindsForOutput(view, stepId).includes(kind)) return view
  const candidates = DOCUMENT_KIND_CATALOG[kind].producers
  const matches = (skill: string): boolean => candidates.some((candidate) => skillsEquivalent(skill, candidate))
  let producers = stageSkillsOf(view.steps, stepId).filter(matches)
  let next = view
  if (producers.length === 0) {
    const suggested = view.steps.flatMap((step) => step.skills.map((skill) => skill.id)).find(matches)
    if (suggested === undefined) return view
    next = appendSkill(view, stepId, suggested)
    producers = [suggested]
  }
  const contract = contractOf(next)
  const produced = contract.slots.some((slot) => slot.kind === kind && slot.role === undefined)
  const slot: Slot = produced ? { kind, ownerStep: stepId, role: 'update', producers } : { kind, ownerStep: stepId, producers }
  return withDocumentContract(next, { ...contract, slots: [...contract.slots, slot] })
}

/** 移除本阶段的一条文档槽位（输出侧 produce / update；输入侧 reads / require），连带删掉悬空项。 */
export function removeDocumentSlotInDef(view: WbWorkflowDef, stepId: string, kind: string, direction: 'inputs' | 'outputs'): WbWorkflowDef {
  const contract = contractOf(view)
  const own = (slot: Slot): boolean => slot.kind === kind && slot.ownerStep === stepId
  const next: WbDocumentContract = direction === 'outputs'
    ? { ...contract, slots: contract.slots.filter((slot) => !(own(slot) && slot.role !== 'require')) }
    : {
        ...contract,
        slots: contract.slots.filter((slot) => !(own(slot) && slot.role === 'require')),
        reads: contract.reads.flatMap((read) => {
          if (read.step !== stepId) return [read]
          const kinds = read.kinds.filter((candidate) => candidate !== kind)
          return kinds.length === 0 ? [] : [{ ...read, kinds }]
        }),
      }
  return withDocumentContract(view, pruneDanglingDocuments(view.steps, next))
}

/** 输入候选：更早阶段 produce / update 的文档（来源 = 最近的一步），加上没有更早来源的项目文档（fromStep 为 null）。 */
export function documentInputCandidates(view: WbWorkflowDef, stepId: string): Array<{ kind: string; fromStep: string | null }> {
  const index = indexOf(view.steps, stepId)
  if (index < 0) return []
  const slots = contractOf(view).slots
  const sources = new Map<string, string | null>()
  for (const step of view.steps.slice(0, index)) {
    for (const slot of slots) {
      if (slot.ownerStep === step.id && slot.role !== 'require') sources.set(slot.kind, step.id)
    }
  }
  for (const kind of DOCUMENT_KINDS) {
    if (isProjectKind(kind) && !sources.has(kind)) sources.set(kind, null)
  }
  return [...sources].map(([kind, fromStep]) => ({ kind, fromStep }))
}

/** 勾选的输入：有更早来源的写进 reads[stepId]；没有来源的项目文档写成本阶段的 require。 */
export function setDocumentInputsInDef(view: WbWorkflowDef, stepId: string, kinds: readonly string[]): WbWorkflowDef {
  const contract = contractOf(view)
  const chosen = documentInputCandidates(view, stepId).filter((candidate) => kinds.includes(candidate.kind))
  const readKinds = chosen.filter((candidate) => candidate.fromStep !== null).map((candidate) => candidate.kind)
  const requireKinds = chosen
    .filter((candidate) => candidate.fromStep === null)
    .map((candidate) => candidate.kind)
    .filter((kind) => !contract.slots.some((slot) => slot.kind === kind && slot.ownerStep === stepId && slot.role !== 'require'))
  const slots: Slot[] = [
    ...contract.slots.filter((slot) => !(slot.ownerStep === stepId && slot.role === 'require')),
    ...requireKinds.map((kind): Slot => ({ kind, ownerStep: stepId, role: 'require', producers: [] })),
  ]
  const reads = [
    ...contract.reads.filter((read) => read.step !== stepId),
    ...(readKinds.length === 0 ? [] : [{ step: stepId, kinds: readKinds }]),
  ]
  return withDocumentContract(view, { ...contract, slots, reads })
}
