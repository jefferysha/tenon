/**
 * loop-run（`tenon loop run <loop-id|pattern>`）—— 纯只读 dry-run 预览的 mock 层回归
 * （H14 硬需求收口起点：唯一不被 H7 verifier / H10 skill-bundle 阻塞的部分）。
 *
 * 覆盖：selector（精确 id / glob 多命中 / 零命中 exit1）· admission allowed 与 blocked:<各维度>
 * （复用 loops.ts 同源 admissionProbe）· level 显式与默认 · 非法 level exit1 · --json 结构
 * · real-run 自然归属筛选 / durable binding / mixed level / 强制 commit / 结构化 JSON
 * · status 非 active 预览为 blocked · registry 缺失/损坏 exit1
 * · dry-run 零状态写（无 store.write、无 ledger 写、无 docker）· cmdLoops 'run' 分派。
 *
 * ledger 投影经注入 projectLedger（LedgerProjector）全 mock——测试绝不碰真 fs/ledger IO。
 */
import { describe, expect, test, vi } from 'vitest'
import type { EffectiveSkillResolver, EffectiveSkillSlot, LedgerRecord, LoopLedgerProjection } from '@tenon/kernel'
import type { AutomationLevel, RoundReport } from '@tenon/automation'
import type { AfkRoundExecutionResult } from './afk-executor.js'
import { makeDeps } from '../test-support.js'
import { cmdLoopRun } from './loop-run.js'
import { cmdLoops } from './loops.js'
import type { LoopEntry, LoopsFs } from './loops.js'
import type { LedgerProjector, SkillBundleWiringDeps } from './loop-admission-view.js'

function loop(over: Partial<LoopEntry> = {}): LoopEntry {
  return {
    id: 'loop-be', name: 'BE loop', kind: 'orchestrator', goal: 'x'.repeat(12), cadence: '1h',
    risk: 'medium', runner: 'claude-code', change_prefix: 'loop-be-', phases: ['a', 'b'], human_gates: ['g'],
    state: '.superpowers/loops/progress.md', design_doc: 'd', status: 'active',
    budget: { max_runs_per_day: 24, max_in_flight: 1, on_exceed: 'skip' }, kill_criteria: ['k'],
    autonomy_level: 'L1', allowlist: [], denylist: [], ...over,
  }
}

function fakeFs(over: Partial<LoopsFs> = {}): LoopsFs {
  return {
    loadRegistry: () => ({ data: { version: 1, loops: [loop()] }, errors: [] }),
    readProgress: () => null,
    listChanges: () => [],
    readChangeFields: () => null,
    readSandboxFields: () => null,
    ...over,
  }
}

function proj(over: Partial<LoopLedgerProjection> = {}): LoopLedgerProjection {
  return {
    loopId: 'loop-be', budgetDay: '2026-07-06', runsToday: 0, inFlight: 0, activatedInFlight: 0,
    reservedTokensOutstanding: 0, settledTokensActual: 0, settledTokensEstimated: 0,
    openReservations: [], rejectedRecords: 0, duplicateReservations: 0, duplicateTerminals: 0,
    invalidActivations: 0, invalidTerminals: 0, health: 'ok', ...over,
  }
}

/** 注入的 ledger 投影 mock：按 id 取 map[id]，缺省健康空投影（→ admission allowed）。 */
function projectorFor(map: Record<string, LoopLedgerProjection> = {}, missing = false): LedgerProjector {
  return vi.fn(async (_cwd: string, ids: string[], _now: Date) => ({
    byId: new Map(ids.map((id) => [id, map[id] ?? proj({ loopId: id })])),
    missing,
  }))
}

const OK = projectorFor()

function roundReport(over: Partial<RoundReport> = {}): RoundReport {
  return {
    candidates: 1,
    admitted: 1,
    entries: [],
    failures: [],
    ledgerFailures: [],
    halted: false,
    ledgerDegraded: false,
    ok: true,
    ...over,
  }
}

function binding(change: string, loopId: string, recordId = `binding-${change}`): LedgerRecord {
  return {
    schema_version: 1,
    record_id: recordId,
    recorded_at: '2026-07-06T00:00:00Z',
    kind: 'change-loop-binding',
    change,
    loop_id: loopId,
    source: 'explicit',
  }
}

function completedExecutor(report: RoundReport = roundReport()) {
  return vi.fn(async (
    _deps: unknown,
    input: { level: AutomationLevel; targets: readonly { change: string; expectedLoopId: string }[] },
  ): Promise<AfkRoundExecutionResult> => ({
    status: 'completed',
    level: input.level,
    image: 'sandcastle:test',
    ready: input.targets.map((target) => target.change),
    report,
  }))
}

// ── skill bundle wiring 预览用 fake resolver/locator（H10 §6/§8任务7）──────────────────

function fakeResolver(slotsByPhase: Record<string, EffectiveSkillSlot[]> = {}): EffectiveSkillResolver {
  return {
    resolveDefault: (stepId: string) => slotsByPhase[stepId] ?? [],
    // 显式 profile 投影直接给出夹具槽：default 模板的技能矩阵已内嵌进定义，桥接函数不再替它查 manifest 表。
    resolveExplicitProfile: (_capability, stepId: string) => slotsByPhase[stepId] ?? [],
    resolveCustom: () => [],
  }
}

