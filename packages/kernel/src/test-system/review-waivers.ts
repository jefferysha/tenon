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
import { reviewGateEvent } from '../state/review-gate.js'
import type { PipelineState } from '../types.js'
import type { RecordActor } from '../users/user.js'
import { readTestPlanState, writeTestPlanUnderLock } from './plan-ledger.js'
import { approveWaivers, type PendingWaiver, type WaiverSkipReason } from './plan-waivers.js'

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

function scalar(state: PipelineState, field: 'review_requested_at' | 'review_gate_phase'): string {
  const value = state.fields[field]
  return Array.isArray(value) ? value.join(',') : (value ?? '')
}

/**
 * 冻结清单，且只在它绑定 `state` 里这一次评审请求时返回（phase / event / requestedAt 逐项相同）；
 * 没有清单、清单不属于这一次请求（旧请求残留）时返回 undefined。CLI 与 Dashboard 的确认、
 * 以及 Dashboard 展示给用户的「这次确认会批准的豁免」都读这一处，展示与批准不会分叉。
 */
export async function boundReviewWaiverSelection(
  changeDir: string,
  state: PipelineState,
): Promise<{ readonly selection: ReviewWaiverSelection | undefined; readonly unbound: boolean }> {
  const selection = await readReviewWaiverSelection(changeDir)
  if (selection === undefined || selection.waivers.length === 0) return { selection: undefined, unbound: false }
  const bound = selection.phase === scalar(state, 'review_gate_phase')
    && selection.event === reviewGateEvent(state)
    && selection.requestedAt === scalar(state, 'review_requested_at')
  return bound ? { selection, unbound: false } : { selection: undefined, unbound: true }
}

export interface WaiverApprovalOutcome {
  readonly approved: readonly string[]
  readonly skipped: readonly { readonly key: string; readonly why: WaiverSkipReason }[]
  /** 计划新摘要；没有写入时 null。 */
  readonly digest: string | null
  /** 清单存在却没能批准的原因（计划缺失 / 不可信 / 清单不属于这次请求），用于提示。 */
  readonly note: string | null
}

const NO_APPROVAL: WaiverApprovalOutcome = { approved: [], skipped: [], digest: null, note: null }

/**
 * 在提交 approved receipt 的那把锁内批准冻结清单里的豁免（调用方持有 Change 锁；CLI 人工确认与 Dashboard
 * 确认共用）。清单必须绑定 `state` 里的这一次请求，否则什么都不批准。写入失败向上抛：receipt 尚未提交，
 * 用户重试同一条确认即可（已批准的豁免会被识别为「已经批准过」）。
 */
export async function approveFrozenWaivers(input: {
  readonly dir: string
  readonly change: string
  readonly state: PipelineState
  readonly actor: RecordActor
  readonly recordedAt: string
}): Promise<WaiverApprovalOutcome> {
  const { selection, unbound } = await boundReviewWaiverSelection(input.dir, input.state)
  if (unbound) return { ...NO_APPROVAL, note: '豁免清单不属于这一次 review request，未批准任何豁免' }
  if (selection === undefined) return NO_APPROVAL
  const plan = await readTestPlanState(input.dir, input.change)
  if (plan.state !== 'ok') {
    return { ...NO_APPROVAL, note: `测试计划${plan.state === 'missing' ? '不存在' : `不可信（${plan.reason}）`}，未批准任何豁免` }
  }
  const result = approveWaivers(plan.plan, selection.waivers, input.actor.id)
  if (result.approved.length === 0) return { ...NO_APPROVAL, skipped: result.skipped }
  const written = await writeTestPlanUnderLock(input.dir, result.plan, { actor: input.actor, recordedAt: input.recordedAt })
  return { approved: result.approved, skipped: result.skipped, digest: written.digest, note: null }
}
