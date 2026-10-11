/**
 * 改动风险分类（纯函数）：一组路径改动 + 一组指标阈值 → 指标、是否超限、超限理由。
 *
 * 一份规则两处用：实现后的改动风险探针（`tenon test run` 判定步骤测试的 `pass.metrics`）与实现前的
 * `tenon assess`（按预计要改的文件评估）。两处的指标都来自 `assessDiffRisk`，上下限的比较都走
 * `thresholdBreaches`，所以事前、事后对同一组改动的结论一致。阈值本身不在这里：它们是工作流里
 * `diff-risk` 测试的 `pass.metrics`，改工作流 YAML 即可调整。
 */
import type { ProtectedChange } from '../test-system/protected-files.js'
import type { TrackBranch } from '../workflow/resolve-track.js'
import type { PathChange } from './changed-files.js'
import { assessDiffRisk, type DiffRiskMetrics } from './diff-risk.js'

/** 改动风险探针的测试方向（templates/test-directions/diff-risk.yaml）：工作流里声明它的步骤测试，其 `pass.metrics` 就是阈值。 */
export const DIFF_RISK_DIRECTION = 'diff-risk'

/** 绝对上下限（工作流 `pass.metrics` 里 `max` / `min`；`max_regression_pct` 等基线相关的字段不在这里）。 */
export interface ThresholdBound {
  readonly max?: number
  readonly min?: number
}

/** 一条指标的绝对上下限。 */
export interface MetricThreshold extends ThresholdBound {
  readonly name: string
}

/** 越过了哪一侧、界限是多少。 */
export interface ThresholdBreach {
  readonly kind: 'max' | 'min'
  readonly limit: number
}

/** 指标值越过上下限的情况：等于界限不算越过；两侧都越过时两条都报，上限在前。 */
export function thresholdBreaches(value: number, bound: ThresholdBound): readonly ThresholdBreach[] {
  const breaches: ThresholdBreach[] = []
  if (bound.max !== undefined && value > bound.max) breaches.push({ kind: 'max', limit: bound.max })
  if (bound.min !== undefined && value < bound.min) breaches.push({ kind: 'min', limit: bound.min })
  return breaches
}

export interface ChangeRiskVerdict {
  readonly metrics: DiffRiskMetrics
  readonly exceeded: boolean
  /** 一条超限一行，如 `auth_files 1 > 0`；顺序同阈值顺序。 */
  readonly reasons: readonly string[]
}

function breachReason(name: string, value: number, breach: ThresholdBreach): string {
  return `${name} ${value} ${breach.kind === 'max' ? '>' : '<'} ${breach.limit}`
}

/**
 * 按阈值给一组改动定级。阈值指向不存在的指标时失败关闭（算超限，理由是 `<name> 缺失`）：
 * 与探针一致——声明了标准的指标读不到就不通过，绝不当作没超限。
 */
export function classifyChange(
  changes: readonly PathChange[],
  protectedTestFiles: number,
  thresholds: readonly MetricThreshold[],
): ChangeRiskVerdict {
  const metrics = assessDiffRisk(changes, protectedTestFiles)
  const values: Readonly<Record<string, number>> = { ...metrics }
  const reasons: string[] = []
  for (const threshold of thresholds) {
    const value = Object.hasOwn(values, threshold.name) ? values[threshold.name] : undefined
    if (value === undefined) {
      reasons.push(`${threshold.name} 缺失`)
      continue
    }
    for (const breach of thresholdBreaches(value, threshold)) reasons.push(breachReason(threshold.name, value, breach))
  }
  return { metrics, exceeded: reasons.length > 0, reasons }
}

/**
 * 计入 `protected_test_files` 指标的受保护测试配置改动个数。项目第一次建测试目录（`tenon init` 自动识别写出）
 * 不是改动既有的信任根：它仍会列进评审请求等用户确认，但不该让每个新项目的第一个任务都升级；
 * 既有目录的修改 / 删除，基线、已知失败清单、项目工作流的任何改动照常计数。探针与评估共用这一条口径。
 */
export function protectedTestFileCount(items: readonly Pick<ProtectedChange, 'kind' | 'status'>[]): number {
  return items.filter((item) => !(item.kind === 'catalog' && item.status === 'added')).length
}

/**
 * 分支的改动风险阈值：步骤顺序里第一条 `diff-risk` 方向测试的 `pass.metrics`（只取绝对上下限，基线退化不适用于事前评估）。
 * 分支没有这条测试、或它没声明任何指标标准时返回 undefined——调用方据此报错，绝不猜一组阈值。
 * 入参只读 `steps`，所以分支（`resolveTrack`）与计划里选中的 pipeline 都能传。
 */
export function riskThresholdsFor(branch: Pick<TrackBranch, 'steps'>): readonly MetricThreshold[] | undefined {
  for (const step of branch.steps) {
    const found = step.tests?.find((test) => test.direction === DIFF_RISK_DIRECTION)
    if (found === undefined) continue
    const thresholds = found.pass.metrics.map((criterion): MetricThreshold => ({
      name: criterion.name,
      ...(criterion.max === undefined ? {} : { max: criterion.max }),
      ...(criterion.min === undefined ? {} : { min: criterion.min }),
    }))
    return thresholds.length === 0 ? undefined : thresholds
  }
  return undefined
}
