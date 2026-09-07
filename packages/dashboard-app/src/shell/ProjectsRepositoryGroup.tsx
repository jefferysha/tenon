import { ChevronDown, ChevronRight } from 'lucide-react'
import type { PhaseCell, ProjectRow, RepositoryGroup } from './projectsModel'
import { PANEL } from '../shared/uiRecipes'

type Tr = (key: string, vars?: Record<string, string | number>) => string

function MiniTrack({ rowId, cells, t }: { rowId: string; cells: PhaseCell[]; t: Tr }): JSX.Element {
  let current: PhaseCell | undefined
  for (const cell of cells) if (cell.count > 0) current = cell
  return (
    <span data-testid={`${rowId}-track`} className="col-start-2 col-end-4 row-start-2 flex w-full min-w-0 flex-1 items-center gap-3 overflow-hidden sm:w-auto">
      <span data-testid={`${rowId}-at`} data-started={current ? 'true' : 'false'} className="flex-none whitespace-nowrap text-[14px] font-medium text-text-2">
        {current ? t('projects.mini_at', { phase: current.label }) : t('projects.mini_none')}
      </span>
      <span aria-hidden="true" className="hidden flex-none items-center gap-0 min-[560px]:flex">
        {cells.map((cell, index) => (
          <span key={cell.phase} className="flex flex-none items-center">
            {index > 0 && <span className={`h-px w-3 flex-none ${cell.state === 'todo' ? 'bg-border' : 'bg-border-2'}`} />}
            <span
              data-phase={cell.phase}
              data-state={cell.state}
              data-count={cell.count}
              title={cell.count > 0 ? `${cell.label} · ${cell.count}` : cell.label}
              className={`flex-none rounded-full ${cell.state === 'current'
                ? 'h-2 w-2 bg-(--accent)'
                : cell.state === 'done'
                  ? 'h-[7px] w-[7px] bg-border-2'
                  : 'h-[7px] w-[7px] border border-border bg-transparent'}`}
            />
          </span>
        ))}
      </span>
    </span>
  )
}

function HealthSummary({ rowId, wip, need, running, t }: {
  rowId: string
  wip: number
  need: number
  running: number
  t: Tr
}): JSX.Element {
  return (
    <span className="col-start-2 col-end-4 row-start-3 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[13px] tabular-nums sm:flex-none sm:flex-nowrap" data-testid={`${rowId}-summary`}>
      <span data-testid={`${rowId}-stat-wip`} data-value={wip} className="text-text-3">
        {t('projects.stat_wip')} <span className="font-semibold text-text-2">{wip}</span>
      </span>
      {need > 0 && <span data-testid={`${rowId}-stat-need`} data-value={need} className="text-text-3">{t('projects.stat_need')} <span className="font-semibold text-red-d">{need}</span></span>}
      {running > 0 && <span data-testid={`${rowId}-stat-running`} data-value={running} className="text-text-3">{t('projects.stat_running')} <span className="font-semibold text-green-d">{running}</span></span>}
    </span>
  )
}

function WorkspaceButton({ rowId, row, visibleRoot, onOpen, t }: {
  rowId: string
  row: ProjectRow
  visibleRoot: string
  onOpen: (root: string) => void
  t: Tr
}): JSX.Element {
  const need = row.need > 0
  return (
    <button
      type="button"
      id={`project-row-${encodeURIComponent(row.root)}`}
      data-anim="pv-item"
      data-testid={rowId}
      data-ok="true"
      data-need={need}
      aria-label={t('projects.open_aria', { name: row.basename, root: row.root })}
      onClick={() => onOpen(row.root)}
      className={`group grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-3 rounded-[18px] border px-4 py-4 text-left shadow-sm transition-[border-color,background-color,transform] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent) active:scale-[.995] motion-reduce:transform-none sm:flex sm:flex-nowrap sm:gap-4 sm:px-5 ${need ? 'border-accent-b bg-accent-t/45 hover:border-(--accent)' : 'border-border bg-card hover:border-border-2 hover:bg-fill/60'}`}
    >
      <span aria-hidden="true" className={`col-start-1 row-start-1 h-2 w-2 flex-none rounded-full ${need ? 'bg-(--accent)' : 'border border-border-2 bg-transparent'}`} />
      <span className="col-start-2 row-start-1 flex min-w-0 flex-col sm:w-[240px] sm:flex-none">
        <span className="flex items-center gap-2 truncate font-mono text-[16px] font-bold tracking-[-0.01em] text-text group-hover:text-(--accent)">
          {row.basename}
          {row.workspaceKind && <span className="rounded-md bg-fill px-1.5 py-0.5 text-[10px] font-semibold text-text-3">{t(`projects.workspace_${row.workspaceKind}`)}</span>}
        </span>
        <span className="truncate font-mono text-[11px] text-text-3" title={row.root}>{visibleRoot}</span>
      </span>
      <MiniTrack rowId={rowId} cells={row.cells} t={t} />
      <HealthSummary rowId={rowId} wip={row.wip} need={row.need} running={row.running} t={t} />
      <ChevronRight aria-hidden="true" className="col-start-3 row-start-1 h-4 w-4 flex-none text-text-3 opacity-70 transition-opacity group-hover:opacity-100 sm:opacity-0" />
    </button>
  )
}

export interface ProjectsRepositoryGroupProps {
  group: RepositoryGroup
  expanded: boolean
  visibleRoots: ReadonlyMap<string, string>
  rowId: (row: ProjectRow) => string
  onExpanded: (expanded: boolean) => void
  onOpen: (root: string) => void
  onInstall: (root: string) => void
  t: Tr
}

export function ProjectsRepositoryGroup({ group, expanded, visibleRoots, rowId, onExpanded, onOpen, onInstall, t }: ProjectsRepositoryGroupProps): JSX.Element {
  return (
    <div data-testid={`repository-group-${group.id}`} data-anim="pv-item" className={`${PANEL} p-2.5`}>
      <button
        type="button"
        data-testid={`repository-toggle-${group.id}`}
        aria-expanded={expanded}
        onClick={() => onExpanded(!expanded)}
        className="flex w-full items-start gap-3 rounded-[18px] px-2.5 py-2 text-left transition-[background-color] hover:bg-fill focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent)"
      >
        {expanded ? <ChevronDown aria-hidden="true" className="h-4 w-4 text-text-3" /> : <ChevronRight aria-hidden="true" className="h-4 w-4 text-text-3" />}
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-[15px] font-bold text-text">{group.label}</span>
          <span className="mt-0.5 block text-[12px] text-text-3">{t('projects.workspace_count', { n: group.workspaceCount })}</span>
        </span>
        <HealthSummary rowId={`repository-${group.id}`} wip={group.wip} need={group.need} running={group.running} t={t} />
      </button>
      {expanded && <div className="mt-2 flex flex-col gap-2.5">{group.workspaces.map((row) => (
        <div key={row.root} className="flex min-w-0 items-stretch gap-2">
          <WorkspaceButton rowId={rowId(row)} row={row} visibleRoot={visibleRoots.get(row.root) ?? row.root} onOpen={onOpen} t={t} />
          <button type="button" className="flex-none rounded-xl border border-border bg-card px-3 text-xs font-semibold text-text-2 transition-colors hover:border-(--accent) hover:text-(--accent) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent)" onClick={() => onInstall(row.root)} aria-label={t('hostPlan.installer.open_aria', { name: row.basename })}>{t('hostPlan.installer.open')}</button>
        </div>
      ))}</div>}
    </div>
  )
}
