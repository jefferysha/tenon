/**
 * POST /api/projects/create/stream：执行新建项目并逐步回报进度（text/event-stream，事件 plan / step / done / failed）。
 * EventSource 只能 GET，所以这里用 fetch 读流并按 SSE 帧解析。开始执行前的失败是普通 JSON 错误，抛 InstructionApiError。
 */
import { decodeProjectCreated, type ProjectCreated } from './instructionsDecoders'
import { InstructionApiError, throwInstructionError, type ProjectCreateInput } from './instructionsClient'
import { ApiError, getToken, isRecord, wrapNetwork } from './transport'

export type CreateStepState = 'running' | 'done' | 'failed'

export type CreateStreamEvent =
  | { type: 'plan'; steps: string[] }
  | { type: 'step'; id: string; state: CreateStepState; error?: string; code?: string }
  | { type: 'done'; created: ProjectCreated }
  | { type: 'failed'; code?: string; error: string; step?: string }

const optionalString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

function stepState(value: unknown): CreateStepState | null {
  return value === 'running' || value === 'done' || value === 'failed' ? value : null
}

/** 一个 SSE 帧 → 事件；形状不对返回 null（调用方忽略）。 */
export function decodeCreateFrame(frame: string): CreateStreamEvent | null {
  const event = /^event: (.*)$/m.exec(frame)?.[1]
  const raw = /^data: (.*)$/m.exec(frame)?.[1]
  if (event === undefined || raw === undefined) return null
  let data: unknown
  try { data = JSON.parse(raw) } catch { return null }
  if (!isRecord(data)) return null
  if (event === 'plan') {
    const steps = data.steps
    return Array.isArray(steps) && steps.every((step) => typeof step === 'string') ? { type: 'plan', steps: steps.map(String) } : null
  }
  if (event === 'step') {
    const state = stepState(data.state)
    if (typeof data.id !== 'string' || state === null) return null
    const error = optionalString(data.error)
    const code = optionalString(data.code)
    return { type: 'step', id: data.id, state, ...(error === undefined ? {} : { error }), ...(code === undefined ? {} : { code }) }
  }
  if (event === 'done') {
    const created = decodeProjectCreated(data)
    return created === null ? null : { type: 'done', created }
  }
  if (event === 'failed') {
    const code = optionalString(data.code)
    const step = optionalString(data.step)
    return { type: 'failed', error: optionalString(data.error) ?? '', ...(code === undefined ? {} : { code }), ...(step === undefined ? {} : { step }) }
  }
  return null
}

/** 读完整个流；每个事件回调一次。流在 done / failed 之前断开 → 抛 ApiError。 */
export async function streamProjectCreate(
  input: ProjectCreateInput, onEvent: (event: CreateStreamEvent) => void, signal?: AbortSignal,
): Promise<void> {
  let response: Response
  try {
    response = await fetch('/api/projects/create/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', Authorization: `Bearer ${getToken()}` },
      body: JSON.stringify(input),
      signal,
    })
  } catch (error) {
    wrapNetwork(error)
  }
  if (!response.ok) await throwInstructionError(response, '新建项目失败')
  const reader = response.body?.getReader()
  if (reader === undefined) throw new InstructionApiError('新建项目：响应没有正文', response.status, false, undefined)
  const decoder = new TextDecoder()
  let buffer = ''
  let finished = false
  for (;;) {
    const { value, done } = await reader.read()
    buffer += decoder.decode(value, { stream: !done })
    let boundary = buffer.indexOf('\n\n')
    while (boundary !== -1) {
      const event = decodeCreateFrame(buffer.slice(0, boundary))
      buffer = buffer.slice(boundary + 2)
      boundary = buffer.indexOf('\n\n')
      if (event === null) continue
      if (event.type === 'done' || event.type === 'failed') finished = true
      onEvent(event)
    }
    if (done) break
  }
  if (!finished) throw new ApiError('新建项目：进度流中断', response.status)
}
