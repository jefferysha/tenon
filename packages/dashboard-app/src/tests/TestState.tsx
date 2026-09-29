import { useT } from '../i18n'
import { StatusPill, type PillTone } from '../shell/ThreeColumns'
import type { CaseStatus, SuiteState, TraceCaseStatus } from '../api/testSystemTypes'

/** 状态 = 6px 圆点 + 一个词（StatusPill 已是无底色的点+字）。语义色不单独承载含义，词总在。 */
const SUITE_TONE: Record<SuiteState, PillTone> = {
  passed: 'done',
  failed: 'blocked',
  stale: 'pending',
  missing: 'neutral',
  running: 'running',
}

const CASE_TONE: Record<TraceCaseStatus, PillTone> = {
  pass: 'done',
  fail: 'blocked',
  flaky: 'pending',
  skip: 'neutral',
  'known-fail': 'neutral',
  'not-run': 'neutral',
}

export function suiteTone(state: SuiteState): PillTone {
  return SUITE_TONE[state]
}

export function caseTone(status: TraceCaseStatus): PillTone {
  return CASE_TONE[status]
}

/** 套件 / 种类的运行状态：通过 · 失败 · 过期 · 未运行 · 运行中。 */
export function SuiteStateMark({ state, testId, title }: { state: SuiteState; testId?: string; title?: string }): JSX.Element {
  const { t } = useT()
  return <StatusPill tone={SUITE_TONE[state]} testId={testId} title={title}>{t(`tests.state.${state}`)}</StatusPill>
}

/** 一次运行或一个套件的最终结果：通过 · 失败。 */
export function ResultMark({ result, testId }: { result: 'pass' | 'fail'; testId?: string }): JSX.Element {
  const { t } = useT()
  return <StatusPill tone={result === 'pass' ? 'done' : 'blocked'} testId={testId}>{t(`tests.case.${result}`)}</StatusPill>
}

/** 用例状态：通过 · 失败 · 跳过 · flaky · 已知失败 · 未运行。 */
export function CaseStateMark({ status, testId }: { status: CaseStatus | TraceCaseStatus; testId?: string }): JSX.Element {
  const { t } = useT()
  return <StatusPill tone={CASE_TONE[status]} testId={testId}>{t(`tests.case.${status}`)}</StatusPill>
}
