import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createOrchestrationLedger,
  type BoardCommandV2,
  type CapabilityAssessmentV2,
  type CapabilityResolutionV2,
  type DevelopmentRequestV2,
  type RepositoryContextV2,
  type WorkflowPipelinePlanV2,
  type WorkGraphV2,
} from '@tenon/kernel'
import { createExecutionRuntimeV2, type RuntimeExecutorV2 } from './runtime-v2.js'
import { openArtifactService } from '../artifacts/service.js'
import type { RuntimeInputBundleV2 } from './input-materialization-v2.js'

const now = '2026-09-02T00:00:00.000Z'
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function request(): DevelopmentRequestV2 {
  return {
    schema_version: 'development-request/v2', record_id: 'request:req-1', project_id: 'project-1', change_id: 'change-1',
    revision: 0, correlation_id: 'corr-1', actor: { kind: 'user', id: 'user-1' }, created_at: now,
    request_id: 'req-1', intent: 'run test skills', interaction_policy: 'recommended-defaults', requested_effects: ['read'],
    constraints: [], user_skills: [], user_mcps: [], auto_select: true,
  }
}

function context(): RepositoryContextV2 {
  return {
    schema_version: 'repository-context/v2', record_id: 'context:1', project_id: 'project-1', change_id: 'change-1', revision: 1,
    correlation_id: 'corr-1', actor: { kind: 'system', id: 'host' }, created_at: now, request_id: 'req-1',
    repository: { ref: 'repo', branch: 'main', base_branch: 'main', head_sha: 'abc', dirty: false },
    workspace_fingerprint: `sha256:${'a'.repeat(64)}`, policy_digest: `sha256:${'b'.repeat(64)}`,
    skill_catalog_digest: `sha256:${'c'.repeat(64)}`, mcp_catalog_digest: `sha256:${'d'.repeat(64)}`, observed_facts: [],
  }
}

function assessment(): CapabilityAssessmentV2 {
  return {
    schema_version: 'capability-assessment/v2', record_id: 'assessment:1', project_id: 'project-1', change_id: 'change-1', revision: 2,
    correlation_id: 'corr-1', actor: { kind: 'system', id: 'planner' }, created_at: now, assessment_id: 'assessment-1', request_id: 'req-1',
    context_record_id: 'context:1', normalization: 'complete', requirements: [
      { id: 'req-a', capability: 'a', necessity: 'required', acceptance_refs: [], evidence_refs: [], constraints: [], risk: 'low' },
      { id: 'req-b', capability: 'b', necessity: 'required', acceptance_refs: [], evidence_refs: [], constraints: [], risk: 'low' },
    ], questions: [], risks: [], proposal_evidence_ref: 'assessment:evidence',
  }
}

function graph(dependencies: readonly { from: string; to: string }[] = [], mode: 'serial' | 'parallel' = 'parallel'): WorkGraphV2 {
  return {
    schema_version: 'work-graph/v2', record_id: 'graph:1', project_id: 'project-1', change_id: 'change-1', revision: 3,
    correlation_id: 'corr-1', actor: { kind: 'system', id: 'planner' }, created_at: now, graph_id: 'graph-1', graph_revision: 1,
    assessment_id: 'assessment-1', task_plan_revision_id: 'plan-1', task_plan_digest: `sha256:${'e'.repeat(64)}`,
    dependency_edges: dependencies.map((edge) => ({ ...edge, reason: 'ordering' as const })),
    execution_groups: [{ id: 'group-1', mode, work_item_ids: ['item-a', 'item-b'] }], acceptance_coverage: [], status: 'frozen',
  }
}

function resolution(): CapabilityResolutionV2 {
  return {
    schema_version: 'capability-resolution/v2', record_id: 'resolution:1', project_id: 'project-1', change_id: 'change-1', revision: 4,
    correlation_id: 'corr-1', actor: { kind: 'system', id: 'resolver' }, created_at: now, resolution_id: 'resolution-1',
    assessment_id: 'assessment-1', graph_id: 'graph-1', policy_digest: `sha256:${'b'.repeat(64)}`, status: 'resolved',
    bindings: [
      { work_item_id: 'item-a', skill_id: 'skill-a', skill_version: '1.0.0', mcp_ids: [], mode: 'parallel', source: 'automatic', depends_on: [] },
      { work_item_id: 'item-b', skill_id: 'skill-b', skill_version: '1.0.0', mcp_ids: [], mode: 'parallel', source: 'automatic', depends_on: [] },
    ], candidates: [], blockers: [], binding_digest: `sha256:${'f'.repeat(64)}`,
  }
}

