import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createStateStore,
  emptyFields,
  reviewGateBindingForState,
  readCurrentRunRevision,
  parseInteractionEventLine,
  serializePipeline,
  type PipelineState,
} from '@tenon/kernel'
import { publishInitialRunRevision } from '../../kernel/src/state/run-revision-store.js'
import { handleGetDecisionRoute } from './serverGetDecisionRoutes.js'
import { handlePostDecisionRoutes } from './serverPostDecisionRoutes.js'
import { handlePostOperationsRoutes } from './serverPostOperationsRoutes.js'

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
    runMetadata: { runId: 'run-decision-route', transitionSequence: 0, workflowPlanFingerprint: 'a'.repeat(64) },
    opaqueTail: '',
  }
  await publishInitialRunRevision(dir, state, '2026-09-14T00:00:00.000Z')
  const store = createStateStore()
  const persisted = (await readCurrentRunRevision(dir))?.state ?? await store.read(dir)
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
      const interactionRaw = await readFile(join(fixture.dir, '.pipeline-interactions.jsonl'), 'utf8')
      const interaction = parseInteractionEventLine(interactionRaw.trim())
      expect(interaction).toMatchObject({ event: 'review.acknowledged', actor: 'system', surface: 'dashboard', result: 'success' })

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

      const conflictCapture = responseCapture()
      await handlePostDecisionRoutes(
        request('/api/change/demo/decisions'), conflictCapture.response, '/api/change/demo/decisions',
        {
          sendJson: conflictCapture.sendJson,
          readJsonBody: async () => ({ ...body, expected_revision: item.revision + 1 }),
          isRegisteredRoot: (root) => root === fixture.root,
          store: fixture.store,
          clock: () => '2026-09-14T00:00:03.000Z',
          history: { append: async () => undefined },
        },
      )
      expect(conflictCapture.result).toMatchObject({ status: 409, body: { ok: false, code: 'idempotency-conflict' } })
    } finally {
      await fixture.cleanup()
    }
  })

  it('validates interaction identity for a custom workflow before approving the receipt', async () => {
    const fixture = await createPendingChange()
    try {
      const state = await fixture.store.read(fixture.dir)
      state.fields.workflow = 'custom-workflow'
      state.fields.track = 'team-track'
      state.fields.phase = 'custom-step'
      state.fields.review_gate_phase = 'custom-step'
      state.fields.review_gate_event = 'custom-pass'
      const requestedAt = '2026-09-14T00:00:00.000Z'
      state.fields.review_requested_at = requestedAt
      await fixture.store.write(fixture.dir, state, { kind: 'set-many' })
      const current = await readCurrentRunRevision(fixture.dir)
      const persisted = current?.state ?? await fixture.store.read(fixture.dir)
      await writeFile(join(fixture.dir, '.pipeline-review-gate-binding.json'), `${JSON.stringify(reviewGateBindingForState(persisted, 'custom-step', 'custom-pass', requestedAt))}\n`, 'utf8')

      const getCapture = responseCapture()
      await handleGetDecisionRoute(
        request(`/api/change/demo/pending-decisions?root=${encodeURIComponent(fixture.root)}`), getCapture.response,
        '/api/change/demo/pending-decisions', {
          sendJson: getCapture.sendJson, store: fixture.store,
          recordStore: { readChain: async () => [] } as never,
          workflowRootForRequest: (root) => ({ ok: true, anchor: { path: root } }) as never,
        },
      )
      const item = (getCapture.result.body as { items: Array<{ ref: { id: string }; revision: number }> }).items[0]!
      const postCapture = responseCapture()
      await handlePostDecisionRoutes(
        request('/api/change/demo/decisions'), postCapture.response, '/api/change/demo/decisions', {
          sendJson: postCapture.sendJson,
          readJsonBody: async () => ({ root: fixture.root, ref: item.ref.id, expected_revision: item.revision, idempotency_key: 'custom-ack-1' }),
          isRegisteredRoot: () => true, store: fixture.store,
          recordStore: { readChain: async () => [] } as never,
          clock: () => '2026-09-14T00:00:01.000Z', history: { append: async () => undefined },
        },
      )
      expect(postCapture.result).toMatchObject({ status: 200, body: { ok: true } })
      const interaction = parseInteractionEventLine((await readFile(join(fixture.dir, '.pipeline-interactions.jsonl'), 'utf8')).trim())
      expect(interaction.workflow).toBe('custom-workflow')
      expect(interaction.workflowMode).toBe('custom')
      expect(interaction.trackKind).toBe('custom')
      expect(interaction.pipelineStage).toBe('custom')
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
          readJsonBody: async () => ({ root: fixture.root, ref: item.ref.id, expected_revision: item.revision + 1, idempotency_key: 'stale-1' }),
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
            history: { append: async () => undefined },
          },
        )
        return capture.result
      }
      expect(await post()).toMatchObject({ status: 409, body: { code: 'review-approval-required' } })
      expect(await post()).toMatchObject({ status: 409, body: { code: 'review-approval-required' } })
      const rejectedInteraction = (await readFile(join(fixture.dir, '.pipeline-interactions.jsonl'), 'utf8')).split('\n').filter(Boolean)
      expect(rejectedInteraction).toHaveLength(1)
      expect(parseInteractionEventLine(rejectedInteraction[0]!)).toMatchObject({ event: 'review.acknowledged', result: 'rejected', actor: 'system', surface: 'dashboard' })
    } finally {
      await fixture.cleanup()
    }
  })

  it('returns 409 without writes when no pending receipt exists', async () => {
    const fixture = await createPendingChange()
    try {
      const before = await readCurrentRunRevision(fixture.dir)
      const capture = responseCapture()
      await handlePostDecisionRoutes(
        request('/api/change/demo/decisions'), capture.response, '/api/change/demo/decisions',
        {
          sendJson: capture.sendJson,
          readJsonBody: async () => ({ root: fixture.root, ref: 'missing-decision', expected_revision: before?.revision ?? 0, idempotency_key: 'missing-1' }),
          isRegisteredRoot: () => true,
          store: fixture.store,
          recordStore: { readChain: async () => [] } as never,
          clock: () => '2026-09-14T00:00:05.000Z',
          history: { append: async () => { throw new Error('history must not be called') } },
        },
      )
      expect(capture.result).toMatchObject({ status: 409, body: { code: 'decision-not-pending' } })
      expect((await readCurrentRunRevision(fixture.dir))?.revision).toBe(before?.revision)
      await expect(readFile(join(fixture.dir, '.pipeline-interactions.jsonl'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(join(fixture.dir, '.pipeline-decision-idempotency.jsonl'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await fixture.cleanup()
    }
  })

  it('maps a damaged idempotency ledger to 500 without mutating the canonical receipt', async () => {
    const fixture = await createPendingChange()
    try {
      const getCapture = responseCapture()
      await handleGetDecisionRoute(
        request(`/api/change/demo/pending-decisions?root=${encodeURIComponent(fixture.root)}`), getCapture.response,
        '/api/change/demo/pending-decisions', {
          sendJson: getCapture.sendJson, store: fixture.store,
          recordStore: { readChain: async () => [] } as never,
          workflowRootForRequest: (root) => ({ ok: true, anchor: { path: root } }) as never,
        },
      )
      const item = (getCapture.result.body as { items: Array<{ ref: { id: string }; revision: number }> }).items[0]!
      await writeFile(join(fixture.dir, '.pipeline-decision-idempotency.jsonl'), '{broken\n', 'utf8')
      const before = await readCurrentRunRevision(fixture.dir)
      const capture = responseCapture()
      await handlePostDecisionRoutes(
        request('/api/change/demo/decisions'), capture.response, '/api/change/demo/decisions', {
          sendJson: capture.sendJson,
          readJsonBody: async () => ({ root: fixture.root, ref: item.ref.id, expected_revision: item.revision, idempotency_key: 'damaged-1' }),
          isRegisteredRoot: () => true, store: fixture.store,
          recordStore: { readChain: async () => [] } as never,
          clock: () => '2026-09-14T00:00:06.000Z', history: { append: async () => undefined },
        },
      )
      expect(capture.result).toMatchObject({ status: 500, body: { ok: false } })
      expect((await readCurrentRunRevision(fixture.dir))?.revision).toBe(before?.revision)
      expect((await fixture.store.read(fixture.dir)).fields.review_gate_status).toBe('pending')
    } finally {
      await fixture.cleanup()
    }
  })

  it('preserves transition-controlled phase when importing a changed YAML projection', async () => {
    const fixture = await createPendingChange()
    try {
      const yamlPath = join(fixture.dir, '.pipeline.yaml')
      const yaml = serializePipeline(await fixture.store.read(fixture.dir))
      await writeFile(yamlPath, yaml, 'utf8')
      await writeFile(yamlPath, yaml.replace('phase: verify\n', 'phase: open\n'), 'utf8')
      const response = responseCapture()
      await handlePostOperationsImport(fixture, response)
      expect(response.result.status).toBe(200)
      expect((await fixture.store.read(fixture.dir)).fields.phase).toBe('verify')
    } finally {
      await fixture.cleanup()
    }
  })

})

async function handlePostOperationsImport(
  fixture: Awaited<ReturnType<typeof createPendingChange>>,
  capture: ReturnType<typeof responseCapture>,
): Promise<void> {
  await handlePostOperationsRoutes(
    request('/api/change/demo/projection'), capture.response, '/api/change/demo/projection', {
      ...({
        sendJson: capture.sendJson, readJsonBody: async () => ({ root: fixture.root, action: 'import-legacy', confirm_import: true }),
        isRegisteredRoot: (root: string) => root === fixture.root, store: fixture.store,
      } as never),
    },
  )
}
