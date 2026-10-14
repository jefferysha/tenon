/**
 * 步骤测试豁免（`test:<id>`）旁边展示的「最新运行」实测值（纯函数）。
 *
 * 豁免理由是登记者写下的一段文字，里面的数字登记之后不会随代码刷新（「新增 2100 行」写下之后，代码继续增加到 2810 行，
 * 理由还是 2100）。展示豁免的地方因此在理由之外另起一行，给出该测试在当前候选上最新一次失败记录的实测值与门槛，
 * 每次展示时从记录现读，不随登记时的文字固定：评审者和批准人看到的是现在这份代码上的数字。
 * 数字是测试 / 探针命令自己输出的指标，Tenon 从当前候选的运行记录里读出；它受测试命令信任门保护（命令经用户确认才会执行），
 * 但不是 Tenon 独立统计的。
 *
 * 指标名来自测试命令的输出（常是执行者 agent 写的探针），与豁免理由一样是不可信文本：展示前走同一套单行化、
 * 控制字符剔除、字符替换（`waiverReasonText`），再截短，伪造不出代码块或标签。
 */
import type { TestMetricRecord, TestRunRecordV1 } from '../test-evidence/types.js'
import { waiverReasonText } from './step-test-waivers.js'

export interface WaiverMetric {
  readonly name: string
  readonly value: number
  /** 上限 / 下限：指标声明了门槛时才有。 */
  readonly max?: number
  readonly min?: number
}

export type WaiverMetricsLocale = 'zh-CN' | 'en'

/** 一行里最多列出的指标数；其余折成「等 N 项」。 */
export const WAIVER_METRICS_MAX_LISTED = 8
/** 单个指标名展示时最多保留的字符数（超过截断并加 …）。 */
const METRIC_NAME_MAX = 64

function runOrder(left: TestRunRecordV1, right: TestRunRecordV1): number {
  if (left.finished_at !== right.finished_at) return left.finished_at < right.finished_at ? -1 : 1
  return left.run_id < right.run_id ? -1 : left.run_id > right.run_id ? 1 : 0
}

function toMetric(record: TestMetricRecord): WaiverMetric | undefined {
  if (record.value === null) return undefined
  return {
    name: record.name,
    value: record.value,
    ...(record.max === undefined ? {} : { max: record.max }),
    ...(record.min === undefined ? {} : { min: record.min }),
  }
}

/** 一条运行记录里的指标，不看结果：超限的排在前面，读不到值的不列。展示最新运行的实测值（豁免旁、没有门槛的探针）都用它。 */
export function runMetrics(record: Pick<TestRunRecordV1, 'metrics'>): readonly WaiverMetric[] {
  const ordered = [...record.metrics.filter((item) => !item.ok), ...record.metrics.filter((item) => item.ok)]
  return ordered.flatMap((item) => {
    const metric = toMetric(item)
    return metric === undefined ? [] : [metric]
  })
}

/**
 * 该步骤测试在 `candidate` 上最新一条记录是失败时，返回它的指标（`runMetrics` 的口径）；
 * 没有这样的记录（没运行过、最新一条已经通过、记录绑的是别的代码）返回 undefined。
 * 失败记录没有任何指标（例如只因退出码失败）返回空数组，与「没有失败记录」区分。
 * `candidate` 为 undefined = 宿主没有工作区指纹能力，不按候选过滤。
 */
export function latestFailureMetrics(
  change: string,
  testId: string,
  records: readonly TestRunRecordV1[],
  candidate: string | null | undefined,
): readonly WaiverMetric[] | undefined {
  const latest = records
    .filter((record) => record.change === change && record.test_id === testId && (candidate === undefined || record.candidate === candidate))
    .sort(runOrder)
    .at(-1)
  if (latest === undefined || latest.result !== 'fail') return undefined
  return runMetrics(latest)
}

function shownName(name: string): string {
  const safe = [...waiverReasonText(name)]
  const text = safe.length > METRIC_NAME_MAX ? `${safe.slice(0, METRIC_NAME_MAX).join('')}…` : safe.join('')
  return text === '' ? '?' : text
}

function shownNumber(value: number): string {
  return String(Number.isInteger(value) ? value : Number(value.toFixed(4)))
}

const WORDS: Readonly<Record<WaiverMetricsLocale, {
  readonly none: string
  readonly latest: string
  readonly noMetrics: string
  readonly max: string
  readonly min: string
  readonly separator: string
  readonly more: (count: number) => string
  readonly limit: (parts: string) => string
}>> = {
  'zh-CN': {
    none: '当前候选上没有失败记录',
    latest: '最新运行：',
    noMetrics: '没有记录到指标',
    max: '上限 ',
    min: '下限 ',
    separator: '，',
    more: (count) => `等 ${count} 项`,
    limit: (parts) => `（${parts}）`,
  },
  en: {
    none: 'No failing run on the current candidate',
    latest: 'Latest run: ',
    noMetrics: 'no metrics recorded',
    max: 'limit ',
    min: 'floor ',
    separator: ', ',
    more: (count) => `and ${count} more`,
    limit: (parts) => ` (${parts})`,
  },
}

/**
 * 豁免下方那一行：`最新运行：lines_added=2810（上限 2000）`。`undefined` = 当前候选上没有失败记录；
 * 没有任何可列的指标时写明「没有记录到指标」，不冒充「没有失败记录」。
 * `nameText` 给出时作用在单行化、截短之后的指标名上（如 Markdown 转义）：先截短后转义，转义序列不会被截在中间。
 */
export function formatWaiverMetrics(
  metrics: readonly WaiverMetric[] | undefined,
  locale: WaiverMetricsLocale = 'zh-CN',
  nameText: (shown: string) => string = (shown) => shown,
): string {
  const words = WORDS[locale]
  if (metrics === undefined) return words.none
  const listable = metrics.filter((metric) => Number.isFinite(metric.value))
  if (listable.length === 0) return `${words.latest}${words.noMetrics}`
  const parts = listable.slice(0, WAIVER_METRICS_MAX_LISTED).map((metric) => {
    const limits = [
      ...(metric.max === undefined || !Number.isFinite(metric.max) ? [] : [`${words.max}${shownNumber(metric.max)}`]),
      ...(metric.min === undefined || !Number.isFinite(metric.min) ? [] : [`${words.min}${shownNumber(metric.min)}`]),
    ]
    return `${nameText(shownName(metric.name))}=${shownNumber(metric.value)}${limits.length === 0 ? '' : words.limit(limits.join(words.separator))}`
  })
  const rest = listable.length - parts.length
  if (rest > 0) parts.push(words.more(rest))
  return `${words.latest}${parts.join(words.separator)}`
}
