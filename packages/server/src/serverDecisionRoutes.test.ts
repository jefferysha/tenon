import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createHistoryWriter,
  createStateStore,
  emptyTestPlan,
  readTestPlanState,
  writeTestPlan,
  type TestPlan,
  createTransitionRecordStore,
  formatReviewMarker,
  parseInteractionEventLine,
  readCurrentRunRevision,
  REVIEW_GATE_BINDING_FILE,
  REVIEW_MARKER_FILE,
  serializePipeline,
} from '@tenon/kernel'
import { FIXED_CLOCK, freshHarness, makeHarness, type Harness } from '../../cli/src/integration-harness.js'
import { handleGetDecisionRoute } from './serverGetDecisionRoutes.js'
import { DECISION_COMMAND_FAILED, handlePostDecisionRoutes } from './serverPostDecisionRoutes.js'
import { handlePostOperationsRoutes } from './serverPostOperationsRoutes.js'
import { buildSnapshot } from './snapshot.js'

/** Frozen closed-schema reader of the previous release; the release bundle gate runs the same file. */
const N_MINUS_ONE_READER = fileURLToPath(
  new URL('../../../tools/fixtures/n-minus-one-canonical-reader.mjs', import.meta.url),
)

type Captured = { status?: number; body?: unknown }
type ViewItem = { ref: { id: string }; revision: number; status: string; type: string; channel: string }

const cleanups: string[] = []
afterEach(async () => {
  for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true })
})

function changeDir(h: Harness): string {
  return join(h.cwd, 'openspec', 'changes', 'demo')
}

async function initChange(): Promise<Harness> {
  const h = await freshHarness()
  cleanups.push(h.cwd)
  expect(await h.run(['init', 'demo', '--track', 'backend', '--preset', 'full'])).toBe(0)
  await h.seedGovernedDocumentEvidence('demo')
  expect(await h.run(['transition', 'demo', 'open-complete'])).toBe(0)
  await h.seedArtifact('demo', 'design_doc', 'openspec/changes/demo/design.md')
  // 调研步骤挂了 researcher 执行者：跑过之后才能请求评审。
  await h.satisfyStepAgents('demo')
  return h
}

async function pendingChange(): Promise<Harness> {
  const h = await initChange()
  expect(await h.run(['review', 'request', 'demo', '--event', 'explore-complete'])).toBe(0)
  return h
}

async function getView(root: string): Promise<{ status?: number; items: ViewItem[]; waivers: { key: string; reason: string }[] }> {
  const captured: Captured = {}
  await handleGetDecisionRoute(
    { url: `/api/change/demo/pending-decisions?root=${encodeURIComponent(root)}`, headers: {} } as never,
    {} as never,
    '/api/change/demo/pending-decisions',
    {
      sendJson: (_res, status, body) => { captured.status = status; captured.body = body },
      store: createStateStore(),
      recordStore: createTransitionRecordStore(),
      workflowRootForRequest: (candidate) => ({ ok: true, anchor: { path: candidate } }),
    },
  )
  const body = captured.body as { items?: ViewItem[]; waivers?: { key: string; reason: string }[] }
  return { status: captured.status, items: body.items ?? [], waivers: body.waivers ?? [] }
}

async function post(root: string, body: Record<string, unknown>): Promise<Captured> {
  const captured: Captured = {}
  await handlePostDecisionRoutes(
    { url: '/api/change/demo/decisions', headers: {} } as never,
    {} as never,
    '/api/change/demo/decisions',
    {
      sendJson: (_res, status, response) => { captured.status = status; captured.body = response },
      readJsonBody: async () => ({ root, ...body }),
      isRegisteredRoot: (candidate) => candidate === root,
      store: createStateStore(),
      recordStore: createTransitionRecordStore(),
      clock: () => FIXED_CLOCK,
      history: createHistoryWriter(),
      resolveUser: () => ({ id: 'tester@tenon.test', name: 'Tester', slug: 'tester-at-tenon.test', source: 'env', trust: 'declared' }),
    },
  )
  return captured
}

async function readOptional(path: string): Promise<string> {
  return readFile(path, 'utf8').catch(() => '<missing>')
}

