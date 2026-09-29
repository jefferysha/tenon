/**
 * 集成 harness 读 CLI `--json` 输出的窄解码器（纯函数）：形状不符一律当「没有」，由调用方决定是否 fail-loud。
 */

/** `tenon agent next --json` 的窄解码：只取本波要跑的 agent，形状不符就当没有。 */
export function agentWave(json: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null) return []
  const wave = (parsed as Record<string, unknown>).wave
  return Array.isArray(wave) ? wave.filter((id): id is string => typeof id === 'string') : []
}

/** `tenon agent prompt --json` 的窄解码：形状不符返回 null，由调用方 fail-loud。 */
export function agentPromptResult(json: string): { run_id: string; report_path: string; role: string } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const row = parsed as Record<string, unknown>
  if (typeof row.run_id !== 'string' || typeof row.report_path !== 'string' || typeof row.role !== 'string') return null
  return { run_id: row.run_id, report_path: row.report_path, role: row.role }
}

/** `tenon test status --json` 的窄解码：只取还没通过的必需测试 id，形状不符就当没有。 */
export function pendingRequiredTestIds(json: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null) return []
  const items = (parsed as Record<string, unknown>).items
  if (!Array.isArray(items)) return []
  const ids: string[] = []
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue
    const row = item as Record<string, unknown>
    if (typeof row.id !== 'string' || row.required !== true || row.status === 'passed') continue
    ids.push(row.id)
  }
  return ids
}
