import type { WbStepDef, WbWorkflowDef } from '../api/governanceTypes'

/** 步骤的深拷贝：复制工作流、新建轨道都从这里取一份与原定义不共享引用的副本。 */
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
  const { source: _source, branches: _branches, ...rest } = def
  return {
    ...rest,
    name,
    ...(def.tracks === undefined ? {} : {
      tracks: Object.fromEntries(Object.entries(def.tracks).map(([id, branch]) => [id, { ...branch, steps: cloneSteps(branch.steps) }])),
    }),
    decomposition: def.decomposition === undefined ? undefined : {
      ...def.decomposition,
      auto_when: [...def.decomposition.auto_when],
      ask_when: [...def.decomposition.ask_when],
    },
    interaction: def.interaction === undefined ? undefined : { ...def.interaction },
    steps: cloneSteps(def.steps),
  }
}

/** 空白工作流：一个阶段、无技能、无离开条件。 */
export function blankWorkflow(name: string, stageLabel: string): WbWorkflowDef {
  return {
    name,
    steps: [{ id: 'stage-1', label: stageLabel, gate: 'auto', skills: [], inputs: [], outputs: [], guards: [], transitions: [] }],
  }
}

