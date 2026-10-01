import { afterEach, describe, expect, it } from 'vitest'
import { createTestDashboardServer } from './test-server.js'
import { resolveServerPaths } from './paths.js'
import { makeProject, makeTempHome, newStore, reqGet, reqPost, testFlow, openSSE } from './test-support.js'

describe('orchestration v2 HTTP control plane', () => {
  const servers: Array<ReturnType<typeof createTestDashboardServer>> = []
  afterEach(async () => { while (servers.length) await servers.pop()!.close() })

  it('creates, reads and streams a canonical change over real HTTP', async () => {
    const root = await makeProject()
    const home = await makeTempHome()
    const server = createTestDashboardServer({
      paths: resolveServerPaths({ home, env: {} }), hostHome: home, token: 'integration-token',
      registry: () => [root], store: newStore(), flow: testFlow(), pollIntervalMs: 10,
    })
    servers.push(server)
    const { port } = await server.listen(0, '127.0.0.1')
    const queryRoot = encodeURIComponent(root)
    const created = await reqPost(port, '/api/orchestration/changes', {
      root, project_id: 'project-1', change_id: 'change-http', correlation_id: 'corr-http',
    }, { headers: { 'X-Pipeline-Token': server.token } })
    expect(created.status).toBe(201)
    expect(created.json<{ snapshot: { revision: number } }>().snapshot.revision).toBe(0)

    const snapshot = await reqGet(port, `/api/orchestration/changes/change-http?root=${queryRoot}`)
    expect(snapshot.status).toBe(200)
    expect(snapshot.json<{ ok: boolean; snapshot: { change_id: string } }>().snapshot.change_id).toBe('change-http')

    const stream = await openSSE(port, `/api/orchestration/changes/change-http/stream?root=${queryRoot}`)
    const initial = await stream.waitFor((entry) => entry.event === 'snapshot')
    expect(JSON.parse(initial.data).snapshot.revision).toBe(0)
    stream.close()

    const unauthorized = await reqPost(port, '/api/orchestration/changes', {
      root, project_id: 'project-2', change_id: 'change-unauthorized', correlation_id: 'corr-2',
    })
    expect(unauthorized.status).toBe(401)
  })
})
