/** 线性插值的分位数（fraction 0..1）；空数组按 0 处理。性能类用例取中位数做预算、p95 只写进报告。 */
export function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  const rank = fraction * (sorted.length - 1)
  const lower = Math.floor(rank)
  const upper = Math.ceil(rank)
  return (sorted[lower] ?? 0) + ((sorted[upper] ?? 0) - (sorted[lower] ?? 0)) * (rank - lower)
}
