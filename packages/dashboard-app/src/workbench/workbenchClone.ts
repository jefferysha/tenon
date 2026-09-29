import type { WbStepDef, WbWorkflowDef } from '../api/governanceTypes'
import { isDefaultWorkflowName } from '@tenon/kernel/workflow/identifier'
import { cloneDocumentContract, pruneContractForSteps } from './documentContractEdits'

/** 定义的深拷贝：复制工作流、新建轨道都从这里取一份与原定义不共享引用的副本。 */
export function cloneSteps(steps: readonly WbStepDef[]): WbStepDef[] {
  return steps.map((step) => ({
    ...step,
    skills: step.skills.map((skill) => ({
      ...skill,
      depends_on: skill.depends_on ? [...skill.depends_on] : undefined,
    })),
    inputs: step.inputs.map((field) => ({ ...field })),
    outputs: step.outputs.map((field) => ({ ...field })),
    artifacts: step.artifacts === undefined ? undefined : step.artifacts.map((artifact) => ({ ...artifact })),
    agents: step.agents === undefined ? undefined : {
      executors: step.agents.executors.map((ref) => ({ ...ref, depends_on: ref.depends_on ? [...ref.depends_on] : undefined })),
      reviewers: step.agents.reviewers.map((ref) => ({
        ...ref,
        depends_on: ref.depends_on ? [...ref.depends_on] : undefined,
        reads_tests: ref.reads_tests ? [...ref.reads_tests] : undefined,
      })),
    },
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
    steps: [{ id: 'stage-1', label: stageLabel, gate: 'auto', skills: [], inputs: [], outputs: [], guards: [], transitions: [] }],
  }
}

