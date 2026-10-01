import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BASELINE_V2_HISTORY_LIMIT, decodeTestBaselineV2, nextBaselineV2, readTestBaselineV2, writeTestBaselineV2,
  type TestBaselineV2,
} from './baseline-v2.js'
import {
  evaluateBenchmarkMetric, median, medianAbsoluteDeviation, percentile, regressionPct, summarizeSamples,
} from './benchmark.js'
import { isMachineProfileMode, machineProfile, memoryTierGiB } from './machine-profile.js'

describe('基准统计', () => {
  it('中位数、分位数、MAD', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 2, 3])).toBe(2.5)
    expect(Number.isNaN(median([]))).toBe(true)
    expect(percentile([1, 2, 3, 4, 5], 95)).toBeCloseTo(4.8)
    expect(percentile([7], 95)).toBe(7)
    expect(medianAbsoluteDeviation([1, 2, 3, 4, 100])).toBe(1)
    expect(summarizeSamples([10, 12, 11, Number.NaN])).toEqual({ median: 11, p95: 11.9, mad: 1, samples: 3 })
    expect(summarizeSamples([])).toBeUndefined()
    expect(regressionPct(110, 100, 'lower')).toBeCloseTo(10)
    expect(regressionPct(90, 100, 'higher')).toBeCloseTo(10)
    expect(regressionPct(1, 0, 'lower')).toBeNull()
  })

  it('判定：绝对阈值始终生效，退化按方向，无基线标记 baselineMissing，离散大标 noisy', () => {
    const spec = { name: 'p95_ms', unit: 'ms', better: 'lower' as const, max_regression_pct: 10, max: 250 }
    const steady = { median: 100, p95: 101, mad: 1, samples: 5 }
    expect(evaluateBenchmarkMetric(spec, steady, 100)).toMatchObject({ failed: false, baselineMissing: false, noisy: false, delta_pct: 0 })
    expect(evaluateBenchmarkMetric(spec, { ...steady, median: 115 }, 100)).toMatchObject({ failed: true, delta_pct: 15 })
    expect(evaluateBenchmarkMetric(spec, { ...steady, median: 300 }, undefined)).toMatchObject({ failed: true, baselineMissing: true })
    expect(evaluateBenchmarkMetric(spec, steady, undefined)).toMatchObject({ failed: false, baselineMissing: true })
    expect(evaluateBenchmarkMetric(spec, { ...steady, mad: 20 }, 100).noisy).toBe(true)
    expect(evaluateBenchmarkMetric({ name: 'rps', better: 'higher', min: 50 }, { ...steady, median: 40 }, undefined))
      .toMatchObject({ failed: true, baselineMissing: false })
    expect(evaluateBenchmarkMetric(spec, undefined, 100)).toMatchObject({ failed: true, summary: null })
  })
})

describe('机器画像', () => {
  const input = {
    platform: 'darwin', arch: 'arm64', cpuModel: 'Apple M3 Max', cores: 16, memoryBytes: 64 * 1024 ** 3,
    runtimeVersion: 'v22.10.0', env: { CI: undefined },
  }

  it('可读名 + 短哈希，确定性', () => {
    const profile = machineProfile(input)
    expect(profile.id).toMatch(/^darwin-arm64-m3max-node22-[a-f0-9]{8}$/)
    expect(profile.label).toBe('darwin-arm64-m3max-node22')
    expect(machineProfile(input)).toEqual(profile)
    expect(machineProfile({ ...input, runtimeVersion: 'v22.11.1' }).id).toBe(profile.id)
    expect(machineProfile({ ...input, env: { CI: 'true' } }).id).not.toBe(profile.id)
    expect(machineProfile({ ...input, cores: 8 }).id).not.toBe(profile.id)
    expect(machineProfile({ ...input, cpuModel: 'Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz' }).label).toBe('darwin-arm64-i79750h-node22')
  })

  it('细口径的 id 不随新增的粗口径改变（已提交的基线文件名依赖它）', () => {
    expect(machineProfile(input).id).toBe('darwin-arm64-m3max-node22-8510794d')
    expect(machineProfile(input, 'fine')).toEqual(machineProfile(input))
    expect(machineProfile(input).mode).toBe('fine')
  })

  describe('粗口径：OS + 架构 + 核数 + 运行时主版本', () => {
    const runner = {
      platform: 'linux', arch: 'x64', cpuModel: 'AMD EPYC 7763 64-Core Processor', cores: 4, memoryBytes: 16 * 1024 ** 3,
      runtimeVersion: 'v22.10.0', env: { CI: 'true' },
    }

    it('可读名带核数，id 合法且确定', () => {
      const profile = machineProfile(runner, 'coarse')
      expect(profile.label).toBe('linux-x64-4c-node22')
      expect(profile.id).toMatch(/^linux-x64-4c-node22-[a-f0-9]{8}$/)
      expect(profile.mode).toBe('coarse')
      expect(profile.facts).toEqual({ platform: 'linux', arch: 'x64', cores: 4, runtime: 'node22' })
      expect(machineProfile(runner, 'coarse')).toEqual(profile)
    })

    it('同规格运行器共用一个画像：CPU 型号、内存档位、运行时补丁版本都不参与', () => {
      const profile = machineProfile(runner, 'coarse')
      for (const other of [
        { ...runner, cpuModel: 'AMD EPYC 9V74 80-Core Processor' },
        { ...runner, cpuModel: 'Intel(R) Xeon(R) Platinum 8370C CPU @ 2.80GHz' },
        { ...runner, memoryBytes: 32 * 1024 ** 3 },
        { ...runner, runtimeVersion: 'v22.23.3' },
      ]) expect(machineProfile(other, 'coarse').id).toBe(profile.id)
      // 同样两台机器在细口径下是两个画像，这正是需要粗口径的原因。
      expect(machineProfile({ ...runner, cpuModel: 'AMD EPYC 9V74 80-Core Processor' }).id).not.toBe(machineProfile(runner).id)
    })

    it('OS、架构、核数、运行时主版本、profiles_env 的取值各自改变画像', () => {
      const profile = machineProfile(runner, 'coarse')
      for (const other of [
        { ...runner, platform: 'darwin' },
        { ...runner, arch: 'arm64' },
        { ...runner, cores: 2 },
        { ...runner, runtimeVersion: 'v24.1.0' },
        { ...runner, env: { CI: undefined } },
      ]) expect(machineProfile(other, 'coarse').id).not.toBe(profile.id)
    })

    it('粗细两种口径的 id 永远不同', () => {
      expect(machineProfile(runner, 'coarse').id).not.toBe(machineProfile(runner, 'fine').id)
    })
  })

  it('口径闭集', () => {
    expect(isMachineProfileMode('coarse')).toBe(true)
    expect(isMachineProfileMode('fine')).toBe(true)
    expect(isMachineProfileMode('medium')).toBe(false)
    expect(isMachineProfileMode(undefined)).toBe(false)
  })

  it('内存档位向下取 2 的幂', () => {
    expect(memoryTierGiB(15.5 * 1024 ** 3)).toBe(8)
    expect(memoryTierGiB(16 * 1024 ** 3)).toBe(16)
    expect(memoryTierGiB(1)).toBe(1)
  })
})

