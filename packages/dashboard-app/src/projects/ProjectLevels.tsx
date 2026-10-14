import { Info } from 'lucide-react'
import type { TestClass } from '@tenon/kernel/test-system/vocabulary'
import { useT } from '../i18n'
import type { CatalogLevel } from '../api/testSystemTypes'
import { KindLabel } from '../tests/KindLabel'
import { TestSection } from '../tests/TestSection'
import { formatPercent } from '../tests/testFormat'
import { LEVELS_FILE } from '../tests/testLabels'
import { SUBGRID_ROW, TABLE_HEAD, TABLE_ROW, contentTable } from '../tests/testStyles'
import { Hinted } from './projectBits'
import { THRESHOLD_METRICS, levelCoverage } from './suiteThresholds'

/** 档位（名称 + 来源）· 必需类 · 碰到才跑的类（按内容定宽）· 门槛（吃剩余宽度，先被截断）。 */
const COLUMNS = 'grid-cols-[6rem_auto_auto_minmax(0,1fr)]'

type Translate = (key: string, vars?: Record<string, string | number>) => string

/** 一档的门槛，按固定顺序：覆盖率各项 · 不稳定上限 · 要求基线 · 场景映射；一项都没有时为空。 */
export function levelThresholdItems(level: CatalogLevel, t: Translate): string[] {
  const coverage = levelCoverage(level)
  return [
    ...THRESHOLD_METRICS.flatMap((metric) => (coverage[metric] === undefined ? [] : [`${t(`tests.project.threshold.${metric}`)} ${formatPercent(coverage[metric] ?? 0)}`])),
    ...(level.flaky === undefined ? [] : [t('tests.project.level.flaky', { n: level.flaky.max })]),
    ...(level.requireBaseline ? [t('tests.project.level.baseline')] : []),
    ...(level.scenarios === 'off' ? [] : [t(`tests.project.level.scenarios.${level.scenarios}`)]),
  ]
}

/** 一格测试类：图标 + 类名（窄列里只放图标，类名进 Tooltip 与读屏文字）；没有就是破折号。 */
function ClassCell({ classes, testId }: { classes: readonly TestClass[]; testId: string }): JSX.Element {
  return (
    <span className="flex min-w-0 flex-nowrap items-center gap-1.5" role="cell" data-testid={testId}>
      {classes.length === 0 ? <span className="text-text-3">—</span> : classes.map((cls) => <KindLabel key={cls} kind={cls} iconOnly />)}
    </span>
  )
}

/**
 * 项目页「测试」中列的档位定义：生效的三档（目录写了的与内建缺省）各一行——必需类、碰到才跑的类、门槛，
 * 名称下标出来自目录还是内建缺省。只读；档位含义在项目测试目录的 levels，文件路径只放标题旁图标的 Tooltip。
 */
export function ProjectLevels({ levels }: { levels: readonly CatalogLevel[] }): JSX.Element | null {
  const { t } = useT()
  if (levels.length === 0) return null
  const hint = (
    <Hinted hint={LEVELS_FILE} label={`${t('tests.policy.definition')}: ${LEVELS_FILE}`} testId="proj-levels-file">
      <Info className="size-3.5 text-text-3" aria-hidden="true" />
    </Hinted>
  )
  return (
    <TestSection title={t('tests.word.level')} action={hint} testId="proj-levels">
      <div role="table" className={contentTable(COLUMNS)} aria-label={t('tests.word.level')}>
        <div className={`${SUBGRID_ROW} ${TABLE_HEAD}`} role="row" data-testid="proj-levels-head">
          <span role="columnheader">{t('tests.word.level')}</span>
          <span role="columnheader">{t('tests.project.level.required')}</span>
          <span role="columnheader">{t('tests.project.level.touched')}</span>
          <span role="columnheader">{t('tests.project.level.thresholds')}</span>
        </div>
        {levels.map((level) => {
          const thresholds = levelThresholdItems(level, t).join(' · ')
          return (
            <div key={level.name} className={`${SUBGRID_ROW} ${TABLE_ROW}`} role="row" data-testid={`proj-level-${level.name}`}>
              <span className="grid min-w-0" role="cell">
                <span className="truncate text-text">{t(`tests.level.${level.name}`)}</span>
                <span className="truncate text-micro text-text-3" title={t(`tests.project.level.source.${level.source}`)} data-source={level.source} data-testid={`proj-level-${level.name}-source`}>
                  {t(`tests.project.level.source.${level.source}`)}
                </span>
              </span>
              <ClassCell classes={level.required} testId={`proj-level-${level.name}-required`} />
              <ClassCell classes={level.touched} testId={`proj-level-${level.name}-touched`} />
              <span
                className="min-w-0 truncate text-caption text-text-2"
                role="cell"
                title={thresholds === '' ? undefined : thresholds}
                data-testid={`proj-level-${level.name}-thresholds`}
              >
                {thresholds === '' ? '—' : thresholds}
              </span>
            </div>
          )
        })}
      </div>
    </TestSection>
  )
}
