import { afterEach, describe, expect, it, vi } from 'vitest'
import { rm } from 'node:fs/promises'
import { createTestDashboardServer } from './test-server.js'
import { resolveServerPaths } from './paths.js'
import { makeProject, makeTempHome, reqGet, reqPost, testFlow } from './test-support.js'
import type { DashboardServer } from './types.js'
import type { PipelineCliRunner } from './operations.js'

const HOSTS = ['codex', 'claude', 'cursor', 'gemini', 'copilot', 'pi', 'devin', 'zed', 'aider', 'continue', 'cline', 'amp'] as const
const hostCatalog = {
  schema_version: 'host-target-plan/v1',
  targets: HOSTS.map((id) => ({
    id, kind: id === 'codex' || id === 'claude' ? 'native' : 'adapter', cli_flag: `--${id}`,
    target_scope: id === 'codex' || id === 'claude' ? 'user' : 'project', supported_operations: ['setup', 'update'],
    capabilities: id === 'codex' || id === 'claude'
      ? ['native-marketplace', 'managed-runtime', 'bundled-skills', 'automatic-update']
      : ['project-adapter', 'managed-runtime', 'bundled-skills'],
  })),
}

describe('catalog + adapter install real HTTP workflow', () => {
  const servers: DashboardServer[] = []
  const roots: string[] = []
  afterEach(async () => {
    while (servers.length) await servers.pop()?.close()
    while (roots.length) await rm(roots.pop()!, { recursive: true, force: true })
  })

  it('loads the catalog, starts a confirmed multi-host job and exposes terminal states', async () => {
    const home = await makeTempHome(); const root = await makeProject(); roots.push(home, root)
    const runner = vi.fn<PipelineCliRunner>().mockImplementation(async (_cwd, args) => ({
      exitCode: 0,
      stdout: args[0] === 'host-target-plan' ? JSON.stringify(hostCatalog) : '',
      stderr: '',
    }))
    const server = createTestDashboardServer({
      paths: resolveServerPaths({ home, env: {} }), hostHome: home, registry: () => [root],
      flow: testFlow(), runPipelineCli: runner, pollIntervalMs: 10,
    })
    servers.push(server)
    const { port } = await server.listen(0, '127.0.0.1')
    const catalog = await reqGet(port, `/api/catalog?root=${encodeURIComponent(root)}`)
    expect(catalog.status).toBe(200)
    expect(catalog.json<{ schema_version: string; pipelines: unknown[] }>()).toMatchObject({ schema_version: 'definition-catalog/v1' })
    expect(catalog.json<{ pipelines: unknown[] }>().pipelines.length).toBeGreaterThan(0)

    const created = await reqPost(port, '/api/adapters/install', {
      root, hosts: ['cursor', 'gemini'], dry_run: false, confirm: true,
    }, { headers: { Authorization: `Bearer ${server.token}` } })
    expect(created.status).toBe(202)
    const jobId = created.json<{ job_id: string }>().job_id
    await vi.waitFor(async () => {
      const job = await reqGet(port, `/api/adapters/install/${jobId}?root=${encodeURIComponent(root)}`)
      const states = job.json<{ states: Array<{ host: string; phase: string }> }>().states
      expect(states.filter((state) => state.phase === 'installed').map((state) => state.host)).toEqual(['cursor', 'gemini'])
    })
    expect(runner.mock.calls.map((call) => call[1])).toContainEqual(['setup', '--cursor', '--target', root, '--yes'])
  })

  it('keeps semantic fingerprints stable when only generated_at advances', async () => {
    const home = await makeTempHome(); const root = await makeProject(); roots.push(home, root)
    const runner = vi.fn<PipelineCliRunner>().mockImplementation(async (_cwd, args) => ({
      exitCode: 0,
      stdout: args[0] === 'host-target-plan' ? JSON.stringify(hostCatalog) : '',
      stderr: '',
    }))
    let now = '2026-09-02T00:00:00.000Z'
    const server = createTestDashboardServer({
      paths: resolveServerPaths({ home, env: {} }), hostHome: home, registry: () => [root],
      flow: testFlow(), runPipelineCli: runner, clock: () => now,
    })
    servers.push(server)
    const { port } = await server.listen(0, '127.0.0.1')
    const first = await reqGet(port, `/api/catalog?root=${encodeURIComponent(root)}`)
    now = '2026-09-02T00:00:01.000Z'
    const second = await reqGet(port, `/api/catalog?root=${encodeURIComponent(root)}`)
    expect(first.json<{ fingerprint: string; generated_at: string }>().fingerprint)
      .toBe(second.json<{ fingerprint: string; generated_at: string }>().fingerprint)
    expect(first.json<{ generated_at: string }>().generated_at).not.toBe(second.json<{ generated_at: string }>().generated_at)
  })
})
