/**
 * 指令文件里的 Tenon 受管块（AGENTS.md / CLAUDE.md / .rules …）。
 *
 * 标记行语法：整行恰为 `<!-- PIPELINE:<TAG>:START -->` / `<!-- PIPELINE:<TAG>:END -->`，
 * `TAG = [A-Z][A-Z0-9_]*`（适配器写 CODEX / COPILOT / ZED）。同一 TAG 至多一对，START 在前，块不嵌套；
 * 任一违例整份文件判为无效，写入方必须拒绝（与 adapters/codex/install.sh 的 fail-closed 规则一致）。
 */

export const MANAGED_MARKER_LINE = /^<!-- PIPELINE:([A-Z][A-Z0-9_]*):(START|END) -->$/

export interface ManagedBlock { tag: string; text: string }

export type ManagedParse =
  | { ok: true; userText: string; blocks: readonly ManagedBlock[] }
  | { ok: false; error: 'unpaired' | 'reversed' | 'duplicate' | 'nested'; tag: string; line: number }

interface MarkerLine { index: number; tag: string; kind: 'START' | 'END' }

function lines(content: string): string[] {
  return content.replace(/\r\n/g, '\n').split('\n')
}

function markerOf(line: string, index: number): MarkerLine | null {
  const match = MANAGED_MARKER_LINE.exec(line)
  if (!match) return null
  return { index, tag: match[1] ?? '', kind: match[2] === 'START' ? 'START' : 'END' }
}

/** 去掉结尾空白行，非空时保留恰好一个换行。 */
function withSingleTrailingNewline(text: string): string {
  const trimmed = text.replace(/\s+$/u, '')
  return trimmed === '' ? '' : `${trimmed}\n`
}

export function parseManagedBlocks(content: string): ManagedParse {
  const all = lines(content)
  const markers = all.map(markerOf).filter((marker): marker is MarkerLine => marker !== null)
  const closed = new Set<string>()
  const ranges: { tag: string; start: number; end: number }[] = []
  let open: MarkerLine | null = null
  for (const marker of markers) {
    const line = marker.index + 1
    if (marker.kind === 'START') {
      if (open) return { ok: false, error: 'nested', tag: marker.tag, line }
      if (closed.has(marker.tag)) return { ok: false, error: 'duplicate', tag: marker.tag, line }
      open = marker
      continue
    }
    if (open && open.tag === marker.tag) {
      ranges.push({ tag: marker.tag, start: open.index, end: marker.index })
      closed.add(marker.tag)
      open = null
      continue
    }
    if (closed.has(marker.tag)) return { ok: false, error: 'duplicate', tag: marker.tag, line }
    const laterStart = markers.some((other) => other.kind === 'START' && other.tag === marker.tag && other.index > marker.index)
    return { ok: false, error: laterStart ? 'reversed' : 'unpaired', tag: marker.tag, line }
  }
  if (open) return { ok: false, error: 'unpaired', tag: open.tag, line: open.index + 1 }

  const blocks = ranges.map((range) => ({ tag: range.tag, text: all.slice(range.start, range.end + 1).join('\n') }))
  const kept: string[] = []
  let cursor = 0
  for (const range of ranges) {
    kept.push(...all.slice(cursor, range.start))
    cursor = range.end + 1
    // 块两侧各有一个空行时只留一个，避免移走中间块后出现连续空行。
    if (kept.at(-1)?.trim() === '' && all[cursor]?.trim() === '') cursor += 1
  }
  kept.push(...all.slice(cursor))
  return { ok: true, userText: withSingleTrailingNewline(kept.join('\n')), blocks }
}

/** 编辑器文本是否含标记行（只看整行，正文里提到标记文字不算）。 */
export function containsManagedMarker(text: string): boolean {
  return lines(text).some((line) => MANAGED_MARKER_LINE.test(line))
}

/** 用户文本在前，受管块按原顺序原样接在末尾（Codex 安装器追加块的位置），LF + 单个结尾换行。 */
export function mergeManagedBlocks(editorText: string, blocks: readonly ManagedBlock[]): string {
  const user = editorText.replace(/\r\n/g, '\n').replace(/\s+$/u, '')
  const managed = blocks.map((block) => block.text).join('\n')
  if (blocks.length === 0) return user === '' ? '' : `${user}\n`
  return user === '' ? `${managed}\n` : `${user}\n\n${managed}\n`
}

/** 删除指令文件：无受管块 → null（删文件）；有 → 只剩受管块。 */
export function contentAfterDelete(blocks: readonly ManagedBlock[]): string | null {
  if (blocks.length === 0) return null
  return `${blocks.map((block) => block.text).join('\n')}\n`
}
