/**
 * advance —— auto-transition 中间档编排（BACKLOG #31 / GOAL B14·D12）。
 * 快速回归层（mock）：验证「停点规则」纯逻辑——终态 / guard 不过 / 复核相位（HITL 默认停）/
 * 三门硬门 / --through-gates 放行 / --dry-run 不写盘 / --max-steps 防失控。
 * 真实副作用（真推进真落盘真停点）由 advance.integration.test.ts（真 fs）证。
 *
 * 复用 test-support 的 mockFlow（契约相位图 + reviewPhases=explore/spec/verify）；
 * store 换成"有状态"版（write 反映到 read），使 advance 的循环能真的逐步推进。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { BUILTIN_TRACK_DEFINITIONS, createBuildRevisionToken, GATE_TTL_MS } from '@tenon/kernel'
import type { FieldName, GuardResult, HistoryEntry, Phase, PipelineState, TrackRegistry } from '@tenon/kernel'
import type { CliDeps, GateMarkerInfo } from '../deps.js'
import {
  FIXED_CLOCK,
  mockFlow,
  mockState,
  mockWorkflowRunRepository,
  spy,
  testEffectiveSkillResolver,
} from '../test-support.js'
import { cmdAdvance } from './advance.js'

/** 满足全程事件前置的字段基线（backend track：verify-pass 需 agent/codex pass） */
const READY: Partial<Record<FieldName, string | string[]>> = {
  track: 'backend',
  design_doc: 'openspec/changes/demo/design.md',
  plan: 'openspec/changes/demo/plan.md',
  build_mode: 'direct',
  isolation: 'worktree',
  pre_verify_review_result: 'pass',
  verification_report: 'openspec/changes/demo/verify.md',
  branch_status: 'handled',
  agent_review_result: 'pass',
  codex_review_result: 'pass',
}

const TEST_BUILD_TOKEN = createBuildRevisionToken('git', 'a'.repeat(40), {
  repository: 'advance-test-repository',
  worktree: 'advance-test-worktree',
})

const approvedReview = (
  phase: string,
  event = phase === 'explore' ? 'explore-complete' : phase === 'spec' ? 'spec-complete' : 'verify-pass',
): Partial<Record<FieldName, string | string[]>> => ({
  review_gate_phase: phase,
  review_gate_status: 'approved',
  review_gate_event: event,
  review_requested_at: FIXED_CLOCK,
  review_acknowledged_at: FIXED_CLOCK,
})

/** 有状态 store：write 落进 holder，read 读回 holder —— 让 advance 循环能逐步推进 */
function statefulStore(initial: PipelineState) {
  let s = initial
  const write = spy(async (_d: string, ns: PipelineState) => {
    s = ns
    return { projection: { status: 'updated' as const } }
  })
  return {
    read: spy(async (_d: string): Promise<PipelineState> => s),
    write,
    // WorkflowRunRepository 已持有 change 锁，提交必须走不会二次取锁的入口；与共享 mockStore
    // 一样返回同一个 spy，保留本文件对 `write.calls` 的既有观测契约。
    get writeUnderLock() { return write },
    get: spy(async (_d: string, f: FieldName) => s.fields[f]),
    set: spy(async (_d: string, f: FieldName, v: string | string[]): Promise<void> => { s = { ...s, fields: { ...s.fields, [f]: v } } }),
    setMany: spy(async (_d: string, kv: Partial<Record<FieldName, string | string[]>>): Promise<void> => { s = { ...s, fields: { ...s.fields, ...kv } } }),
    cas: spy(async (): Promise<boolean> => true),
    init: spy(async (o: { repoRoot: string; name: string }) => `${o.repoRoot}/openspec/changes/${o.name}`),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    withLock: spy(async (_d: string, fn: () => Promise<any>): Promise<any> => fn()),
    phase: () => (Array.isArray(s.fields.phase) ? s.fields.phase.join(',') : s.fields.phase),
  }
}

interface Adv {
  deps: CliDeps
  out: string[]
  err: string[]
  store: ReturnType<typeof statefulStore>
}

