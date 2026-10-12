import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FlashAction } from '../shared/useFlash'
import { useT } from '../i18n'
import { CanonicalStateVersionNotice } from '../progress/CanonicalStateVersionNotice'
import { SnapshotInlineError } from '../progress/SnapshotInlineError'
import { isProjectNavigable } from '../state/projectSelectionModel'
import { useChangeDetail } from '../state/useChangeDetail'
import type { WorkflowRules } from '../model/workflowModel'
import type { Snapshot, UserRefView } from '../types'
import { matchesQuery } from '../shell/GlobalSearch'
import { ThreeColumns } from '../shell/ThreeColumns'
import type { TopBarProject } from '../shell/TopBar'
import { EndedDetail } from './EndedDetail'
import { endedCountOf, endedRowsOf, type EndedRow } from './endedModel'
import { ProjectRail } from './ProjectRail'
import { TaskActionDialog } from './TaskActionDialog'
import { TaskDetailPane } from './TaskDetailPane'
import { DEFAULT_TASK_FILTER, filterEnded, filterRows, isTaskStatus, type TaskFilterState, type TaskStatus } from './taskFilter'
import { TaskListPane } from './TaskListPane'
import { rowsOf, uncommittedDeletionsOf, type TaskRow } from './taskModel'
import { matchesTaskRef, taskRef } from './taskRef'
import { useTaskActions } from './useTaskActions'
import { readWorkspaceParam, writeWorkspaceParam } from './workspaceLocation'
import { TASK_STATUS_PARAM } from '../shell/views'

