import { changeWorkflowName } from '../model/progressModel'
import {
  EVENT_BY_EDGE,
  PHASES,
  REVIEW_PHASES,
  TRANSITIONS,
  type Snapshot,
} from '../types'
import type {
  WbSkillRef,
  WbStepDef,
  WbWorkflowDef,
} from '../api/governanceTypes'
import {
  DEFAULT_WB_DECOMPOSITION_POLICY,
  DEFAULT_WB_INTERACTION_POLICY,
  DEFAULT_WB_REVIEW_BUDGET_POLICY,
} from '../api/governanceTypes'
import type { LanePatch } from './boardLane'
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

export function editLaneInDef(
  def: WbWorkflowDef,
  laneId: string,
  patch: LanePatch,
): WbWorkflowDef {
  return {
    ...def,
    steps: def.steps.map((step) => {
      if (step.id !== laneId) return step
      const updated: WbStepDef = { ...step }
      if (patch.label !== undefined) updated.label = patch.label
      if (patch.gate !== undefined) updated.gate = patch.gate
      if (patch.outputs !== undefined) {
        const outputsByField = new Map(step.outputs.map((output) => [output.field, output]))
        updated.outputs = patch.outputs.map(
          (field) => outputsByField.get(field) ?? { field, type: 'string' as const },
        )
      }
      return updated
    }),
  }
}

const GOVERNED_PHASE_SKILLS: Readonly<Record<string, readonly string[]>> = {
  open: ['tenon-open', 'openspec-propose'],
  explore: ['tenon-explore', 'brainstorming'],
  spec: ['tenon-spec', 'openspec-propose', 'writing-plans'],
  build: ['tenon-build'],
  verify: ['tenon-verify', 'verification-before-completion'],
  ship: ['tenon-ship', 'openspec-apply-change'],
  archive: ['tenon-archive'],
}

export function buildDefaultDef(labels: Partial<Record<(typeof PHASES)[number], string>> = {}): WbWorkflowDef {
  const shape: Record<(typeof PHASES)[number], Pick<WbStepDef, 'label' | 'inputs' | 'outputs' | 'artifacts' | 'guards'>> = {
    open: { label: '立项', inputs: [], outputs: [], guards: [] },
    explore: {
      label: '调研',
      inputs: [],
      outputs: [{ field: 'design_doc', type: 'file_path' }],
      artifacts: [{ field: 'design_doc', type: 'file_path', producerPolicy: 'effective-phase-skills' }],
      guards: [],
    },
    spec: {
      label: '规格',
      inputs: [{ field: 'design_doc', type: 'file_path' }],
      outputs: [{ field: 'plan', type: 'file_path' }],
      artifacts: [{
        field: 'plan',
        type: 'file_path',
        producerPolicy: 'effective-phase-skills',
        requiredWhen: { kind: 'track-not-in', values: ['pm'] },
      }],
      guards: [{ type: 'tasks-at-least', n: 3 }],
    },
    build: {
      label: '实现',
      inputs: [{ field: 'design_doc', type: 'file_path' }, { field: 'plan', type: 'file_path' }],
      outputs: [{ field: 'build_sha', type: 'string' }],
      guards: [],
    },
    verify: {
      label: '验证',
      inputs: [{ field: 'build_sha', type: 'string' }],
      outputs: [{ field: 'verification_report', type: 'file_path' }],
      artifacts: [{ field: 'verification_report', type: 'file_path', producerPolicy: 'effective-phase-skills' }],
      guards: [],
    },
    ship: { label: '交付', inputs: [], outputs: [], guards: [] },
    archive: { label: '归档', inputs: [], outputs: [], guards: [] },
  }
  for (const phase of PHASES) {
    shape[phase] = { ...shape[phase], label: labels[phase] ?? shape[phase].label }
  }
  return {
    name: 'default',
    openspecContract: 'required',
    decomposition: {
      ...DEFAULT_WB_DECOMPOSITION_POLICY,
      auto_when: [],
      ask_when: [],
    },
    interaction: { ...DEFAULT_WB_INTERACTION_POLICY },
    reviewBudget: { ...DEFAULT_WB_REVIEW_BUDGET_POLICY },
    steps: PHASES.map((phase) => ({
      id: phase,
      ...shape[phase],
      gate: (REVIEW_PHASES as readonly string[]).includes(phase) ? 'review' : null,
      ...(phase === 'verify' ? { reviewLanes: ['standards', 'spec', 'e2e'] } : {}),
      skills: [],
      transitions: TRANSITIONS[phase].flatMap((to) => {
        if (to === phase) return []
        const event = EVENT_BY_EDGE[`${phase}->${to}`]
        return event === undefined ? [] : [{ event, to }]
      }),
    })),
  }
}

