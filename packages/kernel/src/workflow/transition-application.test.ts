import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { IllegalTransitionError } from '../types.js'
import { atomicWriteFile, createStateStore } from '../state/store.js'
import { createTransitionRecordStore } from '../state/transition-record-store.js'
import { createWorkflowRunRepository } from '../state/workflow-run-repository.js'
import { recordDocument } from '../documents/document-recording.js'
import { recordDocumentReads } from '../state/document-ledger.js'
import { recordNativeDocumentSkillConfirmation } from '../skill-invocation/document-confirmation.js'
import { recordCanonicalDocumentSkillInvocation } from '../skill-invocation/document-producer.js'
import { createFlowEngine, loadManifest } from '../flow/index.js'
import { compileAutomationPolicySnapshot } from '../loops/automation-policy.js'
import type { LoopEntry } from '../loops/types.js'
import { createTransitionApplication } from './transition-application.js'
import type { TransitionApplicationDeps } from './transition-application.js'
import { INTERACTION_PROJECTION_WRITE_FAILED } from '../interaction/contract.js'
import { compileWorkflow } from './compile.js'
import { builtinWorkflow } from './builtin-workflows.js'
import { compileEffectiveWorkflowPlan, documentGovernanceFingerprint } from './effective-plan.js'
import type { WorkflowDef } from './types.js'
import type { WorkflowIR } from './ir.js'
import type { HistoryEntry } from '../types.js'
import { createBuildRevisionToken, makeBuildRevisionBlocker, safeRevisionHash } from './build-revision.js'

const TEST_CREATOR = { id: 'tester@tenon.test', name: 'Tester', trust: 'declared' } as const

const FIXED_CLOCK = () => '2026-07-17T00:00:00Z'
const REVISION_IDENTITY = { repository: '/repo.git', worktree: '/repo\\0/repo.git/worktrees/change' } as const
const GIT_BUILD_TOKEN = createBuildRevisionToken('git', 'a'.repeat(40), REVISION_IDENTITY).value
const WORKSPACE_BUILD_TOKEN = createBuildRevisionToken(
  'workspace', `workspace:sha256:${'b'.repeat(64)}`, REVISION_IDENTITY,
).value
const WORKSPACE_BUILD_TOKEN_DRIFT = createBuildRevisionToken(
  'workspace', `workspace:sha256:${'c'.repeat(64)}`, REVISION_IDENTITY,
).value
const TRUSTED_GIT_ASSESSMENT = async () => ({
  trusted: true as const,
  token: createBuildRevisionToken('git', 'a'.repeat(40), REVISION_IDENTITY),
})
/** 仓库根 templates/manifest.yaml（同 flow.test.ts 的定位手法，不依赖 cwd） */
const TEMPLATE_MANIFEST = fileURLToPath(new URL('../../../../templates/manifest.yaml', import.meta.url))

const dirs: string[] = []
async function freshRepoRoot(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'pl-transition-app-'))
  dirs.push(d)
  return d
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const manifest = loadManifest(TEMPLATE_MANIFEST)

function makeDeps(overrides: Partial<TransitionApplicationDeps> = {}): TransitionApplicationDeps & {
  historyEntries: Array<[string, HistoryEntry]>
  breadcrumbCalls: Array<[string, string]>
} {
  const store = createStateStore()
  const recordStore = createTransitionRecordStore()
  const runRepository = createWorkflowRunRepository({ store, recordStore, clock: FIXED_CLOCK })
  const historyEntries: Array<[string, HistoryEntry]> = []
  const breadcrumbCalls: Array<[string, string]> = []
  return {
    runRepository,
    flow: createFlowEngine(manifest),
    clock: FIXED_CLOCK,
    // Test callers explicitly provide the verifier; production adapters must use
    // the sidecar-backed binding matcher rather than this permissive test stub.
    reviewGateBinding: async () => true,
    history: { append: async (dir, entry) => { historyEntries.push([dir, entry]) } },
    breadcrumb: { write: async (dir, content) => { breadcrumbCalls.push([dir, content]) } },
    historyEntries,
    breadcrumbCalls,
    ...overrides,
  }
}

async function initChange(deps: ReturnType<typeof makeDeps>, root: string, name: string): Promise<string> {
  const { changeDir } = await deps.runRepository.initChange({
    repoRoot: root, name, track: 'backend', reviewSeed: 'pending', creator: TEST_CREATOR, preset: 'full', clock: FIXED_CLOCK,
  })
  await seedGovernedDocumentEvidence(root, changeDir, name)
  return changeDir
}

/**
 * Default frontend/backend transitions now enforce the document ledger. These tests target unrelated
 * transition/atomicity behavior, so seed a complete real ledger once rather than implicitly relying
 * on the pre-contract bypass. The dedicated evidence tests below exercise missing/stale rejection.
 */
async function seedGovernedDocumentEvidence(root: string, changeDir: string, name: string): Promise<void> {
  const docs = {
    proposal: `openspec/changes/${name}/proposal.md`,
    design: `openspec/changes/${name}/design.md`,
    tasks: `openspec/changes/${name}/tasks.md`,
    superpowerDesign: `docs/superpowers/specs/${name}-design.md`,
    adr: `docs/adr/${name}.md`,
    delta: `openspec/changes/${name}/specs/capability/spec.md`,
    plan: `docs/superpowers/plans/${name}.md`,
    report: `docs/superpowers/reports/${name}.md`,
    applied: 'openspec/specs/capability/spec.md',
  }
  for (const path of Object.values(docs)) {
    const abs = join(root, path)
    await mkdir(join(abs, '..'), { recursive: true })
    await writeFile(abs, `# ${path}\n`, 'utf8')
  }
  await writeFile(join(changeDir, '.pipeline-history.jsonl'), [
    'openspec-propose', 'brainstorming', 'writing-plans', 'verification-before-completion', 'openspec-apply-change',
  ].map((skill) => JSON.stringify({ kind: 'tool', raw: `Skill: ${skill}` })).join('\n') + '\n', 'utf8')

  const store = createStateStore()
  const originalPhase = String((await store.read(changeDir)).fields.phase)
  let receiptSequence = 0
  const record = async (
    phase: 'open' | 'explore' | 'spec' | 'verify' | 'ship',
    kind: Parameters<typeof recordDocument>[0]['kind'],
    path: string,
    producer: string,
  ): Promise<void> => {
    const recordedAt = FIXED_CLOCK()
    await store.set(changeDir, 'phase', phase)
    receiptSequence += 1
    await appendFile(join(changeDir, '.pipeline-history.jsonl'), `${JSON.stringify({
      ts: recordedAt, kind: 'init', raw: `fixture visit ${phase}`,
    })}\n${JSON.stringify({
      ts: recordedAt, kind: 'tool', raw: `Skill: ${producer}`,
    })}\n`, 'utf8')
    const confirmed = await recordNativeDocumentSkillConfirmation(changeDir, producer, phase, {
      sessionId: `transition-application-${name}`,
      toolUseId: `document-${receiptSequence}`,
      observedAt: recordedAt,
    })
    if (!confirmed) throw new Error(`fixture native confirmation rejected for ${producer}`)
    const ledger = await recordDocument({ repoRoot: root, changeDir, phase, policy: defaultDocumentPolicy(), kind, path, producer, recordedAt })
    const canonicalRecord = [...ledger.records].reverse().find((candidate) =>
      candidate.kind === kind && candidate.path === path && candidate.recordedAt === recordedAt)
    if (canonicalRecord === undefined) throw new Error(`fixture canonical record missing for ${path}`)
    if (await recordCanonicalDocumentSkillInvocation(
      changeDir, kind, recordedAt, { record: canonicalRecord },
    ) === undefined) throw new Error(`fixture canonical invocation missing for ${path}`)
  }
  await record('open', 'proposal', docs.proposal, 'openspec-propose')
  await record('open', 'openspec-design', docs.design, 'openspec-propose')
  await record('open', 'tasks', docs.tasks, 'openspec-propose')
  await record('explore', 'superpower-design', docs.superpowerDesign, 'brainstorming')
  await record('explore', 'adr', docs.adr, 'brainstorming')
  await record('spec', 'delta-spec', docs.delta, 'openspec-propose')
  await record('spec', 'superpower-plan', docs.plan, 'writing-plans')
  await record('spec', 'plan', docs.plan, 'writing-plans')
  await record('verify', 'verification-report', docs.report, 'verification-before-completion')
  await record('ship', 'applied-spec', docs.applied, 'openspec-apply-change')
  await store.set(changeDir, 'phase', originalPhase)
  for (const phase of ['explore', 'spec', 'build', 'verify', 'ship', 'archive'] as const) {
    await recordDocumentReads({ repoRoot: root, changeDir, phase, policy: defaultDocumentPolicy(), kind: 'all', readAt: FIXED_CLOCK() })
  }
}

/** Fixtures record the built-in default document table (identical in every default branch). */
function defaultDocumentPolicy() {
  const policy = compileEffectiveWorkflowPlan('default').documentPolicy
  if (policy === undefined) throw new Error('built-in default workflow must be document-governed')
  return policy
}

// TransitionCommand.loadWorkflow 现返回编译产物 WorkflowIR（adapter loadWorkflow→compileWorkflow）；
// 测试里保留人读的 WorkflowDef 常量，在 mock 里 compileWorkflow 成 IR，期望行为逐字不变。
const NEVER_FOUND_WORKFLOW = (): WorkflowIR | null => null
const policyFor = (humanGates: string[] = []) => compileAutomationPolicySnapshot({
  id: 'lp', name: 'Loop', kind: 'continuous', goal: 'Advance safely', cadence: 'manual', risk: 'low',
  runner: 'codex', change_prefix: 'demo', phases: [], human_gates: humanGates, state: 'iteration', design_doc: 'GOAL.md',
  status: 'active', budget: { max_runs_per_day: 2, max_in_flight: 1, on_exceed: 'skip' }, kill_criteria: [],
  autonomy_level: 'L3', allowlist: ['**'], denylist: [], skill_bundle_id: '_all',
} satisfies LoopEntry, { capturedAt: FIXED_CLOCK() })