/** locator：给定「能定位」的 skill id 白名单，其余一律 `SkillContentNotFoundError`（`_tag` 语义
 *  对齐 runtime content-locator.ts::locate()——evaluateSkillBundleWiring 按 `_tag` 区分
 *  not-found（继续试下一候选）与其余错误（立即失败，见 loop-admission-view.ts::locateSlot），
 *  fake 必须诚实标出它模拟的是哪一种）。 */
function fakeLocator(locatable: readonly string[]): SkillBundleWiringDeps['locator'] {
  return {
    locate: async (skillId: string) => {
      if (locatable.includes(skillId)) return { skillId, contentDir: `/fake/${skillId}` }
      throw Object.assign(new Error(`skill '${skillId}' 未找到`), { _tag: 'SkillContentNotFoundError' })
    },
  }
}

/** locator：首个候选按 `firstTag` 指定的**非 not-found**错误失败，其余候选原本可定位——端到端
 *  证明 cmdLoopRun 的 dry-run 预览不会把「首候选 ambiguous/content-invalid」误报成 ready（H10
 *  复审阻断7；判定逻辑本体见 loop-admission-view.test.ts）。 */
function locatorFirstCandidatePoisoned(firstTag: string, otherLocatable: readonly string[]): SkillBundleWiringDeps['locator'] {
  return {
    locate: async (skillId: string) => {
      if (otherLocatable.includes(skillId)) return { skillId, contentDir: `/fake/${skillId}` }
      throw Object.assign(new Error(`skill '${skillId}' 定位失败：${firstTag}`), { _tag: firstTag })
    },
  }
}

const NO_SLOTS = fakeResolver()

// ── selector ─────────────────────────────────────────────────────────────────

describe('selector', () => {
  test('精确 loop-id 命中 → 单条预览 exit 0', async () => {
    const deps = makeDeps()
    const code = await cmdLoopRun(deps, ['loop-be', '--dry-run'], fakeFs(), OK)
    expect(code).toBe(0)
    const out = deps.outLines.join('\n')
    expect(out).toContain('loop-be')
    expect(out).toMatch(/dry-run/i)
  })

  test('精确 id 不等（子串不算命中）→ 零命中 exit 1', async () => {
    const deps = makeDeps()
    const code = await cmdLoopRun(deps, ['loop-b', '--dry-run'], fakeFs(), OK)
    expect(code).toBe(1)
    expect(deps.errLines.join('\n')).toMatch(/未命中|零命中|no.*match/i)
  })

  test('glob pattern 多命中 → 每个都预览', async () => {
    const deps = makeDeps()
    const fs = fakeFs({
      loadRegistry: () => ({
        data: { version: 1, loops: [loop({ id: 'loop-be' }), loop({ id: 'loop-fe' }), loop({ id: 'other' })] },
        errors: [],
      }),
    })
    const code = await cmdLoopRun(deps, ['loop-*', '--dry-run'], fs, projectorFor())
    expect(code).toBe(0)
    const out = deps.outLines.join('\n')
    expect(out).toContain('loop-be')
    expect(out).toContain('loop-fe')
    expect(out).not.toContain('\nother') // 'other' 不该被 loop-* 命中
  })

  test('glob 零命中 → stderr + exit 1', async () => {
    const deps = makeDeps()
    const code = await cmdLoopRun(deps, ['ghost-*', '--dry-run'], fakeFs(), OK)
    expect(code).toBe(1)
    expect(deps.errLines.join('\n')).toMatch(/未命中|ghost/)
  })

  test('缺 selector → 用法错误 exit 1', async () => {
    const deps = makeDeps()
    const code = await cmdLoopRun(deps, ['--dry-run'], fakeFs(), OK)
    expect(code).toBe(1)
    expect(deps.errLines.join('\n')).toMatch(/用法|loop-id|pattern/i)
  })
})

// ── admission（复用 loops.ts 同源 admissionProbe / admissionDecision）──────────────