export const DEFAULT_DEF: WbWorkflowDef = buildDefaultDef()

export function governedWorkflow(
  name: string,
  labels: Partial<Record<(typeof PHASES)[number], string>> = {},
): WbWorkflowDef {
  const base = buildDefaultDef(labels)
  return {
    ...base,
    name,
    steps: base.steps.map((step) => ({
      ...step,
      skills: (GOVERNED_PHASE_SKILLS[step.id] ?? []).map((id) => id === 'verification-before-completion'
        ? { id, kind: 'review' as const, review_lane: 'e2e' }
        : { id }),
      artifacts: step.artifacts?.map(({ requiredWhen: _ignored, ...artifact }) => ({
        ...artifact,
        producerPolicy: 'effective-step-skills',
      })),
    })),
  }
}

export function workflowForCreate(
  mode: 'new' | 'copy',
  currentIsDefault: boolean,
  currentDefinition: WbWorkflowDef | null,
  name: string,
  labels: Partial<Record<(typeof PHASES)[number], string>>,
): WbWorkflowDef | null {
  if (mode === 'new' || currentIsDefault) return governedWorkflow(name, labels)
  return currentDefinition === null ? null : cloneWorkflowDef(currentDefinition, name)
}

export interface StageAmbient {
  count: number
  running: boolean
}

export function stageCounts(
  snapshot: Snapshot | null | undefined,
  root: string,
  workflow: string,
): Record<string, StageAmbient> {
  const out: Record<string, StageAmbient> = {}
  const project = snapshot?.projects.find((candidate) => candidate.root === root)
  if (!project?.ok) return out
  for (const change of project.changes) {
    if (change.archived === 'true' || changeWorkflowName(change) !== workflow) continue
    const bucket = out[change.phase] ?? { count: 0, running: false }
    bucket.count += 1
    if (change.fields.automation === 'running') bucket.running = true
    out[change.phase] = bucket
  }
  return out
}

export interface SkillMove {
  skillId: string
  fromStage: string
  toStage: string
  refSkillId: string | null
  after: boolean
}

function insertRef<T extends { id: string }>(
  list: readonly T[],
  item: T,
  refId: string | null,
  after: boolean,
): T[] {
  const out = [...list]
  const refIndex = refId === null ? -1 : out.findIndex((candidate) => candidate.id === refId)
  out.splice(refIndex < 0 ? out.length : refIndex + (after ? 1 : 0), 0, item)
  return out
}

function dropDep(skill: WbSkillRef, dependency: string): WbSkillRef {
  if (!skill.depends_on?.includes(dependency)) return skill
  const remaining = skill.depends_on.filter((candidate) => candidate !== dependency)
  if (remaining.length > 0) return { ...skill, depends_on: remaining }
  const { depends_on: _dropped, ...withoutDependency } = skill
  return withoutDependency
}

