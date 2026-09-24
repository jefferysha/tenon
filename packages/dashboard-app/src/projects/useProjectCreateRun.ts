import { useCallback, useRef, useState } from 'react'
import { instructionErrorKey } from '../api/instructionErrorKey'
import type { ProjectCreateInput } from '../api/instructionsClient'
import type { ProjectCreated } from '../api/instructionsDecoders'
import { streamProjectCreate, type CreateStreamEvent } from '../api/projectCreateStream'

export type RowState = 'pending' | 'running' | 'done' | 'failed'
export interface RunRow { id: string; state: RowState; error?: string }
export type RunStatus = 'idle' | 'running' | 'done' | 'failed'

export interface ProjectCreateRun {
  status: RunStatus
  rows: readonly RunRow[]
  created: ProjectCreated | null
  /** 执行前的失败（校验、身份、网络）：词典键后缀。 */
  errorKey: string | null
  /** server 报 failed 时的错误码（词典键后缀）；没有哪一行失败时页面显示它。 */
  failure: string | null
  start: (prepare: () => Promise<ProjectCreateInput>) => Promise<void>
}

/** 把一个流事件折叠进行列表。 */
export function applyEvent(rows: readonly RunRow[], event: CreateStreamEvent): RunRow[] {
  if (event.type === 'plan') return event.steps.map((id) => ({ id, state: 'pending' }))
  if (event.type !== 'step') return [...rows]
  return rows.map((row) => (row.id === event.id
    ? { id: row.id, state: event.state, ...(event.error === undefined ? {} : { error: event.error }) }
    : row))
}

/** 新建项目的执行与进度：每次 start 先由调用方重新 dry run 拿到输入，再读进度流。 */
export function useProjectCreateRun(): ProjectCreateRun {
  const [status, setStatus] = useState<RunStatus>('idle')
  const [rows, setRows] = useState<readonly RunRow[]>([])
  const [created, setCreated] = useState<ProjectCreated | null>(null)
  const [errorKey, setErrorKey] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const running = useRef(false)

  const start = useCallback(async (prepare: () => Promise<ProjectCreateInput>): Promise<void> => {
    if (running.current) return
    running.current = true
    setStatus('running')
    setRows([])
    setCreated(null)
    setErrorKey(null)
    setFailure(null)
    let outcome: RunStatus = 'failed'
    try {
      const input = await prepare()
      await streamProjectCreate(input, (event) => {
        setRows((current) => applyEvent(current, event))
        if (event.type === 'done') {
          outcome = 'done'
          setCreated(event.created)
        }
        if (event.type === 'failed') setFailure((event.code ?? 'unknown').replace(/-/g, '_'))
      })
    } catch (error) {
      setErrorKey(instructionErrorKey(error))
    } finally {
      running.current = false
      setStatus(outcome)
    }
  }, [])

  return { status, rows, created, errorKey, failure, start }
}
