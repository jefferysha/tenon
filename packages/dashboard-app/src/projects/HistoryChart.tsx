const WIDTH = 120
const HEIGHT = 28
const PAD = 3

/** 折线各点的 SVG 坐标：横向等距（最旧 → 最新），纵向按最小到最大线性映射（全相等时居中）。 */
export function chartPoints(values: readonly number[]): Array<{ readonly x: number; readonly y: number }> {
  if (values.length === 0) return []
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min
  const step = values.length === 1 ? 0 : (WIDTH - PAD * 2) / (values.length - 1)
  return values.map((value, index) => ({
    x: values.length === 1 ? WIDTH / 2 : PAD + step * index,
    y: span === 0 ? HEIGHT / 2 : PAD + (HEIGHT - PAD * 2) * (1 - (value - min) / span),
  }))
}

/**
 * 基线中位数的走势小折线：最旧在左、当前值在右端（实心圆点）。不引图表库，颜色随文字色；
 * `role="img"` 的名称写明指标与首末值，读屏不必逐点。
 */
export function HistoryChart({ values, label, testId }: { values: readonly number[]; label: string; testId: string }): JSX.Element {
  const points = chartPoints(values)
  const last = points.at(-1)
  return (
    <svg
      className="h-7 w-[120px] flex-none text-text-2"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-label={label}
      data-testid={testId}
      data-points={points.length}
    >
      {points.length > 1 && (
        <polyline
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
          strokeLinecap="round"
          points={points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ')}
          data-testid={`${testId}-line`}
        />
      )}
      {last !== undefined && <circle cx={last.x} cy={last.y} r="2.5" fill="var(--accent)" data-testid={`${testId}-current`} />}
    </svg>
  )
}
