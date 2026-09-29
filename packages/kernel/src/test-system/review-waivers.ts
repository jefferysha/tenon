/**
 * 评审请求时冻结的「待批准豁免」清单（change 目录内的边车 `.pipeline-review-waivers.json`）。
 *
 * `tenon review request` 列出计划里未批准的豁免并把清单写在这里；`tenon review acknowledge` 只批准
 * 清单里的那几条，且清单必须绑定同一次请求（phase / event / requestedAt 与 receipt 逐项相同）。
 * 请求之后才加进计划的豁免因此不会被这次确认顺带批准。
 *
 * 读取失败一律当作「没有清单」（失败关闭：什么都不批准）；写入与清除由持有 Change 锁的调用方负责。
 */
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicReplaceFile } from '../state/atomic-publish.js'
import { readOptionalBoundedRegularTextFile } from '../state/document-path.js'
import type { PendingWaiver } from './plan-waivers.js'

export const REVIEW_WAIVERS_FILE = '.pipeline-review-waivers.json'
const MAX_REVIEW_WAIVERS_BYTES = 64 * 1024
const KEY_RE = /^(kind|covers):\S.*$/

export interface ReviewWaiverSelection {
  readonly version: 1
  readonly phase: string
  readonly event: string
  readonly requestedAt: string
  readonly waivers: readonly PendingWaiver[]
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function decodeSelection(value: unknown): ReviewWaiverSelection | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join(',') !== 'event,phase,requestedAt,version,waivers' || record.version !== 1) return undefined
  const phase = text(record.phase)
  const event = text(record.event)
  const requestedAt = text(record.requestedAt)
  if (phase === undefined || event === undefined || requestedAt === undefined || !Array.isArray(record.waivers)) return undefined
  const waivers: PendingWaiver[] = []
  for (const raw of record.waivers as unknown[]) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
    const item = raw as Record<string, unknown>
    const key = text(item.key)
    const reason = text(item.reason)
    if (Object.keys(item).length !== 2 || key === undefined || reason === undefined || !KEY_RE.test(key)) return undefined
    waivers.push({ key, reason })
  }
  return { version: 1, phase, event, requestedAt, waivers }
}

/** 调用方已持有 Change 锁。 */
export async function writeReviewWaiverSelection(
  changeDir: string,
  selection: Omit<ReviewWaiverSelection, 'version'>,
): Promise<void> {
  const body: ReviewWaiverSelection = { version: 1, ...selection }
  await atomicReplaceFile(join(changeDir, REVIEW_WAIVERS_FILE), `${JSON.stringify(body)}\n`)
}

export async function readReviewWaiverSelection(changeDir: string): Promise<ReviewWaiverSelection | undefined> {
  let raw: string | undefined
  try {
    raw = await readOptionalBoundedRegularTextFile(
      join(changeDir, REVIEW_WAIVERS_FILE), MAX_REVIEW_WAIVERS_BYTES, 'review waiver selection',
    )
  } catch {
    return undefined
  }
  if (raw === undefined) return undefined
  try {
    return decodeSelection(JSON.parse(raw))
  } catch {
    return undefined
  }
}

/** 调用方已持有 Change 锁。 */
export async function clearReviewWaiverSelection(changeDir: string): Promise<void> {
  await rm(join(changeDir, REVIEW_WAIVERS_FILE), { force: true })
}