function makeAdv(opts: {
  phase: Phase
  fields?: Partial<Record<FieldName, string | string[]>>
  gateMarkers?: GateMarkerInfo[]
  guard?: GuardResult
  fileExists?: boolean
}): Adv {
  const out: string[] = []
  const err: string[] = []
  const store = statefulStore(mockState({ ...READY, phase: opts.phase, ...opts.fields }))
  const flow = mockFlow()
  if (opts.guard) flow.guardCheck = spy((): GuardResult => opts.guard as GuardResult)
  const fx = opts.fileExists ?? true
  const registry: TrackRegistry = {
    ordered: BUILTIN_TRACK_DEFINITIONS,
    byId: new Map(BUILTIN_TRACK_DEFINITIONS.map((track) => [track.id, track])),
    revision: 'advance-test',
    source: 'builtin-only',
  }
  const deps = {
    store,
    runRepo: mockWorkflowRunRepository(store, () => FIXED_CLOCK),
    // These fast tests use an isolated approved-receipt fixture; opt into the trusted
    // verifier explicitly instead of weakening production's fail-closed default.
    reviewGateBinding: async () => true,
    flow,
    resolver: testEffectiveSkillResolver,
    // cmdCheck 的 default 路径从 effective registry 取 coverageProfile；测试显式注入内建 registry，
    // 不再靠旧的 track-id 静态分支或缺依赖 TypeError 偶然通过。
    loadRegistry: () => registry,
    // advance 的单测目标是停点/事件编排；真实 ledger 的缺失、hash 漂移、PM 强制性由
    // transition-application 集成测试覆盖，此处显式注入通过的 I/O 端口以隔离两类行为。
    documentEvidence: async (_root: string, _changeDir: string, phase: Phase) => ({
      phase,
      hasLedger: true,
      pass: true,
      blockers: [],
      items: [],
    }),
    cwd: '/repo',
    io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) },
    clock: () => FIXED_CLOCK,
    // Build's typed capture action must produce a canonical token; do not pre-seed build_sha.
    captureBuildRevision: async () => TEST_BUILD_TOKEN.value,
    listChanges: async () => [],
    guardCtx: (name: string) => ({
      changeDirRel: `openspec/changes/${name}`,
      fileExists: () => fx,
      fileNonempty: () => fx,
      readFile: () => 'x',
      readFileBounded: () => ({ kind: 'ok' as const, text: 'x' }),
      dirExists: () => fx,
      changeArchived: () => false,
    }),
    readGateMarkers: async () => opts.gateMarkers ?? [],
    history: { append: async () => {} },
  } as unknown as CliDeps
  return { deps, out, err, store }
}

const marker = (kind: GateMarkerInfo['kind'], ageMs: number): GateMarkerInfo => ({
  kind,
  ageMs,
  raw: `build\n请处理\ndemo\n`,
})

