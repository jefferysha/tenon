import { basename } from 'node:path'
import { decodeWorkflowDef, decodeDevelopmentRequestV2, decodeRepositoryContextV2, digestAggregate, type BoardCommandV2, type BoardSnapshotV2, type OrchestrationLedger } from '@tenon/kernel'
import { assessDevelopmentIntentV2, normalizeCapabilityCatalogV2, pipelineBlueprintFromWorkflowDef, planDevelopmentV2, workItemIdentifierV2 } from '@tenon/automation'
import type { FreezeWorkflowInputV2 } from './serverOrchestrationV2Routes.js'

export function createFreezeHandlers(deps: { ledger: OrchestrationLedger; clock: () => string }): {
  freezePipeline: (changeDir: string, pipeline: unknown) => Promise<BoardSnapshotV2>
  freezeWorkflow: (changeDir: string, input: FreezeWorkflowInputV2) => Promise<BoardSnapshotV2>
} {
  const { orchestrationLedger, clock } = { orchestrationLedger: deps.ledger, clock: deps.clock }
  const freezePipeline = async (changeDir: string, pipeline: unknown): Promise<BoardSnapshotV2> => {
    const snapshot = await orchestrationLedger.readSnapshot(changeDir)
    if (snapshot === undefined) throw new Error('orchestration ledger 未初始化')
    const commandId = `server:freeze-pipeline:${snapshot.change_id}:${snapshot.revision}`
    const command: BoardCommandV2 = {
      schema_version: 'board-command/v2', command_id: commandId, idempotency_key: `idem:${commandId}`,
      expected_revision: snapshot.revision, actor: { kind: 'system', id: 'server' }, issued_at: clock(),
      correlation_id: snapshot.correlation_id, ...(snapshot.event_head_id === undefined ? {} : { causation_id: snapshot.event_head_id }),
      change_id: snapshot.change_id, type: 'freeze-pipeline', pipeline,
    } as BoardCommandV2
    const result = await orchestrationLedger.append(changeDir, command)
    if (result.kind === 'rejected') throw new Error(`${result.rejection.reason_code}: ${result.rejection.message}`)
    return result.snapshot
  }
  const freezeWorkflow = async (changeDir: string, input: FreezeWorkflowInputV2): Promise<BoardSnapshotV2> => {
    const requestDecoded = decodeDevelopmentRequestV2(input.request)
    const contextDecoded = decodeRepositoryContextV2(input.context)
    if (!requestDecoded.ok || !contextDecoded.ok) throw new Error('request/context schema 无效')
    const request = requestDecoded.value
    const context = contextDecoded.value
    if (request.change_id !== context.change_id || request.project_id !== context.project_id || request.correlation_id !== context.correlation_id) throw new Error('request/context identity mismatch')
    if (basename(changeDir) !== request.change_id) throw new Error('request/path change mismatch')
    const catalog = normalizeCapabilityCatalogV2(input.catalog)
    if (!catalog.ok) throw new Error(`catalog schema 无效: ${catalog.issues.join(', ')}`)
    const workflow = decodeWorkflowDef(input.workflow_definition, 'custom')
    const trackRaw = input.workflow_track
    if (trackRaw === null || typeof trackRaw !== 'object' || Array.isArray(trackRaw)) throw new Error('workflow_track schema 无效')
    const track = trackRaw as { id?: unknown; revision?: unknown; source?: unknown }
    if (Object.keys(track).some((key) => !['id', 'revision', 'source'].includes(key))) throw new Error('workflow_track 含未知字段')
    if (typeof track.id !== 'string' || track.id.length === 0) throw new Error('workflow_track.id 无效')
    if (request.workflow_id !== undefined && request.workflow_id !== workflow.name) throw new Error('request/workflow identity mismatch')
    if (request.track_id !== undefined && request.track_id !== track.id) throw new Error('request/track identity mismatch')
    const assessment = assessDevelopmentIntentV2({ request, context, assessment_id: typeof input.assessment_id === 'string' ? input.assessment_id : `assessment:${request.change_id}`, assessed_at: context.created_at })
    if (assessment.normalization !== 'complete') throw new Error('assessment needs input')
    const mappingRaw = input.workflow_blueprint_mapping
    if (mappingRaw === null || typeof mappingRaw !== 'object' || Array.isArray(mappingRaw)) throw new Error('workflow_blueprint_mapping 必须是对象')
    const mapping = mappingRaw as Record<string, unknown>
    const allowedMappingKeys = new Set(['capabilitiesByStep', 'workItemIdsByStep', 'skillVersions', 'workflowVersion', 'pipelineVersion', 'pipelineId'])
    if (Object.keys(mapping).some((key) => !allowedMappingKeys.has(key))) throw new Error('workflow_blueprint_mapping 含未知字段')
    const capabilitiesByStep = mapping.capabilitiesByStep
    const workItemIdsByStep = mapping.workItemIdsByStep
    const resolvedWorkItems: Record<string, readonly string[]> = {}
    if (capabilitiesByStep !== undefined) {
      if (capabilitiesByStep === null || typeof capabilitiesByStep !== 'object' || Array.isArray(capabilitiesByStep)) throw new Error('capabilitiesByStep 无效')
      for (const [stepId, capabilities] of Object.entries(capabilitiesByStep as Record<string, unknown>)) {
        if (!Array.isArray(capabilities) || capabilities.some((value) => typeof value !== 'string')) throw new Error(`capabilitiesByStep.${stepId} 无效`)
        resolvedWorkItems[stepId] = (capabilities as string[]).map((capability) => {
          const requirements = assessment.requirements.filter((entry) => entry.capability === capability)
          if (requirements.length === 0) throw new Error(`capability 未在 assessment 中声明: ${capability}`)
          // A capability may legitimately be required more than once (for
          // example, separate frontend and backend work items). Map every
          // matching requirement so no work item is silently dropped. If a
          // caller assigns that capability to multiple steps, the blueprint
          // coverage validator fails loudly with the conflicting work items.
          return requirements.map((requirement) => workItemIdentifierV2(requirement.id))
        }).flat()
      }
    } else if (workItemIdsByStep !== undefined) {
      if (workItemIdsByStep === null || typeof workItemIdsByStep !== 'object' || Array.isArray(workItemIdsByStep)) throw new Error('workItemIdsByStep 无效')
      for (const [stepId, ids] of Object.entries(workItemIdsByStep as Record<string, unknown>)) {
        if (!Array.isArray(ids) || ids.some((value) => typeof value !== 'string' || value.length === 0)) throw new Error(`workItemIdsByStep.${stepId} 无效`)
        resolvedWorkItems[stepId] = ids as string[]
      }
    } else throw new Error('workflow_blueprint_mapping 必须包含 capabilitiesByStep 或 workItemIdsByStep')
    // A workflow may carry a track-specific branch. Freeze the effective branch
    // so the persisted stage identities match what the selected track actually
    // executes; falling back to top-level steps preserves unbranched workflows.
    const branch = workflow.tracks?.[track.id]
    const effectiveWorkflow = branch === undefined
      ? workflow
      : { ...workflow, steps: branch.steps }
    const blueprint = pipelineBlueprintFromWorkflowDef(effectiveWorkflow, { id: track.id, ...(typeof track.revision === 'string' ? { revision: track.revision } : {}), ...(track.source === 'builtin' || track.source === 'project' || track.source === 'user' || track.source === 'automatic' ? { source: track.source } : {}) }, { ...mapping, workItemIdsByStep: resolvedWorkItems })
    if (blueprint.stages.length === 0) throw new Error('workflow blueprint 为空')
    const planned = planDevelopmentV2({ request, context, assessment, catalog: catalog.catalog, graph_id: typeof input.graph_id === 'string' ? input.graph_id : `graph:${request.change_id}`, plan_revision_id: typeof input.plan_revision_id === 'string' ? input.plan_revision_id : `revision:${request.change_id}`, now: context.created_at, pipeline_blueprint: blueprint })
    if (!planned.ok || planned.pipeline === undefined || planned.resolution.status !== 'resolved') throw new Error(planned.ok ? `pipeline 无法冻结: ${planned.resolution.blockers.join(', ')}` : planned.issues.join(', '))
    let snapshot = await orchestrationLedger.initialize(changeDir, { project_id: request.project_id, change_id: request.change_id, correlation_id: request.correlation_id, updated_at: context.created_at })
    const append = async (type: BoardCommandV2['type'], payload: Record<string, unknown>, key: string, identity: unknown) => {
      const commandId = `server:freeze:${key}:${digestAggregate(identity).slice(7, 39)}`
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const command = { schema_version: 'board-command/v2', command_id: commandId, idempotency_key: `idem:${commandId}`, expected_revision: snapshot.revision, actor: { kind: 'system', id: 'server-planner' }, issued_at: context.created_at, correlation_id: snapshot.correlation_id, ...(snapshot.event_head_id === undefined ? {} : { causation_id: snapshot.event_head_id }), change_id: snapshot.change_id, type, ...payload } as BoardCommandV2
        const result = await orchestrationLedger.append(changeDir, command)
        if (result.kind === 'committed' || result.kind === 'replayed') { snapshot = result.snapshot; return }
        if (result.rejection.code !== 'revision-conflict') throw new Error(`${type} rejected: ${result.rejection.reason_code}`)
        const latest = await orchestrationLedger.readSnapshot(changeDir); if (latest === undefined) throw new Error('orchestration ledger disappeared'); snapshot = latest
      }
      throw new Error(`${type} CAS retry exhausted`)
    }
    await append('accept-request', { request }, 'accept-request', request)
    await append('record-context', { context }, 'record-context', context)
    await append('record-assessment', { assessment: planned.assessment }, 'assessment', planned.assessment)
    await append('freeze-pipeline', { pipeline: planned.pipeline }, 'pipeline', planned.pipeline)
    await append('freeze-work-graph', { graph: planned.graph }, 'graph', planned.graph)
    await append('resolve-capabilities', { resolution: planned.resolution }, 'resolution', planned.resolution)
    return snapshot
  }
  return { freezePipeline, freezeWorkflow }
}
