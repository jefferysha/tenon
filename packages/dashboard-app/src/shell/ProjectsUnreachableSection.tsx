import { ChevronDown, ChevronRight } from 'lucide-react'
import type { ProjectRow } from './projectsModel'
import { BUTTON_GHOST, PANEL } from '../shared/uiRecipes'

type Tr = (key: string, vars?: Record<string, string | number>) => string

export interface ProjectsUnreachableSectionProps {
  rows: readonly ProjectRow[]
  expanded: boolean
  forcedOpen: boolean
  visibleRoots: ReadonlyMap<string, string>
  rowId: (row: ProjectRow) => string
  t: Tr
  onExpanded: (expanded: boolean) => void
  cleanupBusy: boolean
  cleanupFailureCount: number
  onBatchUnregister: () => void
}

function UnreachableRows({
  rows,
  visibleRoots,
  rowId,
  t,
}: Pick<ProjectsUnreachableSectionProps, 'rows' | 'visibleRoots' | 'rowId' | 't'>): JSX.Element {
  return (
    <div className="mt-2 flex flex-col gap-1">
      {rows.map((row) => (
        <div
          key={row.root}
          id={`project-row-${encodeURIComponent(row.root)}`}
          data-testid={rowId(row)}
          data-anim="pv-item"
          data-ok="false"
          role="group"
          aria-label={t('projects.unreachable_aria', {
            name: row.basename,
            root: row.root,
          })}
          aria-disabled="true"
          className="flex items-center gap-3.5 rounded-xl px-3.5 py-2.5"
        >
          <span aria-hidden="true" className="h-2 w-2 flex-none rounded-full border border-border-2 bg-transparent" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate font-mono text-[14px] text-text-2">{row.basename}</span>
            <span className="truncate font-mono text-[11px] text-text-3" title={row.root}>
              {visibleRoots.get(row.root) ?? row.root}
            </span>
          </span>
          <span className="flex-none text-[12px] font-semibold text-text-3">{t('projects.unreachable')}</span>
        </div>
      ))}
    </div>
  )
}

export function ProjectsUnreachableSection({
  rows,
  expanded,
  forcedOpen,
  visibleRoots,
  rowId,
  t,
  onExpanded,
  cleanupBusy,
  cleanupFailureCount,
  onBatchUnregister,
}: ProjectsUnreachableSectionProps): JSX.Element {
  const open = forcedOpen || expanded
  return (
    <div data-testid="section-unreachable" data-anim="pv-item" className={`${PANEL} p-3`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        {forcedOpen ? (
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <span className="text-[13px] font-bold text-text-3">
              {t('projects.unreachable_fold', { n: rows.length })}
            </span>
            <span className="h-px flex-1 bg-border" aria-hidden="true" />
          </div>
        ) : (
          <button
            type="button"
            data-testid="unreachable-toggle"
            aria-expanded={expanded}
            onClick={() => onExpanded(!expanded)}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-[13px] text-text-3 transition-colors hover:text-text-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent)"
          >
            {expanded ? (
              <ChevronDown aria-hidden="true" className="h-4 w-4 flex-none" />
            ) : (
              <ChevronRight aria-hidden="true" className="h-4 w-4 flex-none" />
            )}
            <span>{t('projects.unreachable_fold', { n: rows.length })}</span>
          </button>
        )}
        <button
          type="button"
          data-testid="unreachable-batch-unregister"
          disabled={cleanupBusy}
          onClick={onBatchUnregister}
          className={`${BUTTON_GHOST} min-h-8 px-3 py-1.5 text-[12px] font-semibold`}
        >
          {cleanupBusy ? t('projects.cleanup_running') : t('projects.cleanup_action', { n: rows.length })}
        </button>
      </div>
      {cleanupFailureCount > 0 && (
        <p data-testid="unreachable-cleanup-error" role="status" className="mt-2 text-[12px] text-red-d">
          {t('projects.cleanup_partial', { n: cleanupFailureCount })}
        </p>
      )}
      {open && <UnreachableRows rows={rows} visibleRoots={visibleRoots} rowId={rowId} t={t} />}
    </div>
  )
}
