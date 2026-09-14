import { useEffect, useMemo, useState } from 'react'
import { useT } from '../i18n'
import { CanonicalStateVersionNotice } from '../progress/CanonicalStateVersionNotice'
import { SnapshotInlineError } from '../progress/SnapshotInlineError'
import { isProjectNavigable } from '../state/projectSelectionModel'
import type { WorkflowRules } from '../model/workflowModel'
import type { Snapshot } from '../types'
import { matchesQuery } from '../shell/GlobalSearch'
import { DetailEmpty, ThreeColumns } from '../shell/ThreeColumns'
import type { TopBarProject } from '../shell/TopBar'
import { ProjectRail } from './ProjectRail'
import { TaskDetailPane } from './TaskDetailPane'
import { TaskListPane } from './TaskListPane'
import { DEFAULT_TASK_FILTER, filterRows, rootBasename, rowsOf, type TaskFilterState, type TaskRow } from './taskModel'
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
}

const RAIL_KEY = 'tenon-dashboard-rail:workspace'

/** 工作台：左列项目 / 中列任务（按阶段筛选）/ 右列所选任务逐阶段的输出与输入。只读。 */
export function WorkspaceView({
  snapshot, currentRoot, rulesByKey, projects, onSelectProject, selectedChange, onSelectedChange, onToast,
  staleError = null, loading = false, onRefresh,
}: WorkspaceViewProps): JSX.Element {
  const { t } = useT()
  const [filter, setFilter] = useState<TaskFilterState>(DEFAULT_TASK_FILTER)
  const [search, setSearch] = useState('')
  const [railCollapsed, setRailCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(RAIL_KEY) === '1' } catch { return false }
  })
  useEffect(() => {
    try { localStorage.setItem(RAIL_KEY, railCollapsed ? '1' : '0') } catch { /* ignore */ }
  }, [railCollapsed])
  useEffect(() => { setFilter(DEFAULT_TASK_FILTER); setSearch('') }, [currentRoot])

  // 聚合语境（未选项目）不发 per-root 请求：卡片状态退回「进行中」，不判缺产出。
  const pairs = useMemo(() => {
    const out: Array<{ root: string; workflow: string }> = []
    if (currentRoot === '') return out
    for (const project of snapshot?.projects ?? []) {
      if (!isProjectNavigable(project) || project.root !== currentRoot) continue
      for (const change of project.changes) {
        const workflow = typeof change.fields.workflow === 'string' && change.fields.workflow !== '' ? change.fields.workflow : 'default'
        out.push({ root: project.root, workflow })
      }
    }
    return out
  }, [snapshot, currentRoot])
  const ioOf = useWorkflowIoLookup(pairs)
  const rows = useMemo(() => rowsOf({ snapshot, currentRoot, rulesByKey, ioOf, t }), [snapshot, currentRoot, rulesByKey, ioOf, t])

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
    () => filterRows(rows, filter).filter((row) =>
      matchesQuery(search, row.change.name, row.workflow, row.change.track, row.change.phase)),
    [rows, filter, search],
  )
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
          onSelect={(row) => onSelectedChange(row.change.name)}
          showProject={currentRoot === ''}
          emptyKind={emptyKind}
          onClearFilters={() => { setFilter(DEFAULT_TASK_FILTER); setSearch('') }}
          notice={notice}
        />
      )}
      detail={selectedRow
        ? <TaskDetailPane key={selectedRow.key} row={selectedRow} onToast={onToast} onRefresh={onRefresh} showReviewConsole={selectedChange !== null && currentRoot !== ''} fetchDefinition={currentRoot !== ''} />
        : <DetailEmpty title={t('workspace.no_selection')} desc="" testId="task-detail-empty" />}
    />
  )
}