describe('advance —— auto-transition 中间档停点规则（B14/D12，快速回归）', () => {
  test('非法 change 名 → exit 1，零推进', async () => {
    const a = makeAdv({ phase: 'build' })
    expect(await cmdAdvance(a.deps, '../etc', {})).toBe(1)
    expect(a.store.write.calls).toHaveLength(0)
  })

  test('终态（archive）→ 立即停，零推进，exit 0', async () => {
    const a = makeAdv({ phase: 'archive' })
    expect(await cmdAdvance(a.deps, 'demo', {})).toBe(0)
    expect(a.store.write.calls).toHaveLength(0)
    expect(a.out.some((l) => l.includes('[STOP]') && l.includes('终态'))).toBe(true)
  })

  test('HITL 红线：默认在复核相位（explore）立即停，绝不自动离开——零推进', async () => {
    const a = makeAdv({ phase: 'explore' })
    expect(await cmdAdvance(a.deps, 'demo', {})).toBe(0)
    // 未离开 explore（review 相位不自动退出）
    expect(a.store.phase()).toBe('explore')
    expect(a.store.write.calls).toHaveLength(0)
    expect(a.out.some((l) => l.includes('[STOP]') && l.includes('复核相位'))).toBe(true)
  })

  test('HITL 红线：默认从非复核相位只推进到"进入复核相位"就停（build → verify 停）', async () => {
    const a = makeAdv({ phase: 'build' })
    const code = await cmdAdvance(a.deps, 'demo', {})
    expect(code, JSON.stringify({ out: a.out, err: a.err })).toBe(0)
    // 真推进一步进入 verify（复核相位）后停，绝不跑到 ship/archive
    expect(a.store.phase()).toBe('verify')
    expect(a.store.write.calls).toHaveLength(1)
    expect(await a.store.get('/repo/openspec/changes/demo', 'build_sha')).toBe(TEST_BUILD_TOKEN.value)
    expect(a.out.some((l) => l.includes('[STOP]') && l.includes('复核相位'))).toBe(true)
  })

  test('guard 不过 → 停且零推进，exit 2（对齐 check 口径）', async () => {
    const a = makeAdv({ phase: 'build', guard: { pass: false, failures: ['tasks.md 仍有未勾项'] } })
    expect(await cmdAdvance(a.deps, 'demo', {})).toBe(2)
    expect(a.store.write.calls).toHaveLength(0)
    expect(a.store.phase()).toBe('build')
    expect(a.out.some((l) => l.includes('guard'))).toBe(true)
    expect(a.out.some((l) => l.includes('tasks.md 仍有未勾项'))).toBe(true)
  })

  test('--through-gates 不能跳过首个 review receipt：从 open 只推进到 explore 后停', async () => {
    const a = makeAdv({ phase: 'open' })
    expect(await cmdAdvance(a.deps, 'demo', { throughGates: true })).toBe(0)
    expect(a.store.phase()).toBe('explore')
    expect(a.store.write.calls).toHaveLength(1)
    expect(a.out.some((l) => l.includes('[STOP]') && l.includes('确认回执'))).toBe(true)
  })

  test('--through-gates 从 review 相位起步但无 receipt 时仍停在原地', async () => {
    const a = makeAdv({ phase: 'explore' })
    expect(await cmdAdvance(a.deps, 'demo', { throughGates: true })).toBe(0)
    expect(a.store.phase()).toBe('explore')
    expect(a.store.write.calls).toHaveLength(0)
    expect(a.out.some((l) => l.includes('确认回执'))).toBe(true)
  })

  test('--through-gates 只消费 exact approved receipt：离开 explore 后立即在未确认的 spec 停住', async () => {
    const a = makeAdv({ phase: 'explore', fields: approvedReview('explore') })
    expect(await cmdAdvance(a.deps, 'demo', { throughGates: true })).toBe(0)
    expect(a.store.phase()).toBe('spec')
    expect(a.store.write.calls).toHaveLength(1)
    expect(await a.store.get('/repo/openspec/changes/demo', 'review_gate_status')).toBe('')
    expect(a.out.some((l) => l.includes('确认回执'))).toBe(true)
  })

  test('硬门（confirm marker 新鲜）→ 即便 --through-gates 也停，零推进（HITL 红线）', async () => {
    const a = makeAdv({ phase: 'build', gateMarkers: [marker('confirm', 1000)] })
    expect(await cmdAdvance(a.deps, 'demo', { throughGates: true })).toBe(0)
    expect(a.store.write.calls).toHaveLength(0)
    expect(a.store.phase()).toBe('build')
    expect(a.out.some((l) => l.includes('[STOP]') && l.includes('confirm'))).toBe(true)
  })

  test('硬门（interaction marker 新鲜）→ 也是硬门，停', async () => {
    const a = makeAdv({ phase: 'build', gateMarkers: [marker('interaction', 1000)] })
    expect(await cmdAdvance(a.deps, 'demo', { throughGates: true })).toBe(0)
    expect(a.store.write.calls).toHaveLength(0)
    expect(a.out.some((l) => l.includes('interaction'))).toBe(true)
  })

  test('陈旧 confirm marker（age > TTL）不算硬门 → 推进不被拦', async () => {
    const a = makeAdv({ phase: 'build', gateMarkers: [marker('confirm', GATE_TTL_MS.confirm + 1000)] })
    expect(await cmdAdvance(a.deps, 'demo', {})).toBe(0)
    // 陈旧门不拦，正常推进到 verify（复核相位）停
    expect(a.store.phase()).toBe('verify')
    expect(a.store.write.calls).toHaveLength(1)
  })

  test('--dry-run：只报计划、零写盘、相位不变', async () => {
    const a = makeAdv({ phase: 'build' })
    expect(await cmdAdvance(a.deps, 'demo', { dryRun: true })).toBe(0)
    expect(a.store.write.calls).toHaveLength(0)
    expect(a.store.phase()).toBe('build')
    expect(a.out.some((l) => l.includes('[DRY-RUN]'))).toBe(true)
    expect(a.out.some((l) => l.includes('计划') && l.includes('build') && l.includes('verify'))).toBe(true)
  })

  test('--dry-run 在复核相位（默认）→ 计划即报"停在复核相位"，零写盘', async () => {
    const a = makeAdv({ phase: 'explore' })
    expect(await cmdAdvance(a.deps, 'demo', { dryRun: true })).toBe(0)
    expect(a.store.write.calls).toHaveLength(0)
    expect(a.out.some((l) => l.includes('复核相位'))).toBe(true)
  })

  test('--max-steps 封顶（防失控）：0 步预算在首个非 review phase 立即停住', async () => {
    const a = makeAdv({ phase: 'open' })
    expect(await cmdAdvance(a.deps, 'demo', { throughGates: true, maxSteps: 0 })).toBe(0)
    expect(a.store.write.calls).toHaveLength(0)
    expect(a.store.phase()).toBe('open')
    expect(a.out.some((l) => l.includes('[STOP]') && l.includes('max-steps'))).toBe(true)
  })

  test('停点报告：每步一行 [ADVANCE]，收尾一行 [STOP]（可审计）', async () => {
    const a = makeAdv({ phase: 'build' })
    await cmdAdvance(a.deps, 'demo', {})
    expect(a.out.some((l) => l.startsWith('[ADVANCE]') && l.includes('build') && l.includes('verify'))).toBe(true)
    expect(a.out.filter((l) => l.startsWith('[STOP]'))).toHaveLength(1)
  })
})