describe('admission 判定', () => {
  test('allowed：active + 额度充足', async () => {
    const deps = makeDeps()
    await cmdLoopRun(deps, ['loop-be', '--dry-run', '--json'], fakeFs(), projectorFor({ 'loop-be': proj() }))
    const env = JSON.parse(deps.outLines.join('\n'))
    expect(env.previews[0].admission).toBe('allowed')
  })

  test('blocked:loop-inactive：status=paused', async () => {
    const deps = makeDeps()
    const fs = fakeFs({ loadRegistry: () => ({ data: { version: 1, loops: [loop({ status: 'paused' })] }, errors: [] }) })
    await cmdLoopRun(deps, ['loop-be', '--dry-run', '--json'], fs, projectorFor({ 'loop-be': proj() }))
    const env = JSON.parse(deps.outLines.join('\n'))
    expect(env.previews[0].admission).toBe('blocked:loop-inactive')
    expect(env.previews[0].status).toBe('paused')
  })

  test('blocked:max-runs-per-day：今日 runs 已满', async () => {
    const deps = makeDeps()
    await cmdLoopRun(deps, ['loop-be', '--dry-run', '--json'], fakeFs(), projectorFor({ 'loop-be': proj({ runsToday: 24 }) }))
    const env = JSON.parse(deps.outLines.join('\n'))
    expect(env.previews[0].admission).toBe('blocked:max-runs-per-day')
  })

  test('blocked:max-in-flight：在途已满', async () => {
    const deps = makeDeps()
    await cmdLoopRun(deps, ['loop-be', '--dry-run', '--json'], fakeFs(), projectorFor({ 'loop-be': proj({ inFlight: 1 }) }))
    const env = JSON.parse(deps.outLines.join('\n'))
    expect(env.previews[0].admission).toBe('blocked:max-in-flight')
  })

  test('blocked:max-tokens-per-day：今日 token 花费触顶', async () => {
    const deps = makeDeps()
    const fs = fakeFs({
      loadRegistry: () => ({
        data: { version: 1, loops: [loop({ budget: { max_runs_per_day: 24, max_in_flight: 1, on_exceed: 'skip', max_tokens_per_day: 100 } })] },
        errors: [],
      }),
    })
    await cmdLoopRun(deps, ['loop-be', '--dry-run', '--json'], fs, projectorFor({ 'loop-be': proj({ settledTokensActual: 100 }) }))
    const env = JSON.parse(deps.outLines.join('\n'))
    expect(env.previews[0].admission).toBe('blocked:max-tokens-per-day')
  })

  test('blocked:ledger-degraded：账本坏行 fail-closed', async () => {
    const deps = makeDeps()
    await cmdLoopRun(deps, ['loop-be', '--dry-run', '--json'], fakeFs(), projectorFor({ 'loop-be': proj({ health: 'degraded', rejectedRecords: 2 }) }))
    const env = JSON.parse(deps.outLines.join('\n'))
    expect(env.previews[0].admission).toBe('blocked:ledger-degraded')
    expect(env.previews[0].ledger_health).toBe('degraded')
  })

  test('ledger 缺失 → ledger_health=missing，admission 仍按空投影判 allowed', async () => {
    const deps = makeDeps()
    await cmdLoopRun(deps, ['loop-be', '--dry-run', '--json'], fakeFs(), projectorFor({ 'loop-be': proj() }, true))
    const env = JSON.parse(deps.outLines.join('\n'))
    expect(env.previews[0].ledger_health).toBe('missing')
    expect(env.previews[0].admission).toBe('allowed')
  })
})

// ── level ──────────────────────────────────────────────────────────────────────

describe('level', () => {
  test('默认取 loop.autonomy_level（L1）→ settlement=paused', async () => {
    const deps = makeDeps()
    await cmdLoopRun(deps, ['loop-be', '--dry-run', '--json'], fakeFs(), OK)
    const env = JSON.parse(deps.outLines.join('\n'))
    expect(env.previews[0].level).toBe('L1')
    expect(env.previews[0].level_source).toBe('loop-default')
    expect(env.previews[0].settlement).toBe('paused')
  })

  test('--level L3 显式覆盖 → level_source=flag、settlement=merge-back', async () => {
    const deps = makeDeps()
    await cmdLoopRun(deps, ['loop-be', '--dry-run', '--level', 'L3', '--json'], fakeFs(), OK)
    const env = JSON.parse(deps.outLines.join('\n'))
    expect(env.previews[0].level).toBe('L3')
    expect(env.previews[0].level_source).toBe('flag')
    expect(env.previews[0].settlement).toBe('merge-back')
  })

  test('--level L2 显式 → settlement=paused（仅 L3 自动合并）', async () => {
    const deps = makeDeps()
    await cmdLoopRun(deps, ['loop-be', '--dry-run', '--level', 'L2', '--json'], fakeFs(), OK)
    const env = JSON.parse(deps.outLines.join('\n'))
    expect(env.previews[0].level).toBe('L2')
    expect(env.previews[0].settlement).toBe('paused')
  })

  test('非法 --level → stderr + exit 1（不预览）', async () => {
    const deps = makeDeps()
    const fs = fakeFs()
    const code = await cmdLoopRun(deps, ['loop-be', '--dry-run', '--level', 'L9'], fs, OK)
    expect(code).toBe(1)
    expect(deps.errLines.join('\n')).toMatch(/L1\|L2\|L3|--level/)
    expect(deps.outLines.join('\n')).toBe('') // 非法 level 不产出预览
  })
})

// ── 严格参数面（H14 real-run 不允许宽容吞错）──────────────────────────────────────

describe('严格参数解析', () => {
  test('未知 flag → exit 1，且不加载 registry', async () => {
    const deps = makeDeps()
    const load = vi.fn(() => ({ data: { version: 1, loops: [loop()] }, errors: [] as string[] }))
    const code = await cmdLoopRun(deps, ['loop-be', '--dry-run', '--typo'], fakeFs({ loadRegistry: load }), OK)
    expect(code).toBe(1)
    expect(deps.errLines.join('\n')).toMatch(/未知|--typo/)
    expect(load).not.toHaveBeenCalled()
  })

  test('--level 缺值 → exit 1，不能把后续 flag 吞成 level', async () => {
    const deps = makeDeps()
    const load = vi.fn(() => ({ data: { version: 1, loops: [loop()] }, errors: [] as string[] }))
    const code = await cmdLoopRun(deps, ['loop-be', '--dry-run', '--level', '--json'], fakeFs({ loadRegistry: load }), OK)
    expect(code).toBe(1)
    expect(deps.errLines.join('\n')).toMatch(/--level.*缺|L1\|L2\|L3/)
    expect(load).not.toHaveBeenCalled()
  })

  test('额外位置参数 → exit 1，不能静默忽略', async () => {
    const deps = makeDeps()
    const load = vi.fn(() => ({ data: { version: 1, loops: [loop()] }, errors: [] as string[] }))
    const code = await cmdLoopRun(deps, ['loop-be', 'unexpected', '--dry-run'], fakeFs({ loadRegistry: load }), OK)
    expect(code).toBe(1)
    expect(deps.errLines.join('\n')).toMatch(/额外|unexpected/)
    expect(load).not.toHaveBeenCalled()
  })
})