export interface WorkspaceViewProps {
  snapshot: Snapshot | null
  /** 当前项目 root；'' = 聚合全部可读项目。 */
  currentRoot: string
  rulesByKey: ReadonlyMap<string, WorkflowRules>
  projects: readonly TopBarProject[]
  onSelectProject: (root: string) => void
  selectedChange: string | null
  onSelectedChange: (name: string | null) => void
  /** 带 action 的提示。 */
  onToast?: (message: string, action?: FlashAction) => void
  /** 操作成功但服务端带警告时用：比普通提示醒目；没接则退回 onToast。 */
  onAlert?: (message: string) => void
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

function matchesEndedSearch(search: string, row: EndedRow): boolean {
  return matchesQuery(search, row.task.name, row.task.workflow, row.task.track)
}

/** URL `change` 引用的身份：活跃任务是任务名，已结束的任务是归档目录名。 */
function endedIdentity(row: EndedRow): { root: string; change: { name: string } } {
  return { root: row.root, change: { name: row.dir } }
}

type Selected = { kind: 'task'; row: TaskRow } | { kind: 'ended'; row: EndedRow }

/** URL `status`（顶部徽标跳转带 `status=needs-you`）；非法值回到「全部」。 */
function statusFromUrl(): TaskStatus {
  const value = readWorkspaceParam(TASK_STATUS_PARAM)
  return isTaskStatus(value) ? value : 'all'
}

/** 工作台：左列项目 / 中列任务（单行筛选栏）/ 右列所选任务逐阶段的输出与输入。 */
export function WorkspaceView({
  snapshot, currentRoot, rulesByKey, projects, onSelectProject, selectedChange, onSelectedChange, onToast, onAlert,
  staleError = null, loading = false, onRefresh, me = null, onUserMissing,
}: WorkspaceViewProps): JSX.Element {
  const { t } = useT()
  const [filter, setFilter] = useState<TaskFilterState>(() => ({ ...DEFAULT_TASK_FILTER, status: statusFromUrl() }))
  const [search, setSearch] = useState('')
  const [pending, setPending] = useState<{ root: string; change: string; action: 'terminate' | 'delete' | 'take' } | null>(null)
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
    setPending(null)
  }, [currentRoot])
  useEffect(() => { writeWorkspaceParam(TASK_STATUS_PARAM, filter.status === 'all' ? null : filter.status) }, [filter.status])
  // 前进 / 后退到带 status 的地址时跟随 URL。
  useEffect(() => {
    const onPop = (): void => setFilter((current) => ({ ...current, status: statusFromUrl() }))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  // 行状态只读快照：所有项目与单项目视图、工作流定义加载前后都是同一份判定。
  const rows = useMemo(() => rowsOf({ snapshot, currentRoot, rulesByKey, t }), [snapshot, currentRoot, rulesByKey, t])
  const ended = useMemo(() => endedRowsOf({ snapshot, currentRoot }), [snapshot, currentRoot])
  const endedCount = useMemo(() => endedCountOf(snapshot, currentRoot), [snapshot, currentRoot])
  const deletions = uncommittedDeletionsOf(snapshot, currentRoot)
  const request = useCallback((row: TaskRow, action: 'terminate' | 'delete' | 'take') => setPending({ root: row.root, change: row.change.name, action }), [])
  const { menuOf, endedMenuOf } = useTaskActions({ me, onToast, onRequest: request })

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

  const visibleRows = useMemo(() => filterRows(rows, filter).filter((row) => matchesSearch(search, row)), [rows, filter, search])
  const visibleEnded = useMemo(() => filterEnded(ended, filter).filter((row) => matchesEndedSearch(search, row)), [ended, filter, search])
  const selected: Selected | null = useMemo(() => {
    if (selectedChange !== null) {
      const task = rows.find((row) => matchesTaskRef(selectedChange, row) && (currentRoot === '' || row.root === currentRoot))
      if (task !== undefined) return { kind: 'task', row: task }
      const done = ended.find((row) => matchesTaskRef(selectedChange, endedIdentity(row)) && (currentRoot === '' || row.root === currentRoot))
      if (done !== undefined) return { kind: 'ended', row: done }
    }
    const first = visibleRows[0]
    if (first !== undefined) return { kind: 'task', row: first }
    const firstEnded = visibleEnded[0]
    return firstEnded === undefined ? null : { kind: 'ended', row: firstEnded }
  }, [rows, ended, visibleRows, visibleEnded, selectedChange, currentRoot])
  const selectedRow: TaskRow | null = selected?.kind === 'task' ? selected.row : null

  // The list snapshot leaves out the evidence; the open task reads it on demand and again when its `rev` moves.
  const detail = useChangeDetail(selectedRow?.root ?? '', selectedRow?.change.name ?? '', selectedRow?.change.rev)
  const detailRow: TaskRow | null = selectedRow !== null && detail.state.status === 'ready'
    ? { ...selectedRow, change: detail.state.change }
    : selectedRow

  const emptyKind = rows.length === 0 && ended.length === 0
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
          ended={ended}
          visibleRows={visibleRows}
          visibleEnded={visibleEnded}
          endedCount={endedCount}
          filter={filter}
          onFilter={setFilter}
          search={search}
          onSearch={setSearch}
          selectedKey={selected?.row.key ?? null}
          onSelect={(row) => onSelectedChange(taskRef('task' in row ? endedIdentity(row) : row, currentRoot === ''))}
          showProject={currentRoot === ''}
          emptyKind={emptyKind}
          onClearFilters={() => { setFilter(DEFAULT_TASK_FILTER); setSearch('') }}
          notice={notice}
          me={me}
          uncommittedDeletions={deletions}
          menuOf={menuOf}
        />
      )}
      // 默认选中第一项；列表为空时右列收起（空态已在中列说明）。
      detail={selected?.kind === 'ended'
        ? <EndedDetail key={selected.row.key} row={selected.row} rulesByKey={rulesByKey} menu={endedMenuOf(selected.row)} />
        : selectedRow && detailRow
          ? (
            <TaskDetailPane
              key={selectedRow.key}
              row={detailRow}
              onToast={onToast}
              onRefresh={onRefresh}
              menu={menuOf(selectedRow)}
              {...(detail.state.status === 'loading'
                ? { evidence: { status: 'loading' as const } }
                : detail.state.status === 'error'
                  ? { evidence: { status: 'error' as const, error: detail.state.error, onRetry: detail.retry } }
                  : {})}
            />
          )
          : null}
    />
    {pending !== null && (
      <TaskActionDialog
        root={pending.root}
        change={pending.change}
        action={pending.action}
        onClose={() => setPending(null)}
        {...(onUserMissing === undefined ? {} : { onUserMissing })}
        onDone={(message, warnings = []) => {
          const done = pending
          if (done === null) return
          // 终止不可撤销（想继续就新建任务并 depends_on），所以不带「撤销」。
          if (warnings.length > 0 && onAlert !== undefined) {
            onAlert(t('workspace.done_with_warnings', { done: message, detail: warnings.join('；') }))
          } else {
            onToast?.(message)
          }
          if (done.action !== 'take') onSelectedChange(null)
          void onRefresh?.()
        }}
      />
    )}
    </>
  )
}
