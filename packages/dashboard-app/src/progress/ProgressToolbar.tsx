import { useRef, type KeyboardEvent } from 'react'
import { ChevronDown, ListFilter } from 'lucide-react'
import { PageHeader } from '../shared/PageHeader'
import { SELECT } from '../shared/uiRecipes'
import { DECK_TABS, type DeckTab, type Tr } from './progressViewModel'

export interface ProgressToolbarProps {
  t: Tr
  rowCount: number
  deckTab: DeckTab
  deckCounts: Record<DeckTab, number>
  filterSummary: { shown: number; context: number }
  workflows: readonly string[]
  workflow: string
  onDeckTab: (tab: DeckTab) => void
  onWorkflow: (workflow: string) => void
  /** Deprecated compatibility prop; task creation remains terminal-only. */
  onCreate?: () => void
}

export function ProgressToolbar({
  t,
  rowCount,
  deckTab,
  deckCounts,
  filterSummary,
  workflows,
  workflow,
  onDeckTab,
  onWorkflow,
}: ProgressToolbarProps): JSX.Element {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  // Only expose filters that can currently match something. Keep the selected tab mounted
  // while its count drops to zero so a live update never silently changes the user's context.
  const visibleTabs = DECK_TABS.filter((tab) => tab === 'all' || deckCounts[tab] > 0 || deckTab === tab)

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    let nextIndex: number
    switch (event.key) {
      case 'ArrowRight':
        nextIndex = (index + 1) % visibleTabs.length
        break
      case 'ArrowLeft':
        nextIndex = (index - 1 + visibleTabs.length) % visibleTabs.length
        break
      case 'Home':
        nextIndex = 0
        break
      case 'End':
        nextIndex = visibleTabs.length - 1
        break
      default:
        return
    }
    event.preventDefault()
    const nextTab = visibleTabs[nextIndex]
    onDeckTab(nextTab)
    tabRefs.current[nextIndex]?.focus()
  }

  return (
    <>
      <PageHeader
        title={t('progress.title')}
        className="mb-4"
        testId="prg-hero"
        animation="prg-chrome"
      />
      {rowCount > 0 && (
        <div className="mb-5" data-anim="prg-chrome" data-testid="prg-filterbar">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="min-w-0 max-w-full overflow-x-auto pb-1 [scrollbar-width:thin]">
              <div
                className="inline-flex w-max items-center gap-1 rounded-xl bg-fill/65 p-1 ring-1 ring-border"
                role="tablist"
                aria-label={t('progress.tabs_label')}
                data-testid="prg9t-tabs"
              >
                {visibleTabs.map((tab, index) => (
                  <button
                    key={tab}
                    ref={(node) => { tabRefs.current[index] = node }}
                    type="button"
                    role="tab"
                    tabIndex={deckTab === tab ? 0 : -1}
                    className="group flex min-h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-[13px] font-semibold text-text-3 transition-colors hover:text-text aria-selected:bg-card aria-selected:text-text aria-selected:shadow-sm"
                    aria-selected={deckTab === tab}
                    data-testid={`prg9t-tab-${tab}`}
                    onClick={() => onDeckTab(tab)}
                    onKeyDown={(event) => handleTabKeyDown(event, index)}
                  >
                    {t(`progress.tab_${tab}`)}
                    <span className="inline-flex min-w-[18px] items-center justify-center rounded-full bg-card px-1.5 font-mono text-[11px] leading-[18px] text-text-3 group-aria-selected:bg-(--accent) group-aria-selected:text-btn-fg" data-testid={`prg9t-n-${tab}`}>
                      {deckCounts[tab]}
                    </span>
                  </button>
                ))}
              </div>
            </div>
            {workflows.length > 1 && (
              <label className="relative max-[760px]:basis-full">
                <span className="sr-only">{t('progress.workflow_filter')}</span>
                <select
                  className={`${SELECT} min-w-[180px] py-2.5 text-[13px] font-semibold max-[760px]:w-full`}
                  data-testid="prg-workflow-select"
                  value={workflow}
                  onChange={(event) => onWorkflow(event.target.value)}
                >
                  <option value="all">{t('progress.wf_all')}</option>
                  {workflows.map((name) => <option key={name} value={name}>{name}</option>)}
                </select>
                <ChevronDown className="pointer-events-none absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 text-text-3" aria-hidden="true" />
              </label>
            )}
          </div>
          {deckTab !== 'all' && (
            <p
              className="mt-2 flex items-center gap-1.5 px-1 text-xs font-medium text-text-3"
              role="status"
              aria-live="polite"
              aria-atomic="true"
              data-testid="prg-filter-status"
            >
              <ListFilter className="h-3.5 w-3.5 text-(--accent)" aria-hidden="true" />
              {t('progress.filter_summary', {
                shown: filterSummary.shown,
                context: filterSummary.context,
              })}
            </p>
          )}
        </div>
      )}
    </>
  )
}
