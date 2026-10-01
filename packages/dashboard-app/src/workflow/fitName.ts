/**
 * 画布节点里的长名字怎么缩：按 `-` / `:` 拆成段，整段整段地留，不在词中间切。
 * 放得下就整名；放不下，留头几段和尾几段、中间一个省略号（`openspec…propose`、`test…development`），
 * 在放得下的里选最宽的；连「首段…末段」也放不下，才把首段从尾部削短、末段仍然完整（`verif…completion`）；
 * 只有一段的名字（或削不动）不动，交给样式在末尾截断。纯函数，度量由调用方给（画布里量真实字体的宽度）。
 */

export const NAME_ELLIPSIS = '…'
/** 削首段时至少留几个字符，再短就没有可读性了。 */
const MIN_HEAD_CHARS = 3
/** 量出来的宽度是整数像素，留 1px 余量，免得差零点几像素就被样式截断。 */
const SLACK = 1

/** 一批文本的渲染宽度（像素），顺序与入参一致。 */
export type MeasureNames = (texts: readonly string[]) => readonly number[]

/** 拆成段，每段带着它后面的分隔符（`-` 或 `:`）；拼回去与原名逐字一致。 */
export function nameSegments(name: string): string[] {
  return name.match(/[^-:]+[-:]?|[-:]/gu) ?? [name]
}

function bare(segment: string): string {
  return segment.replace(/[-:]$/u, '')
}

/** 「头几段…尾几段」的全部写法（头、尾各至少一段，合起来少于全部段数）。 */
export function pairCandidates(segments: readonly string[]): string[] {
  const out: string[] = []
  for (let head = 1; head < segments.length - 1; head += 1) {
    for (let tail = 1; head + tail < segments.length; tail += 1) {
      out.push(`${bare(segments.slice(0, head).join(''))}${NAME_ELLIPSIS}${segments.slice(segments.length - tail).join('')}`)
    }
  }
  return out
}

/** 首段削短、末段完整的写法，由长到短（至少留 MIN_HEAD_CHARS 个字符）。 */
function trimCandidates(segments: readonly string[]): string[] {
  const first = segments[0]
  const last = segments[segments.length - 1]
  if (segments.length < 2 || first === undefined || last === undefined) return []
  const chars = [...bare(first)]
  const out: string[] = []
  for (let keep = chars.length - 1; keep >= MIN_HEAD_CHARS; keep -= 1) out.push(`${chars.slice(0, keep).join('')}${NAME_ELLIPSIS}${last}`)
  return out
}

/** 选出在 `available` 像素里显示的写法；量不到宽度（<= 0）或哪种都放不下就原样返回。 */
export function fitName(name: string, available: number, measure: MeasureNames): string {
  if (available <= 0) return name
  const limit = available - SLACK
  const pairs = pairCandidates(nameSegments(name))
  const widths = measure([name, ...pairs])
  if ((widths[0] ?? Infinity) <= limit) return name
  let best = -1
  let bestWidth = -1
  pairs.forEach((_, index) => {
    const width = widths[index + 1] ?? Infinity
    if (width <= limit && width > bestWidth) { best = index; bestWidth = width }
  })
  const pair = pairs[best]
  if (pair !== undefined) return pair
  const trims = trimCandidates(nameSegments(name))
  if (trims.length === 0) return name
  const trimWidths = measure(trims)
  const index = trimWidths.findIndex((width) => width <= limit)
  return trims[index] ?? name
}
