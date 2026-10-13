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

/** `tenon agent prompt --json` 的窄解码：形状不符返回 null，由调用方 fail-loud。`prompt` 是宿主交给子 agent 的全文。 */
export function agentPromptResult(json: string): { run_id: string; report_path: string; role: string; prompt: string } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const row = parsed as Record<string, unknown>
  if (typeof row.run_id !== 'string' || typeof row.report_path !== 'string' || typeof row.role !== 'string') return null
  return { run_id: row.run_id, report_path: row.report_path, role: row.role, prompt: typeof row.prompt === 'string' ? row.prompt : '' }
}

/** JSON 文本 → 对象（夹具 fail-loud：不是合法 JSON 或不是对象就抛，带上 `label` 说明读的是什么）。 */
export function parseJsonRecord(json: string, label: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (error) {
    throw new Error(`${label} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}\n${json}`)
  }
  return recordOf(parsed, label)
}

/** 值必须是对象（夹具 fail-loud）。 */
export function recordOf(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} 不是对象：${JSON.stringify(value)}`)
  return value as Record<string, unknown>
}

/** 值必须是数组，且每个元素都是对象（夹具 fail-loud）；缺省（undefined）按空数组。 */
export function recordRows(value: unknown, label: string): readonly Record<string, unknown>[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${label} 不是数组：${JSON.stringify(value)}`)
  return value.map((row, index) => recordOf(row, `${label}[${index}]`))
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
