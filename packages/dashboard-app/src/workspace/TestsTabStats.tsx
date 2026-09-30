import { useT } from '../i18n'
import { CountRoll } from '../shared/CountRoll'
import { formatPercent } from '../tests/testFormat'
import { cn } from '@/lib/utils'
import type { TabSummary } from './testsTabModel'

interface Stat {
  id: 'suite' | 'case' | 'fail' | 'flaky' | 'coverage'
  label: string
  value: number | string
  /** 0 用 text-3 让位；非零的失败用红。 */
  zero: boolean
  danger: boolean
}

/**
 * 测试页签的汇总：四个 24/600 的等宽数字（套件 · 用例 · 失败 · 不稳定）+ 13px 标签。0 退成 text-3，
 * 失败非零用红；报告了行覆盖率才多一格。单行，不折行；数字变化时纵向滚动。
 */
export function TestsTabStats({ summary, pass }: { summary: TabSummary; pass: boolean }): JSX.Element {
  const { t } = useT()
  const stats: Stat[] = [
    { id: 'suite', label: t('tests.word.suite'), value: summary.suites, zero: summary.suites === 0, danger: false },
    { id: 'case', label: t('tests.word.case'), value: summary.cases, zero: summary.cases === 0, danger: false },
    { id: 'fail', label: t('tests.case.fail'), value: summary.fail, zero: summary.fail === 0, danger: summary.fail > 0 },
    { id: 'flaky', label: t('tests.word.flaky'), value: summary.flaky, zero: summary.flaky === 0, danger: false },
    ...(summary.coverage === null
      ? []
      : [{ id: 'coverage' as const, label: t('tests.word.coverage'), value: formatPercent(summary.coverage), zero: summary.coverage === 0, danger: false }]),
  ]
  return (
    <div
      className="flex flex-nowrap items-end gap-8 whitespace-nowrap"
      role="group"
      aria-label={stats.map((stat) => `${stat.label} ${stat.value}`).join(' · ')}
      data-testid="tests-summary"
      data-pass={pass}
    >
      {stats.map((stat) => (
        <div key={stat.id} className="grid min-w-0 gap-0.5" data-testid={`tests-stat-${stat.id}`} data-zero={stat.zero}>
          <CountRoll
            value={stat.value}
            className={cn('text-section font-semibold tabular-nums', stat.danger ? 'text-red-d' : stat.zero ? 'text-text-3' : 'text-text')}
            testId={`tests-stat-value-${stat.id}`}
          />
          <span className="text-micro text-text-3">{stat.label}</span>
        </div>
      ))}
    </div>
  )
}
