/** 测试视图的数字与时间格式化。纯函数，无语言依赖（单位与数字不翻译）。 */

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`
}

export function formatPercent(value: number): string {
  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** 月/日 时:分（本地时区）；无法解析原样返回。 */
export function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** 带符号的百分比变化：`+18.3%` / `-0.6%`；null → 破折号。 */
export function formatDelta(pct: number | null): string {
  if (pct === null) return '—'
  return `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`
}

/** 指标数值：至多 3 位有效小数，去掉多余的零。 */
export function formatMetric(value: number): string {
  return String(Number(value.toFixed(3)))
}