// ── 预览字段来源 ─────────────────────────────────────────────────────────────────

describe('预览字段', () => {
  test('--json 结构完整：id/status/admission/level/runner/settlement/reserved_tokens/image', async () => {
    const deps = makeDeps()
    await cmdLoopRun(deps, ['loop-be', '--dry-run', '--json'], fakeFs(), projectorFor({ 'loop-be': proj() }))
    const env = JSON.parse(deps.outLines.join('\n'))
    expect(env.dry_run).toBe(true)
    expect(env.selector).toBe('loop-be')
    expect(env.matched).toBe(1)
    const pv = env.previews[0]
    expect(pv.loop_id).toBe('loop-be')
    expect(pv.status).toBe('active')
    expect(pv.admission).toBe('allowed')
    expect(pv.level).toBe('L1')
    expect(pv.runner).toBe('claude-code')
    expect(pv.settlement).toBe('paused')
    // reserved tokens = reservedTokensFor(loop)：risk=medium 无 tokens_per_run → 8000 / risk-default
    expect(pv.reserved_tokens.tokens).toBe(8000)
    expect(pv.reserved_tokens.basis).toBe('risk-default')
    // image 非 loop 级字段 → null + 说明（afk run 时由 --image/automation.json/默认决定）
    expect(pv.image).toBeNull()
    expect(Array.isArray(pv.notes)).toBe(true)
    expect(pv.notes.join(' ')).toMatch(/image/)
  })

  test('reserved_tokens 取显式 budget.tokens_per_run（basis=budget.tokens_per_run）', async () => {
    const deps = makeDeps()
    const fs = fakeFs({
      loadRegistry: () => ({
        data: { version: 1, loops: [loop({ budget: { max_runs_per_day: 24, max_in_flight: 1, on_exceed: 'skip', tokens_per_run: 1234 } })] },
        errors: [],
      }),
    })
    await cmdLoopRun(deps, ['loop-be', '--dry-run', '--json'], fs, OK)
    const env = JSON.parse(deps.outLines.join('\n'))
    expect(env.previews[0].reserved_tokens.tokens).toBe(1234)
    expect(env.previews[0].reserved_tokens.basis).toBe('budget.tokens_per_run')
  })
})

// ── skill bundle wiring 只读预览（H10 §6/§8任务7：evaluateSkillBundleWiring 的唯一消费点）───────

