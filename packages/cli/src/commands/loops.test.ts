/**
 * loops 子命令 —— mock 层快速分支回归（TEST-REALITY.md：真实对位在 loops.integration.test.ts）。
 * 覆盖 dispatch / list / enforce / status 全分支 + --json + --loop + 错误路径（registry 缺失/坏）。
 * fs 经注入的 fake LoopsFs（避免真 fs——真 fs 面在 integration）。
 */
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  ABSENT_REGISTRY_EPOCH,
  createLoopsYamlText,
  createStateStore,
  loadRegistry,
  type WorkflowIR,
} from '@tenon/kernel'
import { makeDeps } from '../test-support.js'
import {
  cmdInit, cmdLoops, derivePrefix, REAL_INIT_ENV, REAL_LOOPS_FS,
  type DriftFs, type GraduationFs, type InitEnv, type LoopsFs, type Prompter,
} from './loops.js'
import type { LoopEntry } from './loops.js'
import type { LoopStarterWiringDeps } from './loop-starter-wiring.js'

const TEST_CREATOR = { id: 'tester@tenon.test', name: 'Tester', trust: 'declared' } as const

function loop(over: Partial<LoopEntry> = {}): LoopEntry {
  return {
    id: 'loop-be', name: 'BE loop', kind: 'orchestrator', goal: 'x'.repeat(12), cadence: '1h',
    risk: 'medium', runner: 'cron', change_prefix: 'loop-be-', phases: ['a', 'b'], human_gates: ['g'],
    state: '.superpowers/loops/progress.md', design_doc: 'd', status: 'active',
    budget: { max_runs_per_day: 24, max_in_flight: 1, on_exceed: 'skip' }, kill_criteria: ['k'],
    autonomy_level: 'L1', allowlist: [], denylist: [], ...over,
  }
}

