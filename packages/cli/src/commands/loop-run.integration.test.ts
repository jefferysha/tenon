/**
 * H14 loop-run 生产默认 preflight 集成钉子。
 *
 * 零 Docker、零 executor mock：真临时项目 + 真 StateStore + 真 createAutomation().scanReady() +
 * 真 createLoopLedgerStore().read()。两条用例都在调用共享 executor 前由 preflight fail-closed，
 * 因而能独立证明生产默认不是测试注入专属，也不会为了验证 preflight 启动容器。
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createStateStore } from '@tenon/kernel'
import { makeHarness, realDeps, rm } from '../integration-harness.js'
import { cmdLoopRun } from './loop-run.js'
import { REAL_LOOPS_FS } from './loops.js'

const TEST_CREATOR = { id: 'tester@tenon.test', name: 'Tester', trust: 'declared' } as const

const LOOPS_YAML = `version: 1
loops:
  - id: loop-be
    name: Backend Loop
    kind: orchestrator
    goal: continuously deliver verified backend improvements
    cadence: 1h
    risk: medium
    runner: codex
    change_prefix: loop-be-
    skill_bundle_id: _all
    phases:
      - build
      - verify
    human_gates:
      - verify
    state: .superpowers/loops/progress.md
    design_doc: docs/loops/loop-be.md
    status: active
    budget:
      max_runs_per_day: 24
      max_in_flight: 1
      on_exceed: skip
    kill_criteria:
      - no-change-3
    autonomy_level: L1
`

let cwd: string

async function seedReady(name: string): Promise<void> {
  const store = createStateStore()
  const dir = await store.init({
    repoRoot: cwd,
    name,
    track: 'backend',
    reviewSeed: 'pending',
    creator: TEST_CREATOR, preset: 'full',
    clock: () => '2026-07-19T00:00:00Z',
  })
  await store.setMany(dir, {
    phase: 'build',
    automation: 'queued',
    automation_queued_at: '2026-07-19T00:00:00Z',
  })
}

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'loop-run-default-runtime-'))
  await mkdir(join(cwd, '.pipeline'), { recursive: true })
  await writeFile(join(cwd, '.pipeline', 'loops.yaml'), LOOPS_YAML, 'utf8')
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

describe('loop run 生产默认 runtime', () => {
  test('真实 Commander 路径保留 flags：dry-run JSON 收到 --level/--commit', async () => {
    const harness = makeHarness(cwd)

    const code = await harness.run(['loops', 'run', 'loop-be', '--dry-run', '--level', 'L3', '--commit', '--json'])

    expect(code).toBe(0)
    const payload = JSON.parse(harness.out.join('\n'))
    expect(payload.commit_ignored).toBe(true)
    expect(payload.previews[0].level).toBe('L3')
    expect(payload.previews[0].level_source).toBe('flag')
  })

  test('真实 Commander 路径未知 flag 不吞掉 → strict parser exit 1', async () => {
    const harness = makeHarness(cwd)

    const code = await harness.run(['loops', 'run', 'loop-be', '--dry-run', '--typo'])

    expect(code).toBe(1)
    expect(harness.err.join('\n')).toMatch(/未知 flag.*--typo/)
    expect(harness.out).toEqual([])
  })

  test('真 createAutomation.scanReady 读到 orphan ready → 自然归属 fail-closed，零 executor', async () => {
    await seedReady('orphan-ready')
    const out: string[] = []
    const err: string[] = []

    const code = await cmdLoopRun(realDeps(cwd, out, err), ['loop-be'], REAL_LOOPS_FS)

    expect(code).toBe(1)
    expect(err.join('\n')).toMatch(/归属不可判定|no-match/)
    expect(out).toEqual([])
  })

  test('真 createLoopLedgerStore.read 隔离坏行 → selector 前 fail-closed，ready 状态保持 queued', async () => {
    await seedReady('loop-be-ready')
    await mkdir(join(cwd, '.pipeline', 'loops'), { recursive: true })
    await writeFile(join(cwd, '.pipeline', 'loops', 'ledger.jsonl'), '{broken-json\n', 'utf8')
    const out: string[] = []
    const err: string[] = []
    const deps = realDeps(cwd, out, err)

    const code = await cmdLoopRun(deps, ['loop-be'], REAL_LOOPS_FS)

    expect(code).toBe(1)
    expect(err.join('\n')).toMatch(/ledger.*坏行|坏行.*ledger/i)
    expect(await deps.store.get(join(cwd, 'openspec', 'changes', 'loop-be-ready'), 'automation')).toBe('queued')
    expect(out).toEqual([])
  })
})