describe('skill bundle wiring 预览', () => {
  test('unwired：loop 未接线 skill_bundle_id（fixture 缺省）', async () => {
    const deps = makeDeps()
    const wiring: SkillBundleWiringDeps = { resolver: NO_SLOTS, locator: fakeLocator([]) }
    await cmdLoopRun(deps, ['loop-be', '--dry-run', '--json'], fakeFs(), projectorFor({ 'loop-be': proj() }), wiring)
    const env = JSON.parse(deps.outLines.join('\n'))
    expect(env.previews[0].skill_bundle.status).toBe('unwired')
    expect(env.previews[0].skill_bundle.bundle_id).toBeNull()
  })

  test('ready：`_all` + 该 loop 声明的各 phase 静态解析为空 slots（合法空快照）', async () => {
    const deps = makeDeps()
    const fs = fakeFs({ loadRegistry: () => ({ data: { version: 1, loops: [loop({ skill_bundle_id: '_all' })] }, errors: [] }) })
    const wiring: SkillBundleWiringDeps = { resolver: NO_SLOTS, locator: fakeLocator([]) }
    await cmdLoopRun(deps, ['loop-be', '--dry-run', '--json'], fs, projectorFor({ 'loop-be': proj() }), wiring)
    const env = JSON.parse(deps.outLines.join('\n'))
    expect(env.previews[0].skill_bundle).toEqual({ status: 'ready', bundle_id: '_all', blocking_reason: null })
  })

  test('ready：具名已知 profile + 每个 slot 至少一个 alternative 可在当前安装面定位', async () => {
    const deps = makeDeps()
    const fs = fakeFs({ loadRegistry: () => ({ data: { version: 1, loops: [loop({ skill_bundle_id: 'backend' })] }, errors: [] }) })
    const wiring: SkillBundleWiringDeps = {
      resolver: fakeResolver({ a: [{ token: 'x', alternatives: ['x'] }], b: [{ token: 'x', alternatives: ['x'] }] }),
      locator: fakeLocator(['x']),
      isSkillProfileKnown: (id) => id === 'backend',
    }
    await cmdLoopRun(deps, ['loop-be', '--dry-run', '--json'], fs, projectorFor({ 'loop-be': proj() }), wiring)
    const env = JSON.parse(deps.outLines.join('\n'))
    expect(env.previews[0].skill_bundle.status).toBe('ready')
    expect(env.previews[0].skill_bundle.bundle_id).toBe('backend')
  })

  test('invalid：具名 profile 但 isSkillProfileKnown 判其不存在', async () => {
    const deps = makeDeps()
    const fs = fakeFs({ loadRegistry: () => ({ data: { version: 1, loops: [loop({ skill_bundle_id: 'ghost' })] }, errors: [] }) })
    const wiring: SkillBundleWiringDeps = { resolver: NO_SLOTS, locator: fakeLocator([]), isSkillProfileKnown: () => false }
    await cmdLoopRun(deps, ['loop-be', '--dry-run', '--json'], fs, projectorFor({ 'loop-be': proj() }), wiring)
    const env = JSON.parse(deps.outLines.join('\n'))
    expect(env.previews[0].skill_bundle.status).toBe('invalid')
    expect(env.previews[0].skill_bundle.bundle_id).toBe('ghost')
    expect(env.previews[0].skill_bundle.blocking_reason).toMatch(/ghost/)
  })

  test('invalid：具名 profile 已知但 slot 全部 alternative 均无法定位', async () => {
    const deps = makeDeps()
    const fs = fakeFs({ loadRegistry: () => ({ data: { version: 1, loops: [loop({ skill_bundle_id: 'backend' })] }, errors: [] }) })
    const wiring: SkillBundleWiringDeps = {
      resolver: fakeResolver({ a: [{ token: 'x', alternatives: ['x'] }] }),
      locator: fakeLocator([]), // 'x' 无法定位
      isSkillProfileKnown: () => true,
    }
    await cmdLoopRun(deps, ['loop-be', '--dry-run', '--json'], fs, projectorFor({ 'loop-be': proj() }), wiring)
    const env = JSON.parse(deps.outLines.join('\n'))
    expect(env.previews[0].skill_bundle.status).toBe('invalid')
  })

  // H10 复审阻断7：首候选 ambiguous/content-invalid 时预览必须是 invalid，不得因为「下一候选恰好
  // 可定位」就误报 ready——真实运行走 runtime selectFirstLocatable 会在此立即 fail-closed。
  test('invalid（而非 ready）：首候选 SkillContentSourceAmbiguousError，即便下一候选可定位也不得误报 ready', async () => {
    const deps = makeDeps()
    const fs = fakeFs({ loadRegistry: () => ({ data: { version: 1, loops: [loop({ skill_bundle_id: 'backend' })] }, errors: [] }) })
    const wiring: SkillBundleWiringDeps = {
      resolver: fakeResolver({ a: [{ token: 'x|y', alternatives: ['x', 'y'] }] }),
      locator: locatorFirstCandidatePoisoned('SkillContentSourceAmbiguousError', ['y']), // 'y' 本可定位
      isSkillProfileKnown: () => true,
    }
    await cmdLoopRun(deps, ['loop-be', '--dry-run', '--json'], fs, projectorFor({ 'loop-be': proj() }), wiring)
    const env = JSON.parse(deps.outLines.join('\n'))
    expect(env.previews[0].skill_bundle.status).toBe('invalid')
  })

  test('文本渲染（非 --json）含 wiring 行：status/bundle id', async () => {
    const deps = makeDeps()
    const fs = fakeFs({ loadRegistry: () => ({ data: { version: 1, loops: [loop({ skill_bundle_id: '_all' })] }, errors: [] }) })
    const wiring: SkillBundleWiringDeps = { resolver: NO_SLOTS, locator: fakeLocator([]) }
    await cmdLoopRun(deps, ['loop-be', '--dry-run'], fs, OK, wiring)
    const out = deps.outLines.join('\n')
    expect(out).toMatch(/skill.bundle/i)
    expect(out).toContain('_all')
    expect(out).toMatch(/ready/)
  })

  test('缺省未注入 wiring 依赖（第 5 参省略）→ 用 deps.resolver/isSkillProfileKnown 装配，不崩，unwired fixture 判 unwired', async () => {
    const deps = makeDeps()
    const code = await cmdLoopRun(deps, ['loop-be', '--dry-run', '--json'], fakeFs(), projectorFor({ 'loop-be': proj() }))
    expect(code).toBe(0)
    const env = JSON.parse(deps.outLines.join('\n'))
    expect(env.previews[0].skill_bundle.status).toBe('unwired')
  })
})

// ── real-run：自然归属筛选 → AFK executor ─────────────────────────────────────────

