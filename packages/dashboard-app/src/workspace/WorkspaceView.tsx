import { useEffect, useMemo, useState } from 'react'
import { useT } from '../i18n'
import { CanonicalStateVersionNotice } from '../progress/CanonicalStateVersionNotice'
import { SnapshotInlineError } from '../progress/SnapshotInlineError'
import { isProjectNavigable } from '../state/projectSelectionModel'
import type { WorkflowRules } from '../model/workflowModel'
import type { Snapshot } from '../types'
import { matchesQuery, useGlobalSearch } from '../shell/GlobalSearch'
import { DetailEmpty, ThreeColumns } from '../shell/ThreeColumns'
import type { TopBarProject } from '../shell/TopBar'
import { ProjectRail } from './ProjectRail'
import { TaskDetailPane } from './TaskDetailPane'
import { TaskListPane } from './TaskListPane'
import { rootBasename, type FlatRow } from './taskRows'
import { flatRowsOf, taskFilterMatch, type TaskFilter } from './workspaceModel'

export interface WorkspaceViewProps {
  snapshot: Snapshot | null
  /** 当前项目 root；'' = 聚合全部可读项目（左列「所有项目」）。 */
  currentRoot: string
  rulesByKey: ReadonlyMap<string, WorkflowRules>
  projects: readonly TopBarProject[]
  onSelectProject: (root: string) => void
  /** URL 深链选中的 change；null = 无。 */
  selectedChange: string | null
  onSelectedChange: (name: string | null) => void
  onToast?: (message: string) => void
  /** 快照刷新失败时的本地化文案（保留旧快照继续可读）；null = 正常。 */
  staleError?: string | null
  loading?: boolean
  onRefresh?: () => void | Promise<void>
}

const RAIL_KEY = 'tenon-dashboard-rail:workspace'

/**
 * 工作台 = 模板的三列阅读页：左列项目 / 中列任务 / 右列该任务逐 stage 的执行状态与产出。
 * 只读：所有写动作留在终端；这里只做阅读、定位与复制。
 */
export function WorkspaceView({
  snapshot,
  currentRoot,
  rulesByKey,
  projects,
  onSelectProject,
  selectedChange,
  onSelectedChange,
  onToast,
  staleError = null,
  loading = false,
  onRefresh,
}: WorkspaceViewProps): JSX.Element {
  const { t } = useT()
  const { query, setQuery } = useGlobalSearch()
  const [filter, setFilter] = useState<TaskFilter>('all')
  const [search, setSearch] = useState('')
  const [railCollapsed, setRailCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(RAIL_KEY) === '1' } catch { return false }
  })
  useEffect(() => {
    try { localStorage.setItem(RAIL_KEY, railCollapsed ? '1' : '0') } catch { /* ignore */ }
  }, [railCollapsed])
  useEffect(() => { setFilter('all'); setSearch('') }, [currentRoot])

  const rows = useMemo(() => flatRowsOf(snapshot, currentRoot, rulesByKey), [snapshot, currentRoot, rulesByKey])
  // 未来 canonical 版本的 change：server 把它们收进 compatibilityIssues 并让同项目其余 change 保持可读。
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
    () => rows.filter((row) => taskFilterMatch(row, filter)
      && matchesQuery(query, row.row.change.name, row.workflow, row.row.change.track, row.row.change.phase)
      && matchesQuery(search, row.row.change.name, row.workflow, row.row.change.track, row.row.change.phase)),
    [rows, filter, query, search],
  )
  const selectedRow: FlatRow | null = useMemo(() => {
    const explicit = selectedChange === null
      ? undefined
      : rows.find((row) => row.row.change.name === selectedChange && (currentRoot === '' || row.row.root === currentRoot))
    return explicit ?? visibleRows[0] ?? null
  }, [rows, visibleRows, selectedChange, currentRoot])

  const currentProject = projects.find((project) => project.root === currentRoot)
  const eyebrow = currentRoot === ''
    ? t('workspace.eyebrow_all')
    : t('workspace.eyebrow_project', { project: (currentProject?.name ?? rootBasename(currentRoot)).toUpperCase() })
  // 未来版本 change 被 server 收进 compatibilityIssues 后 rows 为空：提示条已经说明原因，不再叠加「零任务」教学。
  const emptyKind = rows.length === 0
    ? (currentRoot === '' && projects.length === 0 ? 'no-project' : compat.issues.length > 0 ? 'compat' : 'no-task')
    : 'filtered'

  return (
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
          onSelect={(row) => onSelectedChange(row.row.change.name)}
          showProject={currentRoot === ''}
          emptyKind={emptyKind}
          onClearFilters={() => { setFilter('all'); setSearch(''); setQuery('') }}
          notice={notice}
        />
      )}
      detail={selectedRow
        ? <TaskDetailPane key={selectedRow.key} row={selectedRow} onToast={onToast} />
        : <DetailEmpty title={t('workspace.no_selection')} desc={t('workspace.no_selection_desc')} testId="task-detail-empty" />}
    />
  )
}
