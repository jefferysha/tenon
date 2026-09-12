import { describe, expect, it, vi } from 'vitest'
import type {
  BoardCommandV2,
  BoardEventV2,
  BoardSnapshotV2,
  LedgerAppendResult,
  OrchestrationLedger,
} from '@tenon/kernel'
import {
  resolveOrchestrationV2GetRoute,
  resolveOrchestrationV2PostRoute,
  type OrchestrationV2RouteDeps,
} from './serverOrchestrationV2Routes.js'

const snapshot = {
  schema_version: 'board-snapshot/v2',
  record_id: 'board:change-1', project_id: 'project-1', change_id: 'change-1', revision: 2,
  correlation_id: 'corr-1', actor: { kind: 'system', id: 'kernel' },
  created_at: '2026-09-01T00:00:00.000Z', status: 'draft', work_items: [], runs: [],
  results: [], validations: [], gates: [], leases: [], blockers: [], next_actions: [],
  updated_at: '2026-09-01T00:00:02.000Z',
} as BoardSnapshotV2

const event = (revision: number): BoardEventV2 => ({
  schema_version: 'board-event/v2', event_id: `event-${revision}`, event_type: 'accept-request',
  command_id: `command-${revision}`, idempotency_key: `idem-${revision}`, project_id: 'project-1',
  change_id: 'change-1', correlation_id: 'corr-1', actor: { kind: 'system', id: 'kernel' },
  revision, issued_at: `2026-09-01T00:00:0${revision}.000Z`, before_digest: `sha256:${'a'.repeat(64)}`,
  after_digest: `sha256:${'b'.repeat(64)}`, payload: {} as BoardCommandV2,
  effects: [],
})

function deps(overrides: Partial<OrchestrationV2RouteDeps> = {}): OrchestrationV2RouteDeps {
  const ledger: OrchestrationLedger = {
    initialize: vi.fn(async () => snapshot),
    readSnapshot: vi.fn(async () => snapshot),
    readEvent: vi.fn(async (_dir, id) => id === 'event-1' ? event(1) : undefined),
    readEvents: vi.fn(async (_dir, options) => [event(1), event(2)].filter((e) =>
      (options?.fromRevision === undefined || e.revision >= options.fromRevision)
      && (options?.toRevision === undefined || e.revision <= options.toRevision))),
    append: vi.fn(async (): Promise<LedgerAppendResult> => ({ kind: 'replayed', event: event(2), snapshot, replayed: true })),
    recover: vi.fn(async () => ({ snapshot, events: [event(1), event(2)], report: {} as never })),
  }
  return {
    ledger,
    workflowRootForRequest: () => ({ ok: true as const, anchor: { path: '/repo' } as never }),
    ...overrides,
  }
}

const commandBody = {
  root: '/repo',
  command: {
    schema_version: 'board-command/v2', command_id: 'command-3', idempotency_key: 'idem-3',
    expected_revision: 2, actor: { kind: 'user', id: 'alice' }, issued_at: '2026-09-01T00:00:03.000Z',
    correlation_id: 'corr-1', change_id: 'change-1', type: 'pause-change', reason: 'operator pause',
  },
}

describe('orchestration v2 route boundary', () => {
  it('reads current snapshot only after validating root and change path', async () => {
    const result = await resolveOrchestrationV2GetRoute(
      '/api/orchestration/changes/change-1?root=%2Frepo',
      '/api/orchestration/changes/change-1', deps(),
    )
    expect(result).toEqual({ status: 200, body: { ok: true, snapshot } })
    await expect(resolveOrchestrationV2GetRoute(
      '/api/orchestration/changes/..%2Fsecret?root=%2Frepo',
      '/api/orchestration/changes/..%2Fsecret', deps(),
    )).resolves.toMatchObject({ status: 400, body: { ok: false, code: 'ORCHESTRATION_V2_CHANGE_INVALID' } })
    await expect(resolveOrchestrationV2GetRoute(
      '/api/orchestration/changes/change-1?root=%2Foutside',
      '/api/orchestration/changes/change-1', deps({ workflowRootForRequest: () => ({ ok: false as const, code: 403, error: 'forbidden' }) }),
    )).resolves.toMatchObject({ status: 403, body: { ok: false, code: 'ORCHESTRATION_V2_ROOT_FORBIDDEN' } })
  })

  it('returns bounded event replay by revision cursor', async () => {
    const result = await resolveOrchestrationV2GetRoute(
      '/api/orchestration/changes/change-1/events?root=%2Frepo&after_revision=1&limit=1',
      '/api/orchestration/changes/change-1/events', deps(),
    )
    expect(result).toEqual({ status: 200, body: { ok: true, events: [event(2)], from_revision: 2, to_revision: 2, current_revision: 2 } })
    await expect(resolveOrchestrationV2GetRoute(
      '/api/orchestration/changes/change-1/events?root=%2Frepo&after_revision=-1',
      '/api/orchestration/changes/change-1/events', deps(),
    )).resolves.toMatchObject({ status: 400, body: { ok: false, code: 'ORCHESTRATION_V2_CURSOR_INVALID' } })
  })

  it('maps CAS conflicts to 409 and preserves idempotent replay', async () => {
    const conflictDeps = deps({ ledger: {
      ...deps().ledger,
      append: vi.fn(async (): Promise<LedgerAppendResult> => ({ kind: 'rejected', rejection: {
        code: 'revision-conflict', reason_code: 'stale-revision', message: 'stale', next_actions: ['reload-snapshot'],
      } })),
    } })
    await expect(resolveOrchestrationV2PostRoute('/api/orchestration/changes/change-1/commands', commandBody, conflictDeps))
      .resolves.toMatchObject({ status: 409, body: { ok: false, code: 'ORCHESTRATION_V2_REVISION_CONFLICT', current_revision: 2 } })

    const replay = await resolveOrchestrationV2PostRoute('/api/orchestration/changes/change-1/commands', commandBody, deps())
    expect(replay).toEqual({ status: 200, body: { ok: true, replayed: true, event: event(2), snapshot } })
  })

  it('rejects malformed command bodies and traversal before calling ledger', async () => {
    const routeDeps = deps()
    const result = await resolveOrchestrationV2PostRoute('/api/orchestration/changes/../commands', commandBody, routeDeps)
    expect(result).toMatchObject({ status: 400, body: { ok: false, code: 'ORCHESTRATION_V2_CHANGE_INVALID' } })
    expect(routeDeps.ledger.append).not.toHaveBeenCalled()
    await expect(resolveOrchestrationV2PostRoute(
      '/api/orchestration/changes/change-1/commands', { ...commandBody, command: { ...commandBody.command, unexpected: true } }, deps(),
    )).resolves.toMatchObject({ status: 400, body: { ok: false, code: 'ORCHESTRATION_V2_COMMAND_INVALID' } })
  })

  it('runs through the shared production runtime callback', async () => {
    const runChange = vi.fn(async () => ({ ok: true, snapshot, recovery: { report: {}, recovered: false, expired_runs: [] }, attempts: 1, diagnostics: [] }))
    const result = await resolveOrchestrationV2PostRoute('/api/orchestration/changes/change-1/run', { root: '/repo' }, deps({ runChange }))
    expect(result).toMatchObject({ status: 200, body: { ok: true, snapshot } })
    expect(runChange).toHaveBeenCalledWith('/repo/openspec/changes/change-1')
  })
})
