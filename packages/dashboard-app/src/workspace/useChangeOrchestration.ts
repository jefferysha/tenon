import { useEffect, useState } from 'react'
import { fetchChangeOrchestration, type ChangeOrchestration } from '../api/workflowOrchestrationClient'

export type ChangeOrchestrationState =
  | { status: 'loading' }
  | { status: 'ready'; orchestration: ChangeOrchestration }
  | { status: 'error'; error: unknown }
  /** 调用方禁止请求（只读快照语境）。 */
  | { status: 'disabled' }

/**
 * 任务冻结计划的编排 + 运行状态（`GET /api/change/:c/orchestration`）。`signature` 变了就重取——快照里这个
 * 任务的状态、技能 / agent / 测试 / 文档证据任一变化都会改它；换任务时先回到 loading，不串味。
 */
export function useChangeOrchestration(root: string, change: string, signature: string, enabled = true): ChangeOrchestrationState {
  const key = `${root}\n${change}`
  const [state, setState] = useState<{ key: string; state: ChangeOrchestrationState }>({ key: '', state: { status: 'loading' } })
  useEffect(() => {
    if (!enabled || root === '') return
    const controller = new AbortController()
    fetchChangeOrchestration(change, root, controller.signal)
      .then((orchestration) => { if (!controller.signal.aborted) setState({ key, state: { status: 'ready', orchestration } }) })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        // 已经拿到过的编排在一次重取失败时继续显示，不闪成错误；第一次就失败才报。
        setState((previous) => previous.key === key && previous.state.status === 'ready' ? previous : { key, state: { status: 'error', error } })
      })
    return () => controller.abort()
  }, [key, root, change, signature, enabled])
  if (!enabled) return { status: 'disabled' }
  return state.key === key ? state.state : { status: 'loading' }
}
