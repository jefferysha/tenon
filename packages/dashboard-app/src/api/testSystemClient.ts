/**
 * 测试体系读接口：`GET /api/tests/catalog|baselines|plan|records|record`。全部只读；响应经严格解码器，
 * 形状不合一律 ApiError('invalid response')。产物字节由 `testArtifactUrl`（testEvidenceClient）给出 URL，
 * 由 `<img>` / `<video>` / 下载链接各自消费。
 */
import { ApiError, isAbortError, readJson, throwApiError, isRecord } from './transport'
import {
  decodeBaselinesResponse, decodeCatalogResponse, decodePlanResponse, decodeRecordListResponse, decodeRecordResponse,
} from './testSystemDecoders'
import type {
  RecordDetail, RecordListResponse, SuiteBaselinesResponse, TestCatalogResponse, TestPlanView,
} from './testSystemTypes'

async function getBody(path: string, query: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(`${path}?${new URLSearchParams(query).toString()}`, { signal })
  } catch (error) {
    if (isAbortError(error)) throw error
    throw new ApiError('network error')
  }
  if (!response.ok) return throwApiError(response, '读取测试数据失败')
  const body = await readJson(response)
  if (!isRecord(body) || body.ok !== true) throw new ApiError('invalid response', response.status)
  return body
}

function decoded<T>(value: T | null, status = 200): T {
  if (value === null) throw new ApiError('invalid response', status)
  return value
}

export async function fetchTestCatalog(root: string, signal?: AbortSignal): Promise<TestCatalogResponse> {
  return decoded(decodeCatalogResponse(await getBody('/api/tests/catalog', { root }, signal)))
}

export async function fetchSuiteBaselines(root: string, suite: string, signal?: AbortSignal): Promise<SuiteBaselinesResponse> {
  const body = decoded(decodeBaselinesResponse(await getBody('/api/tests/baselines', { root, suite }, signal)))
  if (body.suite !== suite) throw new ApiError('invalid response')
  return body
}

export async function fetchTestPlan(root: string, change: string, signal?: AbortSignal): Promise<TestPlanView> {
  return decoded(decodePlanResponse(await getBody('/api/tests/plan', { root, change }, signal)))
}

export async function fetchTestRecords(root: string, change: string, suite?: string, signal?: AbortSignal): Promise<RecordListResponse> {
  const query: Record<string, string> = { root, change }
  if (suite !== undefined) query.suite = suite
  return decoded(decodeRecordListResponse(await getBody('/api/tests/records', query, signal)))
}

export async function fetchTestRecord(
  root: string, change: string, user: string, run: string, signal?: AbortSignal,
): Promise<RecordDetail> {
  const record = decoded(decodeRecordResponse(await getBody('/api/tests/record', { root, change, user, run }, signal)))
  if (record.runId !== run || record.user !== user) throw new ApiError('invalid response')
  return record
}
