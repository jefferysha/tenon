import { useCallback, useEffect, useMemo, useState } from 'react'
import { useT } from '../i18n'
import { CanonicalStateVersionNotice } from '../progress/CanonicalStateVersionNotice'
import { SnapshotInlineError } from '../progress/SnapshotInlineError'
import { isProjectNavigable } from '../state/projectSelectionModel'
import type { WorkflowRules } from '../model/workflowModel'
import type { Snapshot, UserRefView } from '../types'
import { matchesQuery } from '../shell/GlobalSearch'
import { ThreeColumns } from '../shell/ThreeColumns'
import type { TopBarProject } from '../shell/TopBar'
import { ProjectRail } from './ProjectRail'
import { TaskActionDialog } from './TaskActionDialog'
import { TaskDetailPane } from './TaskDetailPane'
import { TaskListPane } from './TaskListPane'
import { archivedRowsOf, DEFAULT_TASK_FILTER, filterRows, isTaskStatus, rowsOf, uncommittedDeletionsOf, type TaskFilterState, type TaskRow, type TaskStatus } from './taskModel'
import { useTaskActions } from './useTaskActions'
import { useWorkflowIoLookup } from './useWorkflowDefinition'
import { readWorkspaceParam, TASK_STATUS_PARAM, writeWorkspaceParam } from './workspaceLocation'

export interface WorkspaceViewProps {
  snapshot: Snapshot | null
  /** 当前项目 root；'' = 聚合全部可读项目。 */
  currentRoot: string
  rulesByKey: ReadonlyMap<string, WorkflowRules>
  projects: readonly TopBarProject[]
  onSelectProject: (root: string) => void
  selectedChange: string | null
  onSelectedChange: (name: string | null) => void
  onToast?: (message: string) => void
  onRefresh?: () => void | Promise<void>
  staleError?: string | null
  loading?: boolean
  /** Current declared user for 我的 and 接手. */
  me?: UserRefView | null
  onUserMissing?: () => void
  /** 测试注入筛选栏宽度测量。 */
  measureWidth?: (element: HTMLElement) => number
}

const RAIL_KEY = 'tenon-dashboard-rail:workspace'

function matchesSearch(search: string, row: TaskRow): boolean {
  return matchesQuery(search, row.change.name, row.workflow, row.change.track, row.change.phase)
}

/** URL `status`（顶部徽标跳转带 `status=needs-you`）；非法值回到「全部」。 */
function statusFromUrl(): TaskStatus {
  const value = readWorkspaceParam(TASK_STATUS_PARAM)
  return isTaskStatus(value) ? value : 'all'
}

