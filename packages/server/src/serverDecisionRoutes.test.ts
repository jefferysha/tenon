import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createStateStore,
  emptyFields,
  reviewGateBindingForState,
  serializePipeline,
  type PipelineState,
} from '@tenon/kernel'
import { handleGetDecisionRoute } from './serverGetDecisionRoutes.js'
import { handlePostDecisionRoutes } from './serverPostDecisionRoutes.js'

function request(url: string): Parameters<typeof handleGetDecisionRoute>[0] {
  return { url, headers: {} } as Parameters<typeof handleGetDecisionRoute>[0]
}

function responseCapture() {
  const result: { status?: number; body?: unknown } = {}
  return {
    result,
    response: {} as Parameters<typeof handleGetDecisionRoute>[1],
    sendJson: (_res: unknown, status: number, body: unknown) => {
      result.status = status
      result.body = body
    },
  }
}

async function createPendingChange() {
  const root = await mkdtemp(join(tmpdir(), 'tenon-decision-route-'))
  const dir = join(root, 'openspec', 'changes', 'demo')
  await mkdir(dir, { recursive: true })
  const state: PipelineState = {
    fields: {
      ...emptyFields(),
      phase: 'verify',
      review_gate_phase: 'verify',
      review_gate_event: 'verify-pass',
      review_gate_status: 'pending',
      review_requested_at: '2026-09-14T00:00:00.000Z',
    },
    opaqueTail: '',
  }
  await writeFile(join(dir, '.pipeline.yaml'), serializePipeline(state), 'utf8')
  const store = createStateStore()
  await store.write(dir, state)
  const persisted = await store.read(dir)
  const binding = reviewGateBindingForState(persisted, 'verify', 'verify-pass', '2026-09-14T00:00:00.000Z')
  await writeFile(join(dir, '.pipeline-review-gate-binding.json'), `${JSON.stringify(binding)}\n`, 'utf8')
  return { root, dir, store, cleanup: () => rm(root, { recursive: true, force: true }) }
}

