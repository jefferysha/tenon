import {
  builtinWorkflow,
  compileWorkflow,
  resolveEffectiveWorkflowPlan,
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

export function readCurrentWorkflowDefinition(
  anchor: WorkflowRootAnchor,
  workflow: string,
): WorkflowDefinitionCurrent {
  try {
    assertDefinitionRoot(anchor)
    const plan = resolveEffectiveWorkflowPlan(workflow, (name) => {
      const definition = builtinWorkflow(name) ?? readWorkflowForApi(anchor, name)
      return compileWorkflow(definition)
    }, undefined, () => readDefaultOverride(anchor))
    if (plan === null) return { kind: 'missing' }
    assertDefinitionRoot(anchor)
    return { kind: 'current', fingerprint: plan.workflowFingerprint }
  } catch (error) {
    if (error instanceof WorkflowNotFoundError) return { kind: 'missing' }
    if (error instanceof WorkflowPathError || error instanceof WorkflowReadError) throw error
    return { kind: 'invalid' }
  }
}
