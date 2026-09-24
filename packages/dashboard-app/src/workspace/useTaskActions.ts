import { useCallback, useRef } from 'react'
import { useT } from '../i18n'
import { ApiError, formatApiError, getToken } from '../api/transport'
import { unarchiveTask } from '../api/taskLifecycleClient'
import { takeOwner } from '../api/userClient'
import { dashboardSearch } from '../shell/dashboardLocation'
import type { UserRefView } from '../types'
import { taskMenuItems, type TaskMenuEntry, type TaskMenuHandlers } from './TaskMenu'
import type { TaskRow } from './taskModel'

export interface TaskActionsInput {
  me: UserRefView | null
  listMode: 'active' | 'archived'
  onToast?: (message: string) => void
  onRefresh?: () => void | Promise<void>
  onUserMissing?: () => void
  onSelectedChange: (name: string | null) => void
  /** 归档 / 删除走 TaskActionDialog（服务端给出阻断原因）。 */
  onRequest: (row: TaskRow, action: 'archive' | 'delete') => void
}

/**
 * 工作台所有任务动作的唯一来源：卡片 ⋯ 与详情 ⋯ 用同一份 taskMenuItems。
 * 每个动作带着行自己的 root，聚合视图（未选项目）同样可用。
 */
export function useTaskActions({ me, listMode, onToast, onRefresh, onUserMissing, onSelectedChange, onRequest }: TaskActionsInput): {
  menuOf: (row: TaskRow, place: 'card' | 'detail') => TaskMenuEntry[]
  unarchive: (row: TaskRow) => Promise<void>
} {
  const { t } = useT()
  const taking = useRef(false)

  const copyLink = useCallback((row: TaskRow): void => {
    const search = dashboardSearch(window.location.search, { view: 'workspace', root: row.root, change: row.change.name })
    const link = `${window.location.origin}${window.location.pathname}${search}`
    void navigator.clipboard?.writeText(link).then(() => onToast?.(t('detail.copied', { value: link })))
  }, [onToast, t])

  const take = useCallback(async (row: TaskRow): Promise<void> => {
    if (taking.current) return
    taking.current = true
    try {
      await takeOwner(row.root, row.change.name)
      onToast?.(t('workspace.take_done'))
      await onRefresh?.()
    } catch (error) {
      if (error instanceof ApiError && error.status === 412) {
        if (onUserMissing) onUserMissing()
        else onToast?.(t('common.user_missing'))
      } else if (error instanceof ApiError && error.status === 403) {
        onToast?.(t('workspace.owner_required', { name: row.owner?.name ?? '—' }))
      } else {
        onToast?.(formatApiError(error, t))
      }
    } finally {
      taking.current = false
    }
  }, [onRefresh, onToast, onUserMissing, t])

  const unarchive = useCallback(async (row: TaskRow): Promise<void> => {
    try {
      await unarchiveTask({ root: row.root, change: row.change.name })
      onToast?.(t('workspace.done_unarchived', { name: row.change.name }))
      onSelectedChange(null)
      await onRefresh?.()
    } catch (error) {
      onToast?.(formatApiError(error, t, { exposeServerDetail: true }))
    }
  }, [onRefresh, onSelectedChange, onToast, t])

  const menuOf = useCallback((row: TaskRow, place: 'card' | 'detail'): TaskMenuEntry[] => {
    if (listMode === 'archived') {
      // 已归档列表的卡片行内已有「取消归档」；详情 ⋯ 只留复制链接与取消归档。
      if (place === 'card') return []
      return taskMenuItems({ 'copy-link': () => copyLink(row), unarchive: () => { void unarchive(row) } }, t)
    }
    const canTake = me !== null && row.owner?.slug !== me.slug && getToken() !== ''
    const handlers: TaskMenuHandlers = {
      'copy-link': () => copyLink(row),
      ...(canTake ? { take: () => { void take(row) } } : {}),
      archive: () => onRequest(row, 'archive'),
      delete: () => onRequest(row, 'delete'),
    }
    return taskMenuItems(handlers, t)
  }, [copyLink, listMode, me, onRequest, t, take, unarchive])

  return { menuOf, unarchive }
}
