import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createExecutionRuntimeV2 } from '../../../../packages/automation/src/orchestration/runtime-v2.js'
import { createCodexSkillExecutorV2 } from '../../../../packages/automation/src/orchestration/codex-skill-executor-v2.js'
import { createOrchestrationLedger, type BoardCommandV2, type CapabilityAssessmentV2, type CapabilityResolutionV2, type DevelopmentRequestV2, type RepositoryContextV2, type WorkGraphV2, type WorkflowPipelinePlanV2 } from '@tenon/kernel'
import { openArtifactService } from '../../../../packages/automation/src/artifacts/service.js'
import { artifactNamespaceForChange, openArtifactSubmissionService } from '../../../../packages/automation/src/index.js'
import { readArtifactSubjectRegistry } from '../../../../packages/automation/src/submission/registry.js'

const now = new Date().toISOString()
const root = await mkdtemp(path.join(os.tmpdir(), 'tenon-production-artifact-e2e-'))
const artifactNamespace = artifactNamespaceForChange(root)
const stages = ['open', 'design', 'build', 'review', 'verify', 'package', 'acceptance'] as const
const skills = stages.map((id) => ({
  id: `real-${id}`, version: '1.0.0', source: 'builtin' as const, availability: 'available' as const,
  capabilities: ['code.edit'], supports_parallel: false, permissions: ['repo.read', 'repo.write'],
  resource_claims: [{ kind: 'path' as const, key: 'artifacts', access: 'write' as const }],
  output_schema_id: `real/${id}/v1`, validators: ['real-validator'],
}))
const request: DevelopmentRequestV2 = {
  schema_version: 'development-request/v2', record_id: 'request:production-e2e', project_id: 'production-e2e', change_id: 'artifact-lineage-e2e', revision: 0,
  correlation_id: 'corr:production-e2e', actor: { kind: 'user', id: 'e2e' }, created_at: now, request_id: 'request:production-e2e',
  intent: 'Run a complete seven-stage artifact workflow', interaction_policy: 'recommended-defaults', requested_effects: ['read', 'write'], constraints: [],
  user_skills: stages.map((id, index) => ({ id: `real-${id}`, version: '1.0.0', mode: 'serial' as const, depends_on: index === 0 ? [] : [`real-${stages[index - 1]}`] })), user_mcps: [], auto_select: false,
}
const context: RepositoryContextV2 = {
  schema_version: 'repository-context/v2', record_id: 'context:production-e2e', project_id: request.project_id, change_id: request.change_id, revision: 1,
  correlation_id: request.correlation_id, actor: { kind: 'system', id: 'e2e' }, created_at: now, request_id: request.request_id,
  repository: { ref: root, branch: 'e2e', base_branch: 'e2e', head_sha: 'workspace', dirty: true }, workspace_fingerprint: `sha256:${'1'.repeat(64)}`,
  policy_digest: `sha256:${'2'.repeat(64)}`, skill_catalog_digest: `sha256:${'3'.repeat(64)}`, mcp_catalog_digest: `sha256:${'4'.repeat(64)}`, observed_facts: [],
}
const pipeline: WorkflowPipelinePlanV2 = {
  schema_version: 'workflow-pipeline/v2', record_id: 'pipeline:production-e2e', project_id: request.project_id, change_id: request.change_id, revision: 4,
  correlation_id: request.correlation_id, actor: { kind: 'system', id: 'e2e' }, created_at: now,
  workflow_id: 'production-artifact-e2e', workflow_version: '1', workflow_source: 'user', workflow_fingerprint: `sha256:${'5'.repeat(64)}`,
  track_id: 'backend', track_revision: '1', track_source: 'user', pipeline_id: 'production-artifact-e2e:backend', pipeline_version: '1', pipeline_source: 'user',
  graph_id: 'graph:production-e2e', assessment_id: 'assessment:production-e2e', status: 'frozen', stage_order: [...stages],
  stages: stages.map((id, index) => ({
    stage_id: id, name: id, ordinal: index, execution_mode: 'serial' as const, depends_on: index === 0 ? [] : [stages[index - 1]],
    work_item_ids: [`work-real-${id}`], gate: 'none' as const, input_refs: [], output_refs: [`artifact:${id}`],
    skills: [{ binding_id: `binding:real-${id}`, skill_id: `real-${id}`, skill_version: '1.0.0', role: 'user' as const, source: 'user' as const, mode: 'serial' as const, depends_on: index === 0 ? [] : [`real-${stages[index - 1]}`], mcp_ids: [], validator_ids: ['real-validator'], order: 0 }],
  })),
  customizations: { custom_workflow: true, custom_track: true, custom_pipeline: true, user_skill_ids: skills.map((skill) => skill.id), user_mcp_ids: [] }, pipeline_digest: `sha256:${'6'.repeat(64)}`,
}
const prompt = (input: { readonly work_item_id: string }): string => {
  const stage = input.work_item_id.slice('work-real-'.length)
  const index = stages.indexOf(stage as typeof stages[number])
  const contract = index === 2
    ? 'Rewrite artifacts/contract.md with exactly `contract-v2` (this creates a new version; the consumer must be able to read v1).'
    : index === 0
      ? 'Create artifacts/contract.md containing exactly `contract-v1`.'
      : `Create artifacts/${stage}.txt containing exactly ${stage}.`
  const consume = index >= 3 ? 'Declare consumed: [{"ref":"artifacts/contract.md","version":"v1","representation":"summary"}] in your final envelope.' : ''
  return `You are running stage ${stage} in a real governed workflow. ${contract} ${consume} Then emit only one final JSON envelope inside <output>...</output> with output, artifacts (publish files using relative refs), consumed, and diagnostics. For files you changed, artifacts must include {"ref":"artifacts/${index === 2 ? 'contract.md' : `${stage}.txt`}","kind":"file"}. Do not claim a file you did not create.`
}
try {
  await writeFile(path.join(root, 'README.txt'), 'production e2e\n', 'utf8')
  await mkdir(path.join(root, 'artifacts'), { recursive: true })
  await writeFile(path.join(root, 'artifacts', 'contract.md'), 'contract-v1\n', 'utf8')
  const projection = await openArtifactSubmissionService({
    changeDir: root,
    namespace: artifactNamespace,
    document: { record: async () => ({}) },
    field: { record: async () => ({}) },
  })
  const documentReceipt = await projection.submit({ projection: 'document', logicalKey: 'document:design', path: 'artifacts/contract.md', documentKind: 'design', producer: 'e2e-document', recordedAt: now })
  const fieldReceipt = await projection.submit({ projection: 'field', logicalKey: 'field:design_doc', path: 'artifacts/contract.md', field: 'design_doc', value: 'artifacts/contract.md', producer: 'e2e-field', recordedAt: now })
  if (documentReceipt.status !== 'committed' || fieldReceipt.status !== 'committed') throw new Error('canonical projection setup failed')
  const ledger = createOrchestrationLedger()
  await ledger.initialize(root, { project_id: request.project_id, change_id: request.change_id, correlation_id: request.correlation_id, updated_at: now })
  let snapshot = (await ledger.readSnapshot(root))!
  const append = async (type: BoardCommandV2['type'], payload: Record<string, unknown>, id: string): Promise<void> => {
    const command = { schema_version: 'board-command/v2' as const, command_id: id, idempotency_key: `idem:${id}`, expected_revision: snapshot.revision, actor: { kind: 'system' as const, id: 'production-e2e' }, issued_at: now, correlation_id: request.correlation_id, change_id: request.change_id, type, ...payload } as BoardCommandV2
    const result = await ledger.append(root, command); if (result.kind !== 'committed') throw new Error(`${type} rejected: ${JSON.stringify(result)}`); snapshot = result.snapshot
  }
  const assessment: CapabilityAssessmentV2 = { schema_version: 'capability-assessment/v2', record_id: 'assessment:production-e2e', project_id: request.project_id, change_id: request.change_id, revision: 2, correlation_id: request.correlation_id, actor: { kind: 'system', id: 'e2e' }, created_at: now, assessment_id: 'assessment:production-e2e', request_id: request.request_id, context_record_id: context.record_id, normalization: 'complete', requirements: stages.map((id) => ({ id: `req-${id}`, capability: `workflow.${id}`, necessity: 'required' as const, acceptance_refs: [], evidence_refs: [], constraints: [], risk: 'low' as const })), questions: [], risks: [], proposal_evidence_ref: 'e2e' }
  const graph: WorkGraphV2 = { schema_version: 'work-graph/v2', record_id: 'graph:production-e2e', project_id: request.project_id, change_id: request.change_id, revision: 3, correlation_id: request.correlation_id, actor: { kind: 'system', id: 'e2e' }, created_at: now, graph_id: 'graph:production-e2e', graph_revision: 1, assessment_id: assessment.assessment_id, task_plan_revision_id: 'plan:production-e2e', task_plan_digest: `sha256:${'7'.repeat(64)}`, dependency_edges: stages.slice(1).map((id, index) => ({ from: `work-real-${stages[index]}`, to: `work-real-${id}`, reason: 'ordering' as const })), execution_groups: [{ id: 'serial', mode: 'serial', work_item_ids: stages.map((id) => `work-real-${id}`) }], acceptance_coverage: [], status: 'frozen' }
  const resolution: CapabilityResolutionV2 = { schema_version: 'capability-resolution/v2', record_id: 'resolution:production-e2e', project_id: request.project_id, change_id: request.change_id, revision: 4, correlation_id: request.correlation_id, actor: { kind: 'system', id: 'e2e' }, created_at: now, resolution_id: 'resolution:production-e2e', assessment_id: assessment.assessment_id, graph_id: graph.graph_id, policy_digest: `sha256:${'8'.repeat(64)}`, status: 'resolved', bindings: stages.map((id, index) => ({ work_item_id: `work-real-${id}`, skill_id: `real-${id}`, skill_version: '1.0.0', mcp_ids: [], mode: 'serial' as const, source: 'user' as const, depends_on: index === 0 ? [] : [`real-${stages[index - 1]}`] })), candidates: [], blockers: [], binding_digest: `sha256:${'9'.repeat(64)}` }
  await append('accept-request', { request }, 'accept'); await append('record-context', { context }, 'context'); await append('record-assessment', { assessment }, 'assessment'); await append('freeze-pipeline', { pipeline }, 'pipeline'); await append('freeze-work-graph', { graph }, 'graph'); await append('resolve-capabilities', { resolution }, 'resolution'); await append('start-change', {}, 'start')
  const runtime = createExecutionRuntimeV2({
    change_dir: root, ledger, worker_id: 'production-e2e-worker', clock: () => now, executor: createCodexSkillExecutorV2({ change_dir: root, prompt }),
    validator: { async validate(input) { return { status: 'pass', checks: [{ id: 'production-e2e', status: 'pass' }], target_digests: [], evidence_refs: [`run:${input.run_id}`] } } },
    retry: { max_attempts: 2, max_parallel: 1 },
  })
  const outcome = await runtime.run()
  const service = await openArtifactService({ rootDir: root, scopeId: artifactNamespace })
  const attempts = await service.attempts()
  const consumer = attempts.find((attempt) => attempt.stageId === 'acceptance')
  const catalog = consumer === undefined ? undefined : await service.catalog(consumer.stageAttemptId, { includeCandidates: true, includeHistory: true })
  const events = await service.events(0, 1000)
  const registry = await readArtifactSubjectRegistry(root)
  const runtimeDesign = registry.records.find((record) => record.projection === 'runtime' && record.path === 'artifacts/contract.md')
  const evidence = { root, artifactNamespace, ok: outcome.ok, status: outcome.snapshot.status, attempts, catalog, events, registry, runtimeDiagnostics: outcome.diagnostics, output: outcome.snapshot }
  await writeFile(path.join(process.cwd(), '.trellis/tasks/09-12-fix-artifact-lineage-workflow/live-evidence/production-runtime-e2e.json'), JSON.stringify(evidence, null, 2), 'utf8')
  const completedStageIds = new Set(attempts.filter((attempt) => attempt.status === 'completed').map((attempt) => attempt.stageId))
  if (!outcome.ok || outcome.snapshot.status !== 'completed' || completedStageIds.size !== stages.length) throw new Error(`production workflow failed: ${JSON.stringify({ ok: outcome.ok, status: outcome.snapshot.status, attempts: attempts.length, completedStageIds: [...completedStageIds] })}`)
  if (catalog === undefined || !catalog.entries.some((entry) => entry.source?.path === 'artifacts/contract.md' && entry.availableFromStage === 'open')) throw new Error('producer stage projection missing')
  if (!events.some((event) => event.type === 'artifact.consumed')) throw new Error('execution read receipt missing')
  if (runtimeDesign === undefined || runtimeDesign.subjectRef.subject_id !== documentReceipt.subjectRef.subject_id || runtimeDesign.subjectRef.subject_id !== fieldReceipt.subjectRef.subject_id) throw new Error(`runtime projection did not converge: ${JSON.stringify({ document: documentReceipt.subjectRef.subject_id, field: fieldReceipt.subjectRef.subject_id, runtime: runtimeDesign?.subjectRef.subject_id })}`)
  const restarted = await openArtifactService({ rootDir: root, scopeId: artifactNamespace })
  if ((await restarted.events(0, 1000)).length !== events.length) throw new Error('event replay changed after restart')
  console.log(JSON.stringify({ root, status: outcome.snapshot.status, attempts: attempts.map((attempt) => ({ stageId: attempt.stageId, stageAttemptId: attempt.stageAttemptId })), artifactEvents: events.length, catalogEntries: catalog.entries.length }))
} finally {
  if (process.env.KEEP_PRODUCTION_E2E !== '1') await rm(root, { recursive: true, force: true })
}