describe('decision server adapters', () => {
  it('projects pending reviews without model-facing work and applies an idempotent dashboard ack', async () => {
    const fixture = await createPendingChange()
    try {
      const getCapture = responseCapture()
      await handleGetDecisionRoute(
        request(`/api/change/demo/pending-decisions?root=${encodeURIComponent(fixture.root)}`),
        getCapture.response,
        '/api/change/demo/pending-decisions',
        {
          sendJson: getCapture.sendJson,
          store: fixture.store,
          recordStore: { readChain: async () => [] } as never,
          workflowRootForRequest: (root) => ({ ok: true, anchor: { path: root } }) as never,
        },
      )
      expect(getCapture.result.status).toBe(200)
      const view = getCapture.result.body as { items: Array<{ ref: { id: string }; revision: number }> }
      expect(view.items[0]).toMatchObject({ status: 'pending', type: 'review', command: 'review-acknowledge' })
      const item = view.items[0]!
      const body = { root: fixture.root, ref: item.ref.id, expected_revision: item.revision, idempotency_key: 'dashboard-ack-1' }
      const postCapture = responseCapture()
      await handlePostDecisionRoutes(
        request('/api/change/demo/decisions'),
        postCapture.response,
        '/api/change/demo/decisions',
        {
          sendJson: postCapture.sendJson,
          readJsonBody: async () => body,
          isRegisteredRoot: (root) => root === fixture.root,
          store: fixture.store,
          clock: () => '2026-09-14T00:00:01.000Z',
          history: { append: async () => undefined },
        },
      )
      expect(postCapture.result).toMatchObject({ status: 200, body: { ok: true, idempotent: false, channel: 'dashboard' } })
      expect((await fixture.store.read(fixture.dir)).fields.review_gate_status).toBe('approved')

      const retryCapture = responseCapture()
      await handlePostDecisionRoutes(
        request('/api/change/demo/decisions'), retryCapture.response, '/api/change/demo/decisions',
        {
          sendJson: retryCapture.sendJson,
          readJsonBody: async () => body,
          isRegisteredRoot: (root) => root === fixture.root,
          store: fixture.store,
          clock: () => '2026-09-14T00:00:02.000Z',
          history: { append: async () => undefined },
        },
      )
      expect(retryCapture.result).toMatchObject({ status: 200, body: { ok: true, idempotent: true } })
      expect((await readFile(join(fixture.dir, '.pipeline-decision-idempotency.jsonl'), 'utf8')).split('\n').filter(Boolean)).toHaveLength(1)
    } finally {
      await fixture.cleanup()
    }
  })

  it('returns a 409 revision-conflict for a stale dashboard command', async () => {
    const fixture = await createPendingChange()
    try {
      const getCapture = responseCapture()
      await handleGetDecisionRoute(
        request(`/api/change/demo/pending-decisions?root=${encodeURIComponent(fixture.root)}`),
        getCapture.response,
        '/api/change/demo/pending-decisions',
        {
          sendJson: getCapture.sendJson,
          store: fixture.store,
          recordStore: { readChain: async () => [] } as never,
          workflowRootForRequest: (root) => ({ ok: true, anchor: { path: root } }) as never,
        },
      )
      const item = (getCapture.result.body as { items: Array<{ ref: { id: string } }> }).items[0]!
      const capture = responseCapture()
      await handlePostDecisionRoutes(
        request('/api/change/demo/decisions'), capture.response, '/api/change/demo/decisions',
        {
          sendJson: capture.sendJson,
          readJsonBody: async () => ({ root: fixture.root, ref: item.ref.id, expected_revision: 0, idempotency_key: 'stale-1' }),
          isRegisteredRoot: () => true,
          store: fixture.store,
          clock: () => '2026-09-14T00:00:03.000Z',
          history: { append: async () => undefined },
        },
      )
      expect(capture.result).toMatchObject({ status: 409, body: { ok: false, code: 'revision-conflict' } })
    } finally {
      await fixture.cleanup()
    }
  })

  it('does not append a rejected acknowledgement twice for the same idempotency key', async () => {
    const fixture = await createPendingChange()
    try {
      const getCapture = responseCapture()
      await handleGetDecisionRoute(
        request(`/api/change/demo/pending-decisions?root=${encodeURIComponent(fixture.root)}`),
        getCapture.response,
        '/api/change/demo/pending-decisions',
        {
          sendJson: getCapture.sendJson,
          store: fixture.store,
          recordStore: { readChain: async () => [] } as never,
          workflowRootForRequest: (root) => ({ ok: true, anchor: { path: root } }) as never,
        },
      )
      const item = (getCapture.result.body as { items: Array<{ ref: { id: string }; revision: number }> }).items[0]!
      await writeFile(join(fixture.dir, '.pipeline-review-gate-binding.json'), `${JSON.stringify({
        version: 1, phase: 'verify', event: 'verify-pass', requestedAt: '2026-09-14T00:00:00.000Z',
        decisionStateDigest: '0'.repeat(64),
      })}\n`, 'utf8')
      let historyWrites = 0
      const post = async () => {
        const capture = responseCapture()
        await handlePostDecisionRoutes(
          request('/api/change/demo/decisions'), capture.response, '/api/change/demo/decisions',
          {
            sendJson: capture.sendJson,
            readJsonBody: async () => ({ root: fixture.root, ref: item.ref.id, expected_revision: item.revision, idempotency_key: 'rejected-1' }),
            isRegisteredRoot: () => true,
            store: fixture.store,
            clock: () => '2026-09-14T00:00:04.000Z',
            history: { append: async () => { historyWrites += 1 } },
          },
        )
        return capture.result
      }
      expect(await post()).toMatchObject({ status: 409, body: { code: 'review-approval-required' } })
      expect(await post()).toMatchObject({ status: 409, body: { code: 'review-approval-required' } })
      expect(historyWrites).toBe(1)
    } finally {
      await fixture.cleanup()
    }
  })
})
