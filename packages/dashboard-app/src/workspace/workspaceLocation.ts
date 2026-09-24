/**
 * 工作台自有的 URL 参数：`status`（状态筛选，顶部徽标跳转用 `status=needs-you`）与 `step`（详情所选阶段）。
 * view / root / change 由 useProjectSelection 维护；这里只读写这两个键，用 replaceState，不产生历史条目。
 */
// 与壳层组 shell/views.ts 的 TASK_STATUS_PARAM / NEEDS_YOU_STATUS 同名同值；合并后改为从那里导入。
export const TASK_STATUS_PARAM = 'status'
export const NEEDS_YOU_STATUS = 'needs-you'

export type WorkspaceParam = typeof TASK_STATUS_PARAM | 'step'

export function readWorkspaceParam(key: WorkspaceParam, search: string = window.location.search): string | null {
  try {
    const value = new URLSearchParams(search).get(key)
    return value === null || value === '' ? null : value
  } catch {
    return null
  }
}

export function writeWorkspaceParam(key: WorkspaceParam, value: string | null): void {
  try {
    const params = new URLSearchParams(window.location.search)
    if (value === null || value === '') params.delete(key)
    else params.set(key, value)
    const query = params.toString()
    const next = `${window.location.pathname}${query === '' ? '' : `?${query}`}${window.location.hash}`
    const now = `${window.location.pathname}${window.location.search}${window.location.hash}`
    if (next !== now) window.history.replaceState(window.history.state, '', next)
  } catch {
    // 禁用 history 的宿主只失去可复制 URL。
  }
}
