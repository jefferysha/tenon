/**
 * 套件的覆盖率门槛：门槛写在工作流各阶段的测试策略里，不在目录里。这里从工作流定义（通用分支与各轨道分支）
 * 收集「要求过这个种类且声明了覆盖率」的阶段，取每项指标的最高值；来源阶段按名称给出，放 Tooltip。
 */
import type { WbWorkflowDef } from '../api/governanceTypes'

export type ThresholdMetric = 'lines' | 'branches' | 'changed_lines'
export const THRESHOLD_METRICS: readonly ThresholdMetric[] = ['lines', 'branches', 'changed_lines']

export interface SuiteThresholds {
  readonly highest: Readonly<Partial<Record<ThresholdMetric, number>>>
  /** 每个来源阶段声明的门槛（阶段名 → 指标值），保序去重。 */
  readonly sources: ReadonlyArray<{ readonly stage: string; readonly values: Readonly<Partial<Record<ThresholdMetric, number>>> }>
}

export function suiteThresholds(def: WbWorkflowDef | null, kind: string): SuiteThresholds | null {
  if (def === null) return null
  const steps = [...def.steps, ...Object.values(def.tracks ?? {}).flatMap((branch) => branch.steps)]
  const highest: Partial<Record<ThresholdMetric, number>> = {}
  const sources: Array<SuiteThresholds['sources'][number]> = []
  for (const step of steps) {
    const policy = step.test_policy
    if (policy?.coverage === undefined) continue
    const demanded = [...(policy.kinds ?? []), ...(policy.run ?? []), ...(policy.run_if_registered ?? [])]
    if (!demanded.includes(kind)) continue
    const values: Partial<Record<ThresholdMetric, number>> = {}
    for (const metric of THRESHOLD_METRICS) {
      const value = policy.coverage[metric]
      if (value === undefined) continue
      values[metric] = value
      highest[metric] = Math.max(highest[metric] ?? 0, value)
    }
    if (Object.keys(values).length === 0) continue
    const duplicate = sources.some((source) => source.stage === step.label && THRESHOLD_METRICS.every((metric) => source.values[metric] === values[metric]))
    if (!duplicate) sources.push({ stage: step.label, values })
  }
  return sources.length === 0 ? null : { highest, sources }
}