describe('real-run', () => {
  test('H11：active starter wiring invalid 时先治理暂停，零 scan/ledger/reservation/Docker', async () => {
    const deps = makeDeps()
    const scanReady = vi.fn(async () => [])
    const readLedger = vi.fn(async () => ({ records: [], rejected: [] }))
    const runAfkRound = completedExecutor()
    const enforceLoopWiring = vi.fn(async () => ({
      blocked: [{
        loopId: 'loop-be', status: 'invalid' as const, dimension: 'workflow' as const,
        reason: 'custom workflow missing',
      }],
    }))
    const fs = fakeFs({
      loadRegistry: () => ({
        data: { version: 1, loops: [loop({
          template_id: 'daily-triage', template_version: 1,
          workflow_id: 'missing-workflow', skill_bundle_id: 'backend',
        })] },
        errors: [],
      }),
    })

    const code = await cmdLoopRun(deps, ['loop-be'], fs, OK, undefined, {
      enforceLoopWiring,
      scanReady,
      readLedger,
      runAfkRound,
    } as never)

    expect(code).toBe(1)
    expect(enforceLoopWiring).toHaveBeenCalledWith(deps, ['loop-be'])
    expect(deps.errLines.join('\n')).toMatch(/loop-be.*workflow.*missing/i)
    expect(scanReady).not.toHaveBeenCalled()
    expect(readLedger).not.toHaveBeenCalled()
    expect(runAfkRound).not.toHaveBeenCalled()
  })

  test('selector 只执行自然归属命中的 ready change，并把 expectedLoopId 交给 executor', async () => {
    const deps = makeDeps()
    const fs = fakeFs({
      loadRegistry: () => ({
        data: {
          version: 1,
          loops: [
            loop({ id: 'loop-api', change_prefix: 'api-', autonomy_level: 'L2' }),
            loop({ id: 'loop-web', change_prefix: 'web-', autonomy_level: 'L1' }),
          ],
        },
        errors: [],
      }),
    })
    const runAfkRound = completedExecutor()
    const runtime = {
      scanReady: vi.fn(async () => ['web-first', 'api-selected']),
      readLedger: vi.fn(async () => ({ records: [], rejected: [] })),
      runAfkRound,
    }

    const code = await cmdLoopRun(deps, ['loop-api'], fs, OK, undefined, runtime as never)

    expect(code).toBe(0)
    expect(runAfkRound).toHaveBeenCalledTimes(1)
    expect(runAfkRound).toHaveBeenCalledWith(deps, {
      level: 'L2',
      targets: [{ change: 'api-selected', expectedLoopId: 'loop-api', expectedAutonomyLevel: 'L2' }],
    })
  })

  test('durable 显式 binding 覆盖名字前缀，selector 按自然归属输出 expectedLoopId', async () => {
    const deps = makeDeps()
    const fs = fakeFs({
      loadRegistry: () => ({
        data: {
          version: 1,
          loops: [
            loop({ id: 'loop-api', change_prefix: 'api-', autonomy_level: 'L1' }),
            loop({ id: 'loop-web', change_prefix: 'web-', autonomy_level: 'L3' }),
          ],
        },
        errors: [],
      }),
    })
    const runAfkRound = completedExecutor()
    const runtime = {
      scanReady: vi.fn(async () => ['api-rebound']),
      readLedger: vi.fn(async () => ({ records: [binding('api-rebound', 'loop-web')], rejected: [] })),
      runAfkRound,
    }

    const code = await cmdLoopRun(deps, ['loop-web'], fs, OK, undefined, runtime as never)

    expect(code).toBe(0)
    expect(runAfkRound).toHaveBeenCalledWith(deps, {
      level: 'L3',
      targets: [{ change: 'api-rebound', expectedLoopId: 'loop-web', expectedAutonomyLevel: 'L3' }],
    })
  })

  test('任一 ready change 归属不可判定 → 整批 fail-closed，executor 零调用', async () => {
    const deps = makeDeps()
    const runAfkRound = completedExecutor()
    const runtime = {
      scanReady: vi.fn(async () => ['orphan-change']),
      readLedger: vi.fn(async () => ({ records: [], rejected: [] })),
      runAfkRound,
    }

    const code = await cmdLoopRun(deps, ['loop-be'], fakeFs(), OK, undefined, runtime as never)

    expect(code).toBe(1)
    expect(deps.errLines.join('\n')).toMatch(/归属|no-match/)
    expect(runAfkRound).not.toHaveBeenCalled()
  })

  test('ledger 有 rejected 坏行 → selector 前 fail-closed，executor 零调用', async () => {
    const deps = makeDeps()
    const runAfkRound = completedExecutor()
    const runtime = {
      scanReady: vi.fn(async () => ['loop-be-ready']),
      readLedger: vi.fn(async () => ({
        records: [],
        rejected: [{ line: 2, raw_hash: 'badbadbadbad', error: 'malformed' }],
      })),
      runAfkRound,
    }

    const code = await cmdLoopRun(deps, ['loop-be'], fakeFs(), OK, undefined, runtime as never)

    expect(code).toBe(1)
    expect(deps.errLines.join('\n')).toMatch(/坏行|rejected|ledger/i)
    expect(runAfkRound).not.toHaveBeenCalled()
  })

  test('fresh scan 无 ready → 诚实 exit 0，executor 零调用', async () => {
    const deps = makeDeps()
    const runAfkRound = completedExecutor()
    const runtime = {
      scanReady: vi.fn(async () => []),
      readLedger: vi.fn(async () => ({ records: [], rejected: [] })),
      runAfkRound,
    }

    const code = await cmdLoopRun(deps, ['loop-be'], fakeFs(), OK, undefined, runtime as never)

    expect(code).toBe(0)
    expect(deps.outLines.join('\n')).toMatch(/无 ready|队列空/)
    expect(runAfkRound).not.toHaveBeenCalled()
  })

  test('未给 --level 时按各 loop autonomy_level 分组，保持各组内 ready FIFO', async () => {
    const deps = makeDeps()
    const fs = fakeFs({
      loadRegistry: () => ({
        data: {
          version: 1,
          loops: [
            loop({ id: 'loop-api', change_prefix: 'api-', autonomy_level: 'L1' }),
            loop({ id: 'loop-web', change_prefix: 'web-', autonomy_level: 'L3' }),
          ],
        },
        errors: [],
      }),
    })
    const runAfkRound = completedExecutor()
    const runtime = {
      scanReady: vi.fn(async () => ['web-first', 'api-second', 'web-third']),
      readLedger: vi.fn(async () => ({ records: [], rejected: [] })),
      runAfkRound,
    }

    const code = await cmdLoopRun(deps, ['loop-*'], fs, OK, undefined, runtime as never)

    expect(code).toBe(0)
    expect(runAfkRound.mock.calls.map((call) => call[1])).toEqual([
      {
        level: 'L3',
        targets: [
          { change: 'web-first', expectedLoopId: 'loop-web', expectedAutonomyLevel: 'L3' },
          { change: 'web-third', expectedLoopId: 'loop-web', expectedAutonomyLevel: 'L3' },
        ],
      },
      { level: 'L1', targets: [{ change: 'api-second', expectedLoopId: 'loop-api', expectedAutonomyLevel: 'L1' }] },
    ])
  })

  test('--level 显式覆盖 mixed loops → 合成单组交给 executor', async () => {
    const deps = makeDeps()
    const fs = fakeFs({
      loadRegistry: () => ({
        data: {
          version: 1,
          loops: [
            loop({ id: 'loop-api', change_prefix: 'api-', autonomy_level: 'L1' }),
            loop({ id: 'loop-web', change_prefix: 'web-', autonomy_level: 'L3' }),
          ],
        },
        errors: [],
      }),
    })
    const runAfkRound = completedExecutor()
    const runtime = {
      scanReady: vi.fn(async () => ['web-first', 'api-second']),
      readLedger: vi.fn(async () => ({ records: [], rejected: [] })),
      runAfkRound,
    }

    const code = await cmdLoopRun(deps, ['loop-*', '--level', 'L2'], fs, OK, undefined, runtime as never)

    expect(code).toBe(0)
    expect(runAfkRound).toHaveBeenCalledTimes(1)
    expect(runAfkRound.mock.calls[0]![1]).toEqual({
      level: 'L2',
      targets: [
        { change: 'web-first', expectedLoopId: 'loop-web', expectedAutonomyLevel: null },
        { change: 'api-second', expectedLoopId: 'loop-api', expectedAutonomyLevel: null },
      ],
    })
  })

  test('executor 报治理拒绝（如超预算）→ 不伪装执行，输出 reason；治理常态仍 exit 0', async () => {
    const deps = makeDeps()
    const denialReport = roundReport({
      admitted: 0,
      entries: [{ change: 'loop-be-ready', loopId: 'loop-be', disposition: 'denied', reason: 'max-runs-per-day' }],
    })
    const runAfkRound = completedExecutor(denialReport)
    const runtime = {
      scanReady: vi.fn(async () => ['loop-be-ready']),
      readLedger: vi.fn(async () => ({ records: [], rejected: [] })),
      runAfkRound,
    }

    const code = await cmdLoopRun(deps, ['loop-be'], fakeFs(), OK, undefined, runtime as never)

    expect(code).toBe(0)
    expect(runAfkRound).toHaveBeenCalledTimes(1)
    expect(deps.outLines.join('\n')).toContain('max-runs-per-day')
  })

  test('任一 executor report.ok=false → 汇总真实 failure 并 exit 1', async () => {
    const deps = makeDeps()
    const failure = {
      change: 'loop-be-ready',
      phase: 'execution' as const,
      kind: 'execution' as const,
      message: 'agent exited 17',
    }
    const runAfkRound = completedExecutor(roundReport({ failures: [failure], ok: false }))
    const runtime = {
      scanReady: vi.fn(async () => ['loop-be-ready']),
      readLedger: vi.fn(async () => ({ records: [], rejected: [] })),
      runAfkRound,
    }

    const code = await cmdLoopRun(deps, ['loop-be'], fakeFs(), OK, undefined, runtime as never)

    expect(code).toBe(1)
    expect(deps.errLines.join('\n')).toContain('agent exited 17')
  })

  test.each([
    ['docker-unavailable', 'docker daemon unavailable'],
    ['configuration-error', 'bundle digest mismatch'],
  ] as const)('executor status=%s → 即使无 RoundReport 也诚实 exit 1', async (status, message) => {
    const deps = makeDeps()
    const runAfkRound = vi.fn(async (
      _deps: unknown,
      input: { level: AutomationLevel; targets: readonly { change: string }[] },
    ): Promise<AfkRoundExecutionResult> => ({
      status,
      level: input.level,
      image: 'sandcastle:test',
      ready: input.targets.map((target) => target.change),
      message,
    }))
    const runtime = {
      scanReady: vi.fn(async () => ['loop-be-ready']),
      readLedger: vi.fn(async () => ({ records: [], rejected: [] })),
      runAfkRound,
    }

    const code = await cmdLoopRun(deps, ['loop-be'], fakeFs(), OK, undefined, runtime as never)

    expect(code).toBe(1)
    expect(deps.errLines.join('\n')).toContain(message)
  })

  test('executor 二次 fresh scan 返回 empty → 不伪装执行，诚实 exit 0', async () => {
    const deps = makeDeps()
    const runAfkRound = vi.fn(async (
      _deps: unknown,
      input: { level: AutomationLevel },
    ): Promise<AfkRoundExecutionResult> => ({
      status: 'empty',
      level: input.level,
      image: 'sandcastle:test',
      ready: [],
    }))
    const runtime = {
      scanReady: vi.fn(async () => ['loop-be-ready']),
      readLedger: vi.fn(async () => ({ records: [], rejected: [] })),
      runAfkRound,
    }

    const code = await cmdLoopRun(deps, ['loop-be'], fakeFs(), OK, undefined, runtime as never)

    expect(code).toBe(0)
    expect(deps.outLines.join('\n')).toContain('status=empty')
  })

  test('real --json 输出选择、分组、完整 report 与强制 commit 事实', async () => {
    const deps = makeDeps()
    const report = roundReport({
      entries: [{ change: 'loop-be-ready', loopId: 'loop-be', disposition: 'settled', result: 'paused' }],
    })
    const runtime = {
      scanReady: vi.fn(async () => ['loop-be-ready']),
      readLedger: vi.fn(async () => ({ records: [], rejected: [] })),
      runAfkRound: completedExecutor(report),
    }

    const code = await cmdLoopRun(deps, ['loop-be', '--json'], fakeFs(), OK, undefined, runtime as never)

    expect(code).toBe(0)
    expect(deps.errLines).toEqual([])
    const output = JSON.parse(deps.outLines.join('\n'))
    expect(output).toEqual({
      dry_run: false,
      selector: 'loop-be',
      matched_loops: ['loop-be'],
      ready: 1,
      selected: 1,
      commit: { requested: false, enforced: true },
      groups: [{
        level: 'L1',
        targets: [{ change: 'loop-be-ready', expectedLoopId: 'loop-be', expectedAutonomyLevel: 'L1' }],
        result: {
          status: 'completed',
          level: 'L1',
          image: 'sandcastle:test',
          ready: ['loop-be-ready'],
          report,
        },
      }],
      ok: true,
    })
  })

  test('--commit 被接受但不改变 executor 形状；未带 flag 也同样强制提交', async () => {
    const execute = async (withCommit: boolean) => {
      const deps = makeDeps()
      const runAfkRound = completedExecutor()
      const runtime = {
        scanReady: vi.fn(async () => ['loop-be-ready']),
        readLedger: vi.fn(async () => ({ records: [], rejected: [] })),
        runAfkRound,
      }
      const args = ['loop-be', ...(withCommit ? ['--commit'] : [])]
      const code = await cmdLoopRun(deps, args, fakeFs(), OK, undefined, runtime as never)
      return { code, deps, runAfkRound }
    }

    const without = await execute(false)
    const withFlag = await execute(true)

    expect(without.code).toBe(0)
    expect(withFlag.code).toBe(0)
    expect(without.runAfkRound.mock.calls[0]![1]).toEqual(withFlag.runAfkRound.mock.calls[0]![1])
    expect(without.deps.outLines.join('\n')).toMatch(/commit|提交/i)
    expect(withFlag.deps.outLines.join('\n')).toMatch(/commit|提交/i)
  })
})

