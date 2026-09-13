import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type DevelopmentRequestV2,
  type RepositoryContextV2,
} from '@tenon/kernel'
import { createAutonomousOrchestratorV2 } from './autonomous-orchestrator-v2.js'
import type { PlannerCatalogInputV2 } from './planner-v2.js'

const runProcess = promisify(execFile)
const now = '2026-09-02T00:00:00.000Z'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

const request: DevelopmentRequestV2 = {
  schema_version: 'development-request/v2', record_id: 'request:real', project_id: 'project-real', change_id: 'change-real', revision: 0,
  correlation_id: 'corr-real', actor: { kind: 'user', id: 'alice' }, created_at: now, request_id: 'request-real',
  intent: 'Build a TypeScript API and run tests', interaction_policy: 'recommended-defaults', requested_effects: ['read', 'write'], constraints: [], user_skills: [], user_mcps: [], auto_select: true,
}
const context: RepositoryContextV2 = {
  schema_version: 'repository-context/v2', record_id: 'context:real', project_id: 'project-real', change_id: 'change-real', revision: 1,
  correlation_id: 'corr-real', actor: { kind: 'system', id: 'host' }, created_at: now, request_id: 'request-real',
  repository: { ref: 'real', branch: 'main', base_branch: 'main', head_sha: 'abc', dirty: false }, workspace_fingerprint: `sha256:${'1'.repeat(64)}`,
  policy_digest: `sha256:${'2'.repeat(64)}`, skill_catalog_digest: `sha256:${'3'.repeat(64)}`, mcp_catalog_digest: `sha256:${'4'.repeat(64)}`, observed_facts: [],
}
const catalog: PlannerCatalogInputV2 = { skills: [
  { id: 'ui', version: '1.0.0', source: 'builtin', availability: 'available', capabilities: ['frontend.ui'], supports_parallel: false, permissions: ['repo.write'], resource_claims: [{ kind: 'path', key: 'src/ui', access: 'write' }], output_schema_id: 'ui/output-v1', validators: ['child-validator'] },
  { id: 'api', version: '1.0.0', source: 'builtin', availability: 'available', capabilities: ['backend.api'], supports_parallel: false, permissions: ['repo.write'], resource_claims: [{ kind: 'path', key: 'src/api', access: 'write' }], output_schema_id: 'api/output-v1', validators: ['child-validator'] },
  { id: 'tests', version: '1.0.0', source: 'builtin', availability: 'available', capabilities: ['test.run'], supports_parallel: false, permissions: ['repo.read'], resource_claims: [], output_schema_id: 'test/report-v1', validators: ['child-validator'] },
], mcps: [], allowed_permissions: ['repo.read', 'repo.write'] }

