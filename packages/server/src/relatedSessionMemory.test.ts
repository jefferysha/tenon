import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, realpath, rename, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { nodeMemFs, type MemFs } from '@tenon/kernel'
import { createTestDashboardServer } from './test-server.js'
import { testSessionCookie } from './test-support.js'
import { resolveServerPaths } from './paths.js'
import type {
  DashboardServer,
  RelatedSessionSearchRequest,
  RelatedSessionSearchResponse,
  RelatedSessionSearchRunner,
} from './types.js'
import { initChange, makeProject, makeTempHome, newStore, reqPost, testFlow } from './test-support.js'

const openServers: DashboardServer[] = []
const FROZEN_CLOCK = (): number => 0

afterEach(async () => {
  while (openServers.length) await openServers.pop()!.close()
})

const SUCCESS: RelatedSessionSearchResponse = {
  protocol: 'tenon-related-session-memory/v1',
  query: 'bounded memory',
  platform: 'codex',
  partial: false,
  warnings: [],
  matches: [{
    platform: 'codex',
    session_id: 'opaque-session-id',
    title: 'Earlier design discussion',
    updated_at: '2026-07-28T00:00:00.000Z',
    score: 1.5,
    hit_count: 2,
    excerpt: 'We should keep the project scope explicit.',
    descendants_merged: 0,
  }],
}

interface Harness {
  port: number
  root: string
  token: string
  calls: RelatedSessionSearchRequest[]
}

async function start(
  runner: RelatedSessionSearchRunner = async (request) => ({
    ...SUCCESS,
    query: request.query,
    platform: request.platform,
  }),
  registeredRoot?: string,
): Promise<Harness> {
  const home = await makeTempHome()
  const root = registeredRoot ?? await makeProject()
  const store = newStore()
  await initChange(store, root, 'memory-change')
  const calls: RelatedSessionSearchRequest[] = []
  const wrapped: RelatedSessionSearchRunner = (request) => {
    calls.push(request)
    return runner(request)
  }
  const server = createTestDashboardServer({
    paths: resolveServerPaths({ home, env: {} }),
    hostHome: home,
    registry: () => [root],
    store,
    flow: testFlow(),
    token: 'related-memory-token',
    relatedSessionSearch: wrapped,
  })
  openServers.push(server)
  const { port } = await server.listen(0, '127.0.0.1')
  return { port, root, token: server.token, calls }
}

function requestBody(root: string): Record<string, string> {
  return {
    root,
    name: 'memory-change',
    query: 'bounded memory',
    platform: 'codex',
  }
}

function auth(token: string): { headers: Record<string, string> } {
  return { headers: { Authorization: `Bearer ${token}` } }
}

async function prepareQueuedPost(options: {
  port: number
  token: string
  /** Session cookie (`name=value`) of the server under test. */
  cookie: string
  body: Record<string, string>
  scanSignal: SharedArrayBuffer
}): Promise<{ result: Promise<{ status: number; body: string }>; worker: Worker }> {
  const worker = new Worker(`
    const net = require('node:net')
    const { parentPort, workerData } = require('node:worker_threads')
    const signal = new Int32Array(workerData.scanSignal)
    const body = JSON.stringify(workerData.body)
    const request = [
      'POST /api/mem/related-sessions/search HTTP/1.1',
      'Host: 127.0.0.1:' + workerData.port,
      'Authorization: Bearer ' + workerData.token,
      'Cookie: ' + workerData.cookie,
      'Content-Type: application/json',
      'Content-Length: ' + Buffer.byteLength(body),
      'Connection: close',
      '',
      body,
    ].join('\\r\\n')
    const socket = net.createConnection({ host: '127.0.0.1', port: workerData.port })
    let response = ''
    socket.setEncoding('utf8')
    socket.on('connect', () => {
      parentPort.postMessage({ type: 'ready' })
      Atomics.wait(signal, 0, 0)
      socket.write(request, () => {
        Atomics.store(signal, 1, 1)
        Atomics.notify(signal, 1)
      })
    })
    socket.on('data', (chunk) => { response += chunk })
    socket.on('end', () => {
      const status = Number.parseInt(response.match(/^HTTP\\/1\\.1 (\\d{3})/)?.[1] ?? '0', 10)
      const separator = response.indexOf('\\r\\n\\r\\n')
      parentPort.postMessage({
        type: 'result',
        status,
        body: separator === -1 ? '' : response.slice(separator + 4),
      })
    })
    socket.on('error', (error) => {
      parentPort.postMessage({ type: 'error', message: error.message })
    })
  `, {
    eval: true,
    workerData: options,
  })

  let ready: (() => void) | undefined
  let rejectReady: ((error: Error) => void) | undefined
  const readyPromise = new Promise<void>((resolve, reject) => {
    ready = resolve
    rejectReady = reject
  })
  const result = new Promise<{ status: number; body: string }>((resolve, reject) => {
    worker.on('message', (message: unknown) => {
      if (typeof message !== 'object' || message === null) return
      const record = message as Record<string, unknown>
      if (record.type === 'ready') {
        ready?.()
      } else if (record.type === 'result') {
        resolve({
          status: typeof record.status === 'number' ? record.status : 0,
          body: typeof record.body === 'string' ? record.body : '',
        })
      } else if (record.type === 'error') {
        reject(new Error(typeof record.message === 'string' ? record.message : 'worker request failed'))
      }
    })
    worker.on('error', (error) => {
      rejectReady?.(error)
      reject(error)
    })
  })
  await readyPromise
  return { result, worker }
}

