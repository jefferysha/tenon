import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { withLock } from '../state/lock.js'
import { formatAuditDetail, testAuditRaw } from './audit.js'
import { nextBaselineV2, writeTestBaselineV2 } from './baseline-v2.js'
import { baselineV2Path } from './paths.js'
import { updateTestPlan, writeTestPlan, writeTestPlanUnderLock } from './plan-ledger.js'
import { emptyTestPlan } from './plan.js'

const ACTOR = { id: 'tester@tenon.test', name: 'Tester', trust: 'declared' as const }
let root: string
let changeDir: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tenon-test-audit-'))
  changeDir = join(root, 'openspec', 'changes', 'demo')
  await mkdir(changeDir, { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function historyRows(): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(join(changeDir, '.pipeline-history.jsonl'), 'utf8').catch(() => '')
  return text.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('审计行格式', () => {
  it('key=value 一行，空值省略，值里的空白折成下划线', () => {
    expect(formatAuditDetail({ op: 'waive', subject: undefined, note: 'a b\nc', empty: '' })).toBe('op=waive note=a_b_c')
    expect(testAuditRaw('plan-write', { plan: 'sha256:x' })).toBe('test:plan-write plan=sha256:x')
    expect(testAuditRaw('waiver-approve', {})).toBe('test:waiver-approve')
  })
})

describe('计划写入的审计', () => {
  it('真的变了才留一行，带子命令与新摘要，actor 是声明的操作者', async () => {
    const plan = { ...emptyTestPlan('demo'), suites: [{ suite: 'unit', scope: 'full' as const }] }
    const first = await writeTestPlan(changeDir, plan, { actor: ACTOR, recordedAt: '2026-09-29T10:00:00.000Z', op: 'register' })
    expect(first).toMatchObject({ changed: true, audit: 'recorded' })
    const again = await writeTestPlan(changeDir, plan, { actor: ACTOR, recordedAt: '2026-09-29T10:01:00.000Z', op: 'register' })
    expect(again).toMatchObject({ digest: first.digest, changed: false, audit: 'unchanged' })
    expect(await historyRows()).toEqual([{
      ts: '2026-09-29T10:00:00.000Z', kind: 'tool', raw: `test:plan-write op=register plan=${first.digest}`, actor: ACTOR,
    }])
  })

  it('updateTestPlan 与 writeTestPlan 同一条写入路径：变了留一行，没变（幂等）或被拒不留', async () => {
    const meta = { actor: ACTOR, recordedAt: '2026-09-29T10:00:00.000Z', op: 'register' }
    const plan = { ...emptyTestPlan('demo'), suites: [{ suite: 'unit', scope: 'full' as const }] }
    const first = await updateTestPlan(changeDir, 'demo', meta, () => ({ plan }))
    expect(first).toMatchObject({ changed: true, audit: 'recorded' })
    const digest = 'digest' in first ? first.digest : ''
    expect(await updateTestPlan(changeDir, 'demo', meta, () => ({ plan }))).toMatchObject({ digest, changed: false, audit: 'unchanged' })
    expect(await updateTestPlan(changeDir, 'demo', meta, () => ({ reject: '不行' }))).toEqual({ rejected: '不行' })
    expect(await historyRows()).toEqual([{
      ts: '2026-09-29T10:00:00.000Z', kind: 'tool', raw: `test:plan-write op=register plan=${digest}`, actor: ACTOR,
    }])
  })

  it('持锁写入口不留行（批准豁免的调用方自己记）', async () => {
    await withLock(changeDir, () => writeTestPlanUnderLock(changeDir, emptyTestPlan('demo'), { actor: ACTOR, recordedAt: 't' }))
    expect(await historyRows()).toEqual([])
  })

  it('历史追加失败不回滚计划：返回 failed', async () => {
    // 历史文件的位置被目录占了，追加必然失败。
    await mkdir(join(changeDir, '.pipeline-history.jsonl'))
    const result = await writeTestPlan(changeDir, emptyTestPlan('demo'), { actor: ACTOR, recordedAt: 't' })
    expect(result).toMatchObject({ changed: true, audit: 'failed' })
  })
})

describe('基线更新的审计', () => {
  const baseline = nextBaselineV2(undefined, {
    suite: 'api-bench', profile: 'darwin-arm64-node22-1a2b3c4d', profile_label: 'darwin-arm64-node22',
    metrics: { p95_ms: { median: 12, p95: 13, mad: 0.1, samples: 5, better: 'lower', unit: 'ms' } },
    source: { change: 'demo', run_id: '20260929T100000Z-abc123', commit: 'a'.repeat(40) },
    actor: ACTOR, updated_at: '2026-09-29T10:00:00.000Z',
  })

  it('基线落盘后在来源 change 的历史里留一行', async () => {
    const path = baselineV2Path(root, baseline.suite, baseline.profile)
    expect(await writeTestBaselineV2(path, baseline)).toBe('recorded')
    expect(await historyRows()).toEqual([{
      ts: baseline.updated_at,
      kind: 'tool',
      raw: `test:baseline-update suite=api-bench profile=${baseline.profile} run=20260929T100000Z-abc123 commit=${'a'.repeat(40)}`,
      actor: ACTOR,
    }])
  })

  it('来源 change 不在了、或路径不是项目基线目录：照样落盘，审计 skipped', async () => {
    const gone = { ...baseline, source: { ...baseline.source, change: 'archived-away' } }
    expect(await writeTestBaselineV2(baselineV2Path(root, baseline.suite, baseline.profile), gone)).toBe('skipped')
    expect(await writeTestBaselineV2(join(root, 'elsewhere', 'b.json'), baseline)).toBe('skipped')
    const unsafe = { ...baseline, source: { ...baseline.source, change: '../escape' } }
    expect(await writeTestBaselineV2(baselineV2Path(root, baseline.suite, baseline.profile), unsafe)).toBe('skipped')
    expect(await historyRows()).toEqual([])
  })
})