function command(snapshot: { revision: number; change_id: string; correlation_id: string }, type: BoardCommandV2['type'], payload: Record<string, unknown>, id: string): BoardCommandV2 {
  return {
    schema_version: 'board-command/v2', command_id: id, idempotency_key: `idem:${id}`, expected_revision: snapshot.revision,
    actor: { kind: 'system', id: 'test' }, issued_at: now, correlation_id: snapshot.correlation_id, change_id: snapshot.change_id, type, ...payload,
  } as BoardCommandV2
}

async function fixture(dependencies: readonly { from: string; to: string }[] = [], mode: 'serial' | 'parallel' = 'parallel', pipeline?: WorkflowPipelinePlanV2) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tenon-runtime-v2-'))
  roots.push(root)
  const ledger = createOrchestrationLedger()
  await ledger.initialize(root, { project_id: 'project-1', change_id: 'change-1', correlation_id: 'corr-1', updated_at: now })
  let snapshot = (await ledger.readSnapshot(root))!
  const append = async (type: BoardCommandV2['type'], payload: Record<string, unknown>, id: string) => {
    const result = await ledger.append(root, command(snapshot, type, payload, id))
    if (result.kind !== 'committed') throw new Error(`${type} rejected: ${result.kind === 'rejected' ? result.rejection.message : 'unexpected replay'}`)
    snapshot = result.snapshot
  }
  await append('accept-request', { request: request() }, 'setup-accept')
  await append('record-context', { context: context() }, 'setup-context')
  await append('record-assessment', { assessment: assessment() }, 'setup-assessment')
  if (pipeline !== undefined) await append('freeze-pipeline', { pipeline }, 'setup-pipeline')
  await append('freeze-work-graph', { graph: graph(dependencies, mode) }, 'setup-graph')
  await append('resolve-capabilities', { resolution: resolution() }, 'setup-resolution')
  await append('start-change', {}, 'setup-start')
  return { root, ledger, snapshot }
}

function successfulExecutor(calls: string[] = []): RuntimeExecutorV2 {
  return {
    async execute(input) {
      calls.push(input.work_item_id)
      return { output: { ok: true, item: input.work_item_id }, artifacts: [], diagnostics: [] }
    },
  }
}

function report(workItemId: string, resultId: string) {
  return {
    schema_version: 'validation-report/v2' as const, record_id: `validation:${workItemId}`, project_id: 'project-1', change_id: 'change-1',
    revision: 0, correlation_id: 'corr-1', actor: { kind: 'system' as const, id: 'validator' }, created_at: now,
    report_id: `report:${workItemId}`, work_item_id: workItemId, result_id: resultId, validator_id: 'test-validator', validator_version: '1.0.0',
    status: 'pass' as const, target_digests: [], evidence_refs: [], checks: [{ id: 'contract', status: 'pass' as const }],
  }
}