// ── --commit 与 --dry-run 同传：忽略 + 注明 ─────────────────────────────────────────

describe('--commit 在 dry-run 被忽略', () => {
  test('--dry-run --commit → 预览照出，注明 --commit 仅 real-run 生效', async () => {
    const deps = makeDeps()
    const code = await cmdLoopRun(deps, ['loop-be', '--dry-run', '--commit'], fakeFs(), OK)
    expect(code).toBe(0)
    expect(deps.outLines.join('\n')).toMatch(/--commit/)
    expect(deps.outLines.join('\n')).toMatch(/real-run/)
  })

  test('--json 时 commit_ignored=true', async () => {
    const deps = makeDeps()
    await cmdLoopRun(deps, ['loop-be', '--dry-run', '--commit', '--json'], fakeFs(), OK)
    const env = JSON.parse(deps.outLines.join('\n'))
    expect(env.commit_ignored).toBe(true)
  })
})

// ── registry 缺失 / 损坏 ─────────────────────────────────────────────────────────

describe('registry 边界', () => {
  test('registry 缺失（data null, errors 空）→ stderr + exit 1', async () => {
    const deps = makeDeps()
    const code = await cmdLoopRun(deps, ['loop-be', '--dry-run'], fakeFs({ loadRegistry: () => ({ data: null, errors: [] }) }), OK)
    expect(code).toBe(1)
    expect(deps.errLines.join('\n')).toMatch(/loops\.yaml|未找到|登记/)
  })

  test('registry 损坏（errors 非空）→ stderr 定位错误 + exit 1', async () => {
    const deps = makeDeps()
    const code = await cmdLoopRun(deps, ['loop-be', '--dry-run'], fakeFs({ loadRegistry: () => ({ data: null, errors: ['loops[0].id: missing'] }) }), OK)
    expect(code).toBe(1)
    expect(deps.errLines.join('\n')).toContain('loops[0].id')
  })
})

