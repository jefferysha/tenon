/**
 * 导出里的确定性标识：同一份证据重复导出得到同一个 id / traceId / spanId，下游按 id 去重不会膨胀。
 */
import { sha256Hex } from '../sha256.js'
import type { EvidenceLineRange } from './types.js'

/** 由种子派生的 UUID（版本位 5、变体位 RFC 4122），形如 `xxxxxxxx-xxxx-5xxx-yxxx-xxxxxxxxxxxx`。 */
export function deterministicUuid(seed: string): string {
  const hex = sha256Hex(seed).slice(0, 32).split('')
  hex[12] = '5'
  hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16] ?? '0', 16) % 4] ?? '8'
  const joined = hex.join('')
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20, 32)}`
}

/** 行号集合 → 连续区间（升序、闭区间）。 */
export function linesToRanges(lines: Iterable<number>): readonly EvidenceLineRange[] {
  const sorted = [...new Set(lines)].filter((line) => Number.isInteger(line) && line >= 1).sort((left, right) => left - right)
  const out: EvidenceLineRange[] = []
  for (const line of sorted) {
    const last = out.at(-1)
    if (last !== undefined && line === last.end_line + 1) out[out.length - 1] = { start_line: last.start_line, end_line: line }
    else out.push({ start_line: line, end_line: line })
  }
  return out
}
