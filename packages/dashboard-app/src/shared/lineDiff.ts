/**
 * 行级差异（应用指令文件前的预览）：先去掉公共前缀与后缀，中间段做 LCS。
 * 输入超过 256 KiB 或中间段超过 4 000 × 4 000 行时退化为「旧内容整段删除 + 新内容整段新增」。
 */
export type LineDiffOp = 'eq' | 'add' | 'del'
export interface LineDiffRow { op: LineDiffOp; text: string }

const MAX_BYTES = 256 * 1024
const MAX_CELLS = 4000 * 4000

function lines(text: string): string[] {
  if (text === '') return []
  const out = text.replace(/\r\n/g, '\n').split('\n')
  if (out.at(-1) === '') out.pop()
  return out
}

const row = (op: LineDiffOp) => (text: string): LineDiffRow => ({ op, text })

function lcsDiff(a: readonly string[], b: readonly string[]): LineDiffRow[] {
  const width = b.length + 1
  const table = new Uint16Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] = a[i] === b[j]
        ? (table[(i + 1) * width + j + 1] ?? 0) + 1
        : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0)
    }
  }
  const out: LineDiffRow[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: 'eq', text: a[i] ?? '' })
      i += 1
      j += 1
    } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) {
      out.push({ op: 'del', text: a[i] ?? '' })
      i += 1
    } else {
      out.push({ op: 'add', text: b[j] ?? '' })
      j += 1
    }
  }
  for (; i < a.length; i += 1) out.push({ op: 'del', text: a[i] ?? '' })
  for (; j < b.length; j += 1) out.push({ op: 'add', text: b[j] ?? '' })
  return out
}

export function lineDiff(before: string, after: string): LineDiffRow[] {
  const a = lines(before)
  const b = lines(after)
  const encoder = new TextEncoder()
  if (encoder.encode(before).length > MAX_BYTES || encoder.encode(after).length > MAX_BYTES) {
    return [...a.map(row('del')), ...b.map(row('add'))]
  }
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1
    endB -= 1
  }
  const middleA = a.slice(start, endA)
  const middleB = b.slice(start, endB)
  const middle = middleA.length * middleB.length > MAX_CELLS
    ? [...middleA.map(row('del')), ...middleB.map(row('add'))]
    : lcsDiff(middleA, middleB)
  return [...a.slice(0, start).map(row('eq')), ...middle, ...a.slice(endA).map(row('eq'))]
}