describe('createTransitionApplication —— 唯一 TransitionApplication 用例（G1：CLI 与 server' +
  '共用同一份转换编排，消灭两处复制）', () => {
  describe('default workflow 轨', () => {
    test('H5 transition：policy 存在但当前 loop 非 active → commit 前 constraint-denied，状态/record 均不推进', async () => {
      const root = await freshRepoRoot()
      const deps = makeDeps({
        resolveConstraintContext: async () => ({ active: false, humanGateSatisfied: true }),
      } as Partial<TransitionApplicationDeps>)
      const dir = await initChange(deps, root, 'demo')
      await deps.runRepository.bindAutomationPolicy(dir, policyFor())
      const result = await createTransitionApplication(deps).execute({
        root, changeDir: dir, changeName: 'demo', actor: TEST_CREATOR, event: 'open-complete', context: {}, loadWorkflow: NEVER_FOUND_WORKFLOW,
      })
      expect(result).toEqual({ kind: 'constraint-denied', reason: 'loop-inactive' })
      expect((await createStateStore().read(dir)).fields.phase).toBe('open')
    })

    test('H5 transition：目标 explore 命中 human gate；AFK 未满足被拒，交互满足后同一事务正常提交', async () => {
      const root = await freshRepoRoot()
      let human = false
      const deps = makeDeps({
        resolveConstraintContext: async () => ({ active: true, humanGateSatisfied: human }),
      } as Partial<TransitionApplicationDeps>)
      const dir = await initChange(deps, root, 'demo')
      await deps.runRepository.bindAutomationPolicy(dir, policyFor(['explore']))
      const app = createTransitionApplication(deps)
      const command = { root, changeDir: dir, changeName: 'demo', actor: TEST_CREATOR, event: 'open-complete', context: {}, loadWorkflow: NEVER_FOUND_WORKFLOW }
      expect(await app.execute(command)).toEqual({ kind: 'constraint-denied', reason: 'human-gate-required' })
      human = true
      expect((await app.execute(command)).kind).toBe('applied')
    })

    test('成功转换：applied + from/to 正确 + record 真实存在 + 空 warnings', async () => {
      const root = await freshRepoRoot()
      const deps = makeDeps()
      const dir = await initChange(deps, root, 'demo')
      const app = createTransitionApplication(deps)
      const result = await app.execute({
        root, changeDir: dir, changeName: 'demo', actor: TEST_CREATOR, event: 'open-complete',
        context: {}, loadWorkflow: NEVER_FOUND_WORKFLOW,
      })
      expect(result.kind).toBe('applied')
      if (result.kind !== 'applied') throw new Error('expected applied')
      expect(result.from).toBe('open')
      expect(result.to).toBe('explore')
      expect(result.record.event).toBe('open-complete')
      expect(result.warnings).toEqual([])
    })

    test('tasks-through-phase 在 transition 锁内重验失败时零提交', async () => {
      const root = await freshRepoRoot()
      const deps = makeDeps()
      const dir = await initChange(deps, root, 'demo')
      const result = await createTransitionApplication(deps).execute({
        root, changeDir: dir, changeName: 'demo', actor: TEST_CREATOR, event: 'open-complete',
        context: { tasksThroughPhase: async () => ({ pass: false, failure: 'open 出口：canonical TaskPlan tasks.md 投影认证失败' }) },
        loadWorkflow: NEVER_FOUND_WORKFLOW,
      })
      expect(result).toEqual({
        kind: 'precondition-violated',
        lines: ['open 出口：canonical TaskPlan tasks.md 投影认证失败'],
      })
      expect((await createStateStore().read(dir)).fields.phase).toBe('open')
    })

    test('所有 default track（含 PM）缺 OpenSpec 文档/读取证据 → document-evidence-failed 且零提交', async () => {
      for (const track of ['backend', 'pm'] as const) {
        const root = await freshRepoRoot()
        const deps = makeDeps()
        // Deliberately bypass the fixture helper: initChange creates the empty ledger for a new default
        // change, so this is the real first-phase failure a normal workflow must surface.
        const { changeDir } = await deps.runRepository.initChange({
          repoRoot: root, name: `missing-evidence-${track}`, track, reviewSeed: 'pending', creator: TEST_CREATOR, preset: 'full', clock: FIXED_CLOCK,
        })
        const result = await createTransitionApplication(deps).execute({
          root, changeDir, changeName: `missing-evidence-${track}`, actor: TEST_CREATOR, event: 'open-complete', context: {}, loadWorkflow: NEVER_FOUND_WORKFLOW,
        })
        expect(result.kind).toBe('document-evidence-failed')
        if (result.kind !== 'document-evidence-failed') throw new Error('expected document-evidence-failed')
        expect(result.phase).toBe('open')
        expect(result.blockers.join('\n')).toContain("document 'proposal'")
        const state = await createStateStore().read(changeDir)
        expect(state.fields.phase).toBe('open')
        expect(state.runMetadata?.transitionSequence).toBe(0)
      }
    })

    test('成功转换后收尾顺序 = breadcrumb → history；review projection 不属于 transition', async () => {
      const root = await freshRepoRoot()
      const deps = makeDeps()
      const dir = await initChange(deps, root, 'demo')
      const order: string[] = []
      deps.breadcrumb = { write: async () => { order.push('breadcrumb') } }
      deps.history = { append: async () => { order.push('history') } }
      const app = createTransitionApplication(deps)
      await app.execute({
        root, changeDir: dir, changeName: 'demo', actor: TEST_CREATOR, event: 'open-complete',
        context: {}, loadWorkflow: NEVER_FOUND_WORKFLOW,
      })
      expect(order).toEqual(['breadcrumb', 'history'])
    })

    test('review 出口必须消费当前 phase 的 canonical approval receipt；进入 review phase 本身不写 marker', async () => {
      const root = await freshRepoRoot()
      const deps = makeDeps()
      const dir = await initChange(deps, root, 'demo')
      const store = createStateStore()
      await store.setMany(dir, {
        phase: 'explore',
        design_doc: 'openspec/changes/demo/design.md',
      })
      const app = createTransitionApplication(deps)
      const command = {
        root, changeDir: dir, changeName: 'demo', actor: TEST_CREATOR, event: 'explore-complete',
        context: { fileExists: () => true }, loadWorkflow: NEVER_FOUND_WORKFLOW,
      }
      expect(await app.execute(command)).toEqual({
        kind: 'review-approval-required', phase: 'explore', event: 'explore-complete',
      })
      expect((await store.read(dir)).fields.phase).toBe('explore')

      await store.setMany(dir, {
        review_gate_phase: 'explore',
        review_gate_status: 'approved',
        review_gate_event: 'explore-complete',
        review_requested_at: FIXED_CLOCK(),
        review_acknowledged_at: FIXED_CLOCK(),
      })
      expect((await app.execute(command)).kind).toBe('applied')
      const state = await store.read(dir)
      expect(state.fields.phase).toBe('spec')
      expect(state.fields.review_gate_status).toBe('')
      expect(state.fields.review_gate_phase).toBe('')
    })

    test('review binding verifier=false → review-approval-required，且不写 history/interaction、不消费 receipt', async () => {
      const root = await freshRepoRoot()
      let interactionCalls = 0
      const deps = makeDeps({
        reviewGateBinding: async () => false,
        interaction: { recordUnderLock: async () => { interactionCalls += 1 } },
      })
      const dir = await initChange(deps, root, 'demo')
      const store = createStateStore()
      await store.setMany(dir, {
        phase: 'explore',
        design_doc: 'openspec/changes/demo/design.md',
        review_gate_phase: 'explore',
        review_gate_status: 'approved',
        review_gate_event: 'explore-complete',
        review_requested_at: FIXED_CLOCK(),
        review_acknowledged_at: FIXED_CLOCK(),
      })
      const before = await store.read(dir)
      const result = await createTransitionApplication(deps).execute({
        root, changeDir: dir, changeName: 'demo', actor: TEST_CREATOR, event: 'explore-complete',
        context: { fileExists: () => true }, loadWorkflow: NEVER_FOUND_WORKFLOW,
      })
      expect(result).toEqual({ kind: 'review-approval-required', phase: 'explore', event: 'explore-complete' })
      const after = await store.read(dir)
      expect(after.fields).toEqual(before.fields)
      expect(after.runMetadata?.transitionSequence).toBe(before.runMetadata?.transitionSequence)
      expect(deps.historyEntries).toEqual([])
      expect(interactionCalls).toBe(0)
    })

    test('非 review transition 不调用 review binding verifier', async () => {
      const root = await freshRepoRoot()
      let verifierCalls = 0
      const deps = makeDeps({
        reviewGateBinding: async () => {
          verifierCalls += 1
          throw new Error('corrupt sidecar')
        },
      })
      const dir = await initChange(deps, root, 'demo')
      const result = await createTransitionApplication(deps).execute({
        root, changeDir: dir, changeName: 'demo', actor: TEST_CREATOR, event: 'open-complete',
        context: {}, loadWorkflow: NEVER_FOUND_WORKFLOW,
      })
      expect(result.kind).toBe('applied')
      expect(verifierCalls).toBe(0)
    })

    test('review receipt 绑定 exact event：verify-fail 的确认不能授权 verify-pass', async () => {
      const root = await freshRepoRoot()
      const deps = makeDeps()
      const dir = await initChange(deps, root, 'demo')
      const store = createStateStore()
      await store.setMany(dir, {
        phase: 'verify',
        verification_report: 'docs/v.md',
        branch_status: 'handled',
        agent_review_result: 'pass',
        codex_review_result: 'pass',
        isolation: 'branch',
        build_sha: GIT_BUILD_TOKEN,
        review_gate_phase: 'verify',
        review_gate_status: 'approved',
        review_gate_event: 'verify-fail',
        review_requested_at: FIXED_CLOCK(),
        review_acknowledged_at: FIXED_CLOCK(),
      })
      const app = createTransitionApplication(deps)
      const blocked = await app.execute({
        root, changeDir: dir, changeName: 'demo', actor: TEST_CREATOR, event: 'verify-pass',
        context: {
          fileExists: () => true,
          assessBuildRevision: TRUSTED_GIT_ASSESSMENT,
        }, loadWorkflow: NEVER_FOUND_WORKFLOW,
      })
      expect(blocked).toEqual({ kind: 'review-approval-required', phase: 'verify', event: 'verify-pass' })
      expect((await store.read(dir)).fields.phase).toBe('verify')

      const rollback = await app.execute({
        root, changeDir: dir, changeName: 'demo', actor: TEST_CREATOR, event: 'verify-fail',
        context: {}, loadWorkflow: NEVER_FOUND_WORKFLOW,
      })
      expect(rollback.kind).toBe('applied')
      expect((await store.read(dir)).fields.phase).toBe('build')
    })

    test('未知 event → unknown-event，不提交（commit 未发生：record store 里没有新记录，' +
      'runMetadata.transitionSequence 仍是 0）', async () => {
      const root = await freshRepoRoot()
      const deps = makeDeps()
      const dir = await initChange(deps, root, 'demo')
      const app = createTransitionApplication(deps)
      const result = await app.execute({
        root, changeDir: dir, changeName: 'demo', actor: TEST_CREATOR, event: 'no-such-event',
        context: {}, loadWorkflow: NEVER_FOUND_WORKFLOW,
      })
      expect(result).toEqual({ kind: 'unknown-event', event: 'no-such-event' })
      const state = await createStateStore().read(dir)
      expect(state.runMetadata?.transitionSequence).toBe(0)
      expect(deps.historyEntries).toEqual([])
    })

    test('event 与当前 phase 不匹配 → event-source-mismatch，携带 event/current/expected/to', async () => {
      const root = await freshRepoRoot()
      const deps = makeDeps()
      const dir = await initChange(deps, root, 'demo')
      const app = createTransitionApplication(deps)
      // demo 当前 phase=open；explore-complete 期望 from=explore，不匹配
      const result = await app.execute({
        root, changeDir: dir, changeName: 'demo', actor: TEST_CREATOR, event: 'explore-complete',
        context: {}, loadWorkflow: NEVER_FOUND_WORKFLOW,
      })
      expect(result).toEqual({
        kind: 'event-source-mismatch', event: 'explore-complete', current: 'open', expected: 'explore', to: 'spec',
      })
    })

    test('flow.transition 抛 IllegalTransitionError → illegal-transition，携带 from/to，不提交、' +
      '不产生任何 projection（第 1 轮 review 抓到：9 种 kind 里唯独这种没有直接用例——它与' +
      'event-source-mismatch 是两条独立路径：后者是本模块自己的 phase 前置检查，前者是' +
      'FlowEngine 按 manifest 合法转换表独立裁决的拒绝，manifest 收紧时可在前置检查通过后仍拒）', async () => {
      const root = await freshRepoRoot()
      const deps = makeDeps()
      const dir = await initChange(deps, root, 'demo')
      const realFlow = deps.flow
      deps.flow = {
        manifest: realFlow.manifest,
        legalTransitions: (p) => realFlow.legalTransitions(p),
        guardCheck: (s, c) => realFlow.guardCheck(s, c),
        transition: () => { throw new IllegalTransitionError('open', 'archive') },
      }
      const app = createTransitionApplication(deps)
      const result = await app.execute({
        root, changeDir: dir, changeName: 'demo', actor: TEST_CREATOR, event: 'open-complete', // 前置全过，走到 flow.transition 才抛
        context: {}, loadWorkflow: NEVER_FOUND_WORKFLOW,
      })
      expect(result).toEqual({ kind: 'illegal-transition', from: 'open', to: 'archive' })
      const state = await createStateStore().read(dir)
      expect(state.fields.phase).toBe('open') // 未提交
      expect(state.runMetadata?.transitionSequence).toBe(0)
      expect(deps.historyEntries).toEqual([]) // 零 projection
      expect(deps.breadcrumbCalls).toEqual([])
    })

    test('前置校验不满足（explore-complete 缺 design_doc）→ precondition-violated + lines', async () => {
      const root = await freshRepoRoot()
      const deps = makeDeps()
      const dir = await initChange(deps, root, 'demo')
      await createStateStore().set(dir, 'phase', 'explore')
      const app = createTransitionApplication(deps)
      const result = await app.execute({
        root, changeDir: dir, changeName: 'demo', actor: TEST_CREATOR, event: 'explore-complete',
        context: {}, loadWorkflow: NEVER_FOUND_WORKFLOW,
      })
      expect(result.kind).toBe('precondition-violated')
      if (result.kind !== 'precondition-violated') throw new Error('expected precondition-violated')
      expect(result.lines.length).toBeGreaterThan(0)
    })

    test('ship-complete 由运行时 typed guard 强制迁移证据，缺失能力/非法证据零提交，有效状态才推进', async () => {
      const root = await freshRepoRoot()
      const deps = makeDeps()
      const dir = await initChange(deps, root, 'demo')
      await createStateStore().set(dir, 'phase', 'ship')
      const app = createTransitionApplication(deps)

      const missing = await app.execute({
        root, changeDir: dir, changeName: 'demo', actor: TEST_CREATOR, event: 'ship-complete',
        context: {}, loadWorkflow: NEVER_FOUND_WORKFLOW,
      })
      expect(missing.kind).toBe('precondition-violated')
      expect((await createStateStore().read(dir)).fields.phase).toBe('ship')

      const invalid = await app.execute({
        root, changeDir: dir, changeName: 'demo', actor: TEST_CREATOR, event: 'ship-complete',
        context: { specMigrationStatus: async () => ({ kind: 'invalid', reason: 'receipt-mismatch' }) },
        loadWorkflow: NEVER_FOUND_WORKFLOW,
      })
      expect(invalid.kind).toBe('precondition-violated')
      expect((await createStateStore().read(dir)).fields.phase).toBe('ship')

      const applied = await app.execute({
        root, changeDir: dir, changeName: 'demo', actor: TEST_CREATOR, event: 'ship-complete',
        context: { specMigrationStatus: async () => ({ kind: 'not-required' }) },
        loadWorkflow: NEVER_FOUND_WORKFLOW,
      })
      expect(applied.kind).toBe('applied')
      expect((await createStateStore().read(dir)).fields.phase).toBe('archive')
    })

    test('build-complete 且 capture capability 未注入 → revision-untrusted 且零提交', async () => {
      const root = await freshRepoRoot()
      const deps = makeDeps()
      const dir = await initChange(deps, root, 'demo')
      // preset=full ∧ build_mode=direct 需要显式 direct_override=true（flow/transition-table.ts
      // 的 build-complete 前置校验第三项），否则会先撞这条而不是走到我们要测的 buildShaMissing。
      await createStateStore().setMany(
        dir, {
          phase: 'build', build_mode: 'direct', isolation: 'branch', direct_override: 'true',
          pre_verify_review_result: 'pass',
        },
      )
      const canonicalBefore = await createStateStore().read(dir)
      const canonicalBeforeHash = safeRevisionHash(canonicalBefore.fields)
      const app = createTransitionApplication(deps)
      const result = await app.execute({
        root, changeDir: dir, changeName: 'demo', actor: TEST_CREATOR, event: 'build-complete',
        context: {}, // 无 capture capability → fail-closed
        loadWorkflow: NEVER_FOUND_WORKFLOW,
      })
      expect(result).toMatchObject({ kind: 'revision-untrusted', blocker: {
        code: 'verify-build-revision-untrusted', reason: 'capability-unavailable', stateHash: canonicalBeforeHash,
      } })
      const state = await createStateStore().read(dir)
      expect(state.fields.phase).toBe('build')
      expect(state.runMetadata?.transitionSequence).toBe(0)
      expect(deps.historyEntries).toEqual([])
    })

    test('approved transition remains applied when interaction effect projection fails', async () => {
      const root = await freshRepoRoot()
      const interaction = {
        recordUnderLock: async (): Promise<never> => {
          throw new Error('interaction projection disk full')
        },
      }
      const deps = makeDeps({ interaction })
      const dir = await initChange(deps, root, 'demo')
      await createStateStore().setMany(dir, {
        phase: 'explore',
        design_doc: 'openspec/changes/demo/design.md',
        review_gate_phase: 'explore',
        review_gate_status: 'approved',
        review_gate_event: 'explore-complete',
        review_requested_at: FIXED_CLOCK(),
        review_acknowledged_at: FIXED_CLOCK(),
      })
      const result = await createTransitionApplication(deps).execute({
        root,
        changeDir: dir,
        changeName: 'demo',
        actor: TEST_CREATOR, event: 'explore-complete',
        context: { fileExists: () => true },
        loadWorkflow: NEVER_FOUND_WORKFLOW,
      })
      expect(result.kind).toBe('applied')
      if (result.kind !== 'applied') return
      expect(result.warnings).toContainEqual({
        kind: 'projection-write-failed',
        projection: 'interaction',
        code: INTERACTION_PROJECTION_WRITE_FAILED,
        cause: expect.any(Error),
      })
      expect((await createStateStore().read(dir)).fields.phase).toBe('spec')
    })

    test('requirements-changed：即使上游文档已 stale 也可从 build 受控回退 spec，零伪造 receipt', async () => {
      const root = await freshRepoRoot()
      const deps = makeDeps()
      const dir = await initChange(deps, root, 'demo')
      await createStateStore().setMany(dir, {
        phase: 'build',
        pre_verify_review_result: 'pass',
      })
      await writeFile(join(dir, 'proposal.md'), '# revised during build\n', 'utf8')

      let taskGateCalled = false
      const result = await createTransitionApplication(deps).execute({
        root, changeDir: dir, changeName: 'demo', actor: TEST_CREATOR, event: 'requirements-changed',
        context: { tasksThroughPhase: async () => {
          taskGateCalled = true
          return { pass: false, failure: 'build 出口：tasks.md 仍有 1 项未勾' }
        } },
        loadWorkflow: NEVER_FOUND_WORKFLOW,
      })
      expect(result.kind).toBe('applied')
      expect(taskGateCalled).toBe(false)
      expect((await createStateStore().read(dir)).fields).toMatchObject({
        phase: 'spec',
        phase_status: 'in_progress',
        pre_verify_review_result: 'pending',
      })
    })

    test('projection（breadcrumb）写失败 → 仍是 applied，失败进 warnings 而不是让整体失败（commit' +
      '是不可回退的成功点，projection 只是 commit 之后的 best-effort 兼容投影）', async () => {
      const root = await freshRepoRoot()
      const deps = makeDeps()
      const dir = await initChange(deps, root, 'demo')
      deps.breadcrumb = { write: async () => { throw new Error('disk full') } }
      const app = createTransitionApplication(deps)
      const result = await app.execute({
        root, changeDir: dir, changeName: 'demo', actor: TEST_CREATOR, event: 'open-complete',
        context: {}, loadWorkflow: NEVER_FOUND_WORKFLOW,
      })
      expect(result.kind).toBe('applied')
      if (result.kind !== 'applied') throw new Error('expected applied')
      expect(result.warnings).toEqual([
        { kind: 'projection-write-failed', projection: 'breadcrumb', cause: expect.any(Error) },
      ])
      // 真的提交了：record 存在、state 已推进
      const state = await createStateStore().read(dir)
      expect(state.fields.phase).toBe('explore')
    })

    test('deps.history/breadcrumb 全部缺省（测试可不注入）→ applied，零 warnings', async () => {
      const root = await freshRepoRoot()
      const deps = makeDeps({ history: undefined, breadcrumb: undefined })
      const dir = await initChange(deps, root, 'demo')
      const app = createTransitionApplication(deps)
      const result = await app.execute({
        root, changeDir: dir, changeName: 'demo', actor: TEST_CREATOR, event: 'open-complete',
        context: {}, loadWorkflow: NEVER_FOUND_WORKFLOW,
      })
      expect(result.kind).toBe('applied')
    })
  })

  describe('G2 P3：default 轨 typed guard/action 迁移的 IO 不变量（防双执行 + 拒绝零提交）', () => {
    test('build-complete：captureBuildRevision 恰调一次且冻结 canonical token（拒绝 legacy fallback）', async () => {
      const root = await freshRepoRoot()
      const deps = makeDeps()
      const dir = await initChange(deps, root, 'demo')
      await createStateStore().setMany(dir, {
        phase: 'build', build_mode: 'direct', isolation: 'branch', direct_override: 'true',
        pre_verify_review_result: 'pass',
      })
      let captureCalls = 0
      const app = createTransitionApplication(deps)
      const result = await app.execute({
        root, changeDir: dir, changeName: 'demo', actor: TEST_CREATOR, event: 'build-complete',
        context: { captureBuildRevision: async () => { captureCalls++; return GIT_BUILD_TOKEN } },
        loadWorkflow: NEVER_FOUND_WORKFLOW,
      })
      expect(result.kind).toBe('applied')
      expect(captureCalls).toBe(1)
      const state = await createStateStore().read(dir)
      expect(state.fields.build_sha).toBe(GIT_BUILD_TOKEN)
      expect(state.fields.phase).toBe('verify')
    })

    test('verify-pass：assessor 恰调一次（mark action 不重复评估）→ 通过并落 verify_result=pass', async () => {
      const root = await freshRepoRoot()
      const deps = makeDeps()
      const dir = await initChange(deps, root, 'demo')
      await createStateStore().setMany(dir, {
        phase: 'verify', verification_report: 'docs/v.md', branch_status: 'handled',
        agent_review_result: 'pass', codex_review_result: 'pass', isolation: 'branch', build_sha: GIT_BUILD_TOKEN,
        review_gate_phase: 'verify', review_gate_status: 'approved',
        review_gate_event: 'verify-pass',
        review_requested_at: FIXED_CLOCK(), review_acknowledged_at: FIXED_CLOCK(),
      })
      let assessCalls = 0
      const app = createTransitionApplication(deps)
      const result = await app.execute({
        root, changeDir: dir, changeName: 'demo', actor: TEST_CREATOR, event: 'verify-pass',
        context: {
          fileExists: () => true,
          assessBuildRevision: async (request) => { assessCalls++; return TRUSTED_GIT_ASSESSMENT(request) },
        },
        loadWorkflow: NEVER_FOUND_WORKFLOW,
      })
      expect(result.kind).toBe('applied')
      expect(assessCalls).toBe(1)
      const state = await createStateStore().read(dir)
      expect(state.fields.verify_result).toBe('pass')
      expect(state.fields.phase).toBe('ship')
    })

    test('barrier 拒绝（revision stale）→ typed blocker + 零提交（phase 不推进、seq=0、零 projection）', async () => {
      const root = await freshRepoRoot()
      const deps = makeDeps()
      const dir = await initChange(deps, root, 'demo')
      await createStateStore().setMany(dir, {
        phase: 'verify', verification_report: 'docs/v.md', branch_status: 'handled',
        agent_review_result: 'pass', codex_review_result: 'pass', isolation: 'branch', build_sha: GIT_BUILD_TOKEN,
      })
      const app = createTransitionApplication(deps)
      const result = await app.execute({
        root, changeDir: dir, changeName: 'demo', actor: TEST_CREATOR, event: 'verify-pass',
        context: {
          fileExists: () => true,
          assessBuildRevision: async () => ({ trusted: false as const, blocker: makeBuildRevisionBlocker('revision-stale') }),
        },
        loadWorkflow: NEVER_FOUND_WORKFLOW,
      })
      expect(result).toMatchObject({ kind: 'revision-untrusted', blocker: {
        code: 'verify-build-revision-untrusted', reason: 'revision-stale',
      } })
      const state = await createStateStore().read(dir)
      expect(state.fields.phase).toBe('verify')
      expect(state.runMetadata?.transitionSequence).toBe(0)
      expect(deps.historyEntries).toEqual([])
      expect(deps.breadcrumbCalls).toEqual([])
    })

    test('verify-fail：mark-verification-failed 落 verify_result=fail + build_sha=null（barrier 复位）+' +
      'phase 回退 build/phase_status=in_progress', async () => {
      const root = await freshRepoRoot()
      const deps = makeDeps()
      const dir = await initChange(deps, root, 'demo')
      await createStateStore().setMany(dir, {
        phase: 'verify', build_sha: 'STALE', pre_verify_review_result: 'pass',
        review_gate_phase: 'verify', review_gate_status: 'approved',
        review_gate_event: 'verify-fail',
        review_requested_at: FIXED_CLOCK(), review_acknowledged_at: FIXED_CLOCK(),
      })
      const app = createTransitionApplication(deps)
      let taskGateCalled = false
      const result = await app.execute({
        root, changeDir: dir, changeName: 'demo', actor: TEST_CREATOR, event: 'verify-fail',
        context: { tasksThroughPhase: async () => {
          taskGateCalled = true
          return { pass: false, failure: 'verify 出口：tasks.md 仍有 2 项未勾' }
        } },
        loadWorkflow: NEVER_FOUND_WORKFLOW,
      })
      expect(result.kind).toBe('applied')
      expect(taskGateCalled).toBe(false)
      const state = await createStateStore().read(dir)
      expect(state.fields.verify_result).toBe('fail')
      expect(state.fields.build_sha).toBe('null')
      expect(state.fields.phase).toBe('build')
      expect(state.fields.phase_status).toBe('in_progress')
      expect(state.fields.pre_verify_review_result).toBe('pending')
    })
  })

  describe('custom workflow 轨', () => {
    const TWO_STEP_WF: WorkflowDef = {
      name: 'onboarding',
      steps: [
        { id: 'intake', label: 'intake', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [{ event: 'complete', to: 'done' }] },
        { id: 'done', label: 'done', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] },
      ],
    }

    async function initCustomChange(deps: ReturnType<typeof makeDeps>, root: string, name: string): Promise<string> {
      const { changeDir } = await deps.runRepository.initChange({
        repoRoot: root, name, track: 'backend', reviewSeed: 'pending', creator: TEST_CREATOR, preset: 'full', clock: FIXED_CLOCK,
        initialWorkflow: { workflow: 'onboarding', phase: 'intake' },
      })
      return changeDir
    }

    test('成功转换：applied + from/to = step id，只写 history，不写 breadcrumb', async () => {
      const root = await freshRepoRoot()
      const deps = makeDeps()
      const dir = await initCustomChange(deps, root, 'demo')
      const app = createTransitionApplication(deps)
      const result = await app.execute({
        root, changeDir: dir, changeName: 'demo', actor: TEST_CREATOR, event: 'complete',
        context: {}, loadWorkflow: (name) => (name === 'onboarding' ? compileWorkflow(TWO_STEP_WF) : null),
      })
      expect(result.kind).toBe('applied')
      if (result.kind !== 'applied') throw new Error('expected applied')
      expect(result.from).toBe('intake')
      expect(result.to).toBe('done')
      expect(deps.historyEntries).toHaveLength(1)
      expect(deps.breadcrumbCalls).toHaveLength(0)
    })

    test('声明 skill 的 step 在证据缺失时零提交；当前 visit 证据齐全后才允许退出', async () => {
      const root = await freshRepoRoot()
      let completed = new Set<string>()
      const deps = makeDeps({
        missingStepSkills: async ({ capability, stepId }) => {
          const required = capability.steps.find((step) => step.stepId === stepId)?.requiredSkillIds ?? []
          return required.filter((skillId) => !completed.has(skillId))
        },
      })
      const dir = await initCustomChange(deps, root, 'demo')
      const withSkill: WorkflowDef = {
        ...TWO_STEP_WF,
        steps: [
          { ...TWO_STEP_WF.steps[0]!, skills: [{ id: 'simple-task' }] },
          TWO_STEP_WF.steps[1]!,
        ],
      }
      const command = {
        root,
        changeDir: dir,
        changeName: 'demo',
        actor: TEST_CREATOR, event: 'complete',
        context: {},
        loadWorkflow: (name: string) => name === 'onboarding' ? compileWorkflow(withSkill) : null,
      }
      await expect(createTransitionApplication(deps).execute(command)).resolves.toEqual({
        kind: 'step-skills-incomplete',
        workflowName: 'onboarding',
        stepId: 'intake',
        missing: ['simple-task'],
      })
      expect((await createStateStore().read(dir)).fields.phase).toBe('intake')
      completed = new Set(['simple-task'])
      await expect(createTransitionApplication(deps).execute(command)).resolves.toMatchObject({
        kind: 'applied',
        from: 'intake',
        to: 'done',
      })
    })

    test('workflow 未找到 → workflow-not-found', async () => {
      const root = await freshRepoRoot()
      const deps = makeDeps()
      const dir = await initCustomChange(deps, root, 'demo')
      const app = createTransitionApplication(deps)
      const result = await app.execute({
        root, changeDir: dir, changeName: 'demo', actor: TEST_CREATOR, event: 'complete',
        context: {}, loadWorkflow: NEVER_FOUND_WORKFLOW,
      })
      expect(result).toEqual({ kind: 'workflow-not-found', workflowName: 'onboarding' })
    })

    test('初始化时绑定的 document contract 被移除后 transition fail-closed 且零提交', async () => {
      const root = await freshRepoRoot()
      const deps = makeDeps()
      const governed: WorkflowDef = {
        name: 'governed',
        openspec: true,
        documentContract: {
          version: 'v1',
          slots: [{ kind: 'proposal', ownerStep: 'intake', producers: ['writer'] }],
          reads: [],
        },
        steps: [
          {
            id: 'intake', label: 'intake', gate: null, skills: [{ id: 'writer' }],
            inputs: [], outputs: [], guards: [], transitions: [{ event: 'complete', to: 'done' }],
          },
          {
            id: 'done', label: 'done', gate: null, skills: [],
            inputs: [], outputs: [], guards: [], transitions: [],
          },
        ],
      }
      const policy = compileEffectiveWorkflowPlan('governed', governed).documentPolicy
      if (!policy) throw new Error('expected document policy')
      const { changeDir } = await deps.runRepository.initChange({
        repoRoot: root, name: 'demo', track: 'backend', reviewSeed: 'pending', creator: TEST_CREATOR, preset: 'full', clock: FIXED_CLOCK,
        initialWorkflow: {
          workflow: 'governed',
          phase: 'intake',
          documentProfile: 'document-v1',
          documentGovernanceFingerprint: documentGovernanceFingerprint(policy),
        },
      })

      const result = await createTransitionApplication(deps).execute({
        root,
        changeDir,
        changeName: 'demo',
        actor: TEST_CREATOR, event: 'complete',
        context: {},
        loadWorkflow: (name) => name === 'governed'
          ? compileWorkflow({ name: 'governed', steps: governed.steps })
          : null,
      })

      expect(result).toMatchObject({
        kind: 'document-governance-invalid',
        workflowName: 'governed',
      })
      const state = await createStateStore().read(changeDir)
      expect(state.fields.phase).toBe('intake')
      expect(state.runMetadata?.transitionSequence).toBe(0)
    })

    test('event 在当前 step 不支持 → event-unsupported + available', async () => {
      const root = await freshRepoRoot()
      const deps = makeDeps()
      const dir = await initCustomChange(deps, root, 'demo')
      const app = createTransitionApplication(deps)
      const result = await app.execute({
        root, changeDir: dir, changeName: 'demo', actor: TEST_CREATOR, event: 'no-such-event',
        context: {}, loadWorkflow: (name) => (name === 'onboarding' ? compileWorkflow(TWO_STEP_WF) : null),
      })
      expect(result).toEqual({
        kind: 'event-unsupported', workflowName: 'onboarding', stepId: 'intake', event: 'no-such-event', available: ['complete'],
      })
    })

    test('当前 step 不在 workflow 图里 → step-not-in-graph', async () => {
      const root = await freshRepoRoot()
      const deps = makeDeps()
      const dir = await initCustomChange(deps, root, 'demo')
      await createStateStore().set(dir, 'phase', 'ghost-step')
      const app = createTransitionApplication(deps)
      const result = await app.execute({
        root, changeDir: dir, changeName: 'demo', actor: TEST_CREATOR, event: 'complete',
        context: {}, loadWorkflow: (name) => (name === 'onboarding' ? compileWorkflow(TWO_STEP_WF) : null),
      })
      expect(result).toEqual({ kind: 'step-not-in-graph', workflowName: 'onboarding', stepId: 'ghost-step' })
    })

    test('step guard 未通过 → step-guard-failed + failures', async () => {
      const root = await freshRepoRoot()
      const deps = makeDeps()
      const guardedWf: WorkflowDef = {
        name: 'guarded',
        steps: [
          {
            // tasks-at-least 需要 n 个已勾选任务；新建 change 目录里没有 tasks.md，taskCount=0，
            // 0 < 1 必然不满足——不依赖任何手工构造的坏文件，纯粹靠"什么都没有"触发。
            id: 'intake', label: 'intake', gate: null, skills: [], inputs: [], outputs: [],
            guards: [{ type: 'tasks-at-least', n: 1 }], transitions: [{ event: 'complete', to: 'done' }],
          },
          { id: 'done', label: 'done', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] },
        ],
      }
      const { changeDir: dir } = await deps.runRepository.initChange({
        repoRoot: root, name: 'demo', track: 'backend', reviewSeed: 'pending', creator: TEST_CREATOR, preset: 'full', clock: FIXED_CLOCK,
        initialWorkflow: { workflow: 'guarded', phase: 'intake' },
      })
      const app = createTransitionApplication(deps)
      const result = await app.execute({
        root, changeDir: dir, changeName: 'demo', actor: TEST_CREATOR, event: 'complete',
        context: {}, loadWorkflow: (name) => (name === 'guarded' ? compileWorkflow(guardedWf) : null),
      })
      expect(result.kind).toBe('step-guard-failed')
      if (result.kind !== 'step-guard-failed') throw new Error('expected step-guard-failed')
      expect(result.workflowName).toBe('guarded')
      expect(result.stepId).toBe('intake')
      expect(result.failures.length).toBeGreaterThan(0)
    })
  })

  describe('隐式完成边：没有前进出边的 custom step 以保留事件 archived 完成运行', () => {
    type Step = WorkflowDef['steps'][number]
    const step = (id: string, overrides: Partial<Step> = {}): Step => ({
      id, label: id, gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [], ...overrides,
    })
    // Shapes saved by the Dashboard editor: forward `<id>-complete`, send-back `<id>-back`, no exit on the last stage.
    const MAIN: WorkflowDef = {
      name: 'ui-main',
      steps: [
        step('stage-1', { gate: 'review', transitions: [{ event: 'stage-1-complete', to: 'build' }] }),
        step('build', { gate: 'auto', transitions: [{ event: 'build-complete', to: 'verify' }] }),
        step('verify', {
          gate: 'review',
          skills: [{ id: 'verification-before-completion' }],
          transitions: [{ event: 'verify-back', to: 'build' }],
        }),
      ],
    }
    const DOCS: WorkflowDef = {
      name: 'ui-docs',
      steps: [
        step('stage-1', { gate: 'review', transitions: [{ event: 'stage-1-complete', to: 'build' }] }),
        step('build', {
          gate: 'auto',
          skills: [{ id: 'test-driven-development' }],
          outputs: [{ field: 'design_doc', type: 'file_path' }],
        }),
      ],
    }
    const loaderFor = (def: WorkflowDef) => (name: string): WorkflowIR | null =>
      name === def.name ? compileWorkflow(def) : null
    const approved = (phase: string, event: string) => ({
      review_gate_phase: phase,
      review_gate_status: 'approved',
      review_gate_event: event,
      review_requested_at: FIXED_CLOCK(),
      review_acknowledged_at: FIXED_CLOCK(),
    })
    const missingSkills = (completed: () => ReadonlySet<string>): TransitionApplicationDeps['missingStepSkills'] =>
      async ({ capability, stepId }) =>
        (capability.steps.find((candidate) => candidate.stepId === stepId)?.requiredSkillIds ?? [])
          .filter((skillId) => !completed().has(skillId))
    async function initAt(
      deps: ReturnType<typeof makeDeps>, root: string, workflow: string, phase: string,
    ): Promise<string> {
      const { changeDir } = await deps.runRepository.initChange({
        repoRoot: root, name: 'demo', track: 'backend', reviewSeed: 'pending', creator: TEST_CREATOR, preset: 'full', clock: FIXED_CLOCK,
        initialWorkflow: { workflow, phase },
      })
      return changeDir
    }

    test('末阶段只有退回边（gate=review）：skill 与 exact archived receipt 齐才归档，run 关闭且不可重复归档', async () => {
      const root = await freshRepoRoot()
      let completed: ReadonlySet<string> = new Set()
      const deps = makeDeps({ missingStepSkills: missingSkills(() => completed) })
      const dir = await initAt(deps, root, 'ui-main', 'verify')
      const store = createStateStore()
      const command = {
        root, changeDir: dir, changeName: 'demo', actor: TEST_CREATOR, event: 'archived', context: {}, loadWorkflow: loaderFor(MAIN),
      }

      await expect(createTransitionApplication(deps).execute(command)).resolves.toEqual({
        kind: 'step-skills-incomplete', workflowName: 'ui-main', stepId: 'verify', missing: ['verification-before-completion'],
      })
      completed = new Set(['verification-before-completion'])
      await expect(createTransitionApplication(deps).execute(command)).resolves.toEqual({
        kind: 'review-approval-required', phase: 'verify', event: 'archived',
      })
      // An approval of the send-back edge never authorizes completion.
      await store.setMany(dir, approved('verify', 'verify-back'))
      await expect(createTransitionApplication(deps).execute(command)).resolves.toEqual({
        kind: 'review-approval-required', phase: 'verify', event: 'archived',
      })
      expect((await store.read(dir)).fields.archived).not.toBe('true')

      await store.setMany(dir, approved('verify', 'archived'))
      await expect(createTransitionApplication(deps).execute(command)).resolves.toMatchObject({
        kind: 'applied', from: 'verify', to: 'verify', record: { event: 'archived', from: 'verify', to: 'verify' },
      })
      const closed = await store.read(dir)
      expect(closed.fields).toMatchObject({
        phase: 'verify', phase_status: 'done', archived: 'true', archived_at: FIXED_CLOCK(),
      })
      expect(closed.fields.review_gate_status).not.toBe('approved')
      expect(await deps.runRepository.transact(dir, async (tx) => tx.run.lifecycle)).toBe('archived')

      await expect(createTransitionApplication(deps).execute(command)).resolves.toEqual({
        kind: 'event-unsupported', workflowName: 'ui-main', stepId: 'verify', event: 'archived', available: ['verify-back'],
      })
    })

    test('零出边 step（gate=auto）：进入不等于完成；输出守卫与 skill 都通过后 archived 归档', async () => {
      const root = await freshRepoRoot()
      let completed: ReadonlySet<string> = new Set()
      const deps = makeDeps({ missingStepSkills: missingSkills(() => completed) })
      const dir = await initAt(deps, root, 'ui-docs', 'stage-1')
      const store = createStateStore()
      const base = { root, changeDir: dir, changeName: 'demo', actor: TEST_CREATOR, context: {}, loadWorkflow: loaderFor(DOCS) }

      await store.setMany(dir, approved('stage-1', 'stage-1-complete'))
      await expect(createTransitionApplication(deps).execute({ ...base, event: 'stage-1-complete' }))
        .resolves.toMatchObject({ kind: 'applied', from: 'stage-1', to: 'build' })
      const entered = await store.read(dir)
      expect(entered.fields.phase).toBe('build')
      expect(entered.fields.archived).not.toBe('true')
      expect(entered.fields.phase_status).not.toBe('done')
      expect(await deps.runRepository.transact(dir, async (tx) => tx.run.lifecycle)).toBe('active')

      const missingOutput = await createTransitionApplication(deps).execute({ ...base, event: 'archived' })
      expect(missingOutput).toMatchObject({ kind: 'step-guard-failed', workflowName: 'ui-docs', stepId: 'build' })
      if (missingOutput.kind !== 'step-guard-failed') throw new Error('expected step-guard-failed')
      expect(missingOutput.failures.join('\n')).toContain('design_doc')

      await store.set(dir, 'design_doc', 'docs/design.md')
      await expect(createTransitionApplication(deps).execute({ ...base, event: 'archived' })).resolves.toEqual({
        kind: 'step-skills-incomplete', workflowName: 'ui-docs', stepId: 'build', missing: ['test-driven-development'],
      })
      expect((await store.read(dir)).fields.archived).not.toBe('true')

      completed = new Set(['test-driven-development'])
      await expect(createTransitionApplication(deps).execute({ ...base, event: 'archived' }))
        .resolves.toMatchObject({ kind: 'applied', from: 'build', to: 'build' })
      expect((await store.read(dir)).fields).toMatchObject({ phase: 'build', phase_status: 'done', archived: 'true' })
    })

    test('有前进出边的 step 不接受 archived，也不把它列为可选 event', async () => {
      const root = await freshRepoRoot()
      const deps = makeDeps()
      const dir = await initAt(deps, root, 'ui-main', 'stage-1')
      await expect(createTransitionApplication(deps).execute({
        root, changeDir: dir, changeName: 'demo', actor: TEST_CREATOR, event: 'archived', context: {}, loadWorkflow: loaderFor(MAIN),
      })).resolves.toEqual({
        kind: 'event-unsupported', workflowName: 'ui-main', stepId: 'stage-1', event: 'archived', available: ['stage-1-complete'],
      })
      expect((await createStateStore().read(dir)).runMetadata?.transitionSequence).toBe(0)
    })

    test('archive 终点保持原行为：archived 归档一次，已归档后拒绝', async () => {
      const root = await freshRepoRoot()
      const deps = makeDeps()
      const ARCHIVE: WorkflowDef = {
        name: 'archive-terminal',
        steps: [step('ship', { transitions: [{ event: 'ship-complete', to: 'archive' }] }), step('archive')],
      }
      const dir = await initAt(deps, root, 'archive-terminal', 'archive')
      const command = {
        root, changeDir: dir, changeName: 'demo', actor: TEST_CREATOR, event: 'archived', context: {}, loadWorkflow: loaderFor(ARCHIVE),
      }
      await expect(createTransitionApplication(deps).execute(command))
        .resolves.toMatchObject({ kind: 'applied', from: 'archive', to: 'archive' })
      expect((await createStateStore().read(dir)).fields).toMatchObject({ phase_status: 'done', archived: 'true' })
      await expect(createTransitionApplication(deps).execute(command)).resolves.toEqual({
        kind: 'event-unsupported', workflowName: 'archive-terminal', stepId: 'archive', event: 'archived', available: [],
      })
    })

    test('simple 保持原行为：verify-pass 的显式 archive-run 进入 done，change/done 都不接受 archived', async () => {
      const root = await freshRepoRoot()
      const deps = makeDeps()
      const simple = builtinWorkflow('simple')
      if (simple === null) throw new Error('simple workflow missing')
      const dir = await initAt(deps, root, 'simple', 'change')
      const base = { root, changeDir: dir, changeName: 'demo', actor: TEST_CREATOR, context: {}, loadWorkflow: loaderFor(simple) }

      await expect(createTransitionApplication(deps).execute({ ...base, event: 'archived' })).resolves.toEqual({
        kind: 'event-unsupported', workflowName: 'simple', stepId: 'change', event: 'archived',
        available: ['change-complete', 'scope-expanded'],
      })
      await expect(createTransitionApplication(deps).execute({ ...base, event: 'change-complete' }))
        .resolves.toMatchObject({ kind: 'applied', to: 'verify' })
      await expect(createTransitionApplication(deps).execute({ ...base, event: 'verify-pass' }))
        .resolves.toMatchObject({ kind: 'applied', to: 'done' })
      expect((await createStateStore().read(dir)).fields).toMatchObject({ phase: 'done', archived: 'true' })
      await expect(createTransitionApplication(deps).execute({ ...base, event: 'archived' })).resolves.toEqual({
        kind: 'event-unsupported', workflowName: 'simple', stepId: 'done', event: 'archived', available: [],
      })
    })
  })

  describe('提交原子性：projection 失败不回滚 commit', () => {
    test('canonical current 已提交但 YAML adapter 写失败 → applied + state-yaml warning，状态真实推进', async () => {
      const root = await freshRepoRoot()
      let failProjection = false
      const store = createStateStore({
        writeProjection: async (target, content) => {
          if (failProjection) throw new Error('yaml projection disk full')
          await atomicWriteFile(target, content)
        },
      })
      const runRepository = createWorkflowRunRepository({
        store, recordStore: createTransitionRecordStore(), clock: FIXED_CLOCK,
      })
      const deps = makeDeps({ runRepository })
      const dir = await initChange(deps, root, 'demo')
      failProjection = true

      const result = await createTransitionApplication(deps).execute({
        root, changeDir: dir, changeName: 'demo', actor: TEST_CREATOR, event: 'open-complete',
        context: {}, loadWorkflow: NEVER_FOUND_WORKFLOW,
      })

      expect(result.kind).toBe('applied')
      if (result.kind !== 'applied') throw new Error('expected applied')
      expect(result.warnings).toContainEqual({
        kind: 'projection-write-failed', projection: 'state-yaml', cause: expect.any(Error),
      })
      expect((await store.read(dir)).fields.phase).toBe('explore')
      expect(await store.inspectProjection(dir)).toMatchObject({ status: 'stale' })
    })

    test('history 写失败仍是 applied，且 state 已经真实推进（commit 早于 projection）', async () => {
      const root = await freshRepoRoot()
      const deps = makeDeps()
      const dir = await initChange(deps, root, 'demo')
      deps.history = { append: async () => { throw new Error('disk full') } }
      const app = createTransitionApplication(deps)
      const result = await app.execute({
        root, changeDir: dir, changeName: 'demo', actor: TEST_CREATOR, event: 'open-complete',
        context: {}, loadWorkflow: NEVER_FOUND_WORKFLOW,
      })
      expect(result.kind).toBe('applied')
      const state = await createStateStore().read(dir)
      expect(state.fields.phase).toBe('explore')
    })
  })

  describe('G2 P2 custom 轨 typed handler 接线（edge action/guard、when 按 track、handler 异常中止事务）', () => {
    async function initCustom(deps: ReturnType<typeof makeDeps>, root: string, workflow: string, phase: string): Promise<string> {
      const { changeDir } = await deps.runRepository.initChange({
        repoRoot: root, name: 'demo', track: 'backend', reviewSeed: 'pending', creator: TEST_CREATOR, preset: 'full', clock: FIXED_CLOCK,
        initialWorkflow: { workflow, phase },
      })
      return changeDir
    }

    test('edge action mark-verification-passed 真改字段：verify_result 落盘 pass、verified_at 落时钟（patch 在 commit 前并入 nextFields）', async () => {
      const root = await freshRepoRoot()
      const deps = makeDeps()
      const wf: WorkflowDef = {
        name: 'vf',
        steps: [
          {
            id: 'verify', label: '', gate: null, skills: [], inputs: [], outputs: [], guards: [],
            transitions: [{ event: 'pass', to: 'done', actions: [{ type: 'mark-verification-passed' }] }],
          },
          { id: 'done', label: '', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] },
        ],
      }
      const dir = await initCustom(deps, root, 'vf', 'verify')
      const result = await createTransitionApplication(deps).execute({
        root, changeDir: dir, changeName: 'demo', actor: TEST_CREATOR, event: 'pass',
        context: {}, loadWorkflow: (n) => (n === 'vf' ? compileWorkflow(wf) : null),
      })
      expect(result.kind).toBe('applied')
      const state = await createStateStore().read(dir)
      expect(state.fields.phase).toBe('done')
      expect(state.fields.verify_result).toBe('pass')
      expect(state.fields.verified_at).toBe('2026-07-17T00:00:00Z')
    })

    test('openspec: true 的 custom build/verify 自动继承基线与验证不变量，YAML 漏写 action/guard 也不能降级', async () => {
      const root = await freshRepoRoot()
      const deps = makeDeps({
        documentEvidence: async (_repoRoot, _changeDir, phase) => ({
          phase, hasLedger: true, pass: true, blockers: [], items: [],
        }),
      })
      const wf: WorkflowDef = {
        name: 'governed',
        openspec: true,
        steps: [
          {
            id: 'build', label: '', gate: null, skills: [], inputs: [],
            outputs: [{ field: 'build_sha', type: 'string' }], guards: [],
            transitions: [{ event: 'complete', to: 'verify' }],
          },
          {
            id: 'verify', label: '', gate: 'review', skills: [],
            inputs: [{ field: 'build_sha', type: 'string' }], outputs: [], guards: [],
            transitions: [
              { event: 'accept', to: 'ship' },
              { event: 'reject', to: 'build', actions: [{ type: 'mark-verification-failed' }] },
            ],
          },
          { id: 'ship', label: '', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] },
        ],
      }
      const policy = compileEffectiveWorkflowPlan('governed', wf).documentPolicy
      if (!policy) throw new Error('expected document policy')
      const { changeDir: dir } = await deps.runRepository.initChange({
        repoRoot: root, name: 'demo', track: 'backend', reviewSeed: 'pending', creator: TEST_CREATOR, preset: 'full', clock: FIXED_CLOCK,
        initialWorkflow: {
          workflow: 'governed', phase: 'build', documentProfile: 'document-v1',
          documentGovernanceFingerprint: documentGovernanceFingerprint(policy),
        },
      })
      await createStateStore().setMany(dir, {
        build_mode: 'direct', isolation: 'in-place', direct_override: 'true',
        pre_verify_review_result: 'pass',
      })
      const baseline = WORKSPACE_BUILD_TOKEN
      let current = baseline
      let assessCalls = 0
      let captureCalls = 0
      const app = createTransitionApplication(deps)
      const load = (name: string) => (name === 'governed' ? compileWorkflow(wf) : null)
      expect((await app.execute({
        root, changeDir: dir, changeName: 'demo', actor: TEST_CREATOR, event: 'complete',
        context: {
          captureBuildRevision: async () => { captureCalls += 1; return baseline },
          assessBuildRevision: async () => {
            assessCalls += 1
            return { trusted: true as const, token: createBuildRevisionToken('workspace', `workspace:sha256:${'b'.repeat(64)}`, REVISION_IDENTITY) }
          },
        }, loadWorkflow: load,
      })).kind).toBe('applied')
      expect(captureCalls).toBe(1)
      expect(assessCalls).toBe(0)
      expect((await createStateStore().read(dir)).fields.build_sha).toBe(baseline)

      await createStateStore().setMany(dir, {
        verification_report: 'docs/report.md', branch_status: 'handled',
        agent_review_result: 'pass', codex_review_result: 'pass',
        review_gate_phase: 'verify', review_gate_status: 'approved', review_gate_event: 'accept',
        review_requested_at: FIXED_CLOCK(), review_acknowledged_at: FIXED_CLOCK(),
      })
      current = WORKSPACE_BUILD_TOKEN_DRIFT
      const drifted = await app.execute({
        root, changeDir: dir, changeName: 'demo', actor: TEST_CREATOR, event: 'accept',
        context: {
          fileExists: () => true,
          assessBuildRevision: async () => ({ trusted: false as const, blocker: makeBuildRevisionBlocker('revision-stale') }),
        }, loadWorkflow: load,
      })
      expect(drifted).toMatchObject({ kind: 'revision-untrusted', blocker: {
        code: 'verify-build-revision-untrusted', reason: 'revision-stale',
      } })
      expect((await createStateStore().read(dir)).fields.phase).toBe('verify')

      current = baseline
      const passed = await app.execute({
        root, changeDir: dir, changeName: 'demo', actor: TEST_CREATOR, event: 'accept',
        context: {
          fileExists: () => true,
          assessBuildRevision: async () => ({ trusted: true as const, token: createBuildRevisionToken('workspace', `workspace:sha256:${'b'.repeat(64)}`, REVISION_IDENTITY) }),
        }, loadWorkflow: load,
      })
      expect(passed.kind).toBe('applied')
      const state = await createStateStore().read(dir)
      expect(state.fields.phase).toBe('ship')
      expect(state.fields.verify_result).toBe('pass')
    })

    test('arbitrary Verify rollback injects no trust guard and clears the captured token', async () => {
      const root = await freshRepoRoot()
      const deps = makeDeps({
        documentEvidence: async (_repoRoot, _changeDir, phase) => ({
          phase, hasLedger: true, pass: true, blockers: [], items: [],
        }),
      })
      const wf: WorkflowDef = {
        name: 'rollback',
        steps: [
          {
            id: 'implement', label: '', gate: null, skills: [], inputs: [],
            outputs: [{ field: 'build_sha', type: 'string' }], guards: [],
            transitions: [{ event: 'build', to: 'assure' }],
          },
          {
            id: 'assure', label: '', gate: 'review', skills: [],
            inputs: [{ field: 'build_sha', type: 'string' }], outputs: [], guards: [],
            transitions: [{
              event: 'rollback', to: 'implement',
              // An explicit edge guard must not make this recovery edge assess the stale token.
              guards: [{ type: 'build-head-unchanged', field: 'build_sha' }],
              actions: [{ type: 'mark-verification-failed' }],
            }],
          },
        ],
      }
      const dir = await initCustom(deps, root, 'rollback', 'assure')
      await createStateStore().setMany(dir, {
        build_sha: WORKSPACE_BUILD_TOKEN,
        isolation: 'in-place',
        review_gate_phase: 'assure', review_gate_status: 'approved', review_gate_event: 'rollback',
        review_requested_at: FIXED_CLOCK(), review_acknowledged_at: FIXED_CLOCK(),
      })
      let assessorCalls = 0
      const result = await createTransitionApplication(deps).execute({
        root, changeDir: dir, changeName: 'demo', actor: TEST_CREATOR, event: 'rollback',
        context: {
          assessBuildRevision: async () => {
            assessorCalls += 1
            return { trusted: false as const, blocker: makeBuildRevisionBlocker('revision-stale') }
          },
        },
        loadWorkflow: (name) => name === 'rollback' ? compileWorkflow(wf) : null,
      })
      expect(result.kind).toBe('applied')
      expect(assessorCalls).toBe(0)
      expect((await createStateStore().read(dir)).fields.build_sha).toBe('null')
    })

    test('governed custom rollback inherits fixed lifecycle when YAML omits mark-verification-failed', async () => {
      const root = await freshRepoRoot()
      const deps = makeDeps()
      const wf: WorkflowDef = {
        name: 'governed-rollback',
        openspec: true,
        steps: [
          {
            id: 'build', label: '', gate: null, skills: [], inputs: [],
            outputs: [{ field: 'build_sha', type: 'string' }], guards: [],
            transitions: [{ event: 'complete', to: 'verify' }],
          },
          {
            id: 'verify', label: '', gate: 'review', skills: [],
            inputs: [{ field: 'build_sha', type: 'string' }], outputs: [], guards: [],
            // Deliberately omit the rollback action: document governance supplies it.
            transitions: [{ event: 'reject', to: 'build' }],
          },
        ],
      }
      const { changeDir: dir } = await deps.runRepository.initChange({
        repoRoot: root, name: 'demo', track: 'backend', reviewSeed: 'pending', creator: TEST_CREATOR, preset: 'full', clock: FIXED_CLOCK,
        initialWorkflow: { workflow: 'governed-rollback', phase: 'verify' },
      })
      await createStateStore().setMany(dir, {
        build_sha: 'malformed-legacy-value',
        review_gate_phase: 'verify', review_gate_status: 'approved', review_gate_event: 'reject',
        review_requested_at: FIXED_CLOCK(), review_acknowledged_at: FIXED_CLOCK(),
      })
      let assessorCalls = 0
      const result = await createTransitionApplication(deps).execute({
        root, changeDir: dir, changeName: 'demo', actor: TEST_CREATOR, event: 'reject',
        context: {
          assessBuildRevision: async () => {
            assessorCalls += 1
            return { trusted: false as const, blocker: makeBuildRevisionBlocker('revision-stale') }
          },
        },
        loadWorkflow: (name) => name === 'governed-rollback' ? compileWorkflow(wf) : null,
      })

      expect(result.kind).toBe('applied')
      expect(assessorCalls).toBe(0)
      const state = await createStateStore().read(dir)
      expect(state.fields.phase).toBe('build')
      expect(state.fields.build_sha).toBe('null')
      expect(state.fields.verify_result).toBe('fail')
      expect(state.fields.pre_verify_review_result).toBe('pending')
    })

    test('edge guard field-equals 真拦截/放行：branch_status≠handled → step-guard-failed 零写盘；=handled → applied', async () => {
      const root = await freshRepoRoot()
      const deps = makeDeps()
      const wf: WorkflowDef = {
        name: 'gf',
        steps: [
          {
            id: 'verify', label: '', gate: null, skills: [], inputs: [], outputs: [], guards: [],
            transitions: [{ event: 'pass', to: 'done', guards: [{ type: 'field-equals', field: 'branch_status', value: 'handled' }] }],
          },
          { id: 'done', label: '', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] },
        ],
      }
      const load = (n: string) => (n === 'gf' ? compileWorkflow(wf) : null)
      const dir = await initCustom(deps, root, 'gf', 'verify')
      const app = createTransitionApplication(deps)
      const blocked = await app.execute({ root, changeDir: dir, changeName: 'demo', actor: TEST_CREATOR, event: 'pass', context: {}, loadWorkflow: load })
      expect(blocked.kind).toBe('step-guard-failed')
      expect((await createStateStore().read(dir)).fields.phase).toBe('verify') // 零写盘

      await createStateStore().set(dir, 'branch_status', 'handled')
      const ok = await app.execute({ root, changeDir: dir, changeName: 'demo', actor: TEST_CREATOR, event: 'pass', context: {}, loadWorkflow: load })
      expect(ok.kind).toBe('applied')
      expect((await createStateStore().read(dir)).fields.phase).toBe('done')
    })

    test('step guard 的 when 谓词按 change track 生效：track_not_in:[pm] → backend 轨适用（拦截）、pm 轨豁免（放行）', async () => {
      const wf: WorkflowDef = {
        name: 'wnf',
        steps: [
          {
            id: 'verify', label: '', gate: null, skills: [], inputs: [], outputs: [],
            guards: [{ type: 'field-equals', field: 'agent_review_result', value: 'pass', when: { kind: 'track-not-in', values: ['pm'] } }],
            transitions: [{ event: 'go', to: 'done' }],
          },
          { id: 'done', label: '', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] },
        ],
      }
      const load = (n: string) => (n === 'wnf' ? compileWorkflow(wf) : null)

      // backend 轨：guard 适用，agent_review_result 未设 → 拦截
      const rootA = await freshRepoRoot()
      const depsA = makeDeps()
      const dirA = await initCustom(depsA, rootA, 'wnf', 'verify')
      const blocked = await createTransitionApplication(depsA).execute({ root: rootA, changeDir: dirA, changeName: 'demo', actor: TEST_CREATOR, event: 'go', context: {}, loadWorkflow: load })
      expect(blocked.kind).toBe('step-guard-failed')

      // pm 轨：同一 guard 的 when 不命中 → 豁免（即便字段未设也放行）
      const rootB = await freshRepoRoot()
      const depsB = makeDeps()
      const dirB = await initCustom(depsB, rootB, 'wnf', 'verify')
      await createStateStore().set(dirB, 'track', 'pm')
      const passed = await createTransitionApplication(depsB).execute({ root: rootB, changeDir: dirB, changeName: 'demo', actor: TEST_CREATOR, event: 'go', context: {}, loadWorkflow: load })
      expect(passed.kind).toBe('applied')
    })

    test('edge action 缺 capture capability → typed blocker 且事务不 commit：state 未推进、零 projection', async () => {
      const root = await freshRepoRoot()
      const deps = makeDeps()
      const wf: WorkflowDef = {
        name: 'bf',
        steps: [
          {
            id: 'verify', label: '', gate: null, skills: [], inputs: [], outputs: [], guards: [],
            transitions: [{ event: 'go', to: 'done', actions: [{ type: 'freeze-build-sha' }] }],
          },
          { id: 'done', label: '', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] },
        ],
      }
      const dir = await initCustom(deps, root, 'bf', 'verify')
      await createStateStore().set(dir, 'isolation', 'branch')
      const canonicalBefore = await createStateStore().read(dir)
      const canonicalBeforeHash = safeRevisionHash(canonicalBefore.fields)
      await expect(createTransitionApplication(deps).execute({
        root, changeDir: dir, changeName: 'demo', actor: TEST_CREATOR, event: 'go',
        context: {},
        loadWorkflow: (n) => (n === 'bf' ? compileWorkflow(wf) : null),
      })).resolves.toMatchObject({ kind: 'revision-untrusted', blocker: {
        code: 'verify-build-revision-untrusted', reason: 'capability-unavailable', stateHash: canonicalBeforeHash,
      } })
      const state = await createStateStore().read(dir)
      expect(state.fields.phase).toBe('verify') // 未推进
      expect(state.runMetadata?.transitionSequence).toBe(0) // 未 commit
      expect(deps.historyEntries).toEqual([]) // 零 projection
    })

    test('verify-fail 双边端到端：触发 fail edge → 回退目标 phase + verify_result=fail + build_sha=null 落盘 + 不执行 pass edge 的 action', async () => {
      const root = await freshRepoRoot()
      const deps = makeDeps()
      const wf: WorkflowDef = {
        name: 'vfb',
        steps: [
          {
            id: 'verify', label: '', gate: null, skills: [], inputs: [], outputs: [], guards: [],
            transitions: [
              { event: 'pass', to: 'ship', actions: [{ type: 'mark-verification-passed' }] },
              { event: 'fail', to: 'build', actions: [{ type: 'mark-verification-failed' }] },
            ],
          },
          { id: 'ship', label: '', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] },
          { id: 'build', label: '', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] },
        ],
      }
      const dir = await initCustom(deps, root, 'vfb', 'verify')
      await createStateStore().set(dir, 'build_sha', 'abc123') // 先冻结一个 SHA，证明 fail 复位它
      const result = await createTransitionApplication(deps).execute({
        root, changeDir: dir, changeName: 'demo', actor: TEST_CREATOR, event: 'fail',
        context: {}, loadWorkflow: (n) => (n === 'vfb' ? compileWorkflow(wf) : null),
      })
      expect(result.kind).toBe('applied')
      if (result.kind !== 'applied') throw new Error('expected applied')
      expect(result.to).toBe('build')
      const state = await createStateStore().read(dir)
      expect(state.fields.phase).toBe('build') // 回退到 fail edge 目标
      expect(state.fields.verify_result).toBe('fail') // fail edge action 落盘
      expect(state.fields.build_sha).toBe('null') // barrier 复位（回退重 build 必须重新冻结）
      // pass edge 的 mark-verification-passed 未执行：否则 verify_result='pass' 且 verified_at=时钟
      expect(state.fields.verified_at).not.toBe(FIXED_CLOCK())
    })

    test('含未知惰性 output（custom_doc，无 guard）的旧 workflow → load(compile)+执行转换成功（P2 兼容回退：pre-P2 能加载能跑转换图）', async () => {
      const root = await freshRepoRoot()
      const deps = makeDeps()
      const wf: WorkflowDef = {
        name: 'lazy',
        steps: [
          {
            id: 'draft', label: '', gate: null, skills: [], inputs: [],
            outputs: [{ field: 'custom_doc', type: 'string' }], guards: [],
            transitions: [{ event: 'done', to: 'end' }],
          },
          { id: 'end', label: '', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] },
        ],
      }
      const dir = await initCustom(deps, root, 'lazy', 'draft')
      const result = await createTransitionApplication(deps).execute({
        root, changeDir: dir, changeName: 'demo', actor: TEST_CREATOR, event: 'done',
        context: {}, loadWorkflow: (n) => (n === 'lazy' ? compileWorkflow(wf) : null),
      })
      expect(result.kind).toBe('applied')
      if (result.kind !== 'applied') throw new Error('expected applied')
      expect(result.from).toBe('draft')
      expect(result.to).toBe('end')
    })
  })
})
