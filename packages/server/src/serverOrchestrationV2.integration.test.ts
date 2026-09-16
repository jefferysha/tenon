import { afterEach, describe, expect, it } from 'vitest'
import { rm } from 'node:fs/promises'
import { createDashboardServer } from './server.js'
import { resolveServerPaths } from './paths.js'
import { createOrchestrationLedger, type DevelopmentRequestV2, type RepositoryContextV2 } from '@tenon/kernel'
import { artifactNamespaceForChange, openArtifactService } from '@tenon/automation'
import { initChange, makeProject, makeTempHome, newStore, openSSE, reqGet, reqPost, testFlow } from './test-support.js'
import type { DashboardServer } from './types.js'

const open: DashboardServer[] = []
const roots: string[] = []
const now = '2026-09-02T00:00:00.000Z'

afterEach(async () => {
  await Promise.all(open.splice(0).map((server) => server.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function request(root: string): DevelopmentRequestV2 {
  return {
    schema_version: 'development-request/v2', record_id: 'request:req-1', project_id: 'project-1', change_id: 'change-1',
    revision: 0, correlation_id: 'corr-1', actor: { kind: 'user', id: 'alice' }, created_at: now,
    request_id: 'req-1', intent: `Build a test in ${root}`, interaction_policy: 'recommended-defaults', requested_effects: ['read'],
    constraints: [], user_skills: [], user_mcps: [], auto_select: true,
  }
}

function context(root: string): RepositoryContextV2 {
  return {
    schema_version: 'repository-context/v2', record_id: 'context:change-1', project_id: 'project-1', change_id: 'change-1',
    revision: 0, correlation_id: 'corr-1', actor: { kind: 'system', id: 'server-test' }, created_at: now,
    request_id: 'req-1', repository: { ref: root, branch: 'main', base_branch: 'main', head_sha: 'abc', dirty: false },
    workspace_fingerprint: `sha256:${'a'.repeat(64)}`, policy_digest: `sha256:${'b'.repeat(64)}`,
    skill_catalog_digest: `sha256:${'c'.repeat(64)}`, mcp_catalog_digest: `sha256:${'d'.repeat(64)}`, observed_facts: [],
  }
}

describe('V2 orchestration dashboard HTTP integration', () => {
  it('initializes, appends, reads and streams the same durable revision chain', async () => {
    const root = await makeProject(); roots.push(root)
    await initChange(newStore(), root, 'change-1')
    const home = await makeTempHome(); roots.push(home)
    const server = createDashboardServer({
      paths: resolveServerPaths({ home, env: {} }), token: 'e2e-token', registry: () => [root],
      store: newStore(), flow: testFlow(), clock: () => now, orchestrationLedger: createOrchestrationLedger(),
    })
    open.push(server)
    const { port } = await server.listen(0, '127.0.0.1')
    const initialized = await reqPost(port, '/api/orchestration/changes', { root, project_id: 'project-1', change_id: 'change-1', correlation_id: 'corr-1' }, { headers: { Authorization: 'Bearer e2e-token' } })
    expect(initialized.status).toBe(201)
    const initBody = initialized.json<{ snapshot: { revision: number } }>()
    expect(initBody.snapshot.revision).toBe(0)
    const command = {
      schema_version: 'board-command/v2', command_id: 'cmd-accept', idempotency_key: 'idem-accept', expected_revision: 0,
      actor: { kind: 'user', id: 'alice' }, issued_at: now, correlation_id: 'corr-1', change_id: 'change-1', type: 'accept-request', request: request(root),
    }
    const appended = await reqPost(port, '/api/orchestration/changes/change-1/commands', { root, command }, { headers: { Authorization: 'Bearer e2e-token' } })
    expect(appended.status).toBe(200)
    expect(appended.json<{ snapshot: { revision: number; status: string } }>().snapshot).toMatchObject({ revision: 1, status: 'draft' })
    const read = await reqGet(port, `/api/orchestration/changes/change-1?root=${encodeURIComponent(root)}`)
    expect(read.status).toBe(200)
    expect(read.json<{ snapshot: { revision: number } }>().snapshot.revision).toBe(1)
    const metrics = await reqGet(port, `/api/orchestration/changes/change-1/metrics?root=${encodeURIComponent(root)}`)
    expect(metrics.status).toBe(200)
    expect(metrics.json<{ schema_version: string; revision: number; work_items: { total: number } }>().schema_version).toBe('orchestration-metrics/v1')
    expect(metrics.json<{ work_items: { total: number } }>().work_items.total).toBe(0)
    const stream = await openSSE(port, `/api/orchestration/changes/change-1/stream?root=${encodeURIComponent(root)}&after_revision=0`)
    const snapshotFrame = await stream.waitFor((frame) => frame.event === 'snapshot')
    expect(JSON.parse(snapshotFrame.data)).toMatchObject({ ok: true, snapshot: { revision: 1 } })
    const eventFrame = await stream.waitFor((frame) => frame.event === 'event')
    expect(JSON.parse(eventFrame.data)).toMatchObject({ event_type: 'accept-request', revision: 1 })
    stream.close()
    const unauthorized = await reqPost(port, '/api/orchestration/changes/change-1/commands', { root, command }, { headers: { Authorization: 'Bearer wrong' } })
    expect(unauthorized.status).toBe(401)
  })

  it('freezes a workflow blueprint through the real server planner and ledger', async () => {
    const root = await makeProject(); roots.push(root)
    await initChange(newStore(), root, 'change-1')
    const home = await makeTempHome(); roots.push(home)
    const ledger = createOrchestrationLedger()
    const server = createDashboardServer({
      paths: resolveServerPaths({ home, env: {} }), token: 'e2e-token', registry: () => [root],
      store: newStore(), flow: testFlow(), clock: () => now, orchestrationLedger: ledger,
    })
    open.push(server)
    const { port } = await server.listen(0, '127.0.0.1')
    const body = {
      root, request: request(root), context: context(root),
      catalog: {
        skills: [{ id: 'simple-task', version: '1.0.0', source: 'builtin', availability: 'available', capabilities: ['test.run'], supports_parallel: false, permissions: [], resource_claims: [], output_media_types: [], validators: [], depends_on: [] }],
        mcps: [], allowed_permissions: [],
      },
      workflow_definition: {
        name: 'simple', steps: [{ id: 'change', label: 'Change', gate: null, skills: [{ id: 'simple-task' }], inputs: [], outputs: [], guards: [], transitions: [] }],
      },
      workflow_track: { id: 'backend', revision: 'v1', source: 'project' },
      workflow_blueprint_mapping: { capabilitiesByStep: { change: ['test.run'] }, skillVersions: { 'simple-task': '1.0.0' } },
    }
    const frozen = await reqPost(port, '/api/orchestration/changes/change-1/freeze-pipeline', body, { headers: { Authorization: 'Bearer e2e-token' } })
    expect(frozen.status).toBe(200)
    const frozenBody = frozen.json<{ snapshot: { revision: number; pipeline?: { stage_order: string[] }; graph?: { status: string } } }>()
    expect(frozenBody.snapshot.pipeline?.stage_order).toEqual(['change'])
    expect(frozenBody.snapshot.graph?.status).toBe('frozen')
    expect(frozenBody.snapshot.revision).toBe(6)
    const emptyMapping = await reqPost(port, '/api/orchestration/changes/change-1/freeze-pipeline', {
      ...body, workflow_blueprint_mapping: { capabilitiesByStep: {} },
    }, { headers: { Authorization: 'Bearer e2e-token' } })
    expect(emptyMapping.status).toBe(422)
    expect(emptyMapping.json<{ error: string }>().error).toContain('workflow blueprint 为空')
    const events = await ledger.readEvents(`${root}/openspec/changes/change-1`)
    expect(events.map((entry) => entry.event_type)).toEqual([
      'accept-request', 'record-context', 'record-assessment', 'freeze-pipeline', 'freeze-work-graph', 'resolve-capabilities',
    ])
  })

  it('keeps a change whose artifact scope is canonical free of compatibility issues', async () => {
    const root = await makeProject(); roots.push(root)
    const store = newStore(); const changeDir = await initChange(store, root, 'change-1')
    const artifacts = await openArtifactService({ rootDir: changeDir, scopeId: artifactNamespaceForChange(changeDir), now: () => now })
    await artifacts.beginAttempt({ workflowRunId: 'run-1', stageId: 'change', stageAttemptId: 'attempt-1' })
    await artifacts.submitArtifactOutput('attempt-1', { logicalKey: 'result', path: 'artifacts/result.txt', data: 'runtime-result', mediaType: 'text/plain', disposition: 'deliverable', publish: true })
    await artifacts.endAttempt('attempt-1', 'completed')
    expect((await artifacts.attempts()).map((attempt) => attempt.stageId)).toEqual(['change'])
    const home = await makeTempHome(); roots.push(home)
    // Use the real durable service instance as the server's injected boundary;
    // this keeps the test focused on snapshot projection while avoiding a
    // second open racing the migration check in this fixture.
    const server = createDashboardServer({ paths: resolveServerPaths({ home, env: {} }), token: 'e2e-token', registry: () => [root], store, flow: testFlow(), clock: () => now, artifactServiceForRoot: async () => artifacts })
    open.push(server); const { port } = await server.listen(0, '127.0.0.1')
    const response = await reqGet(port, '/api/snapshot')
    expect(response.status).toBe(200)
    const body = response.json<{ projects: Array<{ changes: Array<{ name: string }>; compatibilityIssues?: readonly unknown[] }> }>()
    const project = body.projects.find((entry) => entry.changes.some((change) => change.name === 'change-1'))
    expect(project?.changes.map((change) => change.name)).toEqual(['change-1'])
    expect(project?.compatibilityIssues ?? []).toEqual([])
  })
})
