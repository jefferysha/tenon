import { mkdir, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  createStateStore,
  deriveReviewAcknowledgeIdempotencyKey,
  isVerifiedInteractionJourney,
  readCurrentRunRevision,
  REVIEW_DECISION_IDEMPOTENCY_FILE,
  readInteractionProjection,
  replayInteractionEvents,
  REVIEW_GATE_BINDING_FILE,
  REVIEW_MARKER_PROTOCOL,
} from '@tenon/kernel'
import { freshHarness, type Harness } from '../integration-harness.js'

describe('真实 e2e —— review exit receipt（default workflow）', () => {
  let h: Harness

  beforeEach(async () => {
    h = await freshHarness()
    await h.run(['init', 'demo', '--track', 'backend', '--preset', 'full'])
    await h.seedGovernedDocumentEvidence('demo')
    expect(await h.run(['transition', 'demo', 'open-complete'])).toBe(0)
    await h.seedArtifact('demo', 'design_doc', 'openspec/changes/demo/design.md')
    expect(await h.run(['check', 'demo'])).toBe(0)
  })

  afterEach(async () => {
    await rm(h.cwd, { recursive: true, force: true })
  })

  test('进入 review phase 不写 marker；request → exact pending receipt → acknowledge → transition 消费 receipt', async () => {
    const marker = join(h.cwd, '.pipeline-pending-review')
    await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' })

    // Without any request the refusal asks for one.
    expect(await h.run(['transition', 'demo', 'explore-complete'])).toBe(2)
    expect(h.err.join('\n')).toContain('先运行 tenon review request demo --event explore-complete')

    expect(await h.run(['review', 'request', 'demo', '--event', 'explore-complete'])).toBe(0)
    const projection = await readFile(marker, 'utf8')
    expect(projection).toContain(`${REVIEW_MARKER_PROTOCOL}\n`)
    expect(projection).toContain('phase=explore\n')
    expect(projection).toContain('change=demo\n')
    expect(projection).toContain('event=explore-complete\n')
    expect(await h.read('demo')).toMatch(/^review_gate_phase: explore$/m)
    expect(await h.read('demo')).toMatch(/^review_gate_status: pending$/m)
    expect(await h.read('demo')).toMatch(/^review_gate_event: explore-complete$/m)

    // The protected fields cannot be forged through generic mutation commands.
    expect(await h.run(['set', 'demo', 'review_gate_status', 'approved'])).toBe(1)
    expect(h.err.join('\n')).toContain('由 tenon review')

    // Pending receipt is not permission: repeat transition only after the explicit acknowledgement.
    // The refusal must point at the acknowledgement, not at another request that already exists.
    expect(await h.run(['transition', 'demo', 'explore-complete'])).toBe(2)
    const pendingRefusal = h.err.join('\n')
    expect(pendingRefusal).toContain('已请求评审，正在等待用户确认')
    expect(pendingRefusal).toContain('tenon review acknowledge demo')
    expect(pendingRefusal).not.toContain('先运行 tenon review request')

    expect(await h.run(['review', 'acknowledge', 'demo'])).toBe(0)
    await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await h.read('demo')).toMatch(/^review_gate_status: approved$/m)

    expect(await h.run(['transition', 'demo', 'explore-complete'])).toBe(0)
    const state = await h.read('demo')
    expect(state).toMatch(/^phase: spec$/m)
    expect(state).not.toMatch(/^review_gate_phase:/m)
    expect(state).not.toMatch(/^review_gate_status:/m)
  })

  test('request is an exit operation: incomplete output fails check and never writes a pending receipt', async () => {
    const h2 = await freshHarness()
    try {
      await h2.run(['init', 'incomplete', '--track', 'backend', '--preset', 'full'])
      await h2.seedGovernedDocumentEvidence('incomplete')
      expect(await h2.run(['transition', 'incomplete', 'open-complete'])).toBe(0)
      expect(await h2.run(['review', 'request', 'incomplete', '--event', 'explore-complete'])).toBe(2)
      const state = await h2.read('incomplete')
      expect(state).not.toMatch(/^review_gate_status:/m)
      await expect(stat(join(h2.cwd, '.pipeline-pending-review'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(h2.cwd, { recursive: true, force: true })
    }
  })

  test('必需评审者未通过时 review request 被拒，也不写 pending receipt', async () => {
    const h2 = await freshHarness()
    try {
      await h2.run(['init', 'reviewed', '--track', 'backend', '--preset', 'full'])
      await h2.seedGovernedDocumentEvidence('reviewed')
      for (const event of ['open-complete', 'explore-complete', 'spec-complete']) {
        await h2.seedArtifact('reviewed', 'design_doc', 'openspec/changes/reviewed/design.md')
        await h2.seedArtifact('reviewed', 'plan', 'openspec/changes/reviewed/tasks.md')
        await h2.satisfyStepTests('reviewed', event.replace(/-complete$/u, ''))
        await h2.run(['review', 'request', 'reviewed', '--event', event])
        await h2.run(['review', 'acknowledge', 'reviewed'])
        expect(await h2.run(['transition', 'reviewed', event]), h2.err.join('\n')).toBe(0)
      }
      await h2.run(['set-many', 'reviewed', 'build_mode=direct', 'isolation=worktree', 'direct_override=true'])
      await h2.satisfyStepTests('reviewed', 'build')
      // pre-Verify 结论只能在本步就绪证据（必需测试）齐全之后写入。
      expect(await h2.run(['set', 'reviewed', 'pre_verify_review_result', 'pass']), h2.err.join('\n')).toBe(0)
      expect(await h2.run(['transition', 'reviewed', 'build-complete']), h2.err.join('\n')).toBe(0)
      await h2.seedArtifact('reviewed', 'verification_report', 'docs/superpowers/reports/reviewed.md')
      await h2.run(['set-many', 'reviewed', 'branch_status=handled'])
      await h2.satisfyStepTests('reviewed', 'verify')
      // verify 的必需评审者一个都没跑 → request 被拒，且不落 pending receipt。
      expect(await h2.run(['review', 'request', 'reviewed', '--event', 'verify-pass'])).toBe(2)
      expect(h2.out.join('\n')).toContain('[FAIL] agent:')
      await expect(stat(join(h2.cwd, '.pipeline-pending-review'))).rejects.toMatchObject({ code: 'ENOENT' })
      await h2.satisfyStepAgents('reviewed')
      expect(await h2.run(['review', 'request', 'reviewed', '--event', 'verify-pass']), h2.err.join('\n')).toBe(0)
      // A pending request for verify-pass does not authorise verify-fail: the refusal asks for the
      // matching request and names the event the pending one is bound to.
      expect(await h2.run(['transition', 'reviewed', 'verify-fail'])).toBe(2)
      const crossEvent = h2.err.join('\n')
      expect(crossEvent).toContain('先运行 tenon review request reviewed --event verify-fail')
      expect(crossEvent).toContain("绑定的是 event 'verify-pass'")
    } finally {
      await rm(h2.cwd, { recursive: true, force: true })
    }
  })

  test('exact review journey projects ordered request, acknowledgement, effect and valid resume', async () => {
    expect(await h.run(['review', 'request', 'demo', '--event', 'explore-complete'])).toBe(0)
    expect(await h.run(['review', 'acknowledge', 'demo'])).toBe(0)
    expect(await h.run(['transition', 'demo', 'explore-complete'])).toBe(0)
    expect(await h.run(['session', 'activate', 'demo'])).toBe(0)

    const projection = await readInteractionProjection(join(h.cwd, 'openspec/changes/demo'))
    expect(projection.kind).toBe('valid')
    if (projection.kind !== 'valid') return
    expect(projection.events.map((event) => event.event + '/' + event.result)).toEqual([
      'review.requested/success',
      'review.acknowledged/success',
      'review.effect-applied/success',
      'resume.validated/success',
    ])
    const [request, acknowledgement, effect, resume] = projection.events
    expect(request?.journeyId).toBe(acknowledgement?.journeyId)
    expect(acknowledgement?.journeyId).toBe(effect?.journeyId)
    expect(effect?.journeyId).toBe(resume?.journeyId)
    expect(acknowledgement?.stateBeforeHash).toBe(request?.stateAfterHash)
    expect(effect?.stateBeforeHash).toBe(acknowledgement?.stateAfterHash)
    expect(resume?.stateBeforeHash).toBe(effect?.stateAfterHash)
    expect(resume?.stateAfterHash).toBe(effect?.stateAfterHash)
    expect(request?.originStepVisit).toEqual(acknowledgement?.originStepVisit)
    expect(acknowledgement?.originStepVisit).toEqual(effect?.originStepVisit)
    expect(resume?.originStepVisit).toEqual(effect?.originStepVisit)
    expect(Date.parse(resume?.occurredAt ?? '')).toBeGreaterThan(Date.parse(effect?.occurredAt ?? ''))
    const replay = replayInteractionEvents(projection.events)
    expect(replay.diagnostics.filter((diagnostic) => diagnostic.code === 'malformed-order')).toEqual([])
    expect(replay.journeys.some((journey) => isVerifiedInteractionJourney(journey, replay))).toBe(true)
    expect(projection.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4])
  })

  test('same-state repeat emits suppressed prompt without a second interruption', async () => {
    expect(await h.run(['review', 'request', 'demo', '--event', 'explore-complete'])).toBe(0)
    expect(await h.run(['review', 'request', 'demo', '--event', 'explore-complete'])).toBe(0)
    const projection = await readInteractionProjection(join(h.cwd, 'openspec/changes/demo'))
    expect(projection.kind).toBe('valid')
    if (projection.kind !== 'valid') return
    expect(projection.events.map((event) => event.event)).toEqual([
      'review.requested',
      'review.prompt-suppressed',
    ])
    expect(projection.events[1]?.result).toBe('suppressed')
  })

  test('canonical decision drift rejects acknowledgement until a fresh request rebinds it', async () => {
    expect(await h.run(['review', 'request', 'demo', '--event', 'explore-complete'])).toBe(0)
    expect(await h.run(['set', 'demo', 'scope', 'changed-before-ack.ts'])).toBe(0)
    expect(await h.run(['review', 'acknowledge', 'demo'])).toBe(2)
    expect(await h.read('demo')).toMatch(/^review_gate_status: pending$/m)
    expect(await h.run(['review', 'request', 'demo', '--event', 'explore-complete'])).toBe(0)
    expect(await h.run(['review', 'acknowledge', 'demo'])).toBe(0)
    expect(await h.run(['transition', 'demo', 'explore-complete'])).toBe(0)
  })

  test('state-drift rejection writes no interaction; the fresh request completes one verified journey', async () => {
    expect(await h.run(['review', 'request', 'demo', '--event', 'explore-complete'])).toBe(0)
    expect(await h.run(['set', 'demo', 'scope', 'changed-before-ack.ts'])).toBe(0)
    expect(await h.run(['review', 'acknowledge', 'demo'])).toBe(2)
    expect(await h.run(['review', 'request', 'demo', '--event', 'explore-complete'])).toBe(0)
    expect(await h.run(['review', 'acknowledge', 'demo'])).toBe(0)
    expect(await h.run(['transition', 'demo', 'explore-complete'])).toBe(0)
    expect(await h.run(['session', 'activate', 'demo'])).toBe(0)

    const projection = await readInteractionProjection(join(h.cwd, 'openspec/changes/demo'))
    expect(projection.kind).toBe('valid')
    if (projection.kind !== 'valid') return
    expect(projection.events.map((event) => `${event.event}/${event.result}`)).toEqual([
      'review.requested/success',
      'review.requested/success',
      'review.acknowledged/success',
      'review.effect-applied/success',
      'resume.validated/success',
    ])
    expect(projection.events[0]?.journeyId).not.toBe(projection.events[1]?.journeyId)
    const replay = replayInteractionEvents(projection.events)
    const completed = replay.journeys.filter((journey) => isVerifiedInteractionJourney(journey, replay))
    expect(completed).toHaveLength(1)
  })

  test('approved receipt with deleted binding can recover through a fresh request', async () => {
    expect(await h.run(['review', 'request', 'demo', '--event', 'explore-complete'])).toBe(0)
    expect(await h.run(['review', 'acknowledge', 'demo'])).toBe(0)
    await rm(join(h.cwd, 'openspec/changes/demo', REVIEW_GATE_BINDING_FILE), { force: true })
    expect(await h.run(['transition', 'demo', 'explore-complete'])).toBe(2)
    expect(await h.run(['review', 'request', 'demo', '--event', 'explore-complete'])).toBe(0)
    expect(await h.run(['review', 'acknowledge', 'demo'])).toBe(0)
    expect(await h.run(['transition', 'demo', 'explore-complete'])).toBe(0)
  })

  test('corrupt binding stays fail-closed until fresh request atomically rebuilds it', async () => {
    expect(await h.run(['review', 'request', 'demo', '--event', 'explore-complete'])).toBe(0)
    expect(await h.run(['review', 'acknowledge', 'demo'])).toBe(0)
    const bindingPath = join(h.cwd, 'openspec/changes/demo', REVIEW_GATE_BINDING_FILE)
    await writeFile(bindingPath, '{"decisionStateDigest":"attacker-secret"}\n', 'utf8')
    expect(await h.run(['review', 'acknowledge', 'demo'])).toBe(2)
    expect(await h.run(['transition', 'demo', 'explore-complete'])).toBe(2)
    expect(await h.run(['review', 'request', 'demo', '--event', 'explore-complete'])).toBe(0)
    const rebuilt = JSON.parse(await readFile(bindingPath, 'utf8')) as Record<string, unknown>
    expect(rebuilt.version).toBe(1)
    expect(rebuilt.decisionStateDigest).not.toBe('attacker-secret')
    expect(await h.run(['review', 'acknowledge', 'demo'])).toBe(0)
    expect(await h.run(['transition', 'demo', 'explore-complete'])).toBe(0)
  })

  test('oversize binding stays fail-closed for acknowledge and transition', async () => {
    expect(await h.run(['review', 'request', 'demo', '--event', 'explore-complete'])).toBe(0)
    const bindingPath = join(h.cwd, 'openspec/changes/demo', REVIEW_GATE_BINDING_FILE)
    const canonical = await readFile(bindingPath, 'utf8')
    await writeFile(bindingPath, `${canonical}${' '.repeat(16 * 1024)}`, 'utf8')
    expect(await h.run(['review', 'acknowledge', 'demo'])).toBe(2)
    expect(await h.run(['transition', 'demo', 'explore-complete'])).toBe(2)
    expect(await h.read('demo')).toMatch(/^review_gate_status: pending$/m)
  })

  test('symlink binding stays fail-closed for acknowledge and transition', async () => {
    expect(await h.run(['review', 'request', 'demo', '--event', 'explore-complete'])).toBe(0)
    const bindingPath = join(h.cwd, 'openspec/changes/demo', REVIEW_GATE_BINDING_FILE)
    const outside = join(h.cwd, 'outside-review-binding.json')
    const canonical = await readFile(bindingPath, 'utf8')
    await writeFile(outside, canonical, 'utf8')
    await rm(bindingPath)
    await symlink(outside, bindingPath)
    expect(await h.run(['review', 'acknowledge', 'demo'])).toBe(2)

    expect(await h.run(['review', 'request', 'demo', '--event', 'explore-complete'])).toBe(0)
    expect(await h.run(['review', 'acknowledge', 'demo'])).toBe(0)
    await rm(bindingPath)
    await symlink(outside, bindingPath)
    expect(await h.run(['transition', 'demo', 'explore-complete'])).toBe(2)
  })

  test('missing interaction projection does not change canonical acknowledgement', async () => {
    expect(await h.run(['review', 'request', 'demo', '--event', 'explore-complete'])).toBe(0)
    await rm(join(h.cwd, 'openspec/changes/demo/.pipeline-interactions.jsonl'), { force: true })
    expect(await h.run(['review', 'acknowledge', 'demo'])).toBe(0)
    expect(await h.read('demo')).toMatch(/^review_gate_status: approved$/m)
  })

  test('legacy approved receipt without a canonical decision binding fails closed', async () => {
    expect(await h.run(['review', 'request', 'demo', '--event', 'explore-complete'])).toBe(0)
    await rm(join(h.cwd, 'openspec/changes/demo', REVIEW_GATE_BINDING_FILE), { force: true })
    expect(await h.run(['review', 'acknowledge', 'demo'])).toBe(2)
    expect(await h.read('demo')).toMatch(/^review_gate_status: pending$/m)
  })

  test('transition refuses an approved receipt after its canonical binding is removed', async () => {
    expect(await h.run(['review', 'request', 'demo', '--event', 'explore-complete'])).toBe(0)
    expect(await h.run(['review', 'acknowledge', 'demo'])).toBe(0)
    await rm(join(h.cwd, 'openspec/changes/demo', REVIEW_GATE_BINDING_FILE), { force: true })
    expect(await h.run(['transition', 'demo', 'explore-complete'])).toBe(2)
    expect(await h.read('demo')).toMatch(/^phase: explore$/m)
  })

  test('corrupt interaction projection does not change canonical acknowledgement', async () => {
    expect(await h.run(['review', 'request', 'demo', '--event', 'explore-complete'])).toBe(0)
    await writeFile(join(h.cwd, 'openspec/changes/demo/.pipeline-interactions.jsonl'), 'not-json\n', 'utf8')
    expect(await h.run(['review', 'acknowledge', 'demo'])).toBe(0)
    expect(await h.read('demo')).toMatch(/^review_gate_status: approved$/m)
    expect(h.err.join('\n')).toContain('interaction-projection-write-failed')
  })

  test('resume with a changed canonical state is rejected and remains non-terminal', async () => {
    expect(await h.run(['review', 'request', 'demo', '--event', 'explore-complete'])).toBe(0)
    expect(await h.run(['review', 'acknowledge', 'demo'])).toBe(0)
    expect(await h.run(['transition', 'demo', 'explore-complete'])).toBe(0)
    expect(await h.run(['set', 'demo', 'scope', 'touched.ts'])).toBe(0)
    expect(await h.run(['session', 'activate', 'demo'])).toBe(0)
    const projection = await readInteractionProjection(join(h.cwd, 'openspec/changes/demo'))
    expect(projection.kind).toBe('valid')
    if (projection.kind !== 'valid') return
    expect(projection.events.at(-1)?.event).toBe('resume.validated')
    expect(projection.events.at(-1)?.result).toBe('rejected')
  })

  test('delegated acknowledge requires a current Change-bound user authority and records that source', async () => {
    const marker = join(h.cwd, '.pipeline-pending-review')
    const local = join(h.cwd, '.tenon', 'users', 'tester-at-tenon.test', 'local')
    const authority = join(local, 'authority')
    const sessionId = '019f92c7-6e66-7290-9352-f9d915266f14'
    const previousSession = process.env.TENON_HOST_SESSION_ID
    process.env.TENON_HOST_SESSION_ID = sessionId
    await expect(h.run(['review', 'request', 'demo', '--event', 'explore-complete'])).resolves.toBe(0)

    try {
      expect(await h.run(['review', 'acknowledge', 'demo', '--delegated'])).toBe(1)
      expect(h.err.join('\n')).toContain('没有有效的用户委托')

      await mkdir(local, { recursive: true })
      await writeFile(join(local, 'active-change'), 'demo\n', 'utf8')
      await writeFile(authority, [
        'pipeline-interaction-authority-v1',
        'change=demo',
        'scope=interactive-skills',
        'review=delegated',
        'issued_at=2026-07-24T00:00:00Z',
        '',
      ].join('\n'), 'utf8')
      expect(await h.run(['review', 'acknowledge', 'demo', '--delegated'])).toBe(1)

      await writeFile(authority, [
        'pipeline-interaction-authority-v2',
        'change=demo',
        'host_session=session-other',
        'scope=interactive-skills',
        'review=delegated',
        'issued_at=2026-07-24T00:00:00Z',
        '',
      ].join('\n'), 'utf8')
      expect(await h.run(['review', 'acknowledge', 'demo', '--delegated'])).toBe(1)

      // Another user's selection and authority never unlock this user's review exit.
      const otherLocal = join(h.cwd, '.tenon', 'users', 'other-at-x.io', 'local')
      await mkdir(otherLocal, { recursive: true })
      await writeFile(join(otherLocal, 'active-change'), 'demo\n', 'utf8')
      await writeFile(join(otherLocal, 'authority'), [
        'pipeline-interaction-authority-v2', 'change=demo', `host_session=${sessionId}`,
        'scope=interactive-skills', 'review=delegated', 'issued_at=2026-07-24T00:00:00Z', '',
      ].join('\n'), 'utf8')
      expect(await h.run(['review', 'acknowledge', 'demo', '--delegated'])).toBe(1)

      await writeFile(authority, [
        'pipeline-interaction-authority-v2',
        'change=demo',
        `host_session=${sessionId}`,
        'scope=interactive-skills',
        'review=delegated',
        'issued_at=2026-07-24T00:00:00Z',
        '',
      ].join('\n'), 'utf8')
      expect(await h.run(['review', 'acknowledge', 'demo', '--delegated'])).toBe(0)
      await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
      const history = await readFile(join(h.cwd, 'openspec/changes/demo/.pipeline-history.jsonl'), 'utf8')
      expect(history).toContain('review:acknowledge via=delegated phase=explore event=explore-complete authority_issued_at=2026-07-24T00:00:00Z')
      expect(history).toContain(`authority_host_session=${sessionId}`)
    } finally {
      if (previousSession === undefined) delete process.env.TENON_HOST_SESSION_ID
      else process.env.TENON_HOST_SESSION_ID = previousSession
    }
  })

  test('acknowledge exit codes: 0 success, 2 review-approval-required, 4 idempotency-conflict, 1 invalid-command; failures write nothing', async () => {
    const dir = join(h.cwd, 'openspec/changes/demo')
    const snapshot = async () => ({
      revision: (await readCurrentRunRevision(dir))?.revision,
      state: await h.read('demo'),
      history: await readFile(join(dir, '.pipeline-history.jsonl'), 'utf8').catch(() => '<missing>'),
      interactions: await readFile(join(dir, '.pipeline-interactions.jsonl'), 'utf8').catch(() => '<missing>'),
      idempotency: await readFile(join(dir, REVIEW_DECISION_IDEMPOTENCY_FILE), 'utf8').catch(() => '<missing>'),
      entries: (await readdir(dir)).sort(),
      revisions: (await readdir(join(dir, '.pipeline-run', 'revisions'))).sort(),
    })
    const expectZeroWrite = async (args: string[], code: number) => {
      const before = await snapshot()
      expect(await h.run(args)).toBe(code)
      expect(await snapshot()).toEqual(before)
    }

    expect(await h.run(['check', 'demo'])).toBe(0)
    await expectZeroWrite(['review', 'acknowledge', 'demo'], 2)

    expect(await h.run(['review', 'request', 'demo', '--event', 'explore-complete'])).toBe(0)
    await expectZeroWrite(['review', 'acknowledge', 'demo', '--event', 'explore-other'], 1)

    const state = await createStateStore().read(dir)
    const key = deriveReviewAcknowledgeIdempotencyKey({
      change: 'demo', phase: 'explore', event: 'explore-complete',
      requestedAt: String(state.fields.review_requested_at), state, channel: 'terminal',
    })
    await writeFile(join(dir, REVIEW_DECISION_IDEMPOTENCY_FILE), `${JSON.stringify({
      key, ref: 'decision:other', expectedRevision: null, channel: 'terminal', payloadDigest: 'other', acknowledgedAt: '2026-07-07T00:00:00Z', code: 'approved',
    })}\n`, 'utf8')
    await expectZeroWrite(['review', 'acknowledge', 'demo'], 4)
    await rm(join(dir, REVIEW_DECISION_IDEMPOTENCY_FILE))

    expect(await h.run(['review', 'acknowledge', 'demo'])).toBe(0)
    expect(await h.run(['transition', 'demo', 'explore-complete'])).toBe(0)
    // The harness records the new visit's phase Skill on its first command; settle it before measuring.
    await h.run(['check', 'demo'])
    await expectZeroWrite(['review', 'acknowledge', 'demo'], 2)
  })

  test('repeated acknowledge replays without new writes and clears a re-created marker', async () => {
    const marker = join(h.cwd, '.pipeline-pending-review')
    const dir = join(h.cwd, 'openspec/changes/demo')
    expect(await h.run(['review', 'request', 'demo', '--event', 'explore-complete'])).toBe(0)
    const content = await readFile(marker, 'utf8')
    expect(await h.run(['review', 'acknowledge', 'demo'])).toBe(0)
    const history = await readFile(join(dir, '.pipeline-history.jsonl'), 'utf8')
    expect(history).toContain('review:acknowledge via=terminal phase=explore event=explore-complete')
    const revision = (await readCurrentRunRevision(dir))?.revision
    await writeFile(marker, content, 'utf8')
    expect(await h.run(['review', 'acknowledge', 'demo'])).toBe(0)
    await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readCurrentRunRevision(dir))?.revision).toBe(revision)
    expect(await readFile(join(dir, '.pipeline-history.jsonl'), 'utf8')).toBe(history)
    expect((await readFile(join(dir, REVIEW_DECISION_IDEMPOTENCY_FILE), 'utf8')).split('\n').filter(Boolean)).toHaveLength(1)
  })

  test('marker cleanup failure keeps the approval, warns and exits 0 (marker-warning)', async () => {
    const marker = join(h.cwd, '.pipeline-pending-review')
    expect(await h.run(['review', 'request', 'demo', '--event', 'explore-complete'])).toBe(0)
    await rm(marker)
    await mkdir(marker)
    expect(await h.run(['review', 'acknowledge', 'demo'])).toBe(0)
    expect(h.err.join('\n')).toContain('review marker 清理失败')
    expect(await h.read('demo')).toMatch(/^review_gate_status: approved$/m)
  })

  test('custom review request passes the exact event: success is revision-blocked while rollback remains requestable', async () => {
    const local = await freshHarness()
    try {
      await mkdir(join(local.cwd, '.pipeline', 'workflows'), { recursive: true })
      await writeFile(join(local.cwd, '.pipeline', 'workflows', 'custom-review.yaml'), `name: custom-review
steps:
  - id: implement-anything
    label: Implement
    gate: null
    skills: []
    inputs: []
    outputs:
      - field: build_sha
        type: string
    guards: []
    transitions:
      - event: ready
        to: assure-anything
  - id: assure-anything
    label: Assure
    gate: review
    skills: []
    inputs:
      - field: build_sha
        type: string
    outputs: []
    guards: []
    transitions:
      - event: pass
        to: ship-anything
      - event: rollback
        to: implement-anything
        actions:
          - type: mark-verification-failed
  - id: ship-anything
    label: Ship
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions: []
`, 'utf8')
      await local.run(['init', 'demo', '--track', 'backend', '--preset', 'full', '--workflow', 'custom-review'])
      await local.seedArtifact('demo', 'phase', 'assure-anything')
      await local.seedArtifact('demo', 'isolation', 'branch')
      await local.seedArtifact('demo', 'build_sha', 'legacy-sha')

      expect(await local.run(['review', 'request', 'demo', '--event', 'pass'])).toBe(2)
      expect(local.out.join('\n')).toContain('verify-build-revision-untrusted')
      expect(local.out.join('\n')).not.toContain('legacy-sha')
      expect(await local.read('demo')).not.toMatch(/^review_gate_status: pending$/m)

      expect(await local.run(['review', 'request', 'demo', '--event', 'rollback'])).toBe(0)
      expect(await local.read('demo')).toMatch(/^review_gate_event: rollback$/m)
      expect(await local.read('demo')).toMatch(/^review_gate_status: pending$/m)
    } finally {
      await rm(local.cwd, { recursive: true, force: true })
    }
  })

  test('custom step without a forward exit: request --event archived → acknowledge → transition archived closes the run', async () => {
    const local = await freshHarness()
    try {
      await mkdir(join(local.cwd, '.pipeline', 'workflows'), { recursive: true })
      // Dashboard editor output: the last review stage only has a send-back edge.
      await writeFile(join(local.cwd, '.pipeline', 'workflows', 'ui-built.yaml'), `name: ui-built
tracks:
  main:
    steps:
      - id: stage-1
        label: stage-1
        gate: review
        skills: []
        inputs: []
        outputs: []
        guards: []
        transitions:
          - event: stage-1-complete
            to: build
      - id: build
        label: build
        gate: auto
        skills: []
        inputs: []
        outputs: []
        guards: []
        transitions:
          - event: build-complete
            to: verify
      - id: verify
        label: verify
        gate: review
        skills: []
        inputs: []
        outputs: []
        guards: []
        transitions:
          - event: verify-back
            to: build
`, 'utf8')
      expect(await local.run(['init', 'demo', '--track', 'main', '--preset', 'full', '--workflow', 'ui-built'])).toBe(0)

      // A step with a forward edge does not accept the completion event.
      expect(await local.run(['review', 'request', 'demo', '--event', 'archived'])).toBe(1)
      expect(local.err.join('\n')).toContain("不支持 review event 'archived'")
      expect(await local.read('demo')).not.toMatch(/^review_gate_status: pending$/m)

      await local.seedArtifact('demo', 'phase', 'verify')
      // Send-back and completion are two exits, so the decision must name one.
      expect(await local.run(['review', 'request', 'demo'])).toBe(1)
      expect(local.err.join('\n')).toContain('verify-back|archived')
      expect(await local.run(['review', 'request', 'demo', '--event', 'archived'])).toBe(0)
      expect(await local.read('demo')).toMatch(/^review_gate_event: archived$/m)
      expect(await local.run(['transition', 'demo', 'archived'])).toBe(2)
      expect(await local.read('demo')).toMatch(/^archived: false$/m)

      expect(await local.run(['review', 'acknowledge', 'demo'])).toBe(0)
      expect(await local.run(['transition', 'demo', 'archived'])).toBe(0)
      const closed = await local.read('demo')
      expect(closed).toMatch(/^phase: verify$/m)
      expect(closed).toMatch(/^phase_status: done$/m)
      expect(closed).toMatch(/^archived: true$/m)
      expect(closed).not.toMatch(/^review_gate_status:/m)

      // Nothing is left to complete once the run is archived.
      expect(await local.run(['review', 'request', 'demo', '--event', 'archived'])).toBe(1)
    } finally {
      await rm(local.cwd, { recursive: true, force: true })
    }
  })
})