describe('POST /api/mem/related-sessions/search', () => {
  it('runs the production kernel adapter against a bounded Codex file', async () => {
    const home = await makeTempHome()
    const root = await makeProject()
    const canonicalRoot = await realpath(root)
    const store = newStore()
    await initChange(store, root, 'memory-change')
    const sessionsDir = join(home, '.codex', 'sessions', '2026', '07')
    const sessionPath = join(
      sessionsDir,
      'rollout-2026-07-28T12-00-00-00000000-0000-0000-0000-000000000001.jsonl',
    )
    await mkdir(sessionsDir, { recursive: true })
    await writeFile(sessionPath, [
      JSON.stringify({
        timestamp: '2026-07-28T12:00:00Z',
        payload: { id: 'opaque-production-session', cwd: canonicalRoot },
      }),
      JSON.stringify({
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'bounded memory belongs to this project' }],
        },
      }),
      JSON.stringify({
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'bounded memory private assistant detail' }],
        },
      }),
    ].join('\n'))
    const server = createTestDashboardServer({
      paths: resolveServerPaths({ home, env: {} }),
      hostHome: home,
      registry: () => [root],
      store,
      flow: testFlow(),
      token: 'related-memory-token',
      // Frozen clock: the 75 ms discovery budget must not trip because the machine is loaded.
      relatedSessionNow: FROZEN_CLOCK,
    })
    openServers.push(server)
    const { port } = await server.listen(0, '127.0.0.1')

    const response = await reqPost(
      port,
      '/api/mem/related-sessions/search',
      requestBody(root),
      auth(server.token),
    )

    expect(response.status).toBe(200)
    expect(response.json()).toMatchObject({
      protocol: 'tenon-related-session-memory/v1',
      matches: [{
        platform: 'codex',
        session_id: 'opaque-production-session',
        excerpt: 'bounded memory belongs to this project',
      }],
    })
    expect(response.body).not.toContain(sessionPath)
    expect(response.body).not.toContain('private assistant detail')
  })

  it('returns the bounded v1 DTO and scopes the runner to the anchored project root', async () => {
    const h = await start()
    const canonicalRoot = await realpath(h.root)

    const response = await reqPost(
      h.port,
      '/api/mem/related-sessions/search',
      requestBody(h.root),
      auth(h.token),
    )

    expect(response.status).toBe(200)
    expect(response.json()).toEqual(SUCCESS)
    expect(h.calls).toEqual([{
      root: canonicalRoot,
      query: 'bounded memory',
      platform: 'codex',
    }])
  })

  it('uses the anchored canonical path for session scope through a symlinked ancestor', async () => {
    const physicalRoot = await makeProject()
    const canonicalRoot = await realpath(physicalRoot)
    const aliasParent = join(dirname(physicalRoot), `${basename(physicalRoot)}-alias-parent`)
    await symlink(dirname(physicalRoot), aliasParent, 'dir')
    const lexicalRoot = join(aliasParent, basename(physicalRoot))
    const h = await start(undefined, lexicalRoot)

    const response = await reqPost(
      h.port,
      '/api/mem/related-sessions/search',
      requestBody(lexicalRoot),
      auth(h.token),
    )

    expect(response.status).toBe(200)
    expect(h.calls).toEqual([{
      root: canonicalRoot,
      query: 'bounded memory',
      platform: 'codex',
    }])
  })

  it('keeps budget-limited results successful and preserves the stable partial warning', async () => {
    const h = await start(async () => ({
      ...SUCCESS,
      partial: true,
      warnings: [{
        code: 'file-read-truncated',
        message: 'At least one session exceeded the per-file read budget.',
      }],
    }))

    const response = await reqPost(
      h.port,
      '/api/mem/related-sessions/search',
      requestBody(h.root),
      auth(h.token),
    )

    expect(response.status).toBe(200)
    expect(response.json()).toMatchObject({
      partial: true,
      warnings: [{ code: 'file-read-truncated' }],
    })
  })

  it('retains the shared Host, token, and application/json guards without starting a scan', async () => {
    const h = await start()

    const noToken = await reqPost(h.port, '/api/mem/related-sessions/search', requestBody(h.root))
    expect(noToken.status).toBe(401)

    const wrongHost = await reqPost(
      h.port,
      '/api/mem/related-sessions/search',
      requestBody(h.root),
      { headers: { Authorization: `Bearer ${h.token}`, Host: 'evil.example:9999' } },
    )
    expect(wrongHost.status).toBe(403)

    const wrongType = await reqPost(
      h.port,
      '/api/mem/related-sessions/search',
      requestBody(h.root),
      {
        headers: {
          Authorization: `Bearer ${h.token}`,
          'Content-Type': 'text/plain',
        },
      },
    )
    expect(wrongType.status).toBe(400)
    expect(h.calls).toHaveLength(0)
  })

  it('returns stable invalid-request errors for malformed JSON, query bounds, and platform values', async () => {
    const h = await start()
    const badBodies: Array<{ payload: unknown; rawBody?: string }> = [
      { payload: undefined, rawBody: '{not json' },
      { payload: { ...requestBody(h.root), query: 'x' } },
      { payload: { ...requestBody(h.root), query: 'one two three four five six seven eight nine' } },
      { payload: { ...requestBody(h.root), platform: 'cursor' } },
      { payload: { ...requestBody(h.root), name: '../escape' } },
    ]

    for (const candidate of badBodies) {
      const response = await reqPost(
        h.port,
        '/api/mem/related-sessions/search',
        candidate.payload,
        { ...auth(h.token), ...(candidate.rawBody === undefined ? {} : { rawBody: candidate.rawBody }) },
      )
      expect(response.status).toBe(400)
      expect(response.json()).toMatchObject({ ok: false, code: 'invalid-request' })
    }
    expect(h.calls).toHaveLength(0)
  })

  it('returns one project-or-change-not-found shape before scanning untrusted or missing targets', async () => {
    const h = await start()
    const missingRoot = await makeProject()

    const unregistered = await reqPost(
      h.port,
      '/api/mem/related-sessions/search',
      requestBody(missingRoot),
      auth(h.token),
    )
    expect(unregistered.status).toBe(404)
    expect(unregistered.json()).toEqual({
      ok: false,
      code: 'project-or-change-not-found',
      error: 'Project or Change is unavailable',
    })

    const missingChange = await reqPost(
      h.port,
      '/api/mem/related-sessions/search',
      { ...requestBody(h.root), name: 'missing-change' },
      auth(h.token),
    )
    expect(missingChange.status).toBe(404)
    expect(missingChange.json()).toEqual(unregistered.json())
    expect(h.calls).toHaveLength(0)
  })

  it('maps Change-state inspection failures to a stable path-free unavailable response', async () => {
    const h = await start()
    const runStateDir = join(
      h.root,
      'openspec',
      'changes',
      'memory-change',
      '.pipeline-run',
    )
    await rename(runStateDir, `${runStateDir}.backup`)
    await writeFile(runStateDir, 'not-a-directory', 'utf8')

    const response = await reqPost(
      h.port,
      '/api/mem/related-sessions/search',
      requestBody(h.root),
      auth(h.token),
    )

    expect(response.status).toBe(404)
    expect(response.json()).toEqual({
      ok: false,
      code: 'project-or-change-not-found',
      error: 'Project or Change is unavailable',
    })
    expect(response.body).not.toContain(h.root)
    expect(response.body).not.toContain('ENOTDIR')
    expect(h.calls).toHaveLength(0)
  })

  it('fails closed when the registered project inode drifts and does not expose its path', async () => {
    const h = await start()
    const movedRoot = `${h.root}-moved`
    await rename(h.root, movedRoot)

    const response = await reqPost(
      h.port,
      '/api/mem/related-sessions/search',
      requestBody(h.root),
      auth(h.token),
    )

    expect(response.status).toBe(404)
    expect(response.json()).toEqual({
      ok: false,
      code: 'project-or-change-not-found',
      error: 'Project or Change is unavailable',
    })
    expect(response.body).not.toContain(h.root)
    expect(h.calls).toHaveLength(0)
  })

  it('allows only one scan per server and maps overlap to memory-search-busy', async () => {
    let release: (() => void) | undefined
    let started: (() => void) | undefined
    const startedPromise = new Promise<void>((resolve) => { started = resolve })
    const releasePromise = new Promise<void>((resolve) => { release = resolve })
    const h = await start(async () => {
      started?.()
      await releasePromise
      return SUCCESS
    })

    const first = reqPost(
      h.port,
      '/api/mem/related-sessions/search',
      requestBody(h.root),
      auth(h.token),
    )
    await startedPromise
    const second = await reqPost(
      h.port,
      '/api/mem/related-sessions/search',
      requestBody(h.root),
      auth(h.token),
    )

    expect(second.status).toBe(429)
    expect(second.json()).toEqual({
      ok: false,
      code: 'memory-search-busy',
      error: 'Related session search is already running',
    })
    expect(h.calls).toHaveLength(1)

    release?.()
    expect((await first).status).toBe(200)
  })

  it('keeps the gate observable while a synchronous scan blocks the server event loop', async () => {
    const scanSignal = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2)
    const signal = new Int32Array(scanSignal)
    const home = await makeTempHome()
    const root = await makeProject()
    const store = newStore()
    await initChange(store, root, 'memory-change')
    const sessionsDir = join(home, '.codex', 'sessions', '2026', '07')
    await mkdir(sessionsDir, { recursive: true })
    await writeFile(join(sessionsDir, 'rollout-2026-07-28T12-00-00-sync-block.jsonl'), [
      JSON.stringify({
        timestamp: '2026-07-28T12:00:00Z',
        payload: { id: 'sync-block-session', cwd: root },
      }),
      JSON.stringify({
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'bounded memory from the production kernel runner' }],
        },
      }),
    ].join('\n'))
    const sourceFs = nodeMemFs(home)
    const sourceReadTextBounded = sourceFs.readTextBounded
    expect(sourceReadTextBounded).toBeDefined()
    let boundedReads = 0
    const blockingFs: MemFs = {
      ...sourceFs,
      readTextBounded: (path, maxBytes) => {
        boundedReads += 1
        if (boundedReads === 1) {
          Atomics.store(signal, 0, 1)
          Atomics.notify(signal, 0)
          // The worker may signal before this thread starts waiting; both outcomes prove that the
          // queued request was written, while a timeout means the synchronization contract failed.
          expect(Atomics.wait(signal, 1, 0, 30_000)).not.toBe('timed-out')
        }
        return sourceReadTextBounded?.(path, maxBytes)
      },
    }
    const server = createTestDashboardServer({
      paths: resolveServerPaths({ home, env: {} }),
      hostHome: home,
      registry: () => [root],
      store,
      flow: testFlow(),
      token: 'related-memory-token',
      memFs: blockingFs,
      // The first scan blocks on purpose; a real clock would expire the discovery budget meanwhile.
      relatedSessionNow: FROZEN_CLOCK,
    })
    openServers.push(server)
    const { port } = await server.listen(0, '127.0.0.1')
    const queued = await prepareQueuedPost({
      port,
      token: server.token,
      cookie: testSessionCookie(port) ?? '',
      body: requestBody(root),
      scanSignal,
    })

    try {
      const first = reqPost(
        port,
        '/api/mem/related-sessions/search',
        requestBody(root),
        auth(server.token),
      )
      const [firstResponse, secondResponse] = await Promise.all([first, queued.result])

      expect(firstResponse.status).toBe(200)
      expect(secondResponse.status).toBe(429)
      expect(JSON.parse(secondResponse.body)).toEqual({
        ok: false,
        code: 'memory-search-busy',
        error: 'Related session search is already running',
      })
      expect(boundedReads).toBe(1)

      const afterRelease = await reqPost(
        port,
        '/api/mem/related-sessions/search',
        requestBody(root),
        auth(server.token),
      )
      expect(afterRelease.status).toBe(200)
      expect(boundedReads).toBe(2)
    } finally {
      await queued.worker.terminate()
    }
  })

  it('maps runner failures to a stable, path-free memory-search-unavailable response', async () => {
    const privatePath = join('/Users/private-person', '.codex', 'sessions', 'secret.jsonl')
    const h = await start(async () => {
      throw new Error(`EACCES reading ${privatePath}`)
    })

    const response = await reqPost(
      h.port,
      '/api/mem/related-sessions/search',
      requestBody(h.root),
      auth(h.token),
    )

    expect(response.status).toBe(500)
    expect(response.json()).toEqual({
      ok: false,
      code: 'memory-search-unavailable',
      error: 'Related session search is unavailable',
    })
    expect(response.body).not.toContain(privatePath)
  })
})
