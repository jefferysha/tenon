import { createOrchestrationLedger, digestAggregate, type BoardCommandV2, type BoardSnapshotV2, type CapabilityResolutionV2, type DevelopmentRequestV2, type OrchestrationLedger, type RepositoryContextV2, type WorkGraphV2 } from '@tenon/kernel'
import { assessDevelopmentIntentV2, planDevelopmentV2, type PlannerCatalogInputV2, type PlannerPlanSuccessV2, type WorkflowPipelineBlueprintV2 } from './planner-v2.js'
import { pipelineBlueprintFromWorkflowDef, type WorkflowBlueprintMappingResolverV2, type WorkflowBlueprintMappingV2, type WorkflowDefinitionBlueprintInputV2, type WorkflowTrackBlueprintInputV2 } from './workflow-pipeline-v2.js'
import { createExecutionRuntimeV2, type ExecutionRuntimeOptionsV2, type ExecutionRuntimeResultV2 } from './runtime-v2.js'

export interface AutonomousOrchestratorV2Options extends Omit<ExecutionRuntimeOptionsV2, 'ledger' | 'change_dir'> {
  readonly change_dir: string
  readonly ledger?: OrchestrationLedger
  readonly request: DevelopmentRequestV2
  readonly context: RepositoryContextV2
  readonly catalog: PlannerCatalogInputV2
  readonly assessment_id?: string
  readonly graph_id?: string
  readonly plan_revision_id?: string
  readonly pipeline_blueprint?: WorkflowPipelineBlueprintV2
  /** Optional workflow source used by the production planner to freeze a blueprint. */
  readonly workflow_definition?: WorkflowDefinitionBlueprintInputV2
  readonly workflow_track?: WorkflowTrackBlueprintInputV2
  /**
   * Mapping may be resolved after assessment so callers can use the planner's
   * canonical requirement/work-item identities. The object form remains for
   * already materialized plans and backwards compatibility.
   */
  readonly workflow_blueprint_mapping?: WorkflowBlueprintMappingV2 | WorkflowBlueprintMappingResolverV2
}

export type AutonomousOrchestrationOutcomeV2 =
  | ({ readonly ok: true; readonly plan: PlannerPlanSuccessV2; readonly runtime: ExecutionRuntimeResultV2 })
  | { readonly ok: false; readonly stage: 'identity' | 'planning' | 'blocked'; readonly snapshot: BoardSnapshotV2; readonly issues: readonly string[] }

export class AutonomousOrchestratorV2 {
  private readonly options: AutonomousOrchestratorV2Options
  private readonly ledger: OrchestrationLedger

  constructor(options: AutonomousOrchestratorV2Options) {
    this.options = options
    this.ledger = options.ledger ?? createOrchestrationLedger()
  }