describe('G1 REAL_LOOPS_FS canonical state cutover', () => {
  test('主 change 删除 YAML projection 后仍从 canonical current 读取完整字段', async () => {
    const root = await mkdtemp(join(tmpdir(), 'loops-canonical-state-'))
    try {
      const store = createStateStore()
      const dir = await store.init({
        repoRoot: root, name: 'loop-be-1', track: 'backend', reviewSeed: 'pending', creator: TEST_CREATOR, preset: 'full',
        clock: () => '2026-07-19T00:00:00Z',
      })
      await store.setMany(dir, { automation: 'running', phase: 'build' })
      await unlink(join(dir, '.pipeline.yaml'))
      expect(REAL_LOOPS_FS.readChangeFields(root, 'loop-be-1')).toMatchObject({
        automation: 'running', phase: 'build',
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

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

describe('dispatch', () => {
  test('未知子命令 → stderr + exit 1', async () => {
    const deps = makeDeps()
    expect(await cmdLoops(deps, 'bogus', [], fakeFs())).toBe(1)
    expect(deps.errLines.join('\n')).toContain('未知 loops 子命令')
  })

  test('H13：sync 原样分派给 reconciliation seam；dry-run 产出计划且零写入', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lite-loop-sync-dispatch-'))
    try {
      await mkdir(join(root, '.pipeline'), { recursive: true })
      const created = createLoopsYamlText(loop({
        id: 'sync-loop',
        name: 'Sync loop',
        design_doc: 'LOOP.md',
        status: 'paused',
      }))
      expect(created.error).toBeNull()
      expect(created.text).not.toBeNull()
      await writeFile(join(root, '.pipeline', 'loops.yaml'), created.text!, 'utf8')
      await writeFile(join(root, 'LOOP.md'), '# Human notes\n', 'utf8')
      const before = await readFile(join(root, 'LOOP.md'), 'utf8')
      const deps = makeDeps({ cwd: root })

      const code = await cmdLoops(
        deps,
        'sync',
        ['sync-loop', '--dry-run', '--json'],
        fakeFs(),
      )

      expect(code).toBe(0)
      expect(deps.errLines).toEqual([])
      expect(JSON.parse(deps.outLines[0]!)).toMatchObject({
        command: 'loop-sync',
        mode: 'dry-run',
        status: 'planned',
        scope: { kind: 'loop', loop_id: 'sync-loop' },
      })
      expect(await readFile(join(root, 'LOOP.md'), 'utf8')).toBe(before)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('H13：sync --apply 重复分派保持幂等，第二次不重复写 managed section', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lite-loop-sync-repeat-'))
    try {
      await mkdir(join(root, '.pipeline'), { recursive: true })
      const created = createLoopsYamlText(loop({
        id: 'sync-loop',
        name: 'Sync loop',
        design_doc: 'LOOP.md',
        status: 'paused',
      }))
      expect(created.error).toBeNull()
      expect(created.text).not.toBeNull()
      await writeFile(join(root, '.pipeline', 'loops.yaml'), created.text!, 'utf8')
      await writeFile(join(root, 'LOOP.md'), '# Human notes\n', 'utf8')

      const firstDeps = makeDeps({ cwd: root })
      expect(await cmdLoops(firstDeps, 'sync', ['sync-loop', '--apply', '--json'], fakeFs())).toBe(0)
      const first = await readFile(join(root, 'LOOP.md'), 'utf8')

      const secondDeps = makeDeps({ cwd: root })
      expect(await cmdLoops(secondDeps, 'sync', ['sync-loop', '--apply', '--json'], fakeFs())).toBe(0)
      const second = await readFile(join(root, 'LOOP.md'), 'utf8')

      expect(second).toBe(first)
      expect(second.match(/PIPELINE:LOOP-MIRROR-V1:START sync-loop/g)).toHaveLength(1)
      expect(second.match(/PIPELINE:LOOP-MIRROR-V1:END sync-loop/g)).toHaveLength(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('list —— 登记表', () => {
  test('text：逐 loop 行含 id/kind/status/autonomy', async () => {
    const deps = makeDeps()
    expect(await cmdLoops(deps, 'list', [], fakeFs())).toBe(0)
    const out = deps.outLines.join('\n')
    expect(out).toContain('loop-be')
    expect(out).toContain('orchestrator')
    expect(out).toContain('L1')
  })

  test('--json：完整 registry 可 JSON.parse', async () => {
    const deps = makeDeps()
    expect(await cmdLoops(deps, 'list', ['--json'], fakeFs())).toBe(0)
    const parsed = JSON.parse(deps.outLines.join('\n'))
    expect(parsed.version).toBe(1)
    expect(parsed.loops[0].id).toBe('loop-be')
  })

  test('registry 缺失（data null, errors 空）→ 提示 + exit 0', async () => {
    const deps = makeDeps()
    expect(await cmdLoops(deps, 'list', [], fakeFs({ loadRegistry: () => ({ data: null, errors: [] }) }))).toBe(0)
    expect(deps.outLines.join('\n')).toMatch(/no|无|registry/i)
  })

  test('registry 校验错误 → stderr 定位错误 + exit 1', async () => {
    const deps = makeDeps()
    expect(await cmdLoops(deps, 'list', [], fakeFs({ loadRegistry: () => ({ data: null, errors: ['loops[0].name: missing'] }) }))).toBe(1)
    expect(deps.errLines.join('\n')).toContain('loops[0].name')
  })
})

describe('enforce —— 裁决出 verdict + exit code（对齐老仓 0/1/2/3）', () => {
  test('全绿 → exit 0、verdict=ok', async () => {
    const deps = makeDeps()
    expect(await cmdLoops(deps, 'enforce', [], fakeFs())).toBe(0)
    expect(deps.outLines.join('\n')).toContain('ok')
  })

  test('在途满 → R8 warn → exit 1', async () => {
    const deps = makeDeps()
    const code = await cmdLoops(deps, 'enforce', [], fakeFs({
      listChanges: (_r, p) => (p === 'loop-be-' ? ['loop-be-1'] : []),
      readChangeFields: () => ({ automation: 'running' }),
    }))
    expect(code).toBe(1)
    expect(deps.outLines.join('\n')).toContain('warn')
  })

  test('kill 判据命中（status=paused）→ exit 2', async () => {
    const deps = makeDeps()
    const code = await cmdLoops(deps, 'enforce', [], fakeFs({
      loadRegistry: () => ({ data: { version: 1, loops: [loop({ status: 'paused' })] }, errors: [] }),
    }))
    expect(code).toBe(2)
    expect(deps.outLines.join('\n')).toContain('kill')
  })

  test('--json：报告含 verdicts + autonomy/enforcement 字段', async () => {
    const deps = makeDeps()
    await cmdLoops(deps, 'enforce', ['--json'], fakeFs())
    const rep = JSON.parse(deps.outLines.join('\n'))
    expect(rep.verdicts[0].id).toBe('loop-be')
    expect(rep.verdicts[0].enforcement).toBe('report-only')
    expect(rep.verdicts[0].report_only).toBe(true)
  })

  test('--loop 过滤未知 id → exit 3 错误', async () => {
    const deps = makeDeps()
    expect(await cmdLoops(deps, 'enforce', ['--loop', 'ghost'], fakeFs())).toBe(3)
  })

  test('registry 错误 → stderr + exit 3', async () => {
    const deps = makeDeps()
    expect(await cmdLoops(deps, 'enforce', [], fakeFs({ loadRegistry: () => ({ data: null, errors: ['boom'] }) }))).toBe(3)
    expect(deps.errLines.join('\n')).toContain('boom')
  })
})

describe('status —— 概览', () => {
  test('逐 loop 汇总 status + verdict + enforcement', async () => {
    const deps = makeDeps()
    expect(await cmdLoops(deps, 'status', [], fakeFs())).toBe(0)
    const out = deps.outLines.join('\n')
    expect(out).toContain('loop-be')
    expect(out).toMatch(/ok|warn|kill/)
    expect(out).toContain('report-only')
  })

  test('H11 starter 文本态显示 template/binding/wiring/runnable，未绑 skill profile 如实为 unwired', async () => {
    const deps = makeDeps()
    const starter = loop({
      id: 'ci-loop',
      goal: 'React to failing CI with minimal fixes and escalation',
      risk: 'medium',
      runner: 'codex',
      phases: ['build'],
      status: 'paused',
      template_id: 'ci-sweeper',
      template_version: 1,
      workflow_id: 'default',
      skill_bundle_id: null,
    })

    expect(await cmdLoops(deps, 'status', [], fakeFs({
      loadRegistry: () => ({ data: { version: 1, loops: [starter] }, errors: [] }),
    }))).toBe(0)

    expect(deps.outLines.join('\n')).toMatch(
      /template=ci-sweeper@1\s+binding=valid\s+wiring=unwired\s+runnable=false/,
    )
  })

  test('H11 --json 输出单一可解析信封，原样带出 helper binding/wiring 与 runnable', async () => {
    const deps = makeDeps()
    const starter = loop({
      id: 'ci-loop',
      goal: 'React to failing CI with minimal fixes and escalation',
      risk: 'medium',
      runner: 'codex',
      phases: ['build'],
      status: 'paused',
      template_id: 'ci-sweeper',
      template_version: 1,
      workflow_id: 'default',
      skill_bundle_id: null,
    })

    expect(await cmdLoops(deps, 'status', ['--json'], fakeFs({
      loadRegistry: () => ({ data: { version: 1, loops: [starter] }, errors: [] }),
    }))).toBe(0)

    expect(deps.outLines).toHaveLength(1)
    const row = JSON.parse(deps.outLines[0]!).loops[0]
    expect(row.template).toEqual({ id: 'ci-sweeper', version: 1 })
    expect(row.binding.status).toBe('valid')
    expect(row.wiring.status).toBe('unwired')
    expect(row.runnable).toBe(false)
  })

  test('status --json 在 registry 缺失的正常态仍输出可解析空信封', async () => {
    const deps = makeDeps()

    expect(await cmdLoops(deps, 'status', ['--json'], fakeFs({
      loadRegistry: () => ({ data: null, errors: [] }),
    }))).toBe(0)

    expect(deps.outLines).toEqual([JSON.stringify({ loops: [] })])
  })
})

// ── #36 budget/cost 子命令（token 预算 + circuit breaker + 成本估算）─────────────

/** 一条 run-log 行（progress.md 5 列；note 内含 tokens=）。 */
function tokenRow(ts: string, id: string, tokens: number): string {
  return `| ${ts} | ${id} | run | 0 | result=ok tokens=${tokens} |`
}

/** 带 token 预算的 loop（LoopEntry.budget 追加可选 max_tokens_per_day/tokens_per_run）。 */
function budgetLoop(maxTokens?: number, over: Partial<LoopEntry> = {}): LoopEntry {
  return loop({ budget: { max_runs_per_day: 24, max_in_flight: 1, on_exceed: 'skip', max_tokens_per_day: maxTokens }, ...over })
}

describe('budget —— circuit breaker 状态（预算/花费/剩余）', () => {
  test('未熔断（花费 < 80%）→ exit 0、输出含 breaker/ok + 花费数', async () => {
    const deps = makeDeps()
    const code = await cmdLoops(deps, 'budget', ['loop-be'], fakeFs({
      loadRegistry: () => ({ data: { version: 1, loops: [budgetLoop(100000)] }, errors: [] }),
      readProgress: () => [tokenRow('2026-07-06T09:00', 'loop-be', 50000)].join('\n'),
    }))
    expect(code).toBe(0)
    const out = deps.outLines.join('\n')
    expect(out).toContain('loop-be')
    expect(out).toMatch(/ok/)
    expect(out).toContain('50000')
  })

  test('花费超阈值 → 熔断 tripped → exit 2', async () => {
    const deps = makeDeps()
    const code = await cmdLoops(deps, 'budget', ['loop-be'], fakeFs({
      loadRegistry: () => ({ data: { version: 1, loops: [budgetLoop(10000)] }, errors: [] }),
      readProgress: () => [tokenRow('2026-07-06T09:00', 'loop-be', 12000)].join('\n'),
    }))
    expect(code).toBe(2)
    expect(deps.outLines.join('\n')).toMatch(/tripped|熔断/)
  })

  test('--json：报告含 statuses + breaker + remaining', async () => {
    const deps = makeDeps()
    await cmdLoops(deps, 'budget', ['--json'], fakeFs({
      loadRegistry: () => ({ data: { version: 1, loops: [budgetLoop(100000)] }, errors: [] }),
      readProgress: () => [tokenRow('2026-07-06T09:00', 'loop-be', 50000)].join('\n'),
    }))
    const rep = JSON.parse(deps.outLines.join('\n'))
    expect(rep.statuses[0].id).toBe('loop-be')
    expect(rep.statuses[0].breaker).toBe('ok')
    expect(rep.statuses[0].remaining).toBe(50000)
  })

  test('未知 --loop id → exit 3', async () => {
    const deps = makeDeps()
    expect(await cmdLoops(deps, 'budget', ['ghost'], fakeFs())).toBe(3)
  })

  test('registry 错误 → stderr + exit 3', async () => {
    const deps = makeDeps()
    expect(await cmdLoops(deps, 'budget', [], fakeFs({ loadRegistry: () => ({ data: null, errors: ['boom'] }) }))).toBe(3)
    expect(deps.errLines.join('\n')).toContain('boom')
  })
})

describe('cost —— 成本估算（cadence×pattern）', () => {
  test('估算在预算内 → exit 0、输出含预估 token/日', async () => {
    const deps = makeDeps()
    const code = await cmdLoops(deps, 'cost', ['loop-be'], fakeFs({
      loadRegistry: () => ({ data: { version: 1, loops: [budgetLoop(300000, { cadence: '1h', risk: 'medium' })] }, errors: [] }),
    }))
    expect(code).toBe(0)
    expect(deps.outLines.join('\n')).toContain('192000') // 24×8000
  })

  test('估算超预算 → exit 1', async () => {
    const deps = makeDeps()
    const code = await cmdLoops(deps, 'cost', [], fakeFs({
      loadRegistry: () => ({ data: { version: 1, loops: [budgetLoop(100000, { cadence: '1h', risk: 'high' })] }, errors: [] }),
    }))
    expect(code).toBe(1)
  })

  test('--json：报告含 estimates + estimatedTokensPerDay', async () => {
    const deps = makeDeps()
    await cmdLoops(deps, 'cost', ['--json'], fakeFs({
      loadRegistry: () => ({ data: { version: 1, loops: [budgetLoop(300000, { cadence: '1h', risk: 'medium' })] }, errors: [] }),
    }))
    const rep = JSON.parse(deps.outLines.join('\n'))
    expect(rep.estimates[0].estimatedTokensPerDay).toBe(192000)
    expect(rep.estimates[0].runsPerDay).toBe(24)
  })
})

// ── #37 drift/audit 子命令（漂移检测 + loop-ready 就绪评分）──────────────────────

const DRIFT_HEADER = '| ts | loop | action | inflight | note |\n|----|------|--------|----------|------|'

/** 满配 loop（loop-ready 100）：goal≥30 / kill≥2 / gates≥2 / token 预算 / 有限 cadence / prefix / 全 doc。 */
function richLoop(over: Partial<LoopEntry> = {}): LoopEntry {
  return loop({
    goal: 'x'.repeat(40), kill_criteria: ['k1', 'k2'], human_gates: ['g1', 'g2'],
    budget: { max_runs_per_day: 24, max_in_flight: 1, on_exceed: 'skip', max_tokens_per_day: 100000 },
    cadence: '1h', change_prefix: 'loop-be-', design_doc: 'docs/loops/loop-be.md',
    state: '.superpowers/loops/progress.md', ...over,
  })
}

/** fake DriftFs（第 5 参注入）：registry + run-log + LOOP.md 镜像。makeDeps clock=2026-07-06T00:00Z。 */
function fakeDriftFs(over: Partial<DriftFs> = {}): DriftFs {
  return {
    loadRegistry: () => ({ data: { version: 1, loops: [richLoop()] }, errors: [] }),
    readRunLog: () => `${DRIFT_HEADER}\n| 2026-07-05T23:30 | loop-be | run | 0 | result=ok |`,
    readLoopDoc: () => '### `loop-be` — BE loop',
    ...over,
  }
}

describe('drift —— 漂移检测（loop-sync）', () => {
  test('对齐 → CLEAN、exit 0', async () => {
    const deps = makeDeps()
    const code = await cmdLoops(deps, 'drift', [], fakeFs(), fakeDriftFs())
    expect(code).toBe(0)
    expect(deps.outLines.join('\n')).toMatch(/CLEAN|无漂移/)
  })

  test('mirror-missing：LOOP.md 未提及 → warn、exit 1', async () => {
    const deps = makeDeps()
    const code = await cmdLoops(deps, 'drift', [], fakeFs(), fakeDriftFs({ readLoopDoc: () => '(无提及)' }))
    expect(code).toBe(1)
    expect(deps.outLines.join('\n')).toContain('mirror-missing')
  })

  test('--json：报告含 items + dimension', async () => {
    const deps = makeDeps()
    await cmdLoops(deps, 'drift', ['--json'], fakeFs(), fakeDriftFs({ readLoopDoc: () => '(无提及)' }))
    const rep = JSON.parse(deps.outLines.join('\n'))
    expect(rep.items[0].dimension).toBe('mirror-missing')
    expect(rep.checked).toContain('loop-be')
  })

  test('未知 --loop → exit 3', async () => {
    const deps = makeDeps()
    expect(await cmdLoops(deps, 'drift', ['ghost'], fakeFs(), fakeDriftFs())).toBe(3)
  })

  test('registry 错误 → stderr + exit 3', async () => {
    const deps = makeDeps()
    expect(await cmdLoops(deps, 'drift', [], fakeFs(), fakeDriftFs({ loadRegistry: () => ({ data: null, errors: ['boom'] }) }))).toBe(3)
    expect(deps.errLines.join('\n')).toContain('boom')
  })
})

describe('audit —— loop-ready 就绪评分（loop-audit）', () => {
  test('满配 loop → ready、exit 0', async () => {
    const deps = makeDeps()
    const code = await cmdLoops(deps, 'audit', [], fakeFs(), fakeDriftFs())
    expect(code).toBe(0)
    const out = deps.outLines.join('\n')
    expect(out).toContain('loop-be')
    expect(out).toMatch(/score=/)
  })

  test('极简 loop（not-ready）→ exit 1 + 建议', async () => {
    const deps = makeDeps()
    const weak = loop({
      goal: 'x'.repeat(10), human_gates: ['g'], kill_criteria: ['k'], change_prefix: null,
      budget: { max_runs_per_day: 24, max_in_flight: 1, on_exceed: 'skip' },
    })
    const code = await cmdLoops(deps, 'audit', [], fakeFs(), fakeDriftFs({ loadRegistry: () => ({ data: { version: 1, loops: [weak] }, errors: [] }) }))
    expect(code).toBe(1)
    expect(deps.outLines.join('\n')).toMatch(/not-ready/)
  })

  test('--json：报告含 scores + band + dimensions', async () => {
    const deps = makeDeps()
    await cmdLoops(deps, 'audit', ['--json'], fakeFs(), fakeDriftFs())
    const rep = JSON.parse(deps.outLines.join('\n'))
    expect(rep.scores[0].id).toBe('loop-be')
    expect(rep.scores[0].score).toBe(100)
    expect(rep.scores[0].band).toBe('ready')
  })

  test('未知 --loop → exit 3', async () => {
    const deps = makeDeps()
    expect(await cmdLoops(deps, 'audit', ['ghost'], fakeFs(), fakeDriftFs())).toBe(3)
  })
})

// ── #38 graduate / level 子命令（分级放权 L1→L3 毕业制）──────────────────────────
// makeDeps clock = 2026-07-06T00:00Z；richLoop 满配（score 100），run-log 近期（不 idle），LOOP.md 同步。

const GRAD_YAML = 'version: 1\nloops:\n  - id: loop-be\n    name: BE loop\n    autonomy_level: L1\n'

/** fake GraduationFs（第 6 参注入）：registry + run-log + LOOP.md + loops.yaml governance 快照/写面。 */
function fakeGradFs(over: Partial<GraduationFs> = {}): GraduationFs {
  return {
    loadRegistry: () => ({ data: { version: 1, loops: [richLoop()] }, errors: [] }),
    readRunLog: () => `${DRIFT_HEADER}\n| 2026-07-05T23:00 | loop-be | run | 0 | result=ok |`,
    readLoopDoc: () => '### `loop-be` — BE loop',
    readRegistrySnapshot: async () => ({ text: GRAD_YAML, epoch: 'e0' }),
    writeRegistryGoverned: async (_r, _e, produce) => {
      const { error } = produce(GRAD_YAML)
      return { ok: error === null, error }
    },
    ...over,
  }
}

/** 捕获 governance 写回文本的 fake（level set --confirm 断言落盘内容）：produce 对快照文本做 surgical 变换。 */
function captureGradFs(writes: string[]): GraduationFs {
  return fakeGradFs({
    writeRegistryGoverned: async (_r, _e, produce) => {
      const { text, error } = produce(GRAD_YAML)
      if (text !== null) writes.push(text)
      return { ok: error === null && text !== null, error }
    },
  })
}

describe('graduate —— 升档准入裁决', () => {
  test('L1 满配 + 镜像同步 + 熔断 ok → canGraduate=true 荐升 L2、exit 1', async () => {
    const deps = makeDeps()
    const code = await cmdLoops(deps, 'graduate', ['--json'], fakeFs(), fakeDriftFs(), fakeGradFs())
    expect(code).toBe(1)
    const v = JSON.parse(deps.outLines.join('\n')).verdicts[0]
    expect(v.current).toBe('L1')
    expect(v.canGraduate).toBe(true)
    expect(v.recommended).toBe('L2')
  })

  test('text 输出含 current/recommended', async () => {
    const deps = makeDeps()
    await cmdLoops(deps, 'graduate', [], fakeFs(), fakeDriftFs(), fakeGradFs())
    expect(deps.outLines.join('\n')).toContain('loop-be')
  })

  test('未知 --loop → exit 3', async () => {
    const deps = makeDeps()
    expect(await cmdLoops(deps, 'graduate', ['ghost'], fakeFs(), fakeDriftFs(), fakeGradFs())).toBe(3)
  })

  test('registry 错误 → stderr + exit 3', async () => {
    const deps = makeDeps()
    const code = await cmdLoops(deps, 'graduate', [], fakeFs(), fakeDriftFs(),
      fakeGradFs({ loadRegistry: () => ({ data: null, errors: ['boom'] }) }))
    expect(code).toBe(3)
    expect(deps.errLines.join('\n')).toContain('boom')
  })
})

describe('level —— 查看 + set 逐级毕业写回', () => {
  test('view：打印 current + recommended', async () => {
    const deps = makeDeps()
    const code = await cmdLoops(deps, 'level', ['loop-be'], fakeFs(), fakeDriftFs(), fakeGradFs())
    expect(code).toBe(0)
    expect(deps.outLines.join('\n')).toMatch(/current=L1/)
  })

  test('set L2 --confirm（准入通过）→ governance 写回落盘含 L2、exit 0', async () => {
    const deps = makeDeps()
    const writes: string[] = []
    const code = await cmdLoops(deps, 'level', ['loop-be', 'set', 'L2', '--confirm'], fakeFs(), fakeDriftFs(), captureGradFs(writes))
    expect(code).toBe(0)
    expect(writes).toHaveLength(1)
    expect(writes[0]).toContain('autonomy_level: L2')
  })

  test('set L2 无 --confirm → dry-run 不写', async () => {
    const deps = makeDeps()
    const writes: string[] = []
    const code = await cmdLoops(deps, 'level', ['loop-be', 'set', 'L2'], fakeFs(), fakeDriftFs(), captureGradFs(writes))
    expect(code).toBe(0)
    expect(writes).toHaveLength(0)
  })

  test('L1 set L3（跨级）→ 拒绝、exit≠0、不写', async () => {
    const deps = makeDeps()
    const writes: string[] = []
    const code = await cmdLoops(deps, 'level', ['loop-be', 'set', 'L3', '--confirm'], fakeFs(), fakeDriftFs(), captureGradFs(writes))
    expect(code).not.toBe(0)
    expect(writes).toHaveLength(0)
    expect(deps.errLines.join('\n')).toMatch(/跨级|逐级/)
  })

  test('未知 loop → exit 3', async () => {
    const deps = makeDeps()
    expect(await cmdLoops(deps, 'level', ['ghost'], fakeFs(), fakeDriftFs(), fakeGradFs())).toBe(3)
  })
})

// ── loop-init：`tenon loops init` 向导 + 非交互结构化通道（L3，真 fs 临时目录）──────────
// 本区块用真 fs 临时目录（区别于上方 mock 层分支回归）——init 的核心契约是「落真盘 + loadRegistry
// 读回」，唯有真 fs 能钉住写盘/CAS/草稿标记；CAS 并发与坏路径注入两例用内存 fake env（无法真并发）。

const GOAL_OK = '把 restyle 前缀的 change 编排跑通' // ≥10 字符

/**
 * 内存 fake InitEnv：非交互，governance 写面用单份 {text, epoch} 模拟盘上 loops.yaml + 字节 epoch。
 * writeGoverned 语义同真 writeRegistryWithGovernance：expectedEpoch ≠ 当前 epoch → CAS 拒（含并发首建：
 * 首建 expected=ABSENT 但此刻已有内容 → epoch 非 ABSENT → 拒）。草稿标记记进数组。
 */
function memInitEnv(seedText: string | null = null): {
  env: InitEnv; state: { text: string | null; epoch: string }; drafts: string[]
} {
  const state = { text: seedText, epoch: seedText === null ? ABSENT_REGISTRY_EPOCH : 'e0' }
  const drafts: string[] = []
  const env: InitEnv = {
    readSnapshot: async () => ({ text: state.text ?? '', epoch: state.text === null ? ABSENT_REGISTRY_EPOCH : state.epoch }),
    writeGoverned: async (_root, expectedEpoch, produce) => {
      const curEpoch = state.text === null ? ABSENT_REGISTRY_EPOCH : state.epoch
      if (curEpoch !== expectedEpoch) return { ok: false, error: `CAS 失败：epoch ${expectedEpoch} → ${curEpoch}` }
      const { text, error } = produce(state.text ?? '')
      if (error !== null || text === null) return { ok: false, error }
      state.text = text
      state.epoch = `${state.epoch}+1`
      return { ok: true, error: null }
    },
    addDraftMark: async (_path, id) => { drafts.push(id) },
    isInteractive: () => false,
    makePrompter: () => ({ ask: async () => '', close: () => {} }),
  }
  return { env, state, drafts }
}

/** 脚本化 Prompter：按注入顺序弹出应答（'' = 回车收默认）。 */
function scriptedPrompter(answers: string[]): Prompter {
  let i = 0
  return { ask: async () => answers[i++] ?? '', close: () => {} }
}

function starterWiringDeps(
  root: string,
  overrides: Partial<LoopStarterWiringDeps> = {},
): LoopStarterWiringDeps {
  return {
    repoRoot: root,
    skillBundleWiring: {
      resolver: { resolveDefault: () => [], resolveCustom: () => [] },
      locator: { locate: async (skillId) => ({ skillId, contentDir: `/skills/${skillId}` }) },
      isSkillProfileKnown: (profileId) => profileId === 'backend',
    },
    ...overrides,
  }
}

function starterWorkflowIr(name: string): WorkflowIR {
  return {
    name,
    steps: ['open', 'explore', 'spec', 'build', 'verify', 'ship', 'archive'].map((id) => ({
      id,
      label: id,
      gate: null,
      skills: [],
      inputs: [],
      outputs: [],
      guards: [],
      artifacts: [],
      transitions: [],
    })),
  }
}

describe('loops init —— 非交互结构化通道（真 fs 临时目录）', () => {
  let root: string
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'lite-loopinit-')) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  test('① 全默认：loops.yaml 生成、loadRegistry 读回绿、status=paused、逐字段等于推导规则表', async () => {
    const deps = makeDeps({ cwd: root })
    const code = await cmdInit(deps, ['--yes', '--id', 'x-loop', '--goal', GOAL_OK])
    expect(code).toBe(0)
    const { data, errors } = loadRegistry(root)
    expect(errors).toEqual([])
    expect(data).not.toBeNull()
    const l = data!.loops[0]!
    expect(l.id).toBe('x-loop')
    expect(l.name).toBe('x-loop')
    expect(l.kind).toBe('orchestrator')
    expect(l.goal).toBe(GOAL_OK)
    expect(l.change_prefix).toBe('xl-') // derivePrefix('x-loop')
    expect(l.risk).toBe('low')
    expect(l.runner).toBe('codex')
    expect(l.cadence).toBe('4h') // low → 4h
    expect(l.phases).toEqual(['open', 'explore', 'spec', 'build', 'verify', 'ship', 'archive'])
    expect(l.human_gates).toEqual(['explore', 'spec', 'verify'])
    expect(l.kill_criteria).toEqual(['no-change-3', 'budget-burn-2d'])
    expect(l.state).toBeUndefined() // H9: runtime iteration state comes from ledger audit facts
    expect(l.design_doc).toBe('docs/loops/x-loop.md')
    expect(l.status).toBe('paused') // 硬 gate
    expect(l.budget).toEqual({ max_runs_per_day: 48, max_in_flight: 1, on_exceed: 'skip', max_tokens_per_day: 100000 })
    expect(l.autonomy_level).toBe('L1') // loadRegistry 派生
  })

  test('手动 loop：显式 workflow 与 skill bundle 不依赖 starter template 也会持久化', async () => {
    const deps = makeDeps({ cwd: root })

    expect(await cmdInit(deps, [
      '--yes',
      '--id', 'manual-bound-loop',
      '--goal', GOAL_OK,
      '--workflow', 'default',
      '--skill-bundle', 'pm',
    ])).toBe(0)

    const { data, errors } = loadRegistry(root)
    expect(errors).toEqual([])
    expect(data!.loops[0]).toMatchObject({
      id: 'manual-bound-loop',
      workflow_id: 'default',
      skill_bundle_id: 'pm',
    })
    const yaml = await readFile(join(root, '.pipeline', 'loops.yaml'), 'utf8')
    expect(yaml).toContain('    workflow_id: default\n')
    expect(yaml).toContain('    skill_bundle_id: pm\n')
    expect(yaml).not.toContain('    template_id:')
  })

  test('H11 starter：已知 v1 template 编译 policy 并持久化 binding，技能 profile 未显式绑定时仍 paused/unwired', async () => {
    const deps = makeDeps({ cwd: root })

    const code = await cmdInit(deps, [
      '--yes', '--id', 'ci-loop', '--template', 'ci-sweeper',
    ])

    expect(code).toBe(0)
    const { data, errors } = loadRegistry(root)
    expect(errors).toEqual([])
    expect(data!.loops[0]).toMatchObject({
      id: 'ci-loop',
      goal: 'React to failing CI with minimal fixes and escalation',
      risk: 'medium',
      status: 'paused',
      template_id: 'ci-sweeper',
      template_version: 1,
      workflow_id: 'default',
      skill_bundle_id: null,
    })
    expect(await readFile(join(root, '.pipeline', 'loops.yaml'), 'utf8')).toContain('    skill_bundle_id: null\n')
    expect(deps.outLines.join('\n')).toMatch(/template=ci-sweeper@1.*trigger=schedule,event.*recommended-skills=ci-triage,minimal-fix/s)
    expect(deps.outLines.join('\n')).toMatch(/binding=valid.*wiring=unwired.*runnable=false/s)
  })

  test.each([
    {
      templateId: 'pr-babysitter',
      goal: 'Shepherd PRs through review, CI, rebase, and merge',
      risk: 'medium',
      trigger: ['schedule'],
      skills: ['pr-review-triage', 'minimal-fix', 'rebase-and-clean'],
    },
    {
      templateId: 'daily-triage',
      goal: 'Prioritized morning scan of CI, issues, commits, and chat',
      risk: 'low',
      trigger: ['schedule'],
      skills: ['loop-triage', 'minimal-fix'],
    },
    {
      templateId: 'ci-sweeper',
      goal: 'React to failing CI with minimal fixes and escalation',
      risk: 'medium',
      trigger: ['schedule', 'event'],
      skills: ['ci-triage', 'minimal-fix'],
    },
    {
      templateId: 'post-merge-cleanup',
      goal: 'Follow-up tech debt and cleanup after merges to main',
      risk: 'low',
      trigger: ['schedule', 'event'],
      skills: ['post-merge-scan', 'minimal-fix'],
    },
    {
      templateId: 'dependency-sweeper',
      goal: 'Discover, safely apply, and verify dependency + vulnerability updates with human gates on risky changes',
      risk: 'medium',
      trigger: ['schedule', 'event', 'manual'],
      skills: ['dependency-triage', 'minimal-fix', 'loop-verifier'],
    },
    {
      templateId: 'changelog-drafter',
      goal: 'Scan merged PRs and commits, draft categorized high-quality release notes or CHANGELOG entries for human review',
      risk: 'low',
      trigger: ['schedule', 'event', 'manual'],
      skills: ['changelog-scan', 'draft-release-notes', 'loop-verifier'],
    },
    {
      templateId: 'issue-triage',
      goal: 'Discover, deduplicate, prioritize and label incoming issues/discussions so the team always has a clean actionable queue. Excellent low-risk companion to Daily Triage.',
      risk: 'low',
      trigger: ['schedule', 'event'],
      skills: ['issue-triage', 'loop-verifier'],
    },
  ])('H11 catalog $templateId：v1 goal/trigger/risk/recommended workflow+skills 均由模板编译', async ({
    templateId, goal, risk, trigger, skills,
  }) => {
    const deps = makeDeps({ cwd: root })

    expect(await cmdInit(deps, [
      '--yes', '--id', templateId, '--template', templateId, '--json',
    ])).toBe(0)

    expect(loadRegistry(root).data!.loops[0]).toMatchObject({
      id: templateId,
      goal,
      risk,
      status: 'paused',
      template_id: templateId,
      template_version: 1,
      workflow_id: 'default',
      skill_bundle_id: null,
    })
    const output = JSON.parse(deps.outLines[0]!)
    expect(output.template).toMatchObject({
      id: templateId,
      version: 1,
      goal,
      risk,
      recommendedWorkflow: 'default',
      recommendedSkills: skills,
    })
    expect(output.template.trigger.map((item: { kind: string }) => item.kind)).toEqual(trigger)
  })

  test('H11 starter：unknown template 无 goal 也落成 paused 诊断草稿，helper 判 invalid 且绝不 runnable', async () => {
    const deps = makeDeps({ cwd: root })

    const code = await cmdInit(deps, [
      '--yes', '--id', 'unknown-loop', '--template', 'unknown-template',
    ])

    expect(code).toBe(0)
    expect(loadRegistry(root).data!.loops[0]).toMatchObject({
      id: 'unknown-loop',
      goal: 'Resolve unknown starter template "unknown-template" before activation',
      status: 'paused',
      template_id: 'unknown-template',
      template_version: 1,
      workflow_id: 'default',
      skill_bundle_id: null,
    })
    expect(deps.outLines.join('\n')).toMatch(/template=unknown-template@1.*compile=invalid.*unknown-template/s)
    expect(deps.outLines.join('\n')).toMatch(/binding=invalid.*wiring=invalid.*runnable=false/s)
  })

  test('H11 missing workflow：引用落盘但 wiring invalid/runnable=false，loop 仍 paused', async () => {
    const deps = makeDeps({ cwd: root })

    expect(await cmdInit(deps, [
      '--yes', '--id', 'missing-workflow-loop', '--template', 'daily-triage',
      '--workflow', 'missing-workflow', '--skill-bundle', 'backend', '--json',
    ], REAL_INIT_ENV, starterWiringDeps(root))).toBe(0)

    const output = JSON.parse(deps.outLines[0]!)
    expect(output).toMatchObject({
      status: 'paused',
      binding: { status: 'valid', workflowId: 'missing-workflow' },
      wiring: { status: 'invalid', workflow: { status: 'invalid', workflowId: 'missing-workflow' } },
      runnable: false,
    })
    expect(output.wiring.reason).toMatch(/missing-workflow.*(?:不存在|缺失)/i)
    expect(loadRegistry(root).data!.loops[0]!.status).toBe('paused')
    expect(loadRegistry(root).data!.loops[0]!.state).toBeUndefined()
    expect(await readFile(join(root, '.pipeline', 'loops.yaml'), 'utf8')).not.toMatch(/^\s+state:/m)
  })

  test('H11 invalid skill profile：唯一 evaluator 判 invalid，落盘后仍 paused/runnable=false', async () => {
    const deps = makeDeps({ cwd: root })

    expect(await cmdInit(deps, [
      '--yes', '--id', 'bad-skill-loop', '--template', 'daily-triage',
      '--skill-bundle', 'ghost-profile', '--json',
    ], REAL_INIT_ENV, starterWiringDeps(root))).toBe(0)

    const output = JSON.parse(deps.outLines[0]!)
    expect(output).toMatchObject({
      status: 'paused',
      binding: { status: 'valid' },
      wiring: {
        status: 'invalid',
        skillBundle: { status: 'invalid', bundleId: 'ghost-profile' },
      },
      runnable: false,
    })
    expect(output.wiring.reason).toMatch(/ghost-profile.*profile/i)
    expect(loadRegistry(root).data!.loops[0]!.status).toBe('paused')
  })

  test('H11 custom workflow runtime unwired：结构与 skill ready 也不得 runnable/active', async () => {
    const deps = makeDeps({ cwd: root })
    const wiring = starterWiringDeps(root, {
      loadWorkflow: () => ({ name: 'custom-runtime', steps: [] }),
      compileWorkflow: () => starterWorkflowIr('custom-runtime'),
      customWorkflowRuntimeWired: false,
    })

    expect(await cmdInit(deps, [
      '--yes', '--id', 'custom-runtime-loop', '--template', 'daily-triage',
      '--workflow', 'custom-runtime', '--skill-bundle', 'backend', '--json',
    ], REAL_INIT_ENV, wiring)).toBe(0)

    const output = JSON.parse(deps.outLines[0]!)
    expect(output).toMatchObject({
      status: 'paused',
      binding: { status: 'valid', workflowId: 'custom-runtime' },
      wiring: {
        status: 'unwired',
        workflow: { status: 'ready', workflowId: 'custom-runtime' },
        customWorkflowRuntime: { status: 'unwired' },
        skillBundle: { status: 'ready', bundleId: 'backend' },
      },
      runnable: false,
    })
    expect(loadRegistry(root).data!.loops[0]!.status).toBe('paused')
  })

  test('H11 ambiguous binding：同一 template 已绑定时第二次 init fail-closed，绝不落第二条', async () => {
    const wiring = starterWiringDeps(root)
    expect(await cmdInit(makeDeps({ cwd: root }), [
      '--yes', '--id', 'daily-one', '--template', 'daily-triage', '--skill-bundle', 'backend',
    ], REAL_INIT_ENV, wiring)).toBe(0)
    const deps = makeDeps({ cwd: root })

    expect(await cmdInit(deps, [
      '--yes', '--id', 'daily-two', '--template', 'daily-triage', '--skill-bundle', 'backend',
    ], REAL_INIT_ENV, wiring)).toBe(1)

    expect(loadRegistry(root).data!.loops.map((entry) => entry.id)).toEqual(['daily-one'])
    expect(deps.errLines.join('\n')).toMatch(/daily-triage.*已绑定.*daily-one/i)
  })

  test('H11 all ready：paused 草稿仍 runnable=false，不把 wiring ready 冒充可运行', async () => {
    const deps = makeDeps({ cwd: root })

    expect(await cmdInit(deps, [
      '--yes', '--id', 'ready-loop', '--template', 'daily-triage',
      '--workflow', 'default', '--skill-bundle', 'backend', '--json',
    ], REAL_INIT_ENV, starterWiringDeps(root))).toBe(0)

    expect(JSON.parse(deps.outLines[0]!)).toMatchObject({
      status: 'paused',
      binding: { status: 'valid', workflowId: 'default' },
      wiring: {
        status: 'ready',
        workflow: { status: 'ready', workflowId: 'default' },
        customWorkflowRuntime: { status: 'ready' },
        skillBundle: { status: 'ready', bundleId: 'backend' },
      },
      runnable: false,
    })
    expect(loadRegistry(root).data!.loops[0]!.status).toBe('paused')
  })

  test('① risk=high 映射：cadence=1h / max_runs=8（推导规则表 risk 映射钉死）', async () => {
    const deps = makeDeps({ cwd: root })
    await cmdInit(deps, ['--yes', '--id', 'h-loop', '--goal', GOAL_OK, '--risk', 'high'])
    const l = loadRegistry(root).data!.loops[0]!
    expect(l.cadence).toBe('1h')
    expect(l.budget.max_runs_per_day).toBe(8)
  })

  test('② 重复 id → exit 非零 + stderr 定位（append 路径查重）', async () => {
    const deps1 = makeDeps({ cwd: root })
    expect(await cmdInit(deps1, ['--yes', '--id', 'dup-loop', '--goal', GOAL_OK])).toBe(0)
    const deps2 = makeDeps({ cwd: root })
    const code = await cmdInit(deps2, ['--yes', '--id', 'dup-loop', '--goal', GOAL_OK])
    expect(code).not.toBe(0)
    expect(deps2.errLines.join('\n')).toContain('dup-loop')
  })

  test('③ 已存在文件（含注释 fixture）→ 追加后原区间逐字节不变、两 loop 都读回', async () => {
    const existing = '# 手写登记表——勿被 init 重排/丢注释\n'
      + createLoopsYamlText({
        id: 'first-loop', name: 'first-loop', kind: 'orchestrator', goal: GOAL_OK, cadence: '4h',
        risk: 'low', runner: 'claude-code', change_prefix: 'fl-', phases: ['open', 'explore'],
        human_gates: ['explore'], state: '.superpowers/loops/progress.md', design_doc: 'docs/loops/first-loop.md',
        status: 'paused', budget: { max_runs_per_day: 48, max_in_flight: 1, on_exceed: 'skip' }, kill_criteria: ['no-change-3'],
      }).text!
    await mkdir(join(root, '.pipeline'), { recursive: true })
    await writeFile(join(root, '.pipeline', 'loops.yaml'), existing, 'utf8')
    const deps = makeDeps({ cwd: root })
    expect(await cmdInit(deps, ['--yes', '--id', 'second-loop', '--goal', GOAL_OK])).toBe(0)
    const after = await readFile(join(root, '.pipeline', 'loops.yaml'), 'utf8')
    expect(after.startsWith(existing)).toBe(true) // 原区间逐字节保留
    const { data, errors } = loadRegistry(root)
    expect(errors).toEqual([])
    expect(data!.loops.map((x) => x.id)).toEqual(['first-loop', 'second-loop'])
  })

  test('④ CAS：写回前 epoch 被并发改 → 如实拒绝 exit 非零、不落盘（governance 锁内重读 epoch 不符）', async () => {
    const existing = createLoopsYamlText({
      id: 'base-loop', name: 'base-loop', kind: 'orchestrator', goal: GOAL_OK, cadence: '4h',
      risk: 'low', runner: 'claude-code', change_prefix: 'bl-', phases: ['open', 'explore'],
      human_gates: ['explore'], state: '.superpowers/loops/progress.md', design_doc: 'docs/loops/base-loop.md',
      status: 'paused', budget: { max_runs_per_day: 48, max_in_flight: 1, on_exceed: 'skip' }, kill_criteria: ['no-change-3'],
    }).text!
    let writes = 0
    const env: InitEnv = {
      readSnapshot: async () => ({ text: existing, epoch: 'e0' }), // 初读 epoch=e0
      writeGoverned: async (_root, expectedEpoch) => {
        // governance 锁内重读 epoch 已变（另一进程并发写）→ expected(e0) ≠ 锁内(e-concurrent) → CAS 拒，不落盘
        expect(expectedEpoch).toBe('e0')
        return { ok: false, error: 'epoch e0 → e-concurrent' }
      },
      addDraftMark: async () => { writes++ },
      isInteractive: () => false,
      makePrompter: () => ({ ask: async () => '', close: () => {} }),
    }
    const deps = makeDeps({ cwd: root })
    const code = await cmdInit(deps, ['--yes', '--id', 'race-loop', '--goal', GOAL_OK], env)
    expect(code).not.toBe(0)
    expect(writes).toBe(0) // 写回 CAS 拒 → 连草稿标记都没走到
    expect(deps.errLines.join('\n')).toMatch(/CAS/)
  })

  test('⑤ --prefix none → change_prefix: null（可读回裸 null）', async () => {
    const deps = makeDeps({ cwd: root })
    await cmdInit(deps, ['--yes', '--id', 'np-loop', '--goal', GOAL_OK, '--prefix', 'none'])
    expect(loadRegistry(root).data!.loops[0]!.change_prefix).toBeNull()
  })

  test('⑤b --prefix 显式值 → 原样落盘', async () => {
    const deps = makeDeps({ cwd: root })
    await cmdInit(deps, ['--yes', '--id', 'cp-loop', '--goal', GOAL_OK, '--prefix', 'custom-'])
    expect(loadRegistry(root).data!.loops[0]!.change_prefix).toBe('custom-')
  })

  test('⑥ 非 enum runner → 写盘前 fail-closed，绝不按 Claude fallback 落盘', async () => {
    const deps = makeDeps({ cwd: root })
    const code = await cmdInit(deps, ['--yes', '--id', 'r-loop', '--goal', GOAL_OK, '--runner', 'cron'])
    expect(code).toBe(1)
    expect(deps.errLines.join('\n')).toMatch(/runner.*claude-code.*codex/i)
    expect(loadRegistry(root).data).toBeNull()
  })

  test('⑥a 非法 runner 不能被后续重复 --runner 洗白，仍须写盘前 fail-closed', async () => {
    const deps = makeDeps({ cwd: root })
    const code = await cmdInit(deps, [
      '--yes', '--id', 'runner-shadow-loop', '--goal', GOAL_OK,
      '--runner', 'codxe', '--runner', 'codex',
    ])

    expect(code).toBe(1)
    expect(deps.errLines.join('\n')).toMatch(/runner.*codxe.*claude-code.*codex/i)
    expect(loadRegistry(root).data).toBeNull()
  })

  test('⑥b 未知 init flag → 非零且零写盘，不静默忽略拼写错误', async () => {
    const deps = makeDeps({ cwd: root })
    const code = await cmdInit(deps, ['--yes', '--id', 'r-loop', '--goal', GOAL_OK, '--runnre', 'codex'])
    expect(code).toBe(1)
    expect(deps.errLines.join('\n')).toMatch(/未知.*--runnre/i)
    expect(loadRegistry(root).data).toBeNull()
  })

  test.each([
    { label: '未知参数', tail: ['--runnre', 'codex'], error: /未知.*--runnre/i },
    { label: '参数缺值', tail: ['--runner'], error: /--runner.*缺少值/i },
    { label: '非法 runner', tail: ['--runner', 'codxe'], error: /runner.*codxe.*claude-code.*codex/i },
  ])('$label 在 snapshot/governance/draft 任一 I/O 前失败', async ({ tail, error }) => {
    const { env, state, drafts } = memInitEnv()
    let snapshotReads = 0
    let registryWrites = 0
    const readSnapshot = env.readSnapshot
    const writeGoverned = env.writeGoverned
    env.readSnapshot = async (repoRoot) => {
      snapshotReads++
      return readSnapshot(repoRoot)
    }
    env.writeGoverned = async (repoRoot, epoch, produce) => {
      registryWrites++
      return writeGoverned(repoRoot, epoch, produce)
    }
    const deps = makeDeps({ cwd: root })

    const code = await cmdInit(deps, [
      '--yes', '--id', 'prewrite-loop', '--goal', GOAL_OK, ...tail,
    ], env)

    expect(code).toBe(1)
    expect(deps.errLines.join('\n')).toMatch(error)
    expect({ snapshotReads, registryWrites, registry: state.text, drafts }).toEqual({
      snapshotReads: 0,
      registryWrites: 0,
      registry: null,
      drafts: [],
    })
  })

  test('H10 r6：显式 --runner claude-code 仍原样落盘（Codex-first 不阉割兼容路径）', async () => {
    const deps = makeDeps({ cwd: root })
    const code = await cmdInit(deps, [
      '--yes', '--id', 'claude-loop', '--goal', GOAL_OK, '--runner', 'claude-code',
    ])
    expect(code).toBe(0)
    expect(loadRegistry(root).data!.loops[0]!.runner).toBe('claude-code')
  })

  test('⑦ goal <10 字 → 拒（exit 非零、不落盘）', async () => {
    const deps = makeDeps({ cwd: root })
    const code = await cmdInit(deps, ['--yes', '--id', 'g-loop', '--goal', '太短'])
    expect(code).not.toBe(0)
    expect(loadRegistry(root).data).toBeNull() // 未建文件
  })

  test('⑦b 非法 id → 拒', async () => {
    const deps = makeDeps({ cwd: root })
    expect(await cmdInit(deps, ['--yes', '--id', 'Bad_ID', '--goal', GOAL_OK])).not.toBe(0)
  })

  test('缺必填（无 --id）非交互 → stderr 列明 + exit 1', async () => {
    const deps = makeDeps({ cwd: root })
    const code = await cmdInit(deps, ['--yes', '--goal', GOAL_OK])
    expect(code).toBe(1)
    expect(deps.errLines.join('\n')).toContain('--id')
  })

  test('⑧ 成功后 drafts.json 含该 id（真 fs 草稿标记）', async () => {
    const deps = makeDeps({ cwd: root })
    await cmdInit(deps, ['--yes', '--id', 'd-loop', '--goal', GOAL_OK])
    const marks = JSON.parse(await readFile(join(root, '.pipeline', 'loops.drafts.json'), 'utf8'))
    expect(marks.ids).toContain('d-loop')
  })

  test('⑧b 草稿标记写失败（注入 addDraftMark 抛）→ WARN + exit 0（loop 仍落盘）', async () => {
    const { env, state, drafts } = memInitEnv()
    env.addDraftMark = async () => { throw new Error('坏路径：EACCES') }
    const deps = makeDeps({ cwd: root })
    const code = await cmdInit(deps, ['--yes', '--id', 'w-loop', '--goal', GOAL_OK], env)
    expect(code).toBe(0) // 不因标记失败而失败
    expect(deps.errLines.join('\n')).toContain('WARN')
    expect(drafts).toHaveLength(0)
    expect(state.text).toContain('w-loop') // loop 已落盘（governance 写回）
  })

  test('⑨ --json 成功信封 {ok:true,id,path,draft:true} 单行', async () => {
    const deps = makeDeps({ cwd: root })
    await cmdInit(deps, ['--yes', '--id', 'j-loop', '--goal', GOAL_OK, '--json'])
    expect(deps.outLines).toHaveLength(1)
    const env = JSON.parse(deps.outLines[0]!)
    expect(env).toEqual({ ok: true, id: 'j-loop', path: join(root, '.pipeline', 'loops.yaml'), draft: true })
  })

  test('⑨b --json 错误信封 {ok:false,error} + exit 非零', async () => {
    const deps = makeDeps({ cwd: root })
    const code = await cmdInit(deps, ['--yes', '--id', 'bad', '--goal', '太短', '--json'])
    expect(code).not.toBe(0)
    const env = JSON.parse(deps.outLines[0]!)
    expect(env.ok).toBe(false)
    expect(typeof env.error).toBe('string')
  })

  test('并发首建：首建 expected=ABSENT 但此刻已被并发创建 → governance CAS 拒、如实报错', async () => {
    const { env } = memInitEnv()
    // readSnapshot 返回缺文件（走首建路径 expectedEpoch=ABSENT），但 writeGoverned 时文件已被并发首建
    // （锁内 epoch 已非 ABSENT）→ CAS 拒（等价旧 wx EEXIST 语义，改由 governance epoch-CAS 承担）。
    env.readSnapshot = async () => ({ text: '', epoch: ABSENT_REGISTRY_EPOCH })
    env.writeGoverned = async (_root, expectedEpoch) => {
      expect(expectedEpoch).toBe(ABSENT_REGISTRY_EPOCH)
      return { ok: false, error: '并发首建：loops.yaml 已存在（epoch 非 ABSENT）' }
    }
    const deps = makeDeps({ cwd: root })
    const code = await cmdInit(deps, ['--yes', '--id', 'race2', '--goal', GOAL_OK], env)
    expect(code).not.toBe(0)
    expect(deps.errLines.join('\n')).toMatch(/并发首建|已存在/)
  })

  test('dispatch：cmdLoops(init) 分派到 cmdInit（默认 REAL_INIT_ENV 走真 fs）', async () => {
    const deps = makeDeps({ cwd: root })
    const code = await cmdLoops(deps, 'init', ['--yes', '--id', 'disp-loop', '--goal', GOAL_OK])
    expect(code).toBe(0)
    expect(loadRegistry(root).data!.loops[0]!.id).toBe('disp-loop')
  })

  // Stage B 返工 #3#4（阻断 D）：init append 走 governance 锁 + epoch-CAS + atomic writer（真 fs）。
  test('⑪ 并发 append：两 init 同时追加不同 loop → governance 串行，最终 loops.yaml 合法（无半文件/坏 YAML/dup）', async () => {
    const d0 = makeDeps({ cwd: root })
    await cmdInit(d0, ['--yes', '--id', 'base-loop', '--goal', GOAL_OK]) // 基底
    const [ca, cb] = await Promise.all([
      cmdInit(makeDeps({ cwd: root }), ['--yes', '--id', 'aaa-loop', '--goal', GOAL_OK]),
      cmdInit(makeDeps({ cwd: root }), ['--yes', '--id', 'bbb-loop', '--goal', GOAL_OK]),
    ])
    // 最终文件恒合法（loadRegistry 窄解析+schema 全过——绝无并发交错的半文件/坏 YAML）。
    const { data, errors } = loadRegistry(root)
    expect(errors).toEqual([])
    expect(data).not.toBeNull()
    const ids = data!.loops.map((l) => l.id)
    expect(ids).toContain('base-loop')
    expect([ca, cb]).toContain(0) // 至少一个并发 append 落盘（另一个 CAS 拒 exit≠0 或亦串行落盘）
    if (ca === 0) expect(ids).toContain('aaa-loop')
    if (cb === 0) expect(ids).toContain('bbb-loop')
    expect(new Set(ids).size).toBe(ids.length) // 原子写：无重复/交错半条目
  })
})

describe('loops init —— 交互向导（脚本化 Prompter 注入，真 fs 落盘）', () => {
  let root: string
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'lite-loopwiz-')) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  test('⑩ 全回车收默认（id/goal 键入，其余回车）等价于 ①', async () => {
    // 问题顺序：id, goal, designDoc, prefix, kind, runner, gates, kill, risk, cadence, phases
    const answers = ['wiz-loop', GOAL_OK, '', '', '', '', '', '', '', '', '']
    const env: InitEnv = { ...REAL_INIT_ENV, isInteractive: () => true, makePrompter: () => scriptedPrompter(answers) }
    const deps = makeDeps({ cwd: root })
    const code = await cmdInit(deps, [], env) // 无 --yes → 交互
    expect(code).toBe(0)
    const l = loadRegistry(root).data!.loops[0]!
    expect(l.id).toBe('wiz-loop')
    expect(l.goal).toBe(GOAL_OK)
    expect(l.status).toBe('paused')
    expect(l.cadence).toBe('4h') // risk 默认 low → 4h
    expect(l.change_prefix).toBe('wl-') // derivePrefix('wiz-loop')
    expect(l.runner).toBe('codex')
    expect(l.phases).toEqual(['open', 'explore', 'spec', 'build', 'verify', 'ship', 'archive'])
  })

  test('⑩b 校验失败就地重问（首个 id 非法 → 重问收合法值）', async () => {
    const answers = ['Bad ID', 'good-loop', GOAL_OK, '', '', '', '', '', '', '', '']
    const env: InitEnv = { ...REAL_INIT_ENV, isInteractive: () => true, makePrompter: () => scriptedPrompter(answers) }
    const deps = makeDeps({ cwd: root })
    expect(await cmdInit(deps, [], env)).toBe(0)
    expect(loadRegistry(root).data!.loops[0]!.id).toBe('good-loop')
    expect(deps.errLines.join('\n')).toContain('id 非法') // 重问前打了错误提示
  })

  test('⑩c 交互态 risk=high 时 cadence 默认联动 1h（回车收派生默认）', async () => {
    const answers = ['hi-loop', GOAL_OK, '', '', '', '', '', '', 'high', '', '']
    const env: InitEnv = { ...REAL_INIT_ENV, isInteractive: () => true, makePrompter: () => scriptedPrompter(answers) }
    const deps = makeDeps({ cwd: root })
    expect(await cmdInit(deps, [], env)).toBe(0)
    const l = loadRegistry(root).data!.loops[0]!
    expect(l.risk).toBe('high')
    expect(l.cadence).toBe('1h') // risk=high 后 cadence 默认联动
  })
})

describe('derivePrefix —— change_prefix 推导（id 分段首字母 + -）', () => {
  test('restyle-loop → rl-', () => { expect(derivePrefix('restyle-loop')).toBe('rl-') })
  test('demo-loop → dl-', () => { expect(derivePrefix('demo-loop')).toBe('dl-') })
  test('单段 foo → f-', () => { expect(derivePrefix('foo')).toBe('f-') })
  test('多连字符 a--b（空段跳过）→ ab-', () => { expect(derivePrefix('a--b')).toBe('ab-') })
})