// ════ 非 default workflow（自定义 step 图自动推进；功能缺口补完）════
// loadWorkflow 是真 fs 读（不可注入），故同 internalSkillGate.test.ts 手法：真临时目录落
// workflow 定义文件、cwd 指过去；store/history 仍是 mock（真实全链路在 advance.integration.test.ts）。

/** 三步单边链：c1 --go--> c2 --go2--> c3（c3 终态零出边）。 */
const CHAIN_WF = `name: chain
steps:
  - id: c1
    label: one
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions:
      - event: go
        to: c2
  - id: c2
    label: two
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions:
      - event: go2
        to: c3
  - id: c3
    label: three
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions: []
`

/** 多边分岔：f1 有两条出边（pass→f2 / fail→f3），需人选 event。 */
const FORK_WF = `name: fork
steps:
  - id: f1
    label: fork
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions:
      - event: pass
        to: f2
      - event: fail
        to: f3
  - id: f2
    label: ok
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions:
      - event: done
        to: f3
  - id: f3
    label: end
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions: []
`

/** g1 声明 nonempty-output guard（design_doc 必须产出）。 */
const GUARDED_WF = `name: guarded
steps:
  - id: g1
    label: one
    gate: null
    skills: []
    inputs: []
    outputs:
      - field: design_doc
        type: file_path
    guards:
      - type: nonempty-output
    transitions:
      - event: done
        to: g2
  - id: g2
    label: end
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions: []
`

/** gc1 是自动门（gate: auto）：不是人门，输出齐全即按守卫推进。 */
const GATE_AUTO_WF = `name: gatec
steps:
  - id: gc1
    label: one
    gate: auto
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions:
      - event: go
        to: gc2
  - id: gc2
    label: end
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions: []
`

/** gr1 是 review 人门（gate: review）。 */
const GATE_REVIEW_WF = `name: gater
steps:
  - id: gr1
    label: one
    gate: review
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions:
      - event: go
        to: gr2
  - id: gr2
    label: end
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions: []
`

interface CustomAdv extends Adv {
  historyEntries: HistoryEntry[]
}