describe('基线 v2', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'tenon-baseline-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  const actor = { id: 'tester@tenon.test', name: 'Tester', trust: 'declared' as const }
  const base: Omit<TestBaselineV2, 'schema' | 'history'> = {
    suite: 'api-bench',
    profile: 'darwin-arm64-m3max-node22-1a2b3c4d',
    profile_label: 'darwin-arm64-m3max-node22',
    metrics: { p95_ms: { median: 100, p95: 110, mad: 2, samples: 5, better: 'lower', unit: 'ms' } },
    source: { change: 'demo', run_id: '20260929T000000Z-abcdef', commit: null },
    actor,
    updated_at: '2026-09-29T00:00:00.000Z',
  }

  it('写入、读回、历史新的在前并截断', async () => {
    const path = join(dir, 'api-bench', 'p.json')
    let baseline = nextBaselineV2(undefined, base)
    expect(baseline.history).toEqual([])
    for (let index = 0; index < BASELINE_V2_HISTORY_LIMIT + 3; index++) {
      baseline = nextBaselineV2(baseline, { ...base, updated_at: `t${index}` })
    }
    expect(baseline.history).toHaveLength(BASELINE_V2_HISTORY_LIMIT)
    expect(baseline.history[0]?.updated_at).toBe(`t${BASELINE_V2_HISTORY_LIMIT + 1}`)
    await writeTestBaselineV2(path, baseline)
    expect(await readTestBaselineV2(path)).toEqual({ state: 'ok', baseline })
    expect(await readTestBaselineV2(join(dir, 'missing.json'))).toEqual({ state: 'missing' })
    await writeFile(path, '{', 'utf8')
    expect(await readTestBaselineV2(path)).toEqual({ state: 'corrupt' })
  })

  it('解码闭集', () => {
    const baseline = nextBaselineV2(undefined, base)
    expect(decodeTestBaselineV2(baseline)).toEqual(baseline)
    expect(decodeTestBaselineV2({ ...baseline, extra: 1 })).toBeUndefined()
    expect(decodeTestBaselineV2({ ...baseline, suite: 'Bad' })).toBeUndefined()
    expect(decodeTestBaselineV2({ ...baseline, metrics: { x: { median: 1 } } })).toBeUndefined()
    expect(decodeTestBaselineV2({ ...baseline, metrics: null })).toBeUndefined()
    expect(decodeTestBaselineV2({ ...baseline, schema: 'tenon-test-baseline-v1' })).toBeUndefined()
    expect(decodeTestBaselineV2({ ...baseline, history: Array.from({ length: 21 }, () => baseline.history[0]) })).toBeUndefined()
  })

  it('形状非法拒绝写入', async () => {
    const bad = { ...nextBaselineV2(undefined, base), profile: 'Bad Profile' }
    await expect(writeTestBaselineV2(join(dir, 'x.json'), bad)).rejects.toThrow(/形状非法/)
  })
})
