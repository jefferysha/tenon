import {
  compileWorkflow,
  resolveEffectiveWorkflowPlan,
  type PlanOptions,
} from '@tenon/kernel'
import {
  assertWorkflowRootAnchor,
  readWorkflowForApi,
  WorkflowNotFoundError,
  WorkflowPathError,
  WorkflowReadError,
  type WorkflowRootAnchor,
} from './workflows.js'
import type { WorkflowDefinitionCurrent } from './workflowDefinitionStatus.js'
import { readDefaultOverride } from './serverWorkflowYamlRoutes.js'

function assertDefinitionRoot(anchor: WorkflowRootAnchor): void {
  try {
    assertWorkflowRootAnchor(anchor)
  } catch (error) {
    throw new WorkflowPathError('workflow definition root trust check failed', error)
  }
}

/** 当前定义的指纹，按任务的轨道与冻结计划的执行模型算（`planOptions`），才能和冻结的指纹比对。 */
export function readCurrentWorkflowDefinition(
  anchor: WorkflowRootAnchor,
  workflow: string,
  planOptions: PlanOptions,
): WorkflowDefinitionCurrent {
  try {
    assertDefinitionRoot(anchor)
    const plan = resolveEffectiveWorkflowPlan(workflow, (name) => {
      return compileWorkflow(readWorkflowForApi(anchor, name))
    }, planOptions, () => readDefaultOverride(anchor))
    if (plan === null) return { kind: 'missing' }
    assertDefinitionRoot(anchor)
    return { kind: 'current', fingerprint: plan.workflowFingerprint }
  } catch (error) {
    if (error instanceof WorkflowNotFoundError) return { kind: 'missing' }
    if (error instanceof WorkflowPathError || error instanceof WorkflowReadError) throw error
    return { kind: 'invalid' }
  }
}
