import { useCallback } from 'react'
import { useT } from '../i18n'
import { getToken } from '../api/transport'
import { dashboardSearch } from '../shell/dashboardLocation'
import type { UserRefView } from '../types'
import type { EndedRow } from './endedModel'
import { taskMenuItems, type TaskMenuEntry, type TaskMenuHandlers } from './TaskMenu'
import type { TaskRow } from './taskModel'

export interface TaskActionsInput {
  me: UserRefView | null
  onToast?: (message: string) => void
  /** 终止 / 删除 / 接手都先走 TaskActionDialog 确认（终止与删除的阻断原因来自服务端）。 */
  onRequest: (row: TaskRow, action: 'terminate' | 'delete' | 'take') => void
}

/**
 * 工作台所有任务动作的唯一来源：卡片 ⋯ 与详情 ⋯ 用同一份 taskMenuItems。
 * 每个动作带着行自己的 root，聚合视图（未选项目）同样可用。已结束的任务只读，只能复制链接。
 */
export function useTaskActions({ me, onToast, onRequest }: TaskActionsInput): {
  menuOf: (row: TaskRow) => TaskMenuEntry[]
  endedMenuOf: (row: EndedRow) => TaskMenuEntry[]
} {
  const { t } = useT()

  const copyLink = useCallback((root: string, change: string): void => {
    const search = dashboardSearch(window.location.search, { view: 'workspace', root, change })
    const link = `${window.location.origin}${window.location.pathname}${search}`
    void navigator.clipboard?.writeText(link).then(() => onToast?.(t('detail.copied', { value: link })))
  }, [onToast, t])

  const menuOf = useCallback((row: TaskRow): TaskMenuEntry[] => {
    const canTake = me !== null && row.owner?.slug !== me.slug && getToken() !== ''
    const handlers: TaskMenuHandlers = {
      'copy-link': () => copyLink(row.root, row.change.name),
      ...(canTake ? { take: () => onRequest(row, 'take') } : {}),
      terminate: () => onRequest(row, 'terminate'),
      delete: () => onRequest(row, 'delete'),
    }
    return taskMenuItems(handlers, t)
  }, [copyLink, me, onRequest, t])

  const endedMenuOf = useCallback((row: EndedRow): TaskMenuEntry[] => (
    taskMenuItems({ 'copy-link': () => copyLink(row.root, row.dir) }, t)
  ), [copyLink, t])

  return { menuOf, endedMenuOf }
}
