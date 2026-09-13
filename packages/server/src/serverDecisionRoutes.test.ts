import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createStateStore,
  encodeSkillInvocationEventV1,
  emptyFields,
  reviewGateBindingForState,
  readCurrentRunRevision,
  parseInteractionEventLine,
  skillInvocationProjectId,
  SKILL_INVOCATION_LEDGER_FILE,
  type PipelineState,
} from '@tenon/kernel'
import { publishInitialRunRevision } from '../../kernel/src/state/run-revision-store.js'
import { handleGetDecisionRoute } from './serverGetDecisionRoutes.js'
import { handlePostDecisionRoutes } from './serverPostDecisionRoutes.js'
import { readDecisionAudit } from './decisionAudit.js'

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

async function createSkillQuestionChange(adapterKind: 'native' | 'afk' = 'native') {
  const root = await mkdtemp(join(tmpdir(), 'tenon-skill-decision-route-'))
  const dir = join(root, 'openspec', 'changes', 'demo')
  await mkdir(dir, { recursive: true })
  const fields = emptyFields()
  fields.workflow = 'default'
  fields.phase = 'build'
  const state: PipelineState = { fields, runMetadata: { runId: 'run-skill-route', transitionSequence: 0 }, opaqueTail: '' }
  await publishInitialRunRevision(dir, state, '2026-09-14T00:00:00.000Z')
  const projectId = await skillInvocationProjectId(root)
  const subject = { project_id: projectId, workflow_definition_id: 'default', workflow_run_id: 'run-skill-route', step_id: 'build', step_visit: { run_id: 'run-skill-route', transition_sequence: 0 }, ...(adapterKind === 'afk' ? { attempt: { attempt_id: 'attempt-1', reservation_id: 'reservation-1' } } : {}) }
  const started = {
    schema_version: 'skill-invocation-evidence/v1' as const, event_id: 'invocation-1-started', invocation_id: 'invocation-1', sequence: 1,
    type: 'invocation-started' as const, subject, recorded_at: '2026-09-14T00:00:01.000Z',
    payload: { skill: { id: 'demo-skill', version: '1' }, input: { schema_id: 'demo-input/v1', fields: [] }, adapter: { kind: adapterKind, proof_ref: 'proof' } },
  }
  const question = {
    ...started, event_id: 'invocation-1-question', sequence: 2, type: 'question-recorded' as const,
    payload: { question_id: 'question-1', key: 'choice', schema_id: 'choice/v1', option_ids: ['yes', 'no'], requiredness: 'hard-gate' as const, shown: true },
  }
  await writeFile(join(dir, SKILL_INVOCATION_LEDGER_FILE), `${encodeSkillInvocationEventV1(started)}\n${encodeSkillInvocationEventV1(question)}\n`, 'utf8')
  return { root, dir, store: createStateStore(), cleanup: () => rm(root, { recursive: true, force: true }) }
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
      expect(interaction).toMatchObject({ event: 'review.acknowledged', actor: 'human', surface: 'dashboard', result: 'success' })

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

  it('passes the server clock into the pending projection so expired review gates are visible', async () => {
    const fixture = await createPendingChange()
    try {
      const capture = responseCapture()
      await handleGetDecisionRoute(
        request(`/api/change/demo/pending-decisions?root=${encodeURIComponent(fixture.root)}`), capture.response, '/api/change/demo/pending-decisions',
        {
          sendJson: capture.sendJson, store: fixture.store, clock: () => '2026-09-14T00:31:00.000Z',
          recordStore: { readChain: async () => [] } as never,
          workflowRootForRequest: (root) => ({ ok: true, anchor: { path: root } }) as never,
        },
      )
      expect(capture.result).toMatchObject({ status: 200, body: { items: [expect.objectContaining({ status: 'expired' })] } })
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
      expect(parseInteractionEventLine(rejectedInteraction[0]!)).toMatchObject({ event: 'review.acknowledged', result: 'rejected', actor: 'human', surface: 'dashboard' })
    } finally {
      await fixture.cleanup()
    }
  })

  it('persists an explicit HITL/AFK mode switch and redacted pending-gate observation', async () => {
    const fixture = await createPendingChange()
    try {
      const post = async (body: unknown) => {
        const capture = responseCapture()
        await handlePostDecisionRoutes(
          request('/api/change/demo/decision-mode'), capture.response, '/api/change/demo/decision-mode',
          { sendJson: capture.sendJson, readJsonBody: async () => body, isRegisteredRoot: () => true, store: fixture.store, clock: () => '2026-09-14T00:00:05.000Z', history: { append: async () => undefined } },
        )
        return capture.result
      }
      const currentRevision = (await readCurrentRunRevision(fixture.dir))?.revision ?? 0
      expect(await post({ root: fixture.root, from: 'hitl', to: 'afk', actor: 'user', expected_revision: currentRevision, idempotency_key: 'bad\nkey' })).toMatchObject({ status: 400 })
      expect(await post({ root: fixture.root, from: 'hitl', to: 'afk', actor: 'user', expected_revision: currentRevision, idempotency_key: 'mode-1' })).toMatchObject({ status: 200 })
      expect(await post({ root: fixture.root, from: 'hitl', to: 'afk', actor: 'automation', expected_revision: currentRevision, idempotency_key: 'mode-1' })).toMatchObject({ status: 409, body: { code: 'decision-ref-mismatch' } })
      expect(await post({ root: fixture.root, from: 'hitl', to: 'afk', actor: 'user', expected_revision: currentRevision, idempotency_key: 'mode-conflict' })).toMatchObject({ status: 409, body: { code: 'decision-mode-conflict' } })
      const pendingCapture = responseCapture()
      await handleGetDecisionRoute(request(`/api/change/demo/pending-decisions?root=${encodeURIComponent(fixture.root)}`), pendingCapture.response, '/api/change/demo/pending-decisions', {
        sendJson: pendingCapture.sendJson, store: fixture.store, recordStore: { readChain: async () => [] } as never,
        workflowRootForRequest: (root) => ({ ok: true, anchor: { path: root } }) as never,
      })
      const pending = (pendingCapture.result.body as { items: Array<{ ref: { id: string } }> }).items[0]!
      const security = responseCapture()
      await handlePostDecisionRoutes(
        request('/api/change/demo/pending-decision-security'), security.response, '/api/change/demo/pending-decision-security',
        { sendJson: security.sendJson, readJsonBody: async () => ({ root: fixture.root, pending_decision_id: pending.ref.id, operation: 'read-token', channel: 'hook', token_digest: null, idempotency_key: 'security-1' }), isRegisteredRoot: () => true, store: fixture.store, clock: () => '2026-09-14T00:00:06.000Z', history: { append: async () => undefined } },
      )
      expect(security.result).toMatchObject({ status: 200 })
      const securityConflict = responseCapture()
      await handlePostDecisionRoutes(
        request('/api/change/demo/pending-decision-security'), securityConflict.response, '/api/change/demo/pending-decision-security',
        { sendJson: securityConflict.sendJson, readJsonBody: async () => ({ root: fixture.root, pending_decision_id: 'wrong-ref', operation: 'read-token', channel: 'hook', token_digest: null, idempotency_key: 'security-1' }), isRegisteredRoot: () => true, store: fixture.store, clock: () => '2026-09-14T00:00:06.000Z', history: { append: async () => undefined } },
      )
      expect(securityConflict.result).toMatchObject({ status: 409, body: { code: 'decision-ref-mismatch' } })
      const rawToken = responseCapture()
      await handlePostDecisionRoutes(
        request('/api/change/demo/pending-decision-security'), rawToken.response, '/api/change/demo/pending-decision-security',
        { sendJson: rawToken.sendJson, readJsonBody: async () => ({ root: fixture.root, pending_decision_id: 'decision:raw', operation: 'read-token', channel: 'hook', token_digest: 'plaintext-token', idempotency_key: 'security-raw' }), isRegisteredRoot: () => true, store: fixture.store, clock: () => '2026-09-14T00:00:06.000Z', history: { append: async () => undefined } },
      )
      expect(rawToken.result).toMatchObject({ status: 400 })
      await expect(readDecisionAudit(fixture.dir)).resolves.toEqual([
        expect.objectContaining({ type: 'decision-mode-switched', from: 'hitl', to: 'afk', strategy: 'afk' }),
        expect.objectContaining({ type: 'pending-decision-self-approval-suspected', tokenDigest: null, operation: 'read-token' }),
      ])
      const auditGet = responseCapture()
      await handleGetDecisionRoute(request(`/api/change/demo/decision-audit?root=${encodeURIComponent(fixture.root)}`), auditGet.response, '/api/change/demo/decision-audit', {
        sendJson: auditGet.sendJson, store: fixture.store, recordStore: { readChain: async () => [] } as never,
        workflowRootForRequest: (root) => ({ ok: true, anchor: { path: root } }) as never,
      })
      expect(auditGet.result).toMatchObject({ status: 200, body: { schemaVersion: 'decision-audit/v1', items: expect.any(Array) } })
    } finally {
      await fixture.cleanup()
    }
  })

  it('answers a pending Skill question through the Dashboard adapter and is idempotent', async () => {
    const fixture = await createSkillQuestionChange()
    try {
      const getCapture = responseCapture()
      await handleGetDecisionRoute(request(`/api/change/demo/pending-decisions?root=${encodeURIComponent(fixture.root)}`), getCapture.response, '/api/change/demo/pending-decisions', {
        sendJson: getCapture.sendJson, store: fixture.store, recordStore: { readChain: async () => [] } as never,
        workflowRootForRequest: (root) => ({ ok: true, anchor: { path: root } }) as never,
      })
      const item = (getCapture.result.body as { items: Array<{ ref: { id: string }; revision: number; type: string }> }).items[0]!
      expect(item.type).toBe('skill-question')
      const post = async () => {
        const capture = responseCapture()
        await handlePostDecisionRoutes(request('/api/change/demo/decisions'), capture.response, '/api/change/demo/decisions', {
          sendJson: capture.sendJson, readJsonBody: async () => ({ root: fixture.root, ref: item.ref.id, expected_revision: item.revision, idempotency_key: 'skill-1', answer: ['yes'] }),
          isRegisteredRoot: () => true, store: fixture.store, clock: () => '2026-09-14T00:00:02.000Z', history: { append: async () => undefined },
        })
        return capture.result
      }
      expect(await post()).toMatchObject({ status: 200, body: { ok: true, idempotent: false } })
      expect((await readCurrentRunRevision(fixture.dir))?.revision).toBe(item.revision + 1)
      expect(await post()).toMatchObject({ status: 200, body: { ok: true, idempotent: true } })
      const answerConflict = responseCapture()
      await handlePostDecisionRoutes(request('/api/change/demo/decisions'), answerConflict.response, '/api/change/demo/decisions', {
        sendJson: answerConflict.sendJson, readJsonBody: async () => ({ root: fixture.root, ref: item.ref.id, expected_revision: item.revision, idempotency_key: 'skill-1', answer: ['no'] }),
        isRegisteredRoot: () => true, store: fixture.store, clock: () => '2026-09-14T00:00:02.000Z', history: { append: async () => undefined },
      })
      expect(answerConflict.result).toMatchObject({ status: 409, body: { code: 'decision-ref-mismatch' } })
    } finally {
      await fixture.cleanup()
    }
  })

  it('answers an AFK question with an explicit afk-answer decision mode', async () => {
    const fixture = await createSkillQuestionChange('afk')
    try {
      const getCapture = responseCapture()
      await handleGetDecisionRoute(request(`/api/change/demo/pending-decisions?root=${encodeURIComponent(fixture.root)}`), getCapture.response, '/api/change/demo/pending-decisions', {
        sendJson: getCapture.sendJson, store: fixture.store, recordStore: { readChain: async () => [] } as never,
        workflowRootForRequest: (root) => ({ ok: true, anchor: { path: root } }) as never,
      })
      const item = (getCapture.result.body as { items: Array<{ ref: { id: string }; revision: number; type: string }> }).items[0]!
      expect(item.type).toBe('afk')
      const capture = responseCapture()
      await handlePostDecisionRoutes(request('/api/change/demo/decisions'), capture.response, '/api/change/demo/decisions', {
        sendJson: capture.sendJson, readJsonBody: async () => ({ root: fixture.root, ref: item.ref.id, expected_revision: item.revision, idempotency_key: 'afk-1', answer: ['no'] }),
        isRegisteredRoot: () => true, store: fixture.store, clock: () => '2026-09-14T00:00:02.000Z', history: { append: async () => undefined },
      })
      expect(capture.result).toMatchObject({ status: 200, body: { ok: true, idempotent: false } })
    } finally {
      await fixture.cleanup()
    }
  })
})