describe('real workflow simulation', () => {
  it('walks request → automatic plan → durable runtime → validation gate → completed', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tenon-real-workflow-')); roots.push(root)
    const orchestrator = createAutonomousOrchestratorV2({
      change_dir: root, request, context, catalog, worker_id: 'real-worker', clock: () => now,
      executor: { async execute(input) { const child = await runProcess(process.execPath, ['-e', "process.stdout.write(JSON.stringify({ok:true}))"], { encoding: 'utf8' }); return { output: child.stdout, artifacts: [], diagnostics: [`executed:${input.work_item_id}`] } } },
      validator: { async validate(input) { return { status: 'pass', checks: [{ id: 'child-process', status: 'pass' }], target_digests: [], evidence_refs: [`run:${input.run_id}`] } } },
      id_factory: (() => { let n = 0; return (prefix: string) => `${prefix}:real:${++n}` })(),
      retry: { max_attempts: 1, max_parallel: 2 },
    })
    const outcome = await orchestrator.run()
    if (!outcome.ok) throw new Error(JSON.stringify(outcome))
    expect(outcome.plan.resolution.status).toBe('resolved')
    expect(outcome.plan.pipeline?.workflow_id).toBe('default')
    expect(outcome.plan.pipeline?.track_id).toBe('backend')
    expect(outcome.plan.pipeline?.stage_order).toEqual(['work-req-backend-api', 'work-req-test-run'])
    expect(outcome.plan.pipeline?.stages.map((stage) => stage.skills[0]?.skill_id)).toEqual(['api', 'tests'])
    expect(outcome.runtime.snapshot.pipeline?.pipeline_id).toBe('default:backend:main')
    expect(outcome.runtime.snapshot.status).toBe('completed')
    expect(outcome.runtime.snapshot.work_items.every((item) => item.status === 'completed')).toBe(true)
    expect(outcome.runtime.snapshot.gates.some((gate) => gate.status === 'passed')).toBe(true)
    const replay = await orchestrator.run()
    expect(replay.ok).toBe(true)
    if (replay.ok) expect(replay.runtime.snapshot.revision).toBe(outcome.runtime.snapshot.revision)

    const driftedCatalog: PlannerCatalogInputV2 = { ...catalog, skills: catalog.skills.map((skill) => skill.id === 'api' ? { ...skill, version: '2.0.0' } : skill) }
    const drifted = createAutonomousOrchestratorV2({
      change_dir: root, request, context, catalog: driftedCatalog, worker_id: 'real-worker', clock: () => now,
      executor: { async execute() { return { output: '{}', artifacts: [], diagnostics: [] } } },
      validator: { async validate() { return { status: 'pass', checks: [], target_digests: [], evidence_refs: [] } } },
      id_factory: (() => { let n = 0; return (prefix: string) => `${prefix}:drift:${++n}` })(), retry: { max_attempts: 1, max_parallel: 2 },
    })
    const drift = await drifted.run()
    expect(drift.ok).toBe(false)
    if (!drift.ok) expect(drift.issues).toContain('persisted-resolution-mismatch')
  })

  it('executes a project-defined workflow/track/pipeline with explicit stage and Skill order', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tenon-real-custom-pipeline-')); roots.push(root)
    const calls: string[] = []
    const orchestrator = createAutonomousOrchestratorV2({
      change_dir: root, request: { ...request, workflow_id: 'enterprise-release', track_id: 'fullstack-enterprise' }, context, catalog, worker_id: 'custom-worker', clock: () => now,
      workflow_definition: { name: 'enterprise-release', steps: [{ id: 'implementation', label: 'Implementation', skills: [{ id: 'api' }], transitions: [{ to: 'verification' }] }, { id: 'verification', label: 'Verification', gate: 'review', skills: [{ id: 'tests' }], transitions: [{ to: 'implementation' }] }] },
      workflow_track: { id: 'fullstack-enterprise', revision: 'team-42', source: 'user' },
      workflow_blueprint_mapping: { workItemIdsByStep: { implementation: ['work-req-backend-api'], verification: ['work-req-test-run'] }, skillVersions: { api: '1.0.0', tests: '1.0.0' }, pipelineVersion: '2026.09.02' },
      executor: { async execute(input) { calls.push(input.skill_id); const child = await runProcess(process.execPath, ['-e', "process.stdout.write(JSON.stringify({ok:true}))"], { encoding: 'utf8' }); return { output: child.stdout, artifacts: [], diagnostics: [`executed:${input.work_item_id}`] } } },
      validator: { async validate(input) { return { status: 'pass', checks: [{ id: 'child-process', status: 'pass' }], target_digests: [], evidence_refs: [`run:${input.run_id}`] } } },
      id_factory: (() => { let n = 0; return (prefix: string) => `${prefix}:custom:${++n}` })(), retry: { max_attempts: 1, max_parallel: 2 },
    })
    const outcome = await orchestrator.run()
    expect(outcome.ok).toBe(true)
    if (!outcome.ok || outcome.plan.pipeline === undefined) return
    expect(outcome.plan.pipeline.workflow_id).toBe('enterprise-release')
    expect(outcome.plan.pipeline.track_id).toBe('fullstack-enterprise')
    expect(outcome.plan.pipeline.stage_order).toEqual(['implementation', 'verification'])
    expect(outcome.plan.pipeline.customizations).toMatchObject({ custom_workflow: true, custom_track: true, custom_pipeline: true })
    expect(calls).toEqual(['api', 'tests'])
    expect(outcome.runtime.snapshot.status).toBe('completed')
  })

  it('resolves step mapping after assessment and rejects missing/empty mappings', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tenon-real-workflow-mapping-')); roots.push(root)
    const base = {
      change_dir: root, request: { ...request, workflow_id: 'mapped-flow', track_id: 'backend' }, context, catalog,
      worker_id: 'mapping-worker', clock: () => now,
      workflow_definition: { name: 'mapped-flow', steps: [{ id: 'build', label: 'Build', skills: [{ id: 'api' }, { id: 'tests' }] }] },
      workflow_track: { id: 'backend', source: 'project' as const },
      executor: { async execute() { return { output: '{}', artifacts: [], diagnostics: [] } } },
      validator: { async validate() { return { status: 'pass', checks: [], target_digests: [], evidence_refs: [] } } },
      retry: { max_attempts: 1, max_parallel: 1 },
    } as const
    let seenRequirements = 0
    const mapped = createAutonomousOrchestratorV2({ ...base, workflow_blueprint_mapping: (assessment) => {
      seenRequirements = assessment.requirements.length
      return { workItemIdsByStep: { build: ['work-req-backend-api', 'work-req-test-run'] }, skillVersions: { api: '1.0.0', tests: '1.0.0' } }
    } })
    const mappedOutcome = await mapped.run()
    expect(mappedOutcome.ok).toBe(true)
    expect(seenRequirements).toBeGreaterThan(0)
    if (mappedOutcome.ok) expect(mappedOutcome.plan.pipeline?.stage_order).toEqual(['build'])

    const missing = createAutonomousOrchestratorV2(base)
    await expect(missing.run()).resolves.toMatchObject({ ok: false, stage: 'planning', issues: ['workflow-blueprint-mapping-required'] })
    const empty = createAutonomousOrchestratorV2({ ...base, workflow_blueprint_mapping: () => ({ workItemIdsByStep: {} }) })
    await expect(empty.run()).resolves.toMatchObject({ ok: false, stage: 'planning', issues: ['workflow-blueprint-mapping-empty'] })
  })
})
