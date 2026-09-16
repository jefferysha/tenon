/**
 * 工作台读测试记录与产物：`GET /api/tests/runs|run|artifact`。全部只读；
 * 产物是原始字节，所以只给出 URL，由 `<img>` / 下载链接 / 日志读取各自消费。
 */
import { ApiError, isAbortError } from './transport'
import type { TestRunSummary } from '../types'

export interface TestRunListEntry extends TestRunSummary {
  readonly artifacts: boolean
}

export interface TestRunDetail {
  readonly record: Record<string, unknown>
  readonly artifacts: { readonly log: boolean; readonly files: readonly string[] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function getJson(url: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  let response: Response
  try {
    response = await fetch(url, { signal })
  } catch (error) {
    if (isAbortError(error)) throw error
    throw new ApiError('network error')
  }
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  if (!response.ok) {
    const detail = isRecord(body) && typeof body.error === 'string' ? body.error : ''
    throw new ApiError(detail, response.status, detail !== '')
  }
  if (!isRecord(body) || body.ok !== true) throw new ApiError('invalid response', response.status)
  return body
}

function decodeEntry(value: unknown): TestRunListEntry | null {
  if (!isRecord(value) || typeof value.runId !== 'string' || typeof value.user !== 'string'
    || !isRecord(value.actor) || typeof value.actor.id !== 'string' || typeof value.actor.name !== 'string'
    || (value.result !== 'pass' && value.result !== 'fail')
    || (value.exitCode !== null && typeof value.exitCode !== 'number')
    || typeof value.durationMs !== 'number' || typeof value.finishedAt !== 'string'
    || !Array.isArray(value.reasons) || typeof value.artifacts !== 'boolean') return null
  return {
    runId: value.runId,
    user: value.user,
    actor: { id: value.actor.id, name: value.actor.name },
    result: value.result,
    exitCode: value.exitCode === null ? null : value.exitCode,
    durationMs: value.durationMs,
    finishedAt: value.finishedAt,
    reasons: value.reasons.filter((reason): reason is string => typeof reason === 'string'),
    artifacts: value.artifacts,
  }
}

export async function fetchTestRuns(
  root: string,
  change: string,
  testId: string,
  signal?: AbortSignal,
): Promise<readonly TestRunListEntry[]> {
  const query = new URLSearchParams({ root, change, test: testId })
  const body = await getJson(`/api/tests/runs?${query.toString()}`, signal)
  if (!Array.isArray(body.runs)) throw new ApiError('invalid response')
  const runs: TestRunListEntry[] = []
  for (const entry of body.runs) {
    const decoded = decodeEntry(entry)
    if (decoded === null) throw new ApiError('invalid response')
    runs.push(decoded)
  }
  return runs
}

export async function fetchTestRun(
  root: string,
  change: string,
  user: string,
  run: string,
  signal?: AbortSignal,
): Promise<TestRunDetail> {
  const query = new URLSearchParams({ root, change, user, run })
  const body = await getJson(`/api/tests/run?${query.toString()}`, signal)
  if (!isRecord(body.record) || !isRecord(body.artifacts) || typeof body.artifacts.log !== 'boolean'
    || !Array.isArray(body.artifacts.files)) throw new ApiError('invalid response')
  return {
    record: body.record,
    artifacts: {
      log: body.artifacts.log,
      files: body.artifacts.files.filter((file): file is string => typeof file === 'string'),
    },
  }
}

export function testArtifactUrl(
  root: string,
  change: string,
  user: string,
  run: string,
  path: string,
  tail?: number,
): string {
  const query = new URLSearchParams({ root, change, user, run, path })
  if (tail !== undefined) query.set('tail', String(tail))
  return `/api/tests/artifact?${query.toString()}`
}

export async function fetchTestArtifactText(url: string, signal?: AbortSignal): Promise<string> {
  let response: Response
  try {
    response = await fetch(url, { signal })
  } catch (error) {
    if (isAbortError(error)) throw error
    throw new ApiError('network error')
  }
  if (!response.ok) throw new ApiError('', response.status)
  return response.text()
}
