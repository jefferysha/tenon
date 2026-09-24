/** FacetBar 的纯排版计算：放得下几项、谁先被收进「更多」。与 DOM 无关，单测直接喂宽度。 */

export const GAP = 4

/**
 * 单行放得下的前缀项数。items 按优先级排好（前面的先保留）；放不下时要给「更多」按钮留位。
 * 返回 n 表示前 n 项可见，其余进「更多」。
 */
export function fitCount(itemWidths: readonly number[], available: number, moreWidth: number, gap = GAP): number {
  const total = itemWidths.reduce((sum, width) => sum + width, 0) + gap * Math.max(itemWidths.length - 1, 0)
  if (total <= available) return itemWidths.length
  let used = moreWidth
  let count = 0
  for (const width of itemWidths) {
    if (used + width + gap > available) break
    used += width + gap
    count += 1
  }
  return count
}

/**
 * 收起顺序：从末尾起收。芯片组里已选中的那颗提到本组最前，保证行内总有一个选中项；
 * 渲染仍按原顺序（「全部」领头）。
 */
export function priorityOf<T extends { key: string; group: { id: string; kind: string; value: string }; option: { id: string } | null }>(items: readonly T[]): T[] {
  const out = [...items]
  for (const item of items) {
    if (item.group.kind !== 'chips' || item.option === null || item.group.value !== item.option.id) continue
    const from = out.indexOf(item)
    const to = out.findIndex((candidate) => candidate.group.id === item.group.id)
    if (from > to) { out.splice(from, 1); out.splice(to, 0, item) }
  }
  return out
}