// ── 零状态写（只读纪律：无 store.write / set / cas，无 ledger 写）──────────────────────

describe('零状态写', () => {
  test('dry-run 全程零写：store.write/set/setMany/cas/init 均未调', async () => {
    const deps = makeDeps()
    await cmdLoopRun(deps, ['loop-be', '--dry-run'], fakeFs(), OK)
    expect(deps.store.write.calls.length).toBe(0)
    expect(deps.store.set.calls.length).toBe(0)
    expect(deps.store.setMany.calls.length).toBe(0)
    expect(deps.store.cas.calls.length).toBe(0)
    expect(deps.store.init.calls.length).toBe(0)
  })

  test('注入的 projectLedger 是只读投影（被调用读，不写）', async () => {
    const deps = makeDeps()
    const projector = projectorFor({ 'loop-be': proj() })
    await cmdLoopRun(deps, ['loop-be', '--dry-run'], fakeFs(), projector)
    expect(projector).toHaveBeenCalledTimes(1)
  })
})

// ── cmdLoops 'run' 分派 ─────────────────────────────────────────────────────────

describe('cmdLoops 分派', () => {
  test("cmdLoops(deps,'run',...) 路由到 cmdLoopRun real-run；fresh ready 为空时诚实 exit 0", async () => {
    const deps = makeDeps()
    const code = await cmdLoops(deps, 'run', ['loop-be'], fakeFs())
    expect(code).toBe(0)
    expect(deps.errLines).toEqual([])
    expect(deps.outLines.join('\n')).toMatch(/无 ready|队列空/)
  })

  test('未知子命令 default 文案含 run', async () => {
    const deps = makeDeps()
    await cmdLoops(deps, 'bogus', [], fakeFs())
    expect(deps.errLines.join('\n')).toContain('run')
  })
})
