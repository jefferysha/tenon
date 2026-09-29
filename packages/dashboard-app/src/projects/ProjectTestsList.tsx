import { useT } from '../i18n'
import type { CatalogSuite, SuiteLatest, TestCatalogResponse } from '../api/testSystemTypes'
import { formatApiError } from '../api/transport'
import { CommandLine } from '../shared/CommandLine'
import { BUTTON_GHOST, LIST_SELECTED } from '../shared/uiRecipes'
import { KindLabel } from '../tests/KindLabel'
import { ResultMark } from '../tests/TestState'
import { TABLE_HEAD, TABLE_ROW, gridRow } from '../tests/testStyles'
import type { Remote } from '../tests/useRemote'
import { cn } from '@/lib/utils'

/** 工具列固定宽：放得下 playwright / vitest-bench，不再被挤成 vit…。 */
const COLUMNS = 'grid-cols-[minmax(0,1fr)_5.5rem_4.5rem_3.5rem]'
export const DISCOVER_COMMAND = 'tenon test discover --write'

function DiscoverEmpty(): JSX.Element {
  const { t } = useT()
  return (
    <div role="group" aria-label={t('tests.project.empty')} data-testid="proj-tests-empty">
      <CommandLine command={DISCOVER_COMMAND} testId="proj-tests-discover" />
    </div>
  )
}

function Rows({ suites, latest, selectedId, onSelect }: {
  suites: readonly CatalogSuite[]
  latest: readonly SuiteLatest[]
  selectedId: string | null
  onSelect: (id: string) => void
}): JSX.Element {
  const { t } = useT()
  return (
    <div role="table" aria-label={t('tests.word.suite')} data-testid="proj-tests-table">
      <div className={cn(gridRow(COLUMNS), TABLE_HEAD)} role="row" data-testid="proj-tests-head">
        <span role="columnheader">{t('tests.project.col.name')}</span>
        <span role="columnheader">{t('tests.word.runner')}</span>
        <span role="columnheader">{t('tests.project.col.result')}</span>
        <span role="columnheader">{t('tests.word.flaky')}</span>
      </div>
      {suites.map((suite) => {
        const run = latest.find((item) => item.suite === suite.id)
        const selected = selectedId === suite.id
        return (
          <div
            key={suite.id}
            className={cn(gridRow(COLUMNS), TABLE_ROW, 'cursor-pointer hover:bg-fill', selected && LIST_SELECTED)}
            role="row"
            aria-current={selected ? 'true' : undefined}
            data-testid={`proj-suite-${suite.id}`}
            onClick={() => onSelect(suite.id)}
          >
            <span className="flex min-w-0 items-center gap-2" role="cell">
              <KindLabel kind={suite.kind} iconOnly testId={`proj-suite-kind-${suite.id}`} />
              <button
                type="button"
                className="block min-w-0 flex-1 truncate rounded-xs text-left font-semibold text-text outline-none focus-visible:ring-2 focus-visible:ring-(--accent)"
                title={suite.id}
                data-testid={`proj-suite-open-${suite.id}`}
                onClick={(event) => { event.stopPropagation(); onSelect(suite.id) }}
              >
                {suite.label ?? suite.id}
              </button>
            </span>
            <span className="truncate font-mono text-caption text-text-2" role="cell" title={suite.runner}>{suite.runner}</span>
            <span role="cell" data-testid={`proj-suite-result-${suite.id}`}>
              {run === undefined ? <span className="text-text-3">—</span> : <ResultMark result={run.result} />}
            </span>
            <span className="font-mono text-caption text-text-2" role="cell" data-testid={`proj-suite-flaky-${suite.id}`}>
              {run === undefined ? '—' : run.totals.flaky}
            </span>
          </div>
        )
      })}
    </div>
  )
}

/** 项目页「测试」的中列：套件表（图标 + 名称 · 工具 · 最近结果 · 不稳定数）；没有目录时只给可复制的发现命令。 */
export function ProjectTestsList({ catalog, selectedId, onSelect, onRetry }: {
  catalog: Remote<TestCatalogResponse>
  selectedId: string | null
  onSelect: (id: string) => void
  onRetry: () => void
}): JSX.Element {
  const { t } = useT()
  if (catalog.status === 'loading') {
    return (
      <ul className="grid gap-2" role="status" aria-label={t('common.loading')} data-testid="proj-tests-loading">
        {[0, 1, 2].map((index) => <li key={index} className="h-11 animate-pulse rounded-md bg-fill motion-reduce:animate-none" />)}
      </ul>
    )
  }
  if (catalog.status === 'error') {
    return (
      <div className="flex min-w-0 items-center gap-3 rounded-md border border-red-b bg-red-t px-4 py-2" role="alert" data-testid="proj-tests-error">
        <span className="min-w-0 flex-1 truncate whitespace-nowrap text-body font-semibold text-red-d">{formatApiError(catalog.error, t)}</span>
        <button type="button" className={BUTTON_GHOST} data-testid="proj-tests-retry" onClick={onRetry}>{t('projects.retry')}</button>
      </div>
    )
  }
  const view = catalog.data.catalog
  if (view.state === 'invalid') {
    return (
      <ul className="grid gap-1" role="alert" data-testid="proj-tests-invalid">
        {view.issues.map((issue, index) => (
          <li key={`${index}-${issue}`} className="truncate whitespace-nowrap font-mono text-caption text-red-d" title={issue}>{issue}</li>
        ))}
      </ul>
    )
  }
  if (view.state === 'missing' || view.suites.length === 0) return <DiscoverEmpty />
  return <Rows suites={view.suites} latest={catalog.data.latest} selectedId={selectedId} onSelect={onSelect} />
}
