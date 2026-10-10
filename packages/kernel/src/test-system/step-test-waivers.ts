/**
 * 步骤测试豁免（计划里的 `test:<id>`）的判定与展示（纯函数）。
 *
 * 判定：豁免「已批准」当且仅当 `approved_by` 非空**且**被批准的候选（`approved_candidate`）等于当前新鲜失败记录的代码候选。
 * 批准只对确认时看到的那份代码有效：之后代码变了、同一测试再次失败，或旧版本留下的批准没有候选，一律「待批准」，
 * 等用户对现在这份失败重新确认——不能让一次批准一直放行后来的真实回归。
 *
 * 展示：豁免理由是登记者（常是执行者 agent）的自述，评审者提示词与 `test-waived` 提示都可能被 agent 读到，
 * 展示前一律标注未经核实、折成单行、截短，并去掉能伪造代码块或标签的字符。
 */
import type { FreshnessContext } from './evaluate-suite.js'
import type { PlanWaiver, TestPlan } from './plan.js'

export interface StepTestWaiverView {
  readonly approved: boolean
  readonly reason: string
}

/** 展示时豁免理由最多保留的字符数（超过截断并加 …）。 */
export const WAIVER_REASON_MAX = 200

/**
 * 被批准的候选是否就是当前这条新鲜失败所在的代码。比较口径与新鲜度判定一致（evaluate-suite 的 `staleBindings`）：
 * 失败记录绑定的候选、宿主给的当前候选、或它的可移植孪生，任一相等即同一份代码——0.3.1 起的记录绑可移植版，
 * 更早的绑完整版，两种写法不该让同一份代码的批准失效。失败记录是新鲜的，所以这三者指向同一棵树。
 */
function approvalIsCurrent(
  waiver: PlanWaiver,
  failedCandidate: string | null | undefined,
  current: Pick<FreshnessContext, 'candidate' | 'candidateAlt'>,
): boolean {
  const approved = waiver.approved_candidate
  if (waiver.approved_by === null || approved === undefined) return false
  return approved === failedCandidate || approved === current.candidate || approved === current.candidateAlt
}

/**
 * 计划里对某个步骤测试的豁免（`test:<id>`）；计划缺失 / 不可信、没有这条豁免时没有。
 * `failedCandidate` 是该测试当前新鲜失败记录绑定的代码候选（记录没有候选 = 无从绑定，批准不成立）。
 */
export function stepTestWaiver(
  plan: TestPlan | undefined,
  testId: string,
  failedCandidate: string | null | undefined,
  current: Pick<FreshnessContext, 'candidate' | 'candidateAlt'>,
): StepTestWaiverView | undefined {
  const waiver = plan?.waivers.find((item) => item.test === testId)
  return waiver === undefined ? undefined : { approved: approvalIsCurrent(waiver, failedCandidate, current), reason: waiver.reason }
}

/**
 * 展示文本里不许出现的码点区间：C0 控制字符（含 ESC，终端转义序列的起点）、DEL 与 C1 控制字符、
 * 双向覆盖（U+202A–U+202E）与双向隔离（U+2066–U+2069，能让一行文字在终端或页面里反向显示）。
 * 按码点区间判断而不写正则字面量，源码里也不出现这些不可见字符。
 */
const UNSAFE_DISPLAY_RANGES: readonly (readonly [number, number])[] = [
  [0x00, 0x1f], [0x7f, 0x9f], [0x202a, 0x202e], [0x2066, 0x2069],
]

function isUnsafeDisplayChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0
  return UNSAFE_DISPLAY_RANGES.some(([from, to]) => code >= from && code <= to)
}

/** 含控制字符或双向覆盖 / 隔离字符（严格解码用：含有就整份拒收）。 */
export function hasUnsafeDisplayChars(text: string): boolean {
  return [...text].some(isUnsafeDisplayChar)
}

/**
 * 豁免理由的展示文本：折成单行、去掉控制字符与双向覆盖 / 隔离字符、最多 200 个字符（超出加 …）、
 * 反引号与尖括号换成全角。换行等空白先折成单个空格，其余控制字符直接去掉。
 */
export function waiverReasonText(reason: string): string {
  const folded = reason.replace(/\s+/gu, ' ')
  const stripped = [...folded].filter((char) => !isUnsafeDisplayChar(char)).join('').replace(/ {2,}/gu, ' ')
  const safe = stripped.trim().replace(/`/gu, '｀').replace(/</gu, '＜').replace(/>/gu, '＞')
  const chars = [...safe]
  return chars.length > WAIVER_REASON_MAX ? `${chars.slice(0, WAIVER_REASON_MAX).join('')}…` : safe
}
