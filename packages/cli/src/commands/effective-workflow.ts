import {
  compileWorkflow,
  loadWorkflow,
  requireTrackForRoot,
  resolveBoundEffectiveWorkflowPlan,
  resolveWorkflowName,
  type EffectiveWorkflowPlan,
  type PipelineState,
} from '@tenon/kernel'
import type { CliDeps } from '../deps.js'

/**
 * CLI compatibility adapter for the kernel's capability plan. Workflow identity handling stays
 * inside the kernel resolver; commands consume only the resulting runtime policies and IR.
 */
export function effectiveWorkflowForState(
  deps: CliDeps,
  state: PipelineState,
): EffectiveWorkflowPlan | null {
  const workflowName = resolveWorkflowName(state)
  const trackValue = state.fields.track
  const trackId = Array.isArray(trackValue) ? trackValue.join(',') : (trackValue ?? '')
  const track = trackId === '' || typeof deps.loadRegistry !== 'function'
    ? undefined
    : requireTrackForRoot(deps.loadRegistry(), trackId, deps.cwd, workflowName)
  return resolveBoundEffectiveWorkflowPlan(workflowName, {
    documentProfile: state.runMetadata?.documentProfile,
    documentGovernanceFingerprint: state.runMetadata?.documentGovernanceFingerprint,
    workflowPlanFingerprint: state.runMetadata?.workflowPlanFingerprint,
  }, (name) => {
    const definition = loadWorkflow(deps.cwd, name)
    return definition === null ? null : compileWorkflow(definition)
  }, track, state.runMetadata?.workflowPlanSnapshot)
}