describe('persistent execution runtime v2', () => {
  it('follows frozen pipeline stage order even when the graph group order differs', async () => {
    const pipeline: WorkflowPipelinePlanV2 = {
      schema_version: 'workflow-pipeline/v2', record_id: 'pipeline:ordered', project_id: 'project-1', change_id: 'change-1', revision: 2,
      correlation_id: 'corr-1', actor: { kind: 'system', id: 'planner' }, created_at: now, pipeline_id: 'ordered', pipeline_version: '1',
      workflow_id: 'custom', workflow_version: '1', workflow_source: 'user', workflow_fingerprint: `sha256:${'a'.repeat(64)}`, track_id: 'custom-track', track_revision: '1', track_source: 'user', pipeline_source: 'user', graph_id: 'graph-1', assessment_id: 'assessment-1', status: 'frozen', stage_order: ['stage-b', 'stage-a'],
      stages: [
        { stage_id: 'stage-b', name: 'B first', ordinal: 0, execution_mode: 'serial', depends_on: [], work_item_ids: ['item-b'], gate: 'none', skills: [{ binding_id: 'binding:item-b:skill-b', skill_id: 'skill-b', skill_version: '1.0.0', order: 0, role: 'user', source: 'user', mode: 'serial', depends_on: [], mcp_ids: [], validator_ids: [] }], input_refs: [], output_refs: [] },
        { stage_id: 'stage-a', name: 'A second', ordinal: 1, execution_mode: 'serial', depends_on: ['stage-b'], work_item_ids: ['item-a'], gate: 'none', skills: [{ binding_id: 'binding:item-a:skill-a', skill_id: 'skill-a', skill_version: '1.0.0', order: 0, role: 'user', source: 'user', mode: 'serial', depends_on: [], mcp_ids: [], validator_ids: [] }], input_refs: [], output_refs: [] },
      ], customizations: { custom_workflow: true, custom_track: true, custom_pipeline: true, user_skill_ids: ['skill-a', 'skill-b'], user_mcp_ids: [] }, pipeline_digest: `sha256:${'b'.repeat(64)}`,
    }
    const calls: string[] = []
    const fixtureState = await fixture([], 'parallel', pipeline)
    expect(fixtureState.snapshot.status).toBe('executing')
    const runtime = createExecutionRuntimeV2({
      change_dir: fixtureState.root, ledger: fixtureState.ledger, worker_id: 'worker-1', executor: successfulExecutor(calls), clock: () => now,
      validator: { async validate(input) { return report(input.work_item_id, input.result_id) } }, id_factory: (() => { let n = 0; return (prefix: string) => `${prefix}:${++n}` })(),
    })
    const result = await runtime.run()
    expect(result.snapshot.status).toBe('completed')
    expect(calls).toEqual(['item-b', 'item-a'])
  })

  it('executes an independent parallel wave and records validator evidence', async () => {
    const calls: string[] = []
    const fixtureState = await fixture()
    const runtime = createExecutionRuntimeV2({
      change_dir: fixtureState.root, ledger: fixtureState.ledger, worker_id: 'worker-1', executor: successfulExecutor(calls),
      validator: { async validate(input) { return report(input.work_item_id, input.result_id) } },
      clock: () => now, id_factory: (() => { let n = 0; return (prefix: string) => `${prefix}:${++n}` })(),
    })
    const result = await runtime.run()
    expect(result.ok).toBe(true)
    expect(calls.sort()).toEqual(['item-a', 'item-b'])
    expect(result.snapshot.work_items.every((item) => item.status === 'completed')).toBe(true)
    expect(result.snapshot.status).toBe('completed')
    expect(result.snapshot.validations).toHaveLength(2)
  })

  it('retries executor failures with a new attempt and preserves lineage', async () => {
    const fixtureState = await fixture([], 'serial')
    let executions = 0
    const runtime = createExecutionRuntimeV2({
      change_dir: fixtureState.root, ledger: fixtureState.ledger, worker_id: 'worker-1', clock: () => now,
      executor: { async execute() { executions += 1; if (executions === 1) throw new Error('tool unavailable'); return { output: 'ok', artifacts: [], diagnostics: [] } } },
      validator: { async validate(input) { return report(input.work_item_id, input.result_id) } },
      retry: { max_attempts: 2 }, id_factory: (() => { let n = 0; return (prefix: string) => `${prefix}:${++n}` })(),
    })
    const result = await runtime.run()
    expect(result.ok).toBe(true)
    const runs = result.snapshot.runs.filter((run) => run.work_item_id === 'item-a')
    expect(runs).toHaveLength(2)
    expect(runs[1]?.prior_attempt_id).toBe(runs[0]?.attempt_id)
    expect(runs[1]?.attempt).toBe(2)
  })

  it('honors cancellation while an executor is running and leaves no active lease', async () => {
    const fixtureState = await fixture([], 'serial')
    const controller = new AbortController()
    const runtime = createExecutionRuntimeV2({
      change_dir: fixtureState.root, ledger: fixtureState.ledger, worker_id: 'worker-1', signal: controller.signal, clock: () => now,
      executor: { async execute(input) { await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true })); return { output: 'ignored', artifacts: [], diagnostics: [] } } },
      id_factory: (() => { let n = 0; return (prefix: string) => `${prefix}:${++n}` })(),
    })
    const running = runtime.run()
    await new Promise((resolve) => setTimeout(resolve, 0))
    controller.abort()
    const result = await running
    expect(result.ok).toBe(true)
    expect(result.snapshot.status).toBe('cancelled')
    expect(result.snapshot.runs.every((run) => run.status === 'cancelled')).toBe(true)
  })

  it('recovers an expired lease before scheduling and retries the orphaned attempt', async () => {
    const fixtureState = await fixture([], 'serial')
    let snapshot = (await fixtureState.ledger.readSnapshot(fixtureState.root))!
    const append = async (type: BoardCommandV2['type'], payload: Record<string, unknown>, id: string) => {
      const result = await fixtureState.ledger.append(fixtureState.root, command(snapshot, type, payload, id))
      if (result.kind !== 'committed') throw new Error('setup command rejected')
      snapshot = result.snapshot
    }
    const run = {
      schema_version: 'skill-run/v2' as const, record_id: 'run:orphan', project_id: 'project-1', change_id: 'change-1', revision: snapshot.revision,
      correlation_id: 'corr-1', actor: { kind: 'worker' as const, id: 'worker-1' }, created_at: now, run_id: 'run:orphan', attempt_id: 'attempt:orphan',
      attempt: 1, work_item_id: 'item-a', skill_id: 'skill-a', skill_version: '1.0.0', mcp_ids: [], status: 'queued' as const, input_refs: [],
    }
    await append('enqueue-work-item', { work_item_id: 'item-a' }, 'orphan-enqueue')
    await append('claim-run', { run, lease: { lease_id: 'lease:orphan', owner_id: 'worker-1', acquired_at: now, heartbeat_at: now, expires_at: '2026-09-01T00:00:00.000Z', generation: 1, status: 'active' as const } }, 'orphan-claim')
    await append('begin-run', { run_id: 'run:orphan', lease_id: 'lease:orphan', owner_id: 'worker-1', generation: 1 }, 'orphan-begin')
    const runtime = createExecutionRuntimeV2({
      change_dir: fixtureState.root, ledger: fixtureState.ledger, worker_id: 'worker-2', clock: () => now, executor: successfulExecutor(), retry: { max_attempts: 2 },
      id_factory: (() => { let n = 0; return (prefix: string) => `${prefix}:recover:${++n}` })(),
    })
    const result = await runtime.run()
    expect(result.recovery.report.lease_decisions.some((entry) => entry.decision === 'expired-awaiting-scheduler')).toBe(true)
    expect(result.snapshot.runs.some((entry) => entry.prior_attempt_id === 'attempt:orphan')).toBe(true)
  })

  it('does not automatically retry an opaque validator failure', async () => {
    const fixtureState = await fixture([], 'serial')
    let executions = 0
    const runtime = createExecutionRuntimeV2({
      change_dir: fixtureState.root, ledger: fixtureState.ledger, worker_id: 'worker-1', clock: () => now,
      executor: { async execute() { executions += 1; return { output: 'ok', artifacts: [], diagnostics: [] } } },
      validator: { async validate() { throw new Error('validator unavailable') } }, retry: { max_attempts: 3 },
      id_factory: (() => { let n = 0; return (prefix: string) => `${prefix}:${++n}` })(),
    })
    const result = await runtime.run()
    expect(result.snapshot.status).toBe('failed')
    expect(executions).toBe(1)
    expect(result.snapshot.runs).toHaveLength(1)
  })

  it('renews the worker lease while a run is in flight', async () => {
    const fixtureState = await fixture([], 'serial')
    const runtime = createExecutionRuntimeV2({
      change_dir: fixtureState.root, ledger: fixtureState.ledger, worker_id: 'worker-1', clock: () => now,
      executor: { async execute() { await new Promise((resolve) => setTimeout(resolve, 45)); return { output: 'ok', artifacts: [], diagnostics: [] } } },
      validator: { async validate(input) { return report(input.work_item_id, input.result_id) } },
      retry: { heartbeat_interval_ms: 5, lease_duration_ms: 100 }, id_factory: (() => { let n = 0; return (prefix: string) => `${prefix}:${++n}` })(),
    })
    const result = await runtime.run()
    expect(result.snapshot.status).toBe('completed')
    expect(result.snapshot.runs.some((run) => (run.lease?.generation ?? 0) > 1)).toBe(true)
  })

  it('passes completed dependency result references into the next serial wave', async () => {
    const fixtureState = await fixture([{ from: 'item-a', to: 'item-b' }], 'serial')
    const refs: readonly string[][] = []
    const runtime = createExecutionRuntimeV2({
      change_dir: fixtureState.root, ledger: fixtureState.ledger, worker_id: 'worker-1', clock: () => now,
      executor: { async execute(input) { (refs as string[][]).push([...input.input_refs]); return { output: 'ok', artifacts: [], diagnostics: [] } } },
      validator: { async validate(input) { return report(input.work_item_id, input.result_id) } },
      id_factory: (() => { let n = 0; return (prefix: string) => `${prefix}:${++n}` })(),
    })
    const result = await runtime.run()
    expect(result.snapshot.status).toBe('completed')
    expect(refs).toHaveLength(2)
    expect(refs[1]?.some((ref) => ref.startsWith('skill-result:'))).toBe(true)
  })

  it('materializes dependency content, persists a canonical output, and records a read proof', async () => {
    const fixtureState = await fixture([{ from: 'item-a', to: 'item-b' }], 'serial')
    const bundles: RuntimeInputBundleV2[] = []
    const runtime = createExecutionRuntimeV2({
      change_dir: fixtureState.root, ledger: fixtureState.ledger, worker_id: 'worker-1', clock: () => now,
      executor: { async execute(input) {
        bundles.push(input.input_bundle)
        return { output: input.work_item_id === 'item-a' ? { value: 42 } : { consumed: true }, artifacts: [], diagnostics: [] }
      } },
      validator: { async validate(input) { return report(input.work_item_id, input.result_id) } },
      id_factory: (() => { let n = 0; return (prefix: string) => `${prefix}:${++n}` })(),
    })
    const result = await runtime.run()
    expect(result.snapshot.status).toBe('completed')
    const first = result.snapshot.results.find((entry) => entry.run_id === result.snapshot.runs.find((run) => run.work_item_id === 'item-a')?.run_id)
    expect(first?.raw_output?.ref).toMatch(/^artifact:\/\/result:/u)
    expect(first?.output_digest).toMatch(/^sha256:[a-f0-9]{64}$/u)
    const persisted = await readFile(path.join(fixtureState.root, '.tenon-artifacts', first!.result_id, 'output.json'), 'utf8')
    expect(persisted).toBe('{"value":42}')
    const downstreamBundle = bundles.find((bundle) => bundle.work_item_id === 'item-b')
    expect(downstreamBundle?.items.some((entry) => entry.ref.startsWith('skill-result:'))).toBe(true)
    expect(downstreamBundle?.items.some((entry) => entry.ref === first?.raw_output?.ref && entry.content && typeof entry.content === 'object' && !Array.isArray(entry.content) && entry.content.value === 42)).toBe(true)
    expect(result.snapshot.runs.find((run) => run.work_item_id === 'item-b')?.input_manifest?.delivery).toBe('injected')
  })

  it('uses a custom pipeline stage as the concurrency boundary and honors Skill dependencies', async () => {
    const pipeline: WorkflowPipelinePlanV2 = {
      schema_version: 'workflow-pipeline/v2', record_id: 'pipeline:parallel-stage', project_id: 'project-1', change_id: 'change-1', revision: 2,
      correlation_id: 'corr-1', actor: { kind: 'system', id: 'planner' }, created_at: now, pipeline_id: 'parallel-stage', pipeline_version: '1',
      workflow_id: 'custom', workflow_version: '1', workflow_source: 'user', workflow_fingerprint: `sha256:${'a'.repeat(64)}`, track_id: 'track', track_revision: '1', track_source: 'user', pipeline_source: 'user', graph_id: 'graph-1', assessment_id: 'assessment-1', status: 'frozen', stage_order: ['build'],
      stages: [{ stage_id: 'build', name: 'Build', ordinal: 0, execution_mode: 'parallel', depends_on: [], work_item_ids: ['item-a', 'item-b'], gate: 'none', skills: [
        { binding_id: 'binding:item-a:skill-a', skill_id: 'skill-a', skill_version: '1.0.0', order: 0, role: 'user', source: 'user', mode: 'parallel', depends_on: [], mcp_ids: [], validator_ids: [] },
        { binding_id: 'binding:item-b:skill-b', skill_id: 'skill-b', skill_version: '1.0.0', order: 1, role: 'user', source: 'user', mode: 'parallel', depends_on: ['binding:item-a:skill-a'], mcp_ids: [], validator_ids: [] },
      ], input_refs: [], output_refs: [] }], customizations: { custom_workflow: true, custom_track: true, custom_pipeline: true, user_skill_ids: ['skill-a', 'skill-b'], user_mcp_ids: [] }, pipeline_digest: `sha256:${'b'.repeat(64)}`,
    }
    const fixtureState = await fixture([], 'parallel', pipeline)
    const calls: string[] = []
    const downstreamRefs: string[] = []
    const runtime = createExecutionRuntimeV2({
      change_dir: fixtureState.root, ledger: fixtureState.ledger, worker_id: 'worker-1', clock: () => now,
      executor: { async execute(input) { calls.push(input.work_item_id); if (input.work_item_id === 'item-b') downstreamRefs.push(...input.input_refs); return { output: input.work_item_id, artifacts: [], diagnostics: [] } } },
      validator: { async validate(input) { return report(input.work_item_id, input.result_id) } },
      id_factory: (() => { let n = 0; return (prefix: string) => `${prefix}:${++n}` })(),
    })
    const result = await runtime.run()
    expect(result.snapshot.status).toBe('completed')
    expect(calls).toEqual(['item-a', 'item-b'])
    expect(downstreamRefs.some((ref) => ref.startsWith('artifact://'))).toBe(true)
  })

  it('runs independent custom-stage Skills concurrently when frozen resource claims do not conflict', async () => {
    const pipeline: WorkflowPipelinePlanV2 = {
      schema_version: 'workflow-pipeline/v2', record_id: 'pipeline:parallel-independent', project_id: 'project-1', change_id: 'change-1', revision: 2,
      correlation_id: 'corr-1', actor: { kind: 'system', id: 'planner' }, created_at: now, pipeline_id: 'parallel-independent', pipeline_version: '1', workflow_id: 'custom', workflow_version: '1', workflow_source: 'user', workflow_fingerprint: `sha256:${'a'.repeat(64)}`, track_id: 'track', track_revision: '1', track_source: 'user', pipeline_source: 'user', graph_id: 'graph-1', assessment_id: 'assessment-1', status: 'frozen', stage_order: ['build'],
      stages: [{ stage_id: 'build', name: 'Build', ordinal: 0, execution_mode: 'parallel', depends_on: [], work_item_ids: ['item-a', 'item-b'], gate: 'none', skills: [
        { binding_id: 'binding:item-a:skill-a', skill_id: 'skill-a', skill_version: '1.0.0', order: 0, role: 'user', source: 'user', mode: 'parallel', depends_on: [], mcp_ids: [], validator_ids: [], resource_claims: [{ kind: 'path', key: 'src/a', access: 'write' }] },
        { binding_id: 'binding:item-b:skill-b', skill_id: 'skill-b', skill_version: '1.0.0', order: 1, role: 'user', source: 'user', mode: 'parallel', depends_on: [], mcp_ids: [], validator_ids: [], resource_claims: [{ kind: 'path', key: 'src/b', access: 'write' }] },
      ], input_refs: [], output_refs: [] }], customizations: { custom_workflow: true, custom_track: true, custom_pipeline: true, user_skill_ids: ['skill-a', 'skill-b'], user_mcp_ids: [] }, pipeline_digest: `sha256:${'b'.repeat(64)}`,
    }
    const fixtureState = await fixture([], 'serial', pipeline)
    let inFlight = 0
    let maxInFlight = 0
    const runtime = createExecutionRuntimeV2({
      change_dir: fixtureState.root, ledger: fixtureState.ledger, worker_id: 'worker-1', clock: () => now,
      executor: { async execute(input) { inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight); await new Promise((resolve) => setTimeout(resolve, 100)); inFlight -= 1; return { output: input.work_item_id, artifacts: [], diagnostics: [] } } },
      validator: { async validate(input) { return report(input.work_item_id, input.result_id) } }, id_factory: (() => { let n = 0; return (prefix: string) => `${prefix}:${++n}` })(),
    })
    const result = await runtime.run()
    expect(result.snapshot.status).toBe('completed')
    expect(maxInFlight).toBe(2)
  })

  it('uses pipeline stage lineage and records execution consumption receipts', async () => {
    const pipeline: WorkflowPipelinePlanV2 = {
      schema_version: 'workflow-pipeline/v2', record_id: 'pipeline:artifacts', project_id: 'project-1', change_id: 'change-1', revision: 2,
      correlation_id: 'corr-1', actor: { kind: 'system', id: 'planner' }, created_at: now, pipeline_id: 'artifacts', pipeline_version: '1',
      workflow_id: 'custom', workflow_version: '1', workflow_source: 'user', workflow_fingerprint: `sha256:${'a'.repeat(64)}`, track_id: 'track', track_revision: '1', track_source: 'user', pipeline_source: 'user', graph_id: 'graph-1', assessment_id: 'assessment-1', status: 'frozen', stage_order: ['produce', 'consume'],
      stages: [
        { stage_id: 'produce', name: 'Produce', ordinal: 0, execution_mode: 'serial', depends_on: [], work_item_ids: ['item-a'], gate: 'none', skills: [{ binding_id: 'binding:item-a:skill-a', skill_id: 'skill-a', skill_version: '1.0.0', order: 0, role: 'user', source: 'user', mode: 'serial', depends_on: [], mcp_ids: [], validator_ids: [] }], input_refs: [], output_refs: [] },
        { stage_id: 'consume', name: 'Consume', ordinal: 1, execution_mode: 'serial', depends_on: ['produce'], work_item_ids: ['item-b'], gate: 'none', skills: [{ binding_id: 'binding:item-b:skill-b', skill_id: 'skill-b', skill_version: '1.0.0', order: 0, role: 'user', source: 'user', mode: 'serial', depends_on: [], mcp_ids: [], validator_ids: [] }], input_refs: [], output_refs: [] },
      ],
      customizations: { custom_workflow: true, custom_track: true, custom_pipeline: true, user_skill_ids: ['skill-a', 'skill-b'], user_mcp_ids: [] }, pipeline_digest: `sha256:${'b'.repeat(64)}`,
    }
    const fixtureState = await fixture([{ from: 'item-a', to: 'item-b' }], 'serial', pipeline)
    const service = await openArtifactService({ rootDir: fixtureState.root, scopeId: 'runtime-artifacts', now: () => now })
    let consumerCatalogEntries = 0
    const runtime = createExecutionRuntimeV2({
      change_dir: fixtureState.root, ledger: fixtureState.ledger, worker_id: 'worker-1', artifact_service: service, clock: () => now,
      executor: { async execute(input) {
        if (input.work_item_id === 'item-a') {
          await writeFile(path.join(fixtureState.root, 'shared.txt'), 'version one', 'utf8')
          await input.artifact_runtime?.publish('shared.txt', 'deliverable')
          await writeFile(path.join(fixtureState.root, 'shared.txt'), 'version two', 'utf8')
          await input.artifact_runtime?.publish('shared.txt', 'deliverable')
          return { output: 'published', artifacts: [], diagnostics: [] }
        }
        consumerCatalogEntries = input.artifact_catalog?.entries.length ?? 0
        return { output: 'consumed', consumed: [{ ref: 'shared.txt', version: 'v1', representation: 'content' }, 'shared.txt'], artifacts: [], diagnostics: [] }
      } },
      validator: { async validate(input) { return report(input.work_item_id, input.result_id) } },
      id_factory: (() => { let n = 0; return (prefix: string) => `${prefix}:${++n}` })(),
    })
    const result = await runtime.run()
    expect(result.snapshot.status).toBe('completed')
    expect(consumerCatalogEntries).toBeGreaterThan(0)
    const attempts = await service.attempts()
    expect(attempts.map((attempt) => attempt.stageId)).toEqual(['produce', 'consume'])
    const producerAttempt = attempts.find((attempt) => attempt.stageId === 'produce')!
    const consumerAttempt = attempts.find((attempt) => attempt.stageId === 'consume')!
    const catalog = await service.catalog(consumerAttempt.stageAttemptId, { includeCandidates: true, includeHistory: true })
    const shared = catalog.entries.find((entry) => entry.source?.path === 'shared.txt')!
    expect(shared.availableFromStage).toBe('produce')
    expect(shared.consumed).toBe(true)
    expect((await service.events()).some((event) => event.type === 'artifact.consumed' && event.attemptId === consumerAttempt.stageAttemptId)).toBe(true)
    expect(shared.producer?.stageAttemptId).toBe(producerAttempt.stageAttemptId)
    expect(shared.producer?.skillId).toBe('skill-a')
    expect(shared.producer?.actorId).toBe('worker-1')
    expect(shared.version).toBe('v1')
    expect(shared.affected).toBe(true)
    const latestShared = catalog.entries.find((entry) => entry.source?.path === 'shared.txt' && entry.version === 'v2')!
    expect(latestShared.consumed).toBe(true)
    expect(latestShared.affected).toBe(false)
  })

})
