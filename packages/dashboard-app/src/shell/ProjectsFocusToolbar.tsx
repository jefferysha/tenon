import { useRef, type KeyboardEvent, type RefObject } from 'react'
import { Search, X } from 'lucide-react'
import { PROJECT_FOCUS_OPTIONS, type ProjectFocus, type ProjectFocusCounts } from './projectsFocusModel'
import { BUTTON_GHOST, PANEL } from '../shared/uiRecipes'

type Tr = (key: string, vars?: Record<string, string | number>) => string

export interface ProjectsFocusToolbarProps {
  t: Tr
  query: string
  focus: ProjectFocus
  counts: ProjectFocusCounts
  shown: number
  total: number
  searchRef: RefObject<HTMLInputElement>
  onQuery: (query: string) => void
  onFocus: (focus: ProjectFocus) => void
  onClear: () => void
}

export function ProjectsFocusToolbar({
  t,
  query,
  focus,
  counts,
  shown,
  total,
  searchRef,
  onQuery,
  onFocus,
  onClear,
}: ProjectsFocusToolbarProps): JSX.Element {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const hasConditions = query.trim().length > 0 || focus !== 'all'
  const attentionTone = counts.attention > 0 ? 'border-(--accent) bg-accent-t text-accent-d' : 'border-border bg-fill text-text-2'
  const runningTone = counts.running > 0 ? 'border-green-b bg-green-t text-green-d' : 'border-border bg-fill text-text-2'
  const unreachableTone = counts.unreachable > 0 ? 'border-amber-b bg-amber-t text-amber-d' : 'border-border bg-fill text-text-2'

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    let nextIndex: number
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        nextIndex = (index + 1) % PROJECT_FOCUS_OPTIONS.length
        break
      case 'ArrowLeft':
      case 'ArrowUp':
        nextIndex = (index - 1 + PROJECT_FOCUS_OPTIONS.length) % PROJECT_FOCUS_OPTIONS.length
        break
      case 'Home':
        nextIndex = 0
        break
      case 'End':
        nextIndex = PROJECT_FOCUS_OPTIONS.length - 1
        break
      default:
        return
    }
    event.preventDefault()
    const nextFocus = PROJECT_FOCUS_OPTIONS[nextIndex]
    onFocus(nextFocus)
    tabRefs.current[nextIndex]?.focus()
  }

  return (
    <section className={`mb-7 ${PANEL} p-4`} data-testid="projects-focus-toolbar">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-bold ${attentionTone}`}>
          {t('projects.focus_attention')} {counts.attention}
        </span>
        <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-bold ${runningTone}`}>
          {t('projects.focus_running')} {counts.running}
        </span>
        <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-bold ${unreachableTone}`}>
          {t('projects.focus_unreachable')} {counts.unreachable}
        </span>
        <p
          role="status"
          aria-label={t('projects.results_label')}
          aria-live="polite"
          aria-atomic="true"
          className="ml-auto text-[12px] font-medium text-text-3"
        >
          {t('projects.result_summary', { focus: t(`projects.focus_${focus}`), shown, total })}
        </p>
      </div>

      <div className="mt-4 grid gap-3 xl:grid-cols-[minmax(0,1fr)_auto]">
        <div className="relative min-w-0 flex-1">
          <label className="sr-only" htmlFor="projects-focus-search">
            {t('projects.search_label')}
          </label>
          <Search
            aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-text-3"
          />
          <input
            ref={searchRef}
            id="projects-focus-search"
            type="text"
            role="searchbox"
            value={query}
            placeholder={t('projects.search_placeholder')}
            onChange={(event) => onQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Escape' || !query) return
              event.preventDefault()
              onQuery('')
            }}
            className="h-11 w-full rounded-xl border border-border bg-card pr-10 pl-10 text-[14px] text-text outline-none transition-[border-color,box-shadow,background-color] placeholder:text-text-3 hover:border-border-2 focus-visible:border-(--accent) focus-visible:ring-2 focus-visible:ring-(--accent) focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
          />
          {query && (
            <button
              type="button"
              aria-label={t('projects.clear_query')}
              title={t('projects.clear_query')}
              onClick={() => {
                onQuery('')
                searchRef.current?.focus()
              }}
              className="absolute top-1/2 right-2.5 inline-flex size-8 -translate-y-1/2 items-center justify-center rounded-lg text-text-3 transition-[background-color,color] hover:bg-fill hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent)"
            >
              <X aria-hidden="true" className="h-4 w-4" />
            </button>
          )}
        </div>

        <div className="max-w-full overflow-x-auto py-0.5 [scrollbar-width:thin]">
          <div
            role="radiogroup"
            aria-label={t('projects.filters_label')}
            className="inline-flex w-max items-center gap-1 rounded-full border border-border bg-fill/80 p-1.5"
          >
            {PROJECT_FOCUS_OPTIONS.map((option, index) => (
              <button
                key={option}
                ref={(node) => {
                  tabRefs.current[index] = node
                }}
                type="button"
                role="radio"
                tabIndex={focus === option ? 0 : -1}
                aria-checked={focus === option}
                data-testid={`projects-focus-${option}`}
                onClick={() => onFocus(option)}
                onKeyDown={(event) => handleTabKeyDown(event, index)}
                className={`group flex min-h-10 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent) focus-visible:ring-offset-1 focus-visible:ring-offset-fill ${
                  option === 'attention'
                    ? 'text-text-2 hover:text-text aria-checked:bg-(--accent) aria-checked:text-btn-fg aria-checked:shadow-sm'
                    : 'text-text-3 hover:text-text aria-checked:bg-card aria-checked:text-text aria-checked:shadow-sm'
                }`}
              >
                {t(`projects.focus_${option}`)}
                <span className="inline-flex min-w-[19px] items-center justify-center rounded-full bg-card px-1.5 font-mono text-[11px] leading-[19px] text-text-3 group-aria-checked:bg-(--accent) group-aria-checked:text-btn-fg">
                  {counts[option]}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-4 flex min-h-7 flex-wrap items-center justify-end gap-2">
        {hasConditions && shown > 0 && (
          <button
            type="button"
            onClick={onClear}
            className={`${BUTTON_GHOST} min-h-8 px-3 py-1.5 text-[12px] font-semibold`}
          >
            {t('projects.clear_filters')}
          </button>
        )}
      </div>
    </section>
  )
}