describe('advance —— 非 default workflow（自定义 step 图，快速回归）', () => {
  let root: string

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'advance-custom-'))
    const wfDir = join(root, '.pipeline', 'workflows')
    await mkdir(wfDir, { recursive: true })
    await writeFile(join(wfDir, 'chain.yaml'), CHAIN_WF, 'utf8')
    await writeFile(join(wfDir, 'fork.yaml'), FORK_WF, 'utf8')
    await writeFile(join(wfDir, 'guarded.yaml'), GUARDED_WF, 'utf8')
    await writeFile(join(wfDir, 'gatec.yaml'), GATE_AUTO_WF, 'utf8')
    await writeFile(join(wfDir, 'gater.yaml'), GATE_REVIEW_WF, 'utf8')
    // 非法 workflow（transitions.to 悬空 → validateWorkflow 拒绝 → loadWorkflow fail-loud 抛错）
    await writeFile(join(wfDir, 'broken.yaml'), 'name: broken\nsteps:\n  - id: b1\n    label: one\n    gate: null\n    skills: []\n    inputs: []\n    outputs: []\n    guards: []\n    transitions:\n      - event: go\n        to: nowhere\n', 'utf8')
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  function makeCustomAdv(opts: {
    phase: string
    workflow: string
    fields?: Partial<Record<FieldName, string | string[]>>
    gateMarkers?: GateMarkerInfo[]
  }): CustomAdv {
    const out: string[] = []
    const err: string[] = []
    const historyEntries: HistoryEntry[] = []
    const store = statefulStore(mockState({ phase: opts.phase, workflow: opts.workflow, ...opts.fields }))
    const deps = {
      store,
      runRepo: mockWorkflowRunRepository(store, () => FIXED_CLOCK),
      // The fixture below models an already-approved receipt; keep that trust explicit
      // while production wiring remains fail-closed when no verifier is provided.
      reviewGateBinding: async () => true,
      flow: mockFlow(),
      cwd: root,
      io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) },
      clock: () => FIXED_CLOCK,
      listChanges: async () => [],
      readGateMarkers: async () => opts.gateMarkers ?? [],
      history: { append: async (_d: string, e: HistoryEntry) => { historyEntries.push(e) } },
    } as unknown as CliDeps
    return { deps, out, err, store, historyEntries }
  }

  test('单边推进多步到终态：c1→c2→c3 两步真写盘 + history 落账，终态 [STOP] exit 0', async () => {
    const a = makeCustomAdv({ phase: 'c1', workflow: 'chain' })
    expect(await cmdAdvance(a.deps, 'demo', {})).toBe(0)
    expect(a.store.phase()).toBe('c3')
    expect(a.store.write.calls).toHaveLength(2)
    expect(a.out.some((l) => l.startsWith('[ADVANCE]') && l.includes('c1') && l.includes('c2') && l.includes('go'))).toBe(true)
    expect(a.out.some((l) => l.startsWith('[ADVANCE]') && l.includes('c2') && l.includes('c3') && l.includes('go2'))).toBe(true)
    expect(a.out.some((l) => l.includes('[STOP]') && l.includes('终态'))).toBe(true)
    // history 落账（经 cmdTransition 自定义分支：kind=transition, raw=event 名）
    const trans = a.historyEntries.filter((e) => e.kind === 'transition')
    expect(trans.map((e) => e.raw)).toEqual(['go', 'go2'])
  })

  test('起步就在终态 step（零出边）→ 立即停，零推进，exit 0', async () => {
    const a = makeCustomAdv({ phase: 'c3', workflow: 'chain' })
    expect(await cmdAdvance(a.deps, 'demo', {})).toBe(0)
    expect(a.store.write.calls).toHaveLength(0)
    expect(a.out.some((l) => l.includes('[STOP]') && l.includes('终态'))).toBe(true)
  })

  test('多条出边 → 停（需人选 event，HITL），列出可选 events，零推进，exit 0', async () => {
    const a = makeCustomAdv({ phase: 'f1', workflow: 'fork' })
    expect(await cmdAdvance(a.deps, 'demo', {})).toBe(0)
    expect(a.store.phase()).toBe('f1')
    expect(a.store.write.calls).toHaveLength(0)
    const stop = a.out.find((l) => l.includes('[STOP]'))
    expect(stop).toBeDefined()
    expect(stop).toContain('pass')
    expect(stop).toContain('fail')
  })

  test('guard 不过 → 停并打 failures，零推进，exit 2（对齐 check 口径）', async () => {
    const a = makeCustomAdv({ phase: 'g1', workflow: 'guarded' })
    expect(await cmdAdvance(a.deps, 'demo', {})).toBe(2)
    expect(a.store.phase()).toBe('g1')
    expect(a.store.write.calls).toHaveLength(0)
    expect(a.out.some((l) => l.includes('[STOP]') && l.includes('guard'))).toBe(true)
    expect(a.out.some((l) => l.includes('design_doc'))).toBe(true)
  })

  test('guard 过（必须产出字段已设）→ 正常推进到终态', async () => {
    const a = makeCustomAdv({ phase: 'g1', workflow: 'guarded', fields: { design_doc: 'x.md' } })
    expect(await cmdAdvance(a.deps, 'demo', {})).toBe(0)
    expect(a.store.phase()).toBe('g2')
    expect(a.store.write.calls).toHaveLength(1)
  })

  test('--max-steps 截停：chain 只推进 1 步就停在 c2', async () => {
    const a = makeCustomAdv({ phase: 'c1', workflow: 'chain' })
    expect(await cmdAdvance(a.deps, 'demo', { maxSteps: 1 })).toBe(0)
    expect(a.store.phase()).toBe('c2')
    expect(a.store.write.calls).toHaveLength(1)
    expect(a.out.some((l) => l.includes('[STOP]') && l.includes('max-steps'))).toBe(true)
  })

  test('workflow 未找到 → exit 1（同 transition 措辞），零推进', async () => {
    const a = makeCustomAdv({ phase: 's1', workflow: 'ghost' })
    expect(await cmdAdvance(a.deps, 'demo', {})).toBe(1)
    expect(a.store.write.calls).toHaveLength(0)
    expect(a.err.join('\n')).toContain("workflow 'ghost' 未找到")
  })

  test('workflow 非法（校验失败）→ exit 1 fail-loud，零推进', async () => {
    const a = makeCustomAdv({ phase: 'b1', workflow: 'broken' })
    expect(await cmdAdvance(a.deps, 'demo', {})).toBe(1)
    expect(a.store.write.calls).toHaveLength(0)
    expect(a.err.join('\n')).toContain('校验失败')
  })

  test('当前 step 不在 workflow 图里 → exit 1（同 transition 措辞），零推进', async () => {
    const a = makeCustomAdv({ phase: 'no-such-step', workflow: 'chain' })
    expect(await cmdAdvance(a.deps, 'demo', {})).toBe(1)
    expect(a.store.write.calls).toHaveLength(0)
    expect(a.err.join('\n')).toContain("step 'no-such-step' 不在 workflow 'chain' 里")
  })

  test('step gate=auto 不是人门：自动推进不因它停下', async () => {
    const a = makeCustomAdv({ phase: 'gc1', workflow: 'gatec' })
    await cmdAdvance(a.deps, 'demo', {})
    expect(a.out.some((l) => l.includes('[STOP]') && l.includes('confirm'))).toBe(false)
  })

  test('step gate=review → 默认停给人复核，零推进', async () => {
    const a = makeCustomAdv({ phase: 'gr1', workflow: 'gater' })
    expect(await cmdAdvance(a.deps, 'demo', {})).toBe(0)
    expect(a.store.phase()).toBe('gr1')
    expect(a.store.write.calls).toHaveLength(0)
    expect(a.out.some((l) => l.includes('[STOP]') && l.includes('review'))).toBe(true)
  })

  test('step gate=review + --through-gates 无 receipt 时也不能放行', async () => {
    const a = makeCustomAdv({ phase: 'gr1', workflow: 'gater' })
    expect(await cmdAdvance(a.deps, 'demo', { throughGates: true })).toBe(0)
    expect(a.store.phase()).toBe('gr1')
    expect(a.store.write.calls).toHaveLength(0)
    expect(a.out.some((l) => l.includes('确认回执'))).toBe(true)
  })

  test('step gate=review + --through-gates 只消费对应 step 的 approved receipt', async () => {
    const a = makeCustomAdv({ phase: 'gr1', workflow: 'gater', fields: approvedReview('gr1', 'go') })
    expect(await cmdAdvance(a.deps, 'demo', { throughGates: true })).toBe(0)
    expect(a.store.phase()).toBe('gr2')
    expect(a.store.write.calls).toHaveLength(1)
  })

  test('硬门 marker（confirm 新鲜）→ 自定义轨同样绝不自动跨越，零推进', async () => {
    const a = makeCustomAdv({ phase: 'c1', workflow: 'chain', gateMarkers: [marker('confirm', 1000)] })
    expect(await cmdAdvance(a.deps, 'demo', { throughGates: true })).toBe(0)
    expect(a.store.phase()).toBe('c1')
    expect(a.store.write.calls).toHaveLength(0)
    expect(a.out.some((l) => l.includes('[STOP]') && l.includes('confirm'))).toBe(true)
  })

  test('--dry-run：只报计划、零写盘、相位不变（自定义轨同一契约）', async () => {
    const a = makeCustomAdv({ phase: 'c1', workflow: 'chain' })
    expect(await cmdAdvance(a.deps, 'demo', { dryRun: true })).toBe(0)
    expect(a.store.write.calls).toHaveLength(0)
    expect(a.store.phase()).toBe('c1')
    expect(a.out.some((l) => l.includes('[DRY-RUN]'))).toBe(true)
    expect(a.out.some((l) => l.includes('计划') && l.includes('c1') && l.includes('c2'))).toBe(true)
    expect(a.out.some((l) => l.includes('终态'))).toBe(true)
  })
})
