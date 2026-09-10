import {
  parseSkillActionAuthorityContract,
  type ExecutionContext,
} from '@tenon/automation'
import {
  requireTrackForRoot,
  resolveWorkflowName,
  type TrackRegistry,
  type WorkflowPermissionLayerInput,
} from '@tenon/kernel'
import type { CliDeps } from '../deps.js'
import { changeDir } from '../paths.js'
import { str } from '../render.js'

/** Fresh non-Workflow facts consumed by the authoritative pre-claim five-layer evaluator. */
export async function resolveAfkWorkflowActionAuthority(
  deps: Pick<CliDeps, 'cwd' | 'store' | 'resolveSkillActionAuthority'>,
  change: string,
  context: Pick<ExecutionContext, 'skill_bundle_id' | 'loop_id' | 'iteration_id'>,
  run: {
    readonly id: string
    readonly workflowId?: string
    readonly workflowPlanFingerprint?: string
    readonly loopId?: string
    readonly iterationId?: string
  },
  registry: TrackRegistry,
) {
  const state = await deps.store.read(changeDir(deps.cwd, change))
  let project: { status: 'valid' | 'malformed'; grants: readonly ['enter-afk'] | readonly [] }
  let projectAuthority: {
    readonly version: 'v1'
    readonly track_id: string
    readonly track_registry_revision: string
  } | undefined
  const trackId = str(state.fields.track)
  try {
    const track = requireTrackForRoot(registry, trackId, deps.cwd)
    const allowed = track.policyProfile.automationEligible
    project = { status: 'valid', grants: allowed ? ['enter-afk'] : [] }
    projectAuthority = {
      version: 'v1',
      track_id: track.id,
      track_registry_revision: registry.revision,
    }
  } catch {
    project = { status: 'malformed', grants: [] }
  }
  let skill: WorkflowPermissionLayerInput = { status: 'missing', grants: [] }
  if (context.skill_bundle_id !== null && context.skill_bundle_id !== undefined
    && run.workflowPlanFingerprint !== undefined
    && deps.resolveSkillActionAuthority !== undefined) {
    const query = {
      change,
      skillBundleId: context.skill_bundle_id,
      workflowRunId: run.id,
      workflowFingerprint: run.workflowPlanFingerprint,
    }
    const rawSkill = await deps.resolveSkillActionAuthority(query)
    try {
      skill = parseSkillActionAuthorityContract(rawSkill, query)
    } catch {
      skill = { status: 'malformed', grants: [] }
    }
  }
  const metadata = state.runMetadata
  const exactRun = metadata !== undefined
    && metadata.runId === run.id
    && run.workflowId !== undefined
    && resolveWorkflowName(state) === run.workflowId
    && run.workflowPlanFingerprint !== undefined
    && metadata.workflowPlanFingerprint === run.workflowPlanFingerprint
    && run.loopId === context.loop_id
    && metadata.loopId === run.loopId
    && run.iterationId === context.iteration_id
    && metadata.iterationId === run.iterationId
  const runLayer = metadata === undefined
    ? { status: 'missing' as const, grants: [] }
    : !exactRun
      ? { status: 'fingerprint-mismatch' as const, grants: [] }
      : { status: 'valid' as const, grants: str(state.fields.automation) === 'queued'
        && str(state.fields.archived) !== 'true' ? ['enter-afk' as const] : [] }
  return {
    platform: { status: 'valid' as const, grants: ['enter-afk' as const] },
    skill,
    project,
    run: runLayer,
    ...(projectAuthority === undefined ? {} : { projectAuthority }),
  }
}
