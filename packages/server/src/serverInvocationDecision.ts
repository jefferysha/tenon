import {
  recordDashboardInvocationDecisionUnderLock,
  projectPendingDecisions,
  readCurrentRunRevision,
  publishRunRevision,
  readSkillInvocationEventsForApplication,
  withSkillInvocationChangeLock,
  type DecisionCommandResult,
  type SkillInvocationEventV1,
} from '@tenon/kernel'
import { appendDecisionIdempotency, readDecisionIdempotency } from './decisionIdempotency.js'

export async function applyInvocationDecision(input: {
  readonly dir: string
  readonly name: string
  readonly ref: string
  readonly expectedRevision: number
  readonly idempotencyKey: string
  readonly answer: readonly string[]
  readonly clock: () => string
  readonly kind: 'skill-question' | 'afk'
}): Promise<{ readonly result: DecisionCommandResult; readonly deferred: readonly string[] }> {
  let result: DecisionCommandResult | undefined
  await withSkillInvocationChangeLock(input.dir, async (lock) => {
    const records = await readDecisionIdempotency(input.dir)
    const prior = records.find((record) => record.key === input.idempotencyKey)
    if (prior !== undefined && (prior.ref !== input.ref || prior.expectedRevision !== input.expectedRevision || prior.kind !== input.kind
      || (prior.answer !== undefined && JSON.stringify(prior.answer) !== JSON.stringify(input.answer)))) {
      throw Object.assign(new Error('idempotency key is already bound to another decision'), { code: 'decision-ref-mismatch' })
    }
    if (prior !== undefined) {
      if (prior.outcome === 'rejected') {
        throw Object.assign(new Error(prior.error ?? 'decision was rejected'), { code: prior.code ?? 'decision-not-pending' })
      }
      result = { ok: true, idempotent: true, ref: { id: prior.ref, kind: prior.kind ?? input.kind, change: input.name, anchor: '', revision: prior.expectedRevision } }
      return
    }
    const current = await readCurrentRunRevision(input.dir)
    const events = await readSkillInvocationEventsForApplication(input.dir)
    if (current === undefined || current.revision !== input.expectedRevision) {
      result = { ok: false, code: 'revision-conflict', message: 'decision revision conflict' }
      return
    }
    const view = projectPendingDecisions({ change: input.name, state: current.state, revision: current.revision, now: input.clock(), invocations: events })
    const item = view.items.find((candidate) => candidate.ref.id === input.ref && candidate.type === input.kind)
    if (item === undefined || item.status !== 'pending') {
      result = { ok: false, code: 'decision-not-pending', message: 'decision is no longer pending' }
      return
    }
    if (input.answer.length === 0 || input.answer.some((value) => typeof value !== 'string' || value === '')) {
      result = { ok: false, code: 'invalid-command', message: 'answer must contain at least one option' }
      return
    }
    const [invocationId, questionId] = item.ref.anchor.split(':', 2)
    if (invocationId === undefined || questionId === undefined) {
      result = { ok: false, code: 'invalid-command', message: 'decision reference is malformed' }
      return
    }
    const invocation = events.filter((event) => event.invocation_id === invocationId)
    const started = invocation.find((event): event is Extract<SkillInvocationEventV1, { type: 'invocation-started' }> => event.type === 'invocation-started')
    const question = invocation.find((event): event is Extract<SkillInvocationEventV1, { type: 'question-recorded' }> => event.type === 'question-recorded' && event.payload.question_id === questionId)
    if (started === undefined || question === undefined || input.answer.some((option) => !question.payload.option_ids.includes(option))) {
      result = { ok: false, code: 'invalid-command', message: 'answer does not match the pending question' }
      return
    }
    const nextSequence = Math.max(...invocation.map((event) => event.sequence)) + 1
    const decision: Extract<SkillInvocationEventV1, { type: 'decision-recorded' }> = {
      ...started,
      event_id: `${invocationId}-dashboard-decision-${input.idempotencyKey}`,
      sequence: nextSequence,
      type: 'decision-recorded',
      recorded_at: input.clock(),
      payload: {
        decision_id: `${invocationId}-dashboard-${input.idempotencyKey}`,
        question_id: questionId,
        mode: input.kind === 'afk' ? 'afk-answer' : 'user-answer',
        selected_option_ids: [...input.answer],
      },
    }
    await recordDashboardInvocationDecisionUnderLock(input.dir, lock, decision, started.subject.attempt === undefined ? {} : { attempt: started.subject.attempt })
    // Invocation evidence and the canonical Change revision share this lock. A revision bump
    // makes the decision command's CAS observable to every projection reader.
    await publishRunRevision(input.dir, current, current.state, { kind: 'set', observedAt: input.clock() })
    await appendDecisionIdempotency(input.dir, {
      key: input.idempotencyKey, ref: input.ref, expectedRevision: input.expectedRevision,
      channel: 'dashboard', kind: input.kind, answer: [...input.answer], acknowledgedAt: input.clock(),
    })
    result = { ok: true, idempotent: false, ref: item.ref }
  })
  if (result === undefined) throw new Error('decision command did not produce a result')
  return { result, deferred: [] }
}
