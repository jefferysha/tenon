/**
 * 覆盖率门槛：门槛写在项目测试目录的档位定义（levels）里，不在工作流里。
 * `suiteThresholds` 从三档的生效定义里收集「所属测试类被该档要求或碰到才跑、且套件声明了覆盖率报告」的档位，
 * 取每项指标的最高值；来源档位放 Tooltip。
 */
import { isTestKind, testClassOf } from '@tenon/kernel/test-system/vocabulary'
import type { CatalogLevel, CatalogSuite, LevelName, TestCoverage } from '../api/testSystemTypes'

export type ThresholdMetric = 'lines' | 'branches' | 'functions' | 'statements' | 'changed_lines'
export const THRESHOLD_METRICS: readonly ThresholdMetric[] = ['lines', 'branches', 'functions', 'statements', 'changed_lines']

type Metrics = Readonly<Partial<Record<ThresholdMetric, number>>>

export interface SuiteThresholds {
  readonly highest: Metrics
  /** 每个来源档位声明的门槛（档位名 → 指标值），按档位顺序。 */
  readonly sources: ReadonlyArray<{ readonly level: LevelName; readonly values: Metrics }>
}

/** 线上字段（camelCase）→ 指标名（snake_case，与 i18n 键一致）。 */
const WIRE: Readonly<Record<ThresholdMetric, keyof TestCoverage>> = {
  lines: 'lines', branches: 'branches', functions: 'functions', statements: 'statements', changed_lines: 'changedLines',
}

/** 一个档位声明的覆盖率门槛，按固定指标顺序；没有声明时是空对象。 */
export function levelCoverage(level: Pick<CatalogLevel, 'coverage'>): Metrics {
  const values: Partial<Record<ThresholdMetric, number>> = {}
  for (const metric of THRESHOLD_METRICS) {
    const value = level.coverage?.[WIRE[metric]]
    if (value !== undefined) values[metric] = value
  }
  return values
}

/** 与 kernel 求值同口径：声明了覆盖率报告，或种类就是 coverage，覆盖率门槛才会作用到这个套件。 */
function checksCoverage(suite: Pick<CatalogSuite, 'kind' | 'coverage'>): boolean {
  return suite.coverage !== undefined || suite.kind === 'coverage'
}

export function suiteThresholds(levels: readonly CatalogLevel[] | null, suite: Pick<CatalogSuite, 'kind' | 'coverage'>): SuiteThresholds | null {
  if (levels === null || !checksCoverage(suite) || !isTestKind(suite.kind)) return null
  const suiteClass = testClassOf(suite.kind)
  const highest: Partial<Record<ThresholdMetric, number>> = {}
  const sources: Array<SuiteThresholds['sources'][number]> = []
  for (const level of levels) {
    if (!level.required.includes(suiteClass) && !level.touched.includes(suiteClass)) continue
    const values = levelCoverage(level)
    const metrics = THRESHOLD_METRICS.filter((metric) => values[metric] !== undefined)
    if (metrics.length === 0) continue
    for (const metric of metrics) highest[metric] = Math.max(highest[metric] ?? 0, values[metric] ?? 0)
    sources.push({ level: level.name, values })
  }
  return sources.length === 0 ? null : { highest, sources }
}
