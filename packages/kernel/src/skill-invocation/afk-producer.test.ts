import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLoopLedgerStore } from '../loops/ledger-store.js'
import type { BudgetReservationRecord, ReservationActivatedRecord, SkillBundleSnapshotRecord } from '../loops/ledger-types.js'
import { createStateStore } from '../state/store.js'
import { createTransitionRecordStore } from '../state/transition-record-store.js'
import { createWorkflowRunRepository } from '../state/workflow-run-repository.js'
import { readSkillInvocationEvidence } from './repository.js'
import {
  AfkSkillInvocationProofError,
  finishDurableAfkSkillInvocations,
  startDurableAfkSkillInvocations,
} from './afk-producer.js'
import { issueVerifiedAfkInteractionReceipt } from './afk-interaction-receipt.js'

const TEST_CREATOR = { id: 'tester@tenon.test', name: 'Tester', trust: 'declared' } as const

const roots: string[] = []
const now = '2026-08-04T00:00:00.000Z'
const snapshotSha = 'd'.repeat(64)

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'tenon-afk-invocation-'))
  roots.push(root)
  const store = createStateStore()
  const changeDir = await store.init({
    repoRoot: root, name: 'demo', track: 'backend', reviewSeed: 'pending', creator: TEST_CREATOR, preset: 'full',
    clock: () => now, runId: 'run-1',
  })
  await createWorkflowRunRepository({
    store, recordStore: createTransitionRecordStore(), clock: () => now,
  }).establishRun(changeDir)
  const ledger = createLoopLedgerStore()
  const reservation: BudgetReservationRecord = {
    schema_version: 1, record_id: 'record-reservation', recorded_at: now,
    kind: 'budget-reservation', reservation_id: 'reservation-1', attempt_id: 'attempt-1',
    loop_id: 'loop-1', change: 'demo', budget_day: '2026-08-04', reserved_runs: 1,
    reserved_tokens: 1024, token_basis: 'risk-default',
    limits_snapshot: { max_runs_per_day: 4, max_in_flight: 1, on_exceed: 'skip-run' },
    expires_at: '2026-08-04T01:00:00.000Z',
  }
  const snapshot: SkillBundleSnapshotRecord = {
    schema_version: 1, record_id: 'record-snapshot', recorded_at: now,
    kind: 'skill-bundle-snapshot', attempt_id: 'attempt-1', reservation_id: 'reservation-1',
    loop_id: 'loop-1', skill_bundle_id: 'profile-1', policy_epoch: 'policy-1',
    resolution_source: 'default', workflow_run_id: 'run-1', workflow: 'default', step: 'open',
    track: 'backend', coordinate_digest: 'c'.repeat(64), snapshot_sha256: snapshotSha,
    cas_relative_path: `.pipeline/loops/skill-snapshots/sha256/${snapshotSha}`,
    slots: [{ token: 'tenon-build', alternatives: ['tenon-build'], concrete_skill_id: 'tenon-build', tree_sha256: 'e'.repeat(64) }],
  }
  const activated: ReservationActivatedRecord = {
    schema_version: 1, record_id: 'record-activated', recorded_at: now,
    kind: 'reservation-activated', reservation_id: 'reservation-1', attempt_id: 'attempt-1',
    loop_id: 'loop-1', change: 'demo', started_at: now,
  }
  await ledger.append(root, reservation)
  await ledger.append(root, snapshot)
  await ledger.append(root, activated)
  return { root, changeDir }
}