/** Every durable surface a decision command could touch. Directories are compared via readdir. */
async function durableSnapshot(h: Harness) {
  const dir = changeDir(h)
  const current = await readCurrentRunRevision(dir)
  return {
    revision: current?.revision,
    transitionSequence: current?.state.runMetadata?.transitionSequence,
    fields: current?.state.fields,
    history: await readOptional(join(dir, '.pipeline-history.jsonl')),
    interactions: await readOptional(join(dir, '.pipeline-interactions.jsonl')),
    idempotency: await readOptional(join(dir, '.pipeline-decision-idempotency.jsonl')),
    changeEntries: (await readdir(dir)).sort(),
    revisions: (await readdir(join(dir, '.pipeline-run', 'revisions')).catch(() => [])).sort(),
    transitions: (await readdir(join(dir, '.pipeline-run', 'transitions')).catch(() => [])).sort(),
  }
}

async function pendingItem(h: Harness): Promise<ViewItem> {
  const view = await getView(h.cwd)
  expect(view.status).toBe(200)
  const item = view.items.find((candidate) => candidate.type === 'review')
  expect(item).toMatchObject({ status: 'pending', type: 'review' })
  return item!
}

describe('decision server adapters', () => {
  it('end-to-end: GET ref → POST 200 → CLI transition → GET consumed with an unchanged ref', async () => {
    const h = await pendingChange()
    const pending = await pendingItem(h)
    const approved = await post(h.cwd, { ref: pending.ref.id, expected_revision: pending.revision, idempotency_key: 'e2e-1' })
    expect(approved).toMatchObject({ status: 200, body: { ok: true, code: 'approved', changed: true, idempotent: false, channel: 'dashboard' } })
    await expect(readFile(join(h.cwd, REVIEW_MARKER_FILE), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

    const answered = (await getView(h.cwd)).items.find((item) => item.type === 'review')
    expect(answered).toMatchObject({ status: 'answered', channel: 'dashboard', ref: { id: pending.ref.id } })

    expect(await h.run(['transition', 'demo', 'explore-complete'])).toBe(0)
    const consumed = (await getView(h.cwd)).items.find((item) => item.type === 'review')
    expect(consumed).toMatchObject({ status: 'consumed', ref: { id: pending.ref.id } })

    const lines = (await readFile(join(changeDir(h), '.pipeline-interactions.jsonl'), 'utf8')).split('\n').filter(Boolean)
    expect(lines.map((line) => parseInteractionEventLine(line)).map((event) => `${event.event}/${event.surface}/${event.actor}`)).toEqual([
      'review.requested/cli/system',
      'review.acknowledged/dashboard/system',
      'review.effect-applied/cli/agent',
    ])
  })

  it('CLI and Dashboard acknowledgements of the same fixture are equivalent except for the channel', async () => {
    const terminal = await pendingChange()
    const dashboardRoot = await mkdtemp(join(tmpdir(), 'tenon-decision-parity-'))
    cleanups.push(dashboardRoot)
    await cp(terminal.cwd, dashboardRoot, { recursive: true })
    const dashboard = makeHarness(dashboardRoot)

    expect(await terminal.run(['review', 'acknowledge', 'demo'])).toBe(0)
    const item = await pendingItem(dashboard)
    expect(await post(dashboardRoot, { ref: item.ref.id, expected_revision: item.revision, idempotency_key: 'parity-1' }))
      .toMatchObject({ status: 200, body: { ok: true, code: 'approved' } })

    const left = await durableSnapshot(terminal)
    const right = await durableSnapshot(dashboard)
    expect(left.fields?.review_acknowledged_via).toBe('terminal')
    expect(right.fields?.review_acknowledged_via).toBe('dashboard')
    // The channel is a companion-backed logical field: neither acknowledgement route may widen the
    // wire or projection closure that the previous release reads.
    for (const h of [terminal, dashboard]) {
      const currentJson = join(changeDir(h), '.pipeline-run', 'current.json')
      const wire = JSON.parse(await readFile(currentJson, 'utf8')) as { state: { fields: Record<string, unknown> } }
      expect(wire.state.fields).not.toHaveProperty('review_acknowledged_via')
      expect(await readFile(join(changeDir(h), '.pipeline.yaml'), 'utf8')).not.toContain('review_acknowledged_via')
      expect(execFileSync(process.execPath, [N_MINUS_ONE_READER, currentJson], { encoding: 'utf8' }).trim())
        .toBe('explore')
    }
    expect({ ...left.fields, review_acknowledged_via: '' }).toEqual({ ...right.fields, review_acknowledged_via: '' })
    expect(left.revision).toBe(right.revision)
    expect(left.transitionSequence).toBe(right.transitionSequence)

    const events = (raw: string) => raw.split('\n').filter(Boolean).map((line) => parseInteractionEventLine(line))
      .map((event) => ({
        event: event.event, result: event.result, journeyId: event.journeyId, actor: event.actor,
        originStepVisit: event.originStepVisit, stateBeforeHash: event.stateBeforeHash, reasonCode: event.reasonCode,
        effectCode: event.effectCode, occurredAt: event.occurredAt, workflowMode: event.workflowMode, trackKind: event.trackKind,
      }))
    expect(events(left.interactions)).toEqual(events(right.interactions))
    const lastHistory = (raw: string) => JSON.parse(raw.trim().split('\n').at(-1) ?? '{}') as { ts: string; kind: string; raw: string }
    const terminalLine = lastHistory(left.history)
    const dashboardLine = lastHistory(right.history)
    expect(terminalLine.raw).toBe('review:acknowledge via=terminal phase=explore event=explore-complete')
    expect({ ...dashboardLine, raw: dashboardLine.raw.replace('via=dashboard', 'via=terminal') }).toEqual(terminalLine)
  })

  it('replays the same key with 200, writes no second ledger line and clears a re-created marker', async () => {
    const h = await pendingChange()
    const item = await pendingItem(h)
    const body = { ref: item.ref.id, expected_revision: item.revision, idempotency_key: 'replay-1' }
    expect(await post(h.cwd, body)).toMatchObject({ status: 200, body: { code: 'approved' } })
    await writeFile(join(h.cwd, REVIEW_MARKER_FILE), formatReviewMarker({
      phase: 'explore', event: 'explore-complete', changeName: 'demo', requestedAt: FIXED_CLOCK,
    }), 'utf8')
    const before = await durableSnapshot(h)
    expect(await post(h.cwd, body)).toMatchObject({ status: 200, body: { ok: true, changed: false, idempotent: true } })
    await expect(readFile(join(h.cwd, REVIEW_MARKER_FILE), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await durableSnapshot(h)).toEqual(before)
  })

  it('returns marker-warning (HTTP 200) when marker cleanup fails after the approval commits', async () => {
    const h = await pendingChange()
    const item = await pendingItem(h)
    await rm(join(h.cwd, REVIEW_MARKER_FILE), { force: true })
    await mkdir(join(h.cwd, REVIEW_MARKER_FILE))
    const result = await post(h.cwd, { ref: item.ref.id, expected_revision: item.revision, idempotency_key: 'marker-1' })
    expect(result).toMatchObject({ status: 200, body: { ok: true, code: 'marker-warning', deferred: ['review-marker-clear'] } })
    expect((await readCurrentRunRevision(changeDir(h)))?.state.fields.review_gate_status).toBe('approved')
  })

  it('rejects stale revision and reused keys with contract H codes and zero writes', async () => {
    const h = await pendingChange()
    const item = await pendingItem(h)
    let before = await durableSnapshot(h)
    expect(await post(h.cwd, { ref: item.ref.id, expected_revision: item.revision + 1, idempotency_key: 'stale-1' }))
      .toMatchObject({ status: 409, body: { ok: false, code: 'revision-conflict' } })
    expect(await durableSnapshot(h)).toEqual(before)

    expect(await post(h.cwd, { ref: item.ref.id, expected_revision: item.revision, idempotency_key: 'reuse-1' }))
      .toMatchObject({ status: 200 })
    before = await durableSnapshot(h)
    expect(await post(h.cwd, { ref: item.ref.id, expected_revision: item.revision + 5, idempotency_key: 'reuse-1' }))
      .toMatchObject({ status: 409, body: { ok: false, code: 'idempotency-conflict' } })
    expect(await durableSnapshot(h)).toEqual(before)
  })

  it('maps missing, not-pending, late and binding-mismatched commands to review-approval-required with zero writes', async () => {
    const assertRejected = async (h: Harness, body: Record<string, unknown>) => {
      const before = await durableSnapshot(h)
      const result = await post(h.cwd, body)
      expect(result).toMatchObject({ status: 409, body: { ok: false, code: 'review-approval-required' } })
      expect(await durableSnapshot(h)).toEqual(before)
    }

    const notPending = await initChange()
    const revision = (await readCurrentRunRevision(changeDir(notPending)))?.revision ?? 0
    await assertRejected(notPending, { ref: 'decision:0000000000000000', expected_revision: revision, idempotency_key: 'none-1' })

    const h = await pendingChange()
    const item = await pendingItem(h)
    await assertRejected(h, { ref: 'decision:missing', expected_revision: item.revision, idempotency_key: 'missing-1' })

    const bindingPath = join(changeDir(h), REVIEW_GATE_BINDING_FILE)
    const binding = await readFile(bindingPath, 'utf8')
    await writeFile(bindingPath, binding.replace(/"decisionStateDigest":"[0-9a-f]{64}"/, `"decisionStateDigest":"${'0'.repeat(64)}"`), 'utf8')
    await assertRejected(h, { ref: item.ref.id, expected_revision: item.revision, idempotency_key: 'binding-1' })
    await writeFile(bindingPath, binding, 'utf8')

    expect(await h.run(['review', 'acknowledge', 'demo'])).toBe(0)
    expect(await h.run(['transition', 'demo', 'explore-complete'])).toBe(0)
    const consumedRevision = (await readCurrentRunRevision(changeDir(h)))?.revision ?? 0
    await assertRejected(h, { ref: item.ref.id, expected_revision: consumedRevision, idempotency_key: 'late-1' })
  })

  it('maps an unexpected failure to HTTP 500 without code or path and with zero writes', async () => {
    const h = await pendingChange()
    const item = await pendingItem(h)
    await writeFile(join(changeDir(h), '.pipeline-decision-idempotency.jsonl'), '{broken\n', 'utf8')
    const before = await durableSnapshot(h)
    const result = await post(h.cwd, { ref: item.ref.id, expected_revision: item.revision, idempotency_key: 'damaged-1' })
    expect(result).toEqual({ status: 500, body: { ok: false, error: DECISION_COMMAND_FAILED } })
    expect(JSON.stringify(result.body)).not.toContain(h.cwd)
    expect(await durableSnapshot(h)).toEqual(before)
  })

  it('records a custom workflow identity on the Dashboard acknowledgement', async () => {
    const h = await freshHarness()
    cleanups.push(h.cwd)
    await mkdir(join(h.cwd, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(h.cwd, '.pipeline', 'workflows', 'custom-review.yaml'), `name: custom-review
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
    await h.run(['init', 'demo', '--track', 'backend', '--preset', 'full', '--workflow', 'custom-review'])
    await h.seedArtifact('demo', 'phase', 'assure-anything')
    await h.seedArtifact('demo', 'isolation', 'branch')
    await h.seedArtifact('demo', 'build_sha', 'legacy-sha')
    expect(await h.run(['review', 'request', 'demo', '--event', 'rollback'])).toBe(0)
    const item = await pendingItem(h)
    expect(await post(h.cwd, { ref: item.ref.id, expected_revision: item.revision, idempotency_key: 'custom-1' }))
      .toMatchObject({ status: 200, body: { ok: true } })
    const lines = (await readFile(join(changeDir(h), '.pipeline-interactions.jsonl'), 'utf8')).split('\n').filter(Boolean)
    expect(parseInteractionEventLine(lines.at(-1)!)).toMatchObject({
      event: 'review.acknowledged', workflow: 'custom-review', workflowMode: 'custom', pipelineStage: 'custom', actor: 'system', surface: 'dashboard',
    })
  })

  it('acknowledges the implicit archived completion of a custom step without a forward exit', async () => {
    const h = await freshHarness()
    cleanups.push(h.cwd)
    await mkdir(join(h.cwd, '.pipeline', 'workflows'), { recursive: true })
    // Dashboard editor output: the last review stage only has a send-back edge.
    await writeFile(join(h.cwd, '.pipeline', 'workflows', 'ui-built.yaml'), `name: ui-built
tracks:
  main:
    steps:
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
    expect(await h.run(['init', 'demo', '--track', 'main', '--preset', 'full', '--workflow', 'ui-built'])).toBe(0)
    await h.seedArtifact('demo', 'phase', 'verify')
    expect(await h.run(['review', 'request', 'demo', '--event', 'archived'])).toBe(0)

    // Rules, readiness and the handshake list the same exits: the Dashboard decoder requires it.
    const snapshot = await buildSnapshot({
      registry: () => [h.cwd], store: createStateStore(), version: '1', clock: () => FIXED_CLOCK,
    })
    const change = snapshot.projects[0]?.changes.find((candidate) => candidate.name === 'demo')
    expect(change?.workflowRules.transitions.verify).toEqual([
      { event: 'verify-back', to: 'build' },
      { event: 'archived', to: 'verify' },
    ])
    expect(Object.keys(change?.workflowExecution.readinessByTransition.verify ?? {})).toEqual(['verify-back', 'archived'])
    expect(change?.reviewHandshake).toMatchObject({ status: 'pending', event: 'archived' })

    const item = await pendingItem(h)
    expect(await post(h.cwd, { ref: item.ref.id, expected_revision: item.revision, idempotency_key: 'archived-1' }))
      .toMatchObject({ status: 200, body: { ok: true, code: 'approved' } })
    expect(await h.run(['transition', 'demo', 'archived'])).toBe(0)
    expect(await h.read('demo')).toMatch(/^archived: true$/m)
  })

  it('preserves transition-controlled phase when importing a changed YAML projection and reports it', async () => {
    const h = await freshHarness()
    cleanups.push(h.cwd)
    expect(await h.run(['init', 'demo', '--track', 'backend', '--preset', 'full'])).toBe(0)
    const store = createStateStore()
    const yamlPath = join(changeDir(h), '.pipeline.yaml')
    const yaml = serializePipeline(await store.read(changeDir(h)))
    await writeFile(yamlPath, yaml.replace('phase: open\n', 'phase: verify\n'), 'utf8')
    const captured: Captured = {}
    await handlePostOperationsRoutes(
      { url: '/api/change/demo/projection', headers: {} } as never, {} as never, '/api/change/demo/projection', {
        ...({
          sendJson: (_res: unknown, status: number, body: unknown) => { captured.status = status; captured.body = body },
          readJsonBody: async () => ({ root: h.cwd, action: 'import-legacy', confirm_import: true }),
          isRegisteredRoot: (root: string) => root === h.cwd, store,
        } as never),
      },
    )
    expect(captured).toMatchObject({ status: 200, body: { ok: true, ignored_protected_fields: ['phase'] } })
    expect((await store.read(changeDir(h))).fields.phase).toBe('open')
  })
})

const TESTER = 'tester@tenon.test'
const REQUEST_WAIVER = { kind: 'unit' as const, reason: '纯文档改动', approved_by: null }

async function planOf(h: Harness): Promise<TestPlan> {
  const state = await readTestPlanState(changeDir(h), 'demo')
  if (state.state !== 'ok') throw new Error(`计划不可读：${state.state}`)
  return state.plan
}

async function writePlan(h: Harness, waivers: TestPlan['waivers']): Promise<void> {
  await writeTestPlan(changeDir(h), { ...emptyTestPlan('demo'), waivers }, {
    actor: { id: TESTER, name: 'Tester', trust: 'declared' }, recordedAt: FIXED_CLOCK,
  })
}

async function waivedPendingChange(): Promise<Harness> {
  const h = await initChange()
  await writePlan(h, [REQUEST_WAIVER])
  expect(await h.run(['review', 'request', 'demo', '--event', 'explore-complete']), h.err.join('\n')).toBe(0)
  return h
}

describe('decision server adapters · test-plan waivers', () => {
  it('GET lists exactly the waivers frozen in the request; approving approves those and only those, with one audit row', async () => {
    const h = await waivedPendingChange()
    // A waiver added after the request is not part of this approval.
    await writePlan(h, [REQUEST_WAIVER, { kind: 'lint', reason: '请求之后才加的', approved_by: null }])
    const view = await getView(h.cwd)
    expect(view.waivers).toEqual([{ key: 'kind:unit', reason: '纯文档改动' }])
    const item = view.items.find((candidate) => candidate.type === 'review')!

    const approved = await post(h.cwd, { ref: item.ref.id, expected_revision: item.revision, idempotency_key: 'waiver-1' })
    expect(approved).toMatchObject({
      status: 200,
      body: { ok: true, code: 'approved', changed: true, waivers: { approved: ['kind:unit'], skipped: [] } },
    })
    expect((await planOf(h)).waivers).toEqual([
      { kind: 'lint', reason: '请求之后才加的', approved_by: null },
      { kind: 'unit', reason: '纯文档改动', approved_by: TESTER },
    ])
    await expect(readFile(join(changeDir(h), '.pipeline-review-waivers.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    const history = await readFile(join(changeDir(h), '.pipeline-history.jsonl'), 'utf8')
    expect(history).toMatch(new RegExp(`"raw":"test:waiver-approve waivers=kind:unit by=${TESTER.replace('.', '\\.')} plan=sha256:[0-9a-f]{64}"`))
    expect(history.match(/test:waiver-approve/gu)).toHaveLength(1)
    // Once approved there is nothing left to show.
    expect((await getView(h.cwd)).waivers).toEqual([])
  })

  it('CLI and Dashboard approvals approve the same waivers and leave the same plan', async () => {
    const terminal = await waivedPendingChange()
    const dashboardRoot = await mkdtemp(join(tmpdir(), 'tenon-decision-waivers-'))
    cleanups.push(dashboardRoot)
    await cp(terminal.cwd, dashboardRoot, { recursive: true })
    const dashboard = makeHarness(dashboardRoot)

    expect(await terminal.run(['review', 'acknowledge', 'demo']), terminal.err.join('\n')).toBe(0)
    const item = await pendingItem(dashboard)
    expect(await post(dashboardRoot, { ref: item.ref.id, expected_revision: item.revision, idempotency_key: 'waiver-parity' }))
      .toMatchObject({ status: 200, body: { ok: true } })
    expect((await planOf(dashboard)).waivers).toEqual((await planOf(terminal)).waivers)
    expect((await planOf(dashboard)).waivers).toEqual([{ ...REQUEST_WAIVER, approved_by: TESTER }])
  })

  it('a waiver list left by an older request is neither shown nor approved', async () => {
    const h = await waivedPendingChange()
    const sidecar = join(changeDir(h), '.pipeline-review-waivers.json')
    const stale = (await readFile(sidecar, 'utf8')).replace(/"requestedAt":"[^"]*"/, '"requestedAt":"2020-01-01T00:00:00.000Z"')
    await writeFile(sidecar, stale, 'utf8')
    const view = await getView(h.cwd)
    expect(view.waivers).toEqual([])
    const item = view.items.find((candidate) => candidate.type === 'review')!

    const result = await post(h.cwd, { ref: item.ref.id, expected_revision: item.revision, idempotency_key: 'waiver-stale' })
    expect(result).toMatchObject({ status: 200, body: { ok: true, waivers: { approved: [], skipped: [] } } })
    expect((await planOf(h)).waivers).toEqual([REQUEST_WAIVER])
    const history = await readFile(join(changeDir(h), '.pipeline-history.jsonl'), 'utf8')
    expect(history).not.toContain('test:waiver-approve')
  })

  it('a change without waivers reports an empty list and an empty outcome', async () => {
    const h = await pendingChange()
    const view = await getView(h.cwd)
    expect(view.waivers).toEqual([])
    const item = view.items.find((candidate) => candidate.type === 'review')!
    expect(await post(h.cwd, { ref: item.ref.id, expected_revision: item.revision, idempotency_key: 'waiver-none' }))
      .toMatchObject({ status: 200, body: { ok: true, waivers: { approved: [], skipped: [] } } })
  })

  it('a waiver whose reason changed after the request is reported as skipped, not approved', async () => {
    const h = await waivedPendingChange()
    await writePlan(h, [{ ...REQUEST_WAIVER, reason: '请求之后换的理由' }])
    const item = await pendingItem(h)
    const result = await post(h.cwd, { ref: item.ref.id, expected_revision: item.revision, idempotency_key: 'waiver-changed' })
    expect(result).toMatchObject({ status: 200, body: { ok: true, waivers: { approved: [], skipped: [{ key: 'kind:unit', why: 'reason-changed' }] } } })
    expect((await planOf(h)).waivers).toEqual([{ ...REQUEST_WAIVER, reason: '请求之后换的理由' }])
  })
})
