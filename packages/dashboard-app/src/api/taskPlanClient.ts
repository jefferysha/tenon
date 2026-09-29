import { ApiError, isAbortError, readJson, wrapNetwork } from './transport'
import { TASK_PLAN_ERROR_CODES } from './taskPlanTypes'
import type { TaskPlanErrorCode, TaskPlanReadModelV1 } from './taskPlanTypes'
import { exactKeys, isEnum } from './taskPlanDecodePrimitives'
import { decodeTaskPlanReadModel } from './taskPlanDecoder'

export * from './taskPlanTypes'
export { decodeTaskPlanReadModel, decodeTaskPlanReadModelV1 } from './taskPlanDecoder'

export class TaskPlanApiError extends ApiError {
  constructor(message: string, status: number, code?: TaskPlanErrorCode) {
    super(message, status)
    this.name = 'TaskPlanApiError'
    this.code = code
  }

  readonly code: TaskPlanErrorCode | undefined
}

const TASK_PLAN_ERROR_MESSAGES: Readonly<Record<TaskPlanErrorCode, string>> = {
  TASK_PLAN_CHANGE_INVALID: 'TaskPlan change 参数无效',
  TASK_PLAN_ROOT_REQUIRED: 'TaskPlan root 参数缺失',
  TASK_PLAN_ROOT_NOT_REGISTERED: 'TaskPlan root 未注册',
  TASK_PLAN_ROOT_FORBIDDEN: 'TaskPlan root 无权访问',
  TASK_PLAN_NOT_FOUND: 'TaskPlan 不存在',
  TASK_PLAN_PATH_FORBIDDEN: 'TaskPlan 路径不可访问',
  TASK_PLAN_CORRUPT: 'TaskPlan 数据损坏',
}

function taskPlanErrorCode(value: unknown): value is TaskPlanErrorCode {
  return isEnum(value, TASK_PLAN_ERROR_CODES)
}

function errorCodeFromBody(value: unknown): TaskPlanErrorCode | undefined {
  if (!exactKeys(value, ['ok', 'code', 'error']) || value.ok !== false
    || !taskPlanErrorCode(value.code) || typeof value.error !== 'string') return undefined
  return value.code
}

function taskPlanApiError(status: number, code?: TaskPlanErrorCode): TaskPlanApiError {
  const message = code === undefined
    ? `TaskPlan 请求失败（${status}）`
    : TASK_PLAN_ERROR_MESSAGES[code]
  return new TaskPlanApiError(message, status, code)
}

export async function fetchTaskPlan(
  root: string,
  change: string,
  signal?: AbortSignal,
): Promise<TaskPlanReadModelV1> {
  let response: Response
  try {
    response = await fetch(
      `/api/task-plans/${encodeURIComponent(change)}?root=${encodeURIComponent(root)}`,
      { headers: { Accept: 'application/json' }, signal },
    )
  } catch (error) {
    wrapNetwork(error)
  }
  if (!response.ok) {
    let body: unknown
    try {
      body = await readJson(response)
    } catch (error) {
      if (isAbortError(error)) throw error
      body = undefined
    }
    throw taskPlanApiError(response.status, errorCodeFromBody(body))
  }
  let body: unknown
  try {
    body = await readJson(response)
  } catch (error) {
    if (isAbortError(error)) throw error
    throw taskPlanApiError(response.status)
  }
  const decoded = decodeTaskPlanReadModel(body)
  if (decoded === null) throw taskPlanApiError(response.status)
  return decoded
}
