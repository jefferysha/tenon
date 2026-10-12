import { describe, expect, test } from 'vitest'
import { compileDefaultWorkflow } from '../workflow/compile.js'
import { resolveTrack } from '../workflow/resolve-track.js'
import { compiledDefault, defaultWithLiteBranch } from '../workflow/test-support.js'
import type { StepTestDef, TestMetricCriterion } from '../workflow/types.js'
import type { PathChange } from './changed-files.js'
import {
  classifyChange, protectedTestFileCount, riskThresholdsFor, thresholdBreaches, type MetricThreshold,
} from './change-risk.js'
import { assessDiffRisk } from './diff-risk.js'

const change = (path: string, status: PathChange['status'] = 'modified'): PathChange => ({ path, status })

/** lite 改动风险探针的阈值（templates/workflows/default.yaml 里 lite 分支实现步的 diff-risk 测试）。 */
const PROBE: readonly MetricThreshold[] = [
  { name: 'files_changed', max: 8 },
  { name: 'contract_files', max: 0 },
  { name: 'auth_files', max: 0 },
  { name: 'dependency_files', max: 0 },
  { name: 'migration_files', max: 0 },
  { name: 'deleted_tests', max: 0 },
  { name: 'protected_test_files', max: 0 },
]

describe('thresholdBreaches', () => {
  test('等于上下限不算超限，越过才算', () => {
    expect(thresholdBreaches(8, { max: 8 })).toEqual([])
    expect(thresholdBreaches(9, { max: 8 })).toEqual([{ kind: 'max', limit: 8 }])
    expect(thresholdBreaches(5, { min: 5 })).toEqual([])
    expect(thresholdBreaches(4, { min: 5 })).toEqual([{ kind: 'min', limit: 5 }])
  })

  test('没有声明上下限就没有超限；上下限都越过时两条都报', () => {
    expect(thresholdBreaches(1000, {})).toEqual([])
    expect(thresholdBreaches(5, { max: 1, min: 9 })).toEqual([
      { kind: 'max', limit: 1 },
      { kind: 'min', limit: 9 },
    ])
  })

  test('上限 0 与负数边界', () => {
    expect(thresholdBreaches(0, { max: 0 })).toEqual([])
    expect(thresholdBreaches(1, { max: 0 })).toEqual([{ kind: 'max', limit: 0 }])
    expect(thresholdBreaches(-1, { min: 0 })).toEqual([{ kind: 'min', limit: 0 }])
  })
})

describe('classifyChange', () => {
  test('与探针对同一组改动结论一致', () => {
    const changes = [change('packages/server/src/auth/login.ts')]
    const verdict = classifyChange(changes, 0, [{ name: 'files_changed', max: 8 }, { name: 'auth_files', max: 0 }])
    expect(verdict.exceeded).toBe(true)
    expect(verdict.reasons).toEqual(['auth_files 1 > 0'])
    expect(verdict.metrics).toEqual(assessDiffRisk(changes, 0))
  })

  test('3 个普通文件不超限，reasons 为空', () => {
    const changes = [change('src/add.js'), change('src/calc.js'), change('test/add.test.js')]
    const verdict = classifyChange(changes, 0, PROBE)
    expect(verdict).toEqual({ metrics: assessDiffRisk(changes, 0), exceeded: false, reasons: [] })
  })

  test('文档与 Tenon 状态不计入文件数', () => {
    const changes = [change('docs/notes.md'), change('openspec/changes/c/.pipeline.yaml'), change('README.md')]
    const verdict = classifyChange(changes, 0, PROBE)
    expect(verdict.metrics.files_changed).toBe(0)
    expect(verdict.exceeded).toBe(false)
  })

  test('文件数恰为 8 不超限，9 超限', () => {
    const files = (count: number) => Array.from({ length: count }, (_, index) => change(`src/f${index}.js`))
    expect(classifyChange(files(8), 0, PROBE).exceeded).toBe(false)
    const nine = classifyChange(files(9), 0, PROBE)
    expect(nine.exceeded).toBe(true)
    expect(nine.reasons).toEqual(['files_changed 9 > 8'])
  })

  test('多项超限时按阈值顺序一次列出全部', () => {
    const changes = [change('package.json'), change('src/a.test.ts', 'deleted')]
    const verdict = classifyChange(changes, 2, PROBE)
    expect(verdict.reasons).toEqual(['dependency_files 1 > 0', 'deleted_tests 1 > 0', 'protected_test_files 2 > 0'])
  })

  test('受保护测试配置的改动个数来自入参', () => {
    const verdict = classifyChange([], 1, PROBE)
    expect(verdict.exceeded).toBe(true)
    expect(verdict.reasons).toEqual(['protected_test_files 1 > 0'])
  })

  test('下限：低于 min 的写法 `<`', () => {
    const verdict = classifyChange([change('src/a.js')], 0, [{ name: 'files_changed', min: 2 }])
    expect(verdict.exceeded).toBe(true)
    expect(verdict.reasons).toEqual(['files_changed 1 < 2'])
  })

  test('阈值指向不存在的指标：失败关闭，不当作没超限', () => {
    const verdict = classifyChange([change('src/a.js')], 0, [{ name: 'no_such_metric', max: 0 }])
    expect(verdict.exceeded).toBe(true)
    expect(verdict.reasons).toEqual(['no_such_metric 缺失'])
  })

  test('原型链上的名字不是指标', () => {
    const verdict = classifyChange([], 0, [{ name: 'toString', max: 0 }, { name: '__proto__', max: 0 }])
    expect(verdict.exceeded).toBe(true)
    expect(verdict.reasons).toEqual(['toString 缺失', '__proto__ 缺失'])
  })

  test('没有阈值时只给指标，不超限', () => {
    const verdict = classifyChange([change('package.json')], 0, [])
    expect(verdict.exceeded).toBe(false)
    expect(verdict.reasons).toEqual([])
    expect(verdict.metrics.dependency_files).toBe(1)
  })
})

