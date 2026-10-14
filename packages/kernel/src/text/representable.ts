/**
 * 中性可表示性谓词——窄行序列化子集经「UTF-8 落盘 → 逐行读回」往返的**通用**拒绝面单一事实源
 * （G2 P2 阻断 2）。与具体 schema 无关，只管往返的物理与行结构约束；schema 层（如
 * workflow/representable.ts）委托本模块再叠加各自 parser 的行解析限制。
 *
 * 拒绝面（一字不多）：
 * - 空串：逐行值解析器（如 workflow parse 的 `value: (.+?)`）的值捕获至少要一字符，读不回零字符；
 * - 控制字符（C0 U+0000–001F 含 \t\n\r、C1 U+007F–009F）：换行/回车把值劈成多行破坏结构，
 *   tab 与其余控制符超出窄序列化子集；
 * - 首尾空白：读回时被解析器的 `\s*` / trim 吞掉，往返丢失；
 * - 未配对 UTF-16 surrogate（高位后不跟低位、或低位前不接高位）：writeFileSync(..,'utf8') 落盘把
 *   孤立代理替换成 U+FFFD，读回值变。
 *
 * 刻意不拒（属 schema 层各自裁量，不在通用域）：单/双引号（bare 值无引号语义、quoted 值只拒同含
 * 两款）、U+2028/U+2029（能否往返取决于 parser 是否开 dotAll——workflow 的 `.` 读不回故其自身叠加拒）。
 *
 * @returns null = 可表示；否则返回可直接拼进错误信息的人话原因。
 */

// 未配对 surrogate：高位（U+D800–DBFF）后不跟低位，或低位（U+DC00–DFFF）前不接高位。
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
// C0（U+0000–001F，含 \t\n\r）与 C1（U+007F–009F）控制字符。
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/

export function stringUnrepresentableReason(s: string): string | null {
  if (s === '') return '不得为空串（窄行序列化的值捕获读不回零字符）'
  if (CONTROL_RE.test(s)) return '含控制字符（换行/回车/tab 等），破坏行结构或超出窄序列化子集'
  if (s !== s.trim()) return '含首尾空白，读回时被 trim 丢失'
  if (LONE_SURROGATE_RE.test(s)) return '含未配对 UTF-16 surrogate，UTF-8 落盘会被替换成 U+FFFD，无法往返'
  return null
}
