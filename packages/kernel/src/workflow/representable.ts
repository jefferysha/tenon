/**
 * field-equals value 的可表示域——委托 ../text/representable.ts 的**通用**往返检查，再叠加
 * workflow 窄 parser 逐行读 value 的**行解析限制**（G2 P2 阻断 2）。compile/validate 放行 ⇒
 * serialize 写得出且 parse 读得回，writer 合同（保存成功的定义层 config 经 serialize→parse
 * 结构相等）由此闭合，拒绝面不在 compile 与 serialize/parse 之间漂移。
 *
 * 分工：
 * - 通用面（空串 / 首尾空白 / 控制字符含 tab·CR·LF / 未配对 surrogate）下沉到 text/representable.ts，
 *   workflow 不再自带一份漏拒 lone surrogate 的判定。
 * - workflow 独有叠加：U+2028 行分隔符 / U+2029 段分隔符。serialize 把 value 写进一行
 *   `value: ${g.value}`（serialize.ts），parse 用 `/^\s*value:\s*(.+?)\s*$/` 读回（parse.ts）未开
 *   dotAll，JS 正则 `.` 不匹配这两个行分隔符 → 存后读不回。
 *
 * 刻意不拒（承 text 通用面之外）：内部空格、`:`、`#`、引号、逗号、歧义标量形（true/123/~/*）——本窄
 * value 解析器原样读回（value 无引号语义、无注释剥离，`(.+?)` 逐字捕获到行尾 trim 前）。
 *
 * @returns null = 可表示；否则返回可直接拼进错误信息的人话原因。
 */
import { stringUnrepresentableReason } from '../text/representable.js'

// U+2028 行分隔符 / U+2029 段分隔符：JS 正则 `.`（未开 s 标志）不匹配，逐行 (.+?) 读不回。
const LINE_PARAGRAPH_SEP_RE = /[\u2028\u2029]/

export function fieldEqualsValueUnrepresentableReason(value: string): string | null {
  const generic = stringUnrepresentableReason(value)
  if (generic) return `field-equals 的 value ${generic}`
  if (LINE_PARAGRAPH_SEP_RE.test(value)) {
    return 'field-equals 的 value 含 U+2028/U+2029 行/段分隔符，parse 的 (.+?) 读不回（. 不匹配行分隔符）'
  }
  return null
}