describe('durable AFK SkillInvocation producer', () => {
  it('starts and completes only from the exact durable reservation, snapshot, and activation', async () => {
    const { root, changeDir } = await fixture()
    const handles = await startDurableAfkSkillInvocations(changeDir, 'reservation-1')
    expect(handles).toHaveLength(1)
    await expect(finishDurableAfkSkillInvocations(handles))
      .rejects.toThrow(/durable terminal RunRecord/u)
    await createLoopLedgerStore().closeReservationIfOpen(root, 'reservation-1', (reservation) => ({
      schema_version: 1, record_id: 'record-run', recorded_at: now, kind: 'run',
      run_record_id: 'run-1', reservation_id: reservation.reservation_id,
      attempt_id: reservation.attempt_id, loop_id: reservation.loop_id, change: reservation.change,
      workflow_run_id: 'run-1', level: 'L1', runner: 'codex', admitted_at: now, finished_at: now, result: 'paused',
      skill_bundle_snapshot_sha256: snapshotSha,
      usage_record_ids: [], accounting: { reserved_tokens: 1024, charged_tokens: 0, charge_source: 'none' },
    }))
    await finishDurableAfkSkillInvocations(handles)
    const read = await readSkillInvocationEvidence(changeDir)
    expect(read.items[0]).toMatchObject({ status: 'completed', skill: { id: 'tenon-build' },
      subject: { attempt: { attempt_id: 'attempt-1', reservation_id: 'reservation-1' } } })
  })

  it('rejects a closed-reservation replay before issuing handles', async () => {
    const { root, changeDir } = await fixture()
    await createLoopLedgerStore().closeReservationIfOpen(root, 'reservation-1', (reservation) => ({
      schema_version: 1, record_id: 'record-run', recorded_at: now, kind: 'run',
      run_record_id: 'run-1', reservation_id: reservation.reservation_id,
      attempt_id: reservation.attempt_id, loop_id: reservation.loop_id, change: reservation.change,
      workflow_run_id: 'run-1', level: 'L1', runner: 'codex', admitted_at: now, finished_at: now, result: 'paused',
      skill_bundle_snapshot_sha256: snapshotSha,
      usage_record_ids: [], accounting: { reserved_tokens: 1024, charged_tokens: 0, charge_source: 'none' },
    }))
    await expect(startDurableAfkSkillInvocations(changeDir, 'reservation-1'))
      .rejects.toBeInstanceOf(AfkSkillInvocationProofError)
  })

  it('rejects a caller-selected reservation that has no exact durable binding', async () => {
    const { changeDir } = await fixture()
    await expect(startDurableAfkSkillInvocations(changeDir, 'reservation-forged'))
      .rejects.toBeInstanceOf(AfkSkillInvocationProofError)
    await expect(readSkillInvocationEvidence(changeDir)).resolves.toEqual({
      schema_version: 'skill-invocation-list/v1', state: 'empty', items: [],
    })
  })

  it('records a recommended default only from a sealed verified frozen-policy receipt', async () => {
    const { root, changeDir } = await fixture()
    const input = {
      schema_version: 'afk-interaction-policy-receipt/v1' as const,
      attempt_id: 'attempt-1', reservation_id: 'reservation-1', snapshot_sha256: snapshotSha,
      skill_id: 'tenon-build', recorded_at: now,
      question: {
        question_id: 'afk-default', key: 'build.mode', schema_id: 'build-mode/v1',
        option_ids: ['direct'], requiredness: 'routine' as const, shown: false,
      },
      decision: {
        decision_id: 'afk-default-decision', question_id: 'afk-default',
        mode: 'recommended-default' as const, selected_option_ids: ['direct'],
        policy: { id: 'interaction-policy', version: '7', rule_id: 'build-mode' },
        rationale_code: 'afk-conservative-default',
      },
    }
    await expect(issueVerifiedAfkInteractionReceipt(input, async () => false))
      .rejects.toThrow(/frozen interaction policy/u)
    const receipt = await issueVerifiedAfkInteractionReceipt(input, async (candidate) =>
      candidate.decision.policy.version === '7')
    const handles = await startDurableAfkSkillInvocations(changeDir, 'reservation-1', [receipt])
    expect(handles).toHaveLength(1)
    await expect(readSkillInvocationEvidence(changeDir)).resolves.toMatchObject({
      items: [{
        status: 'incomplete', questions: [{ shown: false }],
        decisions: [{ mode: 'recommended-default', selected_option_ids: ['direct'] }],
      }],
    })
    await createLoopLedgerStore().closeReservationIfOpen(root, 'reservation-1', (reservation) => ({
      schema_version: 1, record_id: 'record-run-default', recorded_at: now, kind: 'run',
      run_record_id: 'run-default', reservation_id: reservation.reservation_id,
      attempt_id: reservation.attempt_id, loop_id: reservation.loop_id, change: reservation.change,
      workflow_run_id: 'run-1', level: 'L1', runner: 'codex', admitted_at: now, finished_at: now, result: 'paused',
      skill_bundle_snapshot_sha256: snapshotSha,
      usage_record_ids: [], accounting: { reserved_tokens: 1024, charged_tokens: 0, charge_source: 'none' },
    }))
    await finishDurableAfkSkillInvocations(handles)
    await expect(readSkillInvocationEvidence(changeDir)).resolves.toMatchObject({
      items: [{ status: 'completed', questions: [{ shown: false }], decisions: [{ mode: 'recommended-default' }] }],
    })
  })
})
