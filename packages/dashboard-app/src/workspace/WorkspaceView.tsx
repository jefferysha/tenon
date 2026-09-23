import { useEffect, useMemo, useState } from 'react'
import { useT } from '../i18n'
import { CanonicalStateVersionNotice } from '../progress/CanonicalStateVersionNotice'
import { SnapshotInlineError } from '../progress/SnapshotInlineError'
import { isProjectNavigable } from '../state/projectSelectionModel'
import type { WorkflowRules } from '../model/workflowModel'
import type { Snapshot, UserRefView } from '../types'
import { matchesQuery } from '../shell/GlobalSearch'
import { DetailEmpty, ThreeColumns } from '../shell/ThreeColumns'
import type { TopBarProject } from '../shell/TopBar'
import { ProjectRail } from './ProjectRail'
import { TaskActionDialog } from './TaskActionDialog'
import { TaskDetailPane } from './TaskDetailPane'
import { TaskListPane } from './TaskListPane'
import { archivedRowsOf, DEFAULT_TASK_FILTER, filterRows, rootBasename, rowsOf, uncommittedDeletionsOf, type TaskFilterState, type TaskRow } from './taskModel'
import { unarchiveTask } from '../api/taskLifecycleClient'
import { formatApiError } from '../api/transport'
import { useWorkflowIoLookup } from './useWorkflowDefinition'

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
}

const RAIL_KEY = 'tenon-dashboard-rail:workspace'

function matchesSearch(search: string, row: TaskRow): boolean {
  return matchesQuery(search, row.change.name, row.workflow, row.change.track, row.change.phase)
}

/** 工作台：左列项目 / 中列任务（按阶段筛选）/ 右列所选任务逐阶段的输出与输入。只读。 */
export function WorkspaceView({
  snapshot, currentRoot, rulesByKey, projects, onSelectProject, selectedChange, onSelectedChange, onToast,
  staleError = null, loading = false, onRefresh, me = null, onUserMissing,
}: WorkspaceViewProps): JSX.Element {
  const { t } = useT()
  const [filter, setFilter] = useState<TaskFilterState>(DEFAULT_TASK_FILTER)
  const [search, setSearch] = useState('')
  const [listMode, setListMode] = useState<'active' | 'archived'>('active')
  const [pending, setPending] = useState<{ change: string; action: 'archive' | 'delete' } | null>(null)
  const [railCollapsed, setRailCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(RAIL_KEY) === '1' } catch { return false }
  })
  useEffect(() => {
    try { localStorage.setItem(RAIL_KEY, railCollapsed ? '1' : '0') } catch { /* ignore */ }
  }, [railCollapsed])
  useEffect(() => { setFilter(DEFAULT_TASK_FILTER); setSearch(''); setListMode('active'); setPending(null) }, [currentRoot])

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
  // 归档 / 删除 need a selected project: the aggregate view issues only /api/snapshot.
  const canAct = currentRoot !== ''

  async function unarchive(row: TaskRow): Promise<void> {
    try {
      await unarchiveTask({ root: row.root, change: row.change.name })
      onToast?.(t('workspace.done_unarchived', { name: row.change.name }))
      onSelectedChange(null)
      await onRefresh?.()
    } catch (error) {
      onToast?.(formatApiError(error, t, { exposeServerDetail: true }))
    }
  }

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
  // 只剩已完结任务被「含已完结」关掉时，空态要说出它们在哪，而不是「还没有任务」。
  const hiddenCompleted = archivedView || filter.includeCompleted
    ? 0
    : filterRows(rows, { ...filter, includeCompleted: true }).filter((row) => row.archived && matchesSearch(search, row)).length
  const selectedRow: TaskRow | null = useMemo(() => {
    const explicit = selectedChange === null
      ? undefined
      : rows.find((row) => row.change.name === selectedChange && (currentRoot === '' || row.root === currentRoot))
    return explicit ?? visibleRows[0] ?? null
  }, [rows, visibleRows, selectedChange, currentRoot])

  const currentProject = projects.find((project) => project.root === currentRoot)
  const eyebrow = currentRoot === ''
    ? t('workspace.eyebrow_all')
    : t('workspace.eyebrow_project', { project: (currentProject?.name ?? rootBasename(currentRoot)).toUpperCase() })
  const emptyKind = archivedView
    ? (rows.length === 0 ? 'no-archived' : 'filtered')
    : rows.length === 0
      ? (currentRoot === '' && projects.length === 0 ? 'no-project' : compat.issues.length > 0 ? 'compat' : 'no-task')
      : hiddenCompleted > 0 ? 'completed' : 'filtered'

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
          eyebrow={eyebrow}
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
          hiddenCompleted={hiddenCompleted}
          onClearFilters={() => { setFilter(DEFAULT_TASK_FILTER); setSearch('') }}
          notice={notice}
          me={me}
          listMode={listMode}
          onListMode={(next) => { setListMode(next); setSearch(''); onSelectedChange(null) }}
          archivedCount={archivedRows.length}
          uncommittedDeletions={deletions}
          {...(canAct ? { onAction: (row: TaskRow, action: 'archive' | 'delete') => setPending({ change: row.change.name, action }) } : {})}
          {...(canAct && archivedView ? { onUnarchive: (row: TaskRow) => { void unarchive(row) } } : {})}
        />
      )}
      detail={selectedRow
        ? (
          <TaskDetailPane
            key={selectedRow.key}
            row={selectedRow}
            onToast={onToast}
            onRefresh={onRefresh}
            showReviewConsole={selectedChange !== null && currentRoot !== ''}
            fetchDefinition={currentRoot !== ''}
            me={me}
            onUserMissing={onUserMissing}
            {...(canAct && !archivedView ? { onAction: (action: 'archive' | 'delete') => setPending({ change: selectedRow.change.name, action }) } : {})}
            {...(canAct && archivedView ? { onUnarchive: () => { void unarchive(selectedRow) } } : {})}
          />
        )
        : <DetailEmpty title={t('workspace.no_selection')} desc="" testId="task-detail-empty" />}
    />
    {pending !== null && (
      <TaskActionDialog
        root={currentRoot}
        change={pending.change}
        action={pending.action}
        onClose={() => setPending(null)}
        onDone={(message) => { onToast?.(message); onSelectedChange(null); void onRefresh?.() }}
      />
    )}
    </>
  )
}