export function reorderStagesInDef(
  def: WbWorkflowDef,
  fromId: string,
  toId: string,
  after: boolean,
): WbWorkflowDef {
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

export function moveSkillInDef(def: WbWorkflowDef, move: SkillMove): WbWorkflowDef {
  const source = def.steps.find((step) => step.id === move.fromStage)
  const target = def.steps.find((step) => step.id === move.toStage)
  const moved = source?.skills.find((skill) => skill.id === move.skillId)
  if (!source || !target || !moved) return def
  if (source !== target && target.skills.some((skill) => skill.id === move.skillId)) return def
  if (source === target) {
    return {
      ...def,
      steps: def.steps.map((step) => step.id !== source.id ? step : {
        ...step,
        skills: insertRef(step.skills.filter((skill) => skill.id !== move.skillId), moved, move.refSkillId, move.after),
      }),
    }
  }
  const { depends_on: _dropped, ...dependencyFree } = moved
  return {
    ...def,
    steps: def.steps.map((step) => {
      if (step.id === source.id) {
        return {
          ...step,
          skills: step.skills
            .filter((skill) => skill.id !== move.skillId)
            .map((skill) => dropDep(skill, move.skillId)),
        }
      }
      return step.id === target.id
        ? { ...step, skills: insertRef(step.skills, dependencyFree, move.refSkillId, move.after) }
        : step
    }),
  }
}

export function setSkillDepInDef(
  def: WbWorkflowDef,
  stageId: string,
  skillId: string,
  dependency: string | null,
  previous: string | null,
): WbWorkflowDef {
  return {
    ...def,
    steps: def.steps.map((step) => step.id !== stageId ? step : {
      ...step,
      skills: step.skills.map((skill) => {
        if (skill.id !== skillId) return skill
        if (dependency === null) return previous === null ? skill : dropDep(skill, previous)
        const current = skill.depends_on ?? []
        if (previous === null) {
          return current.includes(dependency) ? skill : { ...skill, depends_on: [...current, dependency] }
        }
        if (!current.includes(previous)) return skill
        const next = current
          .map((candidate) => candidate === previous ? dependency : candidate)
          .filter((candidate, index, all) => all.indexOf(candidate) === index)
        return { ...skill, depends_on: next }
      }),
    }),
  }
}

export function removeSkillFromDef(def: WbWorkflowDef, stageId: string, skillId: string): WbWorkflowDef {
  const step = def.steps.find((candidate) => candidate.id === stageId)
  if (!step?.skills.some((skill) => skill.id === skillId)) return def
  return {
    ...def,
    steps: def.steps.map((candidate) => candidate.id !== stageId ? candidate : {
      ...candidate,
      skills: candidate.skills
        .filter((skill) => skill.id !== skillId)
        .map((skill) => dropDep(skill, skillId)),
    }),
  }
}

export function addSkillToDef(def: WbWorkflowDef, stageId: string, skillId: string): WbWorkflowDef {
  const step = def.steps.find((candidate) => candidate.id === stageId)
  if (!step || step.skills.some((skill) => skill.id === skillId)) return def
  return {
    ...def,
    steps: def.steps.map((candidate) => candidate.id === stageId
      ? { ...candidate, skills: [...candidate.skills, { id: skillId }] }
      : candidate),
  }
}

export function cloneWorkflowDef(def: WbWorkflowDef, name: string): WbWorkflowDef {
  return {
    ...def,
    name,
    decomposition: def.decomposition === undefined ? undefined : {
      ...def.decomposition,
      auto_when: [...def.decomposition.auto_when],
      ask_when: [...def.decomposition.ask_when],
    },
    interaction: def.interaction === undefined ? undefined : { ...def.interaction },
    reviewBudget: def.reviewBudget === undefined ? undefined : { ...def.reviewBudget },
    steps: def.steps.map((step) => ({
      ...step,
      reviewLanes: step.reviewLanes === undefined ? undefined : [...step.reviewLanes],
      skills: step.skills.map((skill) => ({
        ...skill,
        depends_on: skill.depends_on ? [...skill.depends_on] : undefined,
      })),
      inputs: step.inputs.map((field) => ({ ...field })),
      outputs: step.outputs.map((field) => ({ ...field })),
      guards: step.guards.map((guard) => ({ ...guard })),
      transitions: step.transitions.map((transition) => ({ ...transition })),
    })),
  }
}

export function setLaneGuardInDef(def: WbWorkflowDef, stageId: string, enabled: boolean): WbWorkflowDef {
  return {
    ...def,
    steps: def.steps.map((step) => {
      if (step.id !== stageId) return step
      const hasGuard = step.guards.some((guard) => guard.type === 'nonempty-output')
      if (hasGuard === enabled) return step
      return {
        ...step,
        guards: enabled
          ? [...step.guards, { type: 'nonempty-output' }]
          : step.guards.filter((guard) => guard.type !== 'nonempty-output'),
      }
    }),
  }
}

export function removeStageFromDef(def: WbWorkflowDef, laneId: string): WbWorkflowDef {
  const index = def.steps.findIndex((step) => step.id === laneId)
  const victim = def.steps[index]
  if (index < 0 || !victim) return def
  const next = def.steps[index + 1]
  const successor = next && victim.transitions.some((transition) => transition.to === next.id) ? next.id : null
  return {
    ...def,
    steps: def.steps.filter((step) => step.id !== laneId).map((step) => ({
      ...step,
      transitions: step.transitions.flatMap((transition) => {
        if (transition.to !== laneId) return [transition]
        return successor === null || successor === step.id ? [] : [{ ...transition, to: successor }]
      }),
    })),
  }
}
