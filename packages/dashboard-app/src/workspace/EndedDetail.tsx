import { formatApiError } from '../api/transport'
import { useT } from '../i18n'
import type { WorkflowRules } from '../model/workflowModel'
import { BUTTON_GHOST } from '../shared/uiRecipes'
import { DetailColumn, StatusPill } from '../shell/ThreeColumns'
import { useEndedDetail } from '../state/useEndedDetail'
import { resultOf, type EndedRow } from './endedModel'
import { resultTone } from './TaskCard'
import { TaskDetailPane } from './TaskDetailPane'
import { TaskMenu, type TaskMenuEntry } from './TaskMenu'
import { taskRowOf } from './taskModel'

export interface EndedDetailProps {
  row: EndedRow
  rulesByKey: ReadonlyMap<string, WorkflowRules>
  /** ⋯ 菜单：已结束的任务只读，只有复制链接。 */
  menu: readonly TaskMenuEntry[]
}

/**
 * 工作台右列里的一个已结束任务：按归档目录名只读读取，读到之前只有任务名与任务结果，读取失败给重试。
 * 读到后与活跃任务同一个详情页（阶段 · 总览、编排画布、输入输出、记录都按同一个目录名带 `archived=1` 读），
 * 只是没有下一步 / 评审台 / 测试页签，任何写操作都不出现。
 */
export function EndedDetail({ row, rulesByKey, menu }: EndedDetailProps): JSX.Element {
  const { t } = useT()
  const { state, retry } = useEndedDetail(row.root, row.dir)
  const result = resultOf(row.task)
  if (state.status === 'ready') {
    // 详情的 name 是归档目录名（带日期前缀）；界面上只显示任务名，与列表卡片一致。
    const taskRow = taskRowOf(row.root, { ...state.change, name: row.task.name }, rulesByKey, t, result)
    return <TaskDetailPane key={row.key} row={taskRow} archived={{ dir: row.dir }} menu={menu} />
  }
  const flow = row.task.track === '' ? row.task.workflow : `${row.task.workflow}/${row.task.track}`
  const label = t(`workspace.result_${result}`)
  return (
    <DetailColumn
      testId="task-detail-pane"
      panelId="task-detail-panel"
      header={(
        <>
          <div className="mb-1.5 flex min-w-0 items-center gap-2">
            <h1 className="min-w-0 flex-1 truncate text-page font-bold tracking-[-.01em] text-text" title={row.task.name} data-testid="task-detail-title">{row.task.name}</h1>
            <TaskMenu items={menu} testId="task-detail-menu" />
          </div>
          <div className="mb-4 flex min-w-0 items-center gap-3">
            <p className="min-w-0 flex-1 truncate whitespace-nowrap font-mono text-base text-text-2" data-testid="task-detail-meta">{flow}</p>
            <p className="flex-none"><StatusPill tone={resultTone(result)}>{label}</StatusPill></p>
          </div>
        </>
      )}
    >
      {state.status === 'error' ? (
        <div className="flex min-w-0 items-center gap-3 text-body text-red-d" role="alert" data-testid="task-detail-error">
          <p className="min-w-0 flex-1 truncate whitespace-nowrap">{t('workspace.detail_error', { msg: formatApiError(state.error, t) })}</p>
          <button type="button" className={BUTTON_GHOST} onClick={retry} data-testid="task-detail-retry">{t('common.snapshot_retry')}</button>
        </div>
      ) : (
        <p className="text-body text-text-3" role="status" data-testid="task-detail-loading">{t('common.loading')}</p>
      )}
    </DetailColumn>
  )
}