  async run(): Promise<AutonomousOrchestrationOutcomeV2> {
    const { request, context } = this.options
    let snapshot = await this.ledger.initialize(this.options.change_dir, { project_id: request.project_id, change_id: request.change_id, correlation_id: request.correlation_id, updated_at: context.created_at })
    const identityIssues = [
      request.change_id !== context.change_id ? 'request-context-change-mismatch' : '',
      request.project_id !== context.project_id ? 'request-context-project-mismatch' : '',
      request.request_id !== context.request_id ? 'request-context-request-mismatch' : '',
      request.correlation_id !== context.correlation_id ? 'request-context-correlation-mismatch' : '',
      snapshot.request !== undefined && digestAggregate(snapshot.request) !== digestAggregate(request) ? 'persisted-request-mismatch' : '',
      snapshot.context !== undefined && digestAggregate(snapshot.context) !== digestAggregate(context) ? 'persisted-context-mismatch' : '',
    ].filter(Boolean)
    if (identityIssues.length > 0) return { ok: false, stage: 'identity', snapshot, issues: identityIssues }
    const assessment = assessDevelopmentIntentV2({ request, context, assessment_id: this.options.assessment_id ?? `assessment:${request.change_id}`, assessed_at: context.created_at })
    if (assessment.normalization !== 'complete') return { ok: false, stage: 'planning', snapshot, issues: assessment.questions.filter((question) => question.blocking).map((question) => question.id) }
    let pipelineBlueprint: WorkflowPipelineBlueprintV2 | undefined = this.options.pipeline_blueprint
    if (pipelineBlueprint === undefined && this.options.workflow_definition !== undefined && this.options.workflow_track !== undefined) {
      const mapping = typeof this.options.workflow_blueprint_mapping === 'function'
        ? this.options.workflow_blueprint_mapping(assessment)
        : this.options.workflow_blueprint_mapping
      if (mapping === undefined) return { ok: false, stage: 'planning', snapshot, issues: ['workflow-blueprint-mapping-required'] }
      pipelineBlueprint = pipelineBlueprintFromWorkflowDef(this.options.workflow_definition, this.options.workflow_track, mapping)
      if (pipelineBlueprint.stages.length === 0) return { ok: false, stage: 'planning', snapshot, issues: ['workflow-blueprint-mapping-empty'] }
    }
    const plan = planDevelopmentV2({ request, context, assessment, catalog: this.options.catalog, graph_id: this.options.graph_id ?? `graph:${request.change_id}`, plan_revision_id: this.options.plan_revision_id ?? `revision:${request.change_id}`, now: context.created_at, pipeline_blueprint: pipelineBlueprint })
    if (!plan.ok) return { ok: false, stage: 'planning', snapshot, issues: plan.issues }
    const persistedPlanIssues = [
      snapshot.assessment !== undefined && digestAggregate(snapshot.assessment) !== digestAggregate(plan.assessment) ? 'persisted-assessment-mismatch' : '',
      snapshot.graph !== undefined && digestAggregate(snapshot.graph) !== digestAggregate(plan.graph) ? 'persisted-graph-mismatch' : '',
      snapshot.resolution !== undefined && digestAggregate(snapshot.resolution) !== digestAggregate(plan.resolution) ? 'persisted-resolution-mismatch' : '',
      plan.pipeline !== undefined && snapshot.pipeline !== undefined && digestAggregate(snapshot.pipeline) !== digestAggregate(plan.pipeline) ? 'persisted-pipeline-mismatch' : '',
    ].filter(Boolean)
    if (persistedPlanIssues.length > 0) return { ok: false, stage: 'planning', snapshot, issues: persistedPlanIssues }
    snapshot = await this.appendIfMissing(snapshot, 'accept-request', snapshot.request === undefined ? { request } : undefined, 'accept', request)
    snapshot = await this.appendIfMissing(snapshot, 'record-context', snapshot.context === undefined ? { context } : undefined, 'context', context)
    snapshot = await this.appendIfMissing(snapshot, 'record-assessment', snapshot.assessment === undefined ? { assessment: plan.assessment } : undefined, 'assessment', plan.assessment)
    snapshot = await this.appendIfMissing(snapshot, 'freeze-pipeline', plan.pipeline !== undefined && (snapshot.pipeline === undefined || snapshot.pipeline.status === 'superseded') ? { pipeline: plan.pipeline } : undefined, 'pipeline', plan.pipeline)
    snapshot = await this.appendIfMissing(snapshot, 'freeze-work-graph', snapshot.graph === undefined ? { graph: plan.graph } : undefined, 'graph', plan.graph)
    snapshot = await this.appendIfMissing(snapshot, 'resolve-capabilities', snapshot.resolution === undefined ? { resolution: plan.resolution } : undefined, 'resolution', plan.resolution)
    if (plan.resolution.status !== 'resolved' || snapshot.resolution?.status !== 'resolved') return { ok: false, stage: 'blocked', snapshot, issues: plan.resolution.blockers }
    snapshot = await this.appendIfMissing(snapshot, 'start-change', snapshot.status === 'ready' ? {} : undefined, 'start', plan.graph)
    if (snapshot.status !== 'executing' && snapshot.status !== 'verifying' && snapshot.status !== 'completed') return { ok: false, stage: 'blocked', snapshot, issues: snapshot.blockers.length > 0 ? snapshot.blockers : ['change-not-runnable'] }
    const runtime = createExecutionRuntimeV2({ ...this.options, ledger: this.ledger, change_dir: this.options.change_dir })
    const result = await runtime.run()
    return { ok: true, plan, runtime: result }
  }

  private async appendIfMissing<T>(snapshot: BoardSnapshotV2, type: BoardCommandV2['type'], payload: Record<string, unknown> | undefined, key: string, identity: T): Promise<BoardSnapshotV2> {
    if (payload === undefined) return snapshot
    const digest = digestAggregate(identity).slice(7, 39)
    const commandId = `orchestrator:${key}:${digest}`
    let expected = snapshot
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const command: BoardCommandV2 = {
        schema_version: 'board-command/v2', command_id: commandId, idempotency_key: `idem:${commandId}`, expected_revision: expected.revision,
        actor: { kind: 'system', id: 'orchestrator' }, issued_at: this.options.context.created_at, correlation_id: expected.correlation_id,
        ...(expected.event_head_id === undefined ? {} : { causation_id: expected.event_head_id }), change_id: expected.change_id, type, ...payload,
      } as BoardCommandV2
      const result = await this.ledger.append(this.options.change_dir, command)
      if (result.kind === 'committed' || result.kind === 'replayed') return result.snapshot
      if (result.rejection.code !== 'revision-conflict') throw new Error(`${type} rejected: ${result.rejection.reason_code}`)
      const latest = await this.ledger.readSnapshot(this.options.change_dir)
      if (latest === undefined) throw new Error('orchestration ledger disappeared during CAS retry')
      expected = latest
    }
    throw new Error(`${type} rejected: CAS retry budget exhausted`)
  }
}

export function createAutonomousOrchestratorV2(options: AutonomousOrchestratorV2Options): AutonomousOrchestratorV2 {
  return new AutonomousOrchestratorV2(options)
}

export type { CapabilityResolutionV2, WorkGraphV2 }
