import type {
  WbExecutorRef,
  WbReviewerRef,
  WbSkillRef,
  WbStepAgents,
  WbStepDef,
  WbStepTest,
  WbWorkflowDef,
} from '../api/governanceTypes'
import { appendSkill, removeSkill } from './skillWaves'
import { mapStep } from './workbenchStep'
export { BASE_BRANCH, addTrackBranch, branchesOf, removeTrackBranch, resolveBranch, selectBranchDef, writeBranchDef } from './workbenchBranches'
export { blankWorkflow, cloneWorkflowDef, copyWorkflowDef } from './workbenchClone'
export {
  backTargetOf, backTransitionOf, displacedBackTransitions, removeStageFromDef, reorderStagesInDef, setStageBackInDef,
} from './workbenchTransitions'
export type {
  WbActionConfig,
  WbArtifactConfig,
  WbDocumentContract,
  WbFieldRef,
  WbGuardConfig,
  WbSkillRef,
  WbStepDef,
  WbStepTest,
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
} from '../api/governanceTypes'

/**
 * 工作流定义的纯变换：所有编辑器动作都落到这里（分支、转移、复制各在自己的模块，这里统一导出），
 * 返回新对象，不改入参。定义 = 服务端读回的 WbWorkflowDef（default 亦然）；前端不再持有任何内建副本。
 */

/** 门禁只有 评审 / 自动：`gate: null`（旧定义、缺省）与自动同义，读到就按自动看。 */
export function gateKind(gate: WbStepDef['gate']): 'review' | 'auto' {
  return gate === 'review' ? 'review' : 'auto'
}

function withExplicitGates(steps: readonly WbStepDef[]): WbStepDef[] {
  return steps.map((step) => step.gate === null ? { ...step, gate: 'auto' } : step)
}

/**
 * 写回前剔除读接口附带的投影字段，并把 `gate: null` 显式写成 `auto`（保存后 YAML 里只有 review / auto）。
 * 草稿与基线都过这里再比较，所以打开旧定义不会凭空变成「有改动」。
 */
export function definitionForWrite(def: WbWorkflowDef): Omit<WbWorkflowDef, 'source' | 'effectiveIo' | 'branches'> {
  const { source: _source, effectiveIo: _effectiveIo, branches: _branches, ...definition } = def
  return {
    ...definition,
    steps: withExplicitGates(definition.steps),
    ...(definition.tracks === undefined ? {} : {
      tracks: Object.fromEntries(Object.entries(definition.tracks).map(([id, branch]) => [id, { ...branch, steps: withExplicitGates(branch.steps) }])),
    }),
  }
}

export function renameStepInDef(def: WbWorkflowDef, stepId: string, label: string): WbWorkflowDef {
  return mapStep(def, stepId, (step) => ({ ...step, label }))
}

export function setGateInDef(def: WbWorkflowDef, stepId: string, gate: WbStepDef['gate']): WbWorkflowDef {
  return mapStep(def, stepId, (step) => ({ ...step, gate }))
}

/** 整体替换阶段技能（含 depends_on）；来自技能画布。 */
export function setStepSkillsInDef(def: WbWorkflowDef, stepId: string, skills: readonly WbSkillRef[]): WbWorkflowDef {
  return mapStep(def, stepId, (step) => ({ ...step, skills: [...skills] }))
}

/**
 * 整体替换步骤的 agent 列表（只给的那一侧被替换）；两侧都空 → 删掉 agents 键，与 YAML 往返一致。
 */
export function setStepAgentsInDef(
  def: WbWorkflowDef,
  stepId: string,
  patch: { executors?: readonly WbExecutorRef[]; reviewers?: readonly WbReviewerRef[] },
): WbWorkflowDef {
  return mapStep(def, stepId, (step) => {
    const current = step.agents ?? { executors: [], reviewers: [] }
    const next: WbStepAgents = {
      executors: [...(patch.executors ?? current.executors)],
      reviewers: [...(patch.reviewers ?? current.reviewers)],
    }
    if (next.executors.length === 0 && next.reviewers.length === 0) {
      const { agents: _agents, ...rest } = step
      return rest
    }
    return { ...step, agents: next }
  })
}

/** 步骤测试项整份替换（同 setStepSkillsInDef 的口径：草稿里只改这一步）。 */
export function setStepTestsInDef(def: WbWorkflowDef, stepId: string, tests: readonly WbStepTest[]): WbWorkflowDef {
  return mapStep(def, stepId, (step) => ({ ...step, tests: [...tests] }))
}

/** 把一个测试方向抄成步骤测试项；id 冲突时追加 `-2`、`-3` …（与 kernel testFromDirection 同规则）。 */
export function testFromDirection(
  direction: { id: string; label: string } & Omit<WbStepTest, 'id' | 'direction' | 'required' | 'keep_runs' | 'label'>,
  existingIds: ReadonlySet<string>,
): WbStepTest {
  let id = direction.id
  for (let suffix = 2; existingIds.has(id); suffix++) id = `${direction.id}-${suffix}`
  const { id: _id, ...rest } = direction
  return { ...rest, id, direction: direction.id, required: true }
}

/** 追加技能：不写 depends_on，按声明顺序串行接在最后（kernel skill-order 的口径）。 */
export function addSkillToDef(def: WbWorkflowDef, stepId: string, skillId: string): WbWorkflowDef {
  const step = def.steps.find((candidate) => candidate.id === stepId)
  if (!step || step.skills.some((skill) => skill.id === skillId)) return def
  return mapStep(def, stepId, (current) => ({ ...current, skills: appendSkill(current.skills, skillId) }))
}

export function removeSkillFromDef(def: WbWorkflowDef, stepId: string, skillId: string): WbWorkflowDef {
  const step = def.steps.find((candidate) => candidate.id === stepId)
  if (!step?.skills.some((skill) => skill.id === skillId)) return def
  return mapStep(def, stepId, (current) => ({ ...current, skills: removeSkill(current.skills, skillId) }))
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