/** 工作台：左列项目 / 中列任务（单行筛选栏）/ 右列所选任务逐阶段的输出与输入。 */
export function WorkspaceView({
  snapshot, currentRoot, rulesByKey, projects, onSelectProject, selectedChange, onSelectedChange, onToast,
  staleError = null, loading = false, onRefresh, me = null, onUserMissing, measureWidth,
}: WorkspaceViewProps): JSX.Element {
  const { t } = useT()
  const [filter, setFilter] = useState<TaskFilterState>(() => ({ ...DEFAULT_TASK_FILTER, status: statusFromUrl() }))
  const [search, setSearch] = useState('')
  const [listMode, setListMode] = useState<'active' | 'archived'>('active')
  const [pending, setPending] = useState<{ root: string; change: string; action: 'archive' | 'delete' } | null>(null)
  const [railCollapsed, setRailCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(RAIL_KEY) === '1' } catch { return false }
  })
  useEffect(() => {
    try { localStorage.setItem(RAIL_KEY, railCollapsed ? '1' : '0') } catch { /* ignore */ }
  }, [railCollapsed])
  // 换项目只清维度筛选与搜索；状态筛选跨项目保留（徽标跳转可能同时带 root 与 status）。
  useEffect(() => {
    setFilter((current) => ({ ...DEFAULT_TASK_FILTER, status: current.status }))
    setSearch('')
    setListMode('active')
    setPending(null)
  }, [currentRoot])
  useEffect(() => { writeWorkspaceParam(TASK_STATUS_PARAM, filter.status === 'all' ? null : filter.status) }, [filter.status])
  // 前进 / 后退到带 status 的地址时跟随 URL。
  useEffect(() => {
    const onPop = (): void => setFilter((current) => ({ ...current, status: statusFromUrl() }))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  // 聚合语境（未选项目）不发 per-root 请求：卡片状态退回「进行中」，不判缺产出。
  const pairs = useMemo(() => {
    const out: Array<{ root: string; workflow: string }> = []
    if (currentRoot === '') return out
    for (const project of snapshot?.projects ?? []) {
      if (!isProjectNavigable(project) || project.root !== currentRoot) continue
      for (const change of [...project.changes, ...(project.archived ?? [])]) {
        const workflow = typeof change.fields.workflow === 'string' && change.fields.workflow !== '' ? change.fields.workflow : 'default'
        out.push({ root: project.root, workflow })
      }
    }
    return out
  }, [snapshot, currentRoot])
  const ioOf = useWorkflowIoLookup(pairs)
  const activeRows = useMemo(() => rowsOf({ snapshot, currentRoot, rulesByKey, ioOf, t }), [snapshot, currentRoot, rulesByKey, ioOf, t])
  const archivedRows = useMemo(() => archivedRowsOf({ snapshot, currentRoot, rulesByKey, ioOf, t }), [snapshot, currentRoot, rulesByKey, ioOf, t])
  const archivedView = listMode === 'archived'
  const rows = archivedView ? archivedRows : activeRows
  const deletions = uncommittedDeletionsOf(snapshot, currentRoot)
  const request = useCallback((row: TaskRow, action: 'archive' | 'delete') => setPending({ root: row.root, change: row.change.name, action }), [])
  const { menuOf, unarchive } = useTaskActions({ me, listMode, onToast, onRefresh, onUserMissing, onSelectedChange, onRequest: request })

  const compat = useMemo(() => {
    const scoped = (snapshot?.projects ?? []).filter((project) => isProjectNavigable(project) && (currentRoot === '' || project.root === currentRoot))
    return {
      issues: scoped.flatMap((project) => project.compatibilityIssues ?? []),
      truncated: scoped.some((project) => project.compatibilityIssuesTruncated === true),
    }
  }, [snapshot, currentRoot])
  const notice = (compat.issues.length > 0 || staleError !== null) ? (
    <div className="mb-4 grid gap-3">
      {staleError !== null && <SnapshotInlineError error={staleError} loading={loading} onRefresh={onRefresh} />}
      {compat.issues.length > 0 && <CanonicalStateVersionNotice issues={compat.issues} truncated={compat.truncated} loading={loading} onRefresh={onRefresh} />}
    </div>
  ) : undefined

  const visibleRows = useMemo(
    () => (archivedView ? rows : filterRows(rows, filter)).filter((row) => matchesSearch(search, row)),
    [archivedView, rows, filter, search],
  )
  const selectedRow: TaskRow | null = useMemo(() => {
    const explicit = selectedChange === null
      ? undefined
      : rows.find((row) => row.change.name === selectedChange && (currentRoot === '' || row.root === currentRoot))
    return explicit ?? visibleRows[0] ?? null
  }, [rows, visibleRows, selectedChange, currentRoot])

  const emptyKind = archivedView
    ? (rows.length === 0 ? 'no-archived' : 'filtered')
    : rows.length === 0
      ? (currentRoot === '' && projects.length === 0 ? 'no-project' : compat.issues.length > 0 ? 'compat' : 'no-task')
      : 'filtered'

  return (
    <>
    <ThreeColumns
      testId="workspace-view"
      railCollapsed={railCollapsed}
      rail={(
        <ProjectRail
          projects={projects}
          currentRoot={currentRoot}
          collapsed={railCollapsed}
          onToggle={() => setRailCollapsed((value) => !value)}
          onSelect={onSelectProject}
        />
      )}
      list={(
        <TaskListPane
          rows={rows}
          visibleRows={visibleRows}
          filter={filter}
          onFilter={setFilter}
          search={search}
          onSearch={setSearch}
          selectedKey={selectedRow?.key ?? null}
          onSelect={(row) => onSelectedChange(row.change.name)}
          showProject={currentRoot === ''}
          emptyKind={emptyKind}
          onClearFilters={() => { setFilter(DEFAULT_TASK_FILTER); setSearch('') }}
          notice={notice}
          me={me}
          listMode={listMode}
          onListMode={(next) => { setListMode(next); setSearch(''); onSelectedChange(null) }}
          archivedCount={archivedRows.length}
          uncommittedDeletions={deletions}
          menuOf={(row) => menuOf(row, 'card')}
          {...(archivedView ? { onUnarchive: (row: TaskRow) => { void unarchive(row) } } : {})}
          {...(measureWidth === undefined ? {} : { measureWidth })}
        />
      )}
      // 没有可选任务时不渲染右列内容：空态已在中列说明，右列再写「选一个任务」是重复。
      detail={selectedRow
        ? (
          <TaskDetailPane
            key={selectedRow.key}
            row={selectedRow}
            onToast={onToast}
            onRefresh={onRefresh}
            showReviewConsole={selectedChange !== null && currentRoot !== ''}
            fetchDefinition={currentRoot !== ''}
            menu={menuOf(selectedRow, 'detail')}
            archived={archivedView}
          />
        )
        : <section className="min-h-0 bg-surface-detail max-[900px]:hidden" aria-hidden="true" data-testid="task-detail-none" />}
    />
    {pending !== null && (
      <TaskActionDialog
        root={pending.root}
        change={pending.change}
        action={pending.action}
        onClose={() => setPending(null)}
        onDone={(message) => { onToast?.(message); onSelectedChange(null); void onRefresh?.() }}
      />
    )}
    </>
  )
}