const probe = (direction: string, metrics: readonly TestMetricCriterion[], id = 'probe'): StepTestDef => ({
  id, direction, command: 'tenon test diff-risk --json', pass: { metrics },
})

/** 现 default 加五步 lite 分支；`byStep` 指名的步骤带上这些测试，编译后取出 lite 分支。 */
function liteBranchWithTests(byStep: Readonly<Record<string, readonly StepTestDef[]>>) {
  const def = defaultWithLiteBranch()
  const lite = def.tracks?.lite
  if (lite === undefined) throw new Error('夹具缺 lite 分支')
  const steps = lite.steps.map((step) => (byStep[step.id] === undefined ? step : { ...step, tests: byStep[step.id] }))
  return resolveTrack(compileDefaultWorkflow({ ...def, tracks: { ...def.tracks, lite: { ...lite, steps } } }), 'lite')
}

describe('riskThresholdsFor', () => {
  test('取分支里 diff-risk 测试的 pass.metrics，只留名字与上下限', () => {
    const branch = liteBranchWithTests({
      build: [probe('diff-risk', [
        { name: 'files_changed', max: 8, max_regression_pct: 10, better: 'higher' },
        { name: 'auth_files', max: 0 },
        { name: 'files_floor', min: 1 },
      ])],
    })
    expect(riskThresholdsFor(branch)).toStrictEqual([
      { name: 'files_changed', max: 8 },
      { name: 'auth_files', max: 0 },
      { name: 'files_floor', min: 1 },
    ])
  })

  test('取出的阈值直接交给 classifyChange：事前评估与探针同一份规则', () => {
    const branch = liteBranchWithTests({ build: [probe('diff-risk', [{ name: 'files_changed', max: 2 }, { name: 'auth_files', max: 0 }])] })
    const thresholds = riskThresholdsFor(branch) ?? []
    const verdict = classifyChange([change('a.ts'), change('b.ts'), change('src/auth/login.ts')], 0, thresholds)
    expect(verdict.reasons).toEqual(['files_changed 3 > 2', 'auth_files 1 > 0'])
  })

  test('分支没有 diff-risk 测试时没有阈值', () => {
    expect(riskThresholdsFor(resolveTrack(compiledDefault(), 'backend'))).toBeUndefined()
    expect(riskThresholdsFor(liteBranchWithTests({}))).toBeUndefined()
  })

  test('别的方向的测试不是改动风险探针', () => {
    const branch = liteBranchWithTests({ build: [probe('code-size', [{ name: 'files_changed', max: 8 }])] })
    expect(riskThresholdsFor(branch)).toBeUndefined()
  })

  test('diff-risk 测试没有声明任何指标标准：没有阈值，不当作「全部放行」', () => {
    expect(riskThresholdsFor(liteBranchWithTests({ build: [probe('diff-risk', [])] }))).toBeUndefined()
  })

  test('多处声明时取步骤顺序里第一条 diff-risk 测试', () => {
    const branch = liteBranchWithTests({
      build: [probe('code-size', [{ name: 'files_changed', max: 1 }], 'size'), probe('diff-risk', [{ name: 'files_changed', max: 8 }], 'first')],
      verify: [probe('diff-risk', [{ name: 'files_changed', max: 3 }], 'second')],
    })
    expect(riskThresholdsFor(branch)).toStrictEqual([{ name: 'files_changed', max: 8 }])
  })
})

describe('protectedTestFileCount', () => {
  test('项目第一次建测试目录不计入：它仍会列进评审请求，但不让每个新项目的第一个任务都升级', () => {
    expect(protectedTestFileCount([{ kind: 'catalog', status: 'added' }])).toBe(0)
  })

  test('目录的修改 / 删除、基线、已知失败清单、项目工作流的任何改动都计数', () => {
    expect(protectedTestFileCount([
      { kind: 'catalog', status: 'modified' },
      { kind: 'catalog', status: 'deleted' },
      { kind: 'baseline', status: 'added' },
      { kind: 'known-failures', status: 'modified' },
      { kind: 'workflow', status: 'deleted' },
    ])).toBe(5)
  })

  test('没有受保护改动就是 0', () => {
    expect(protectedTestFileCount([])).toBe(0)
  })
})
