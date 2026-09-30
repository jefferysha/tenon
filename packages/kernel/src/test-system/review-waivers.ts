/**
 * 评审请求时冻结的「待批准」清单（change 目录内的边车 `.pipeline-review-waivers.json`）：待批准的测试豁免，
 * 以及本任务 diff 里待人确认的受保护配置改动（测试目录、基线、已知失败清单、工作流；见 protected-files.ts）。
 *
 * `tenon review request` 列出未批准的项并把清单写在这里；`tenon review acknowledge` 只批准
 * 清单里的那几条，且清单必须绑定同一次请求（phase / event / requestedAt 与 receipt 逐项相同）。
 * 请求之后才加进计划的豁免、请求之后又改过内容的受保护文件因此不会被这次确认顺带批准。
 * 豁免的批准写进任务测试计划；受保护改动的批准（路径 + 内容摘要）写进本机封存文件（seal.ts）。
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
import { userSlug } from '../users/user.js'
import type { PathChangeStatus } from '../workspace/changed-files.js'
import { readTestPlanState, writeTestPlanUnderLock } from './plan-ledger.js'
import { approveWaivers, type PendingWaiver, type WaiverSkipReason } from './plan-waivers.js'
import { protectedFileDigest, protectedKindOf, type ProtectedKind, type ProtectedOrigin } from './protected-files.js'
import { updateTestSeal } from './seal.js'

export const REVIEW_WAIVERS_FILE = '.pipeline-review-waivers.json'
const MAX_REVIEW_WAIVERS_BYTES = 64 * 1024
const KEY_RE = /^(kind|covers):\S.*$/

/** 冻结在评审请求里的一项受保护配置改动：确认时它的当前摘要必须仍等于这里的摘要才算数。 */
export interface FrozenProtectedChange {
  readonly path: string
  readonly kind: ProtectedKind
  readonly status: PathChangeStatus
  readonly digest: string
  /** 请求时的来源：待确认 / 台账外改动（Tenon 命令写出之后又被改）。展示用。 */
  readonly origin: Exclude<ProtectedOrigin, 'approved'>
}

export interface ReviewWaiverSelection {
  readonly version: 1
  readonly phase: string
  readonly event: string
  readonly requestedAt: string
  readonly waivers: readonly PendingWaiver[]
  /** 缺省 = 没有待确认的受保护改动（旧版本写的清单没有这一项）。 */
  readonly protected?: readonly FrozenProtectedChange[]
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

const STATUSES: ReadonlySet<string> = new Set<PathChangeStatus>(['added', 'modified', 'deleted'])

function decodeProtected(value: unknown): readonly FrozenProtectedChange[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: FrozenProtectedChange[] = []
  for (const raw of value as unknown[]) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
    const item = raw as Record<string, unknown>
    if (Object.keys(item).sort().join(',') !== 'digest,kind,origin,path,status') return undefined
    const path = text(item.path)
    const digest = text(item.digest)
    const kind = path === undefined ? undefined : protectedKindOf(path)
    if (path === undefined || digest === undefined || kind === undefined || kind !== item.kind) return undefined
    if (typeof item.status !== 'string' || !STATUSES.has(item.status)) return undefined
    if (item.origin !== 'pending' && item.origin !== 'outside-command') return undefined
    out.push({ path, kind, status: item.status as PathChangeStatus, digest, origin: item.origin })
  }
  return out
}

function decodeSelection(value: unknown): ReviewWaiverSelection | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort().join(',')
  if ((keys !== 'event,phase,requestedAt,version,waivers' && keys !== 'event,phase,protected,requestedAt,version,waivers') || record.version !== 1) return undefined
  const frozen = record.protected === undefined ? [] : decodeProtected(record.protected)
  if (frozen === undefined) return undefined
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
  return { version: 1, phase, event, requestedAt, waivers, ...(frozen.length === 0 ? {} : { protected: frozen }) }
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
  if (selection === undefined || (selection.waivers.length === 0 && (selection.protected ?? []).length === 0)) {
    return { selection: undefined, unbound: false }
  }
  const bound = selection.phase === scalar(state, 'review_gate_phase')
    && selection.event === reviewGateEvent(state)
    && selection.requestedAt === scalar(state, 'review_requested_at')
  return bound ? { selection, unbound: false } : { selection: undefined, unbound: true }
}

export type ProtectedSkipReason = 'content-changed' | 'unreadable'

export interface WaiverApprovalOutcome {
  readonly approved: readonly string[]
  readonly skipped: readonly { readonly key: string; readonly why: WaiverSkipReason }[]
  /** 计划新摘要；没有写入时 null。 */
  readonly digest: string | null
  /** 清单存在却没能批准的原因（计划缺失 / 不可信 / 清单不属于这次请求），用于提示。 */
  readonly note: string | null
  /** 本次确认批准的受保护配置改动（路径）。 */
  readonly protectedApproved: readonly string[]
  readonly protectedSkipped: readonly { readonly path: string; readonly why: ProtectedSkipReason }[]
}

const NO_APPROVAL: WaiverApprovalOutcome = {
  approved: [], skipped: [], digest: null, note: null, protectedApproved: [], protectedSkipped: [],
}

/**
 * 批准冻结清单里的受保护改动：对每一项重新读文件当前摘要，仍等于冻结摘要才写进封存 approvals
 * （请求之后又被改过的不批准，留给下一次请求）。已经批准过的原样保留，重试同一条确认是幂等的。
 */
async function approveProtectedChanges(input: {
  readonly repoRoot: string
  readonly change: string
  readonly actor: RecordActor
  readonly recordedAt: string
  readonly frozen: readonly FrozenProtectedChange[]
}): Promise<Pick<WaiverApprovalOutcome, 'protectedApproved' | 'protectedSkipped'>> {
  if (input.frozen.length === 0) return { protectedApproved: [], protectedSkipped: [] }
  const approved: FrozenProtectedChange[] = []
  const skipped: { path: string; why: ProtectedSkipReason }[] = []
  for (const item of input.frozen) {
    const current = await protectedFileDigest(input.repoRoot, item.path)
    if (current === 'unreadable' || item.digest === 'unreadable') skipped.push({ path: item.path, why: 'unreadable' })
    else if (current !== item.digest) skipped.push({ path: item.path, why: 'content-changed' })
    else approved.push(item)
  }
  if (approved.length > 0) {
    await updateTestSeal(input.repoRoot, userSlug(input.actor.id), (seal) => ({
      ...seal,
      approvals: [
        ...seal.approvals.filter((entry) => !approved.some((item) => entry.change === input.change && entry.path === item.path && entry.digest === item.digest)),
        ...approved.map((item) => ({ change: input.change, path: item.path, digest: item.digest, by: input.actor.id, at: input.recordedAt })),
      ],
    }))
  }
  return { protectedApproved: approved.map((item) => item.path), protectedSkipped: skipped }
}

/**
 * 在提交 approved receipt 的那把锁内批准冻结清单里的豁免（调用方持有 Change 锁；CLI 人工确认与 Dashboard
 * 确认共用）。清单必须绑定 `state` 里的这一次请求，否则什么都不批准。写入失败向上抛：receipt 尚未提交，
 * 用户重试同一条确认即可（已批准的豁免会被识别为「已经批准过」）。
 */
export async function approveFrozenWaivers(input: {
  readonly repoRoot: string
  readonly dir: string
  readonly change: string
  readonly state: PipelineState
  readonly actor: RecordActor
  readonly recordedAt: string
}): Promise<WaiverApprovalOutcome> {
  const { selection, unbound } = await boundReviewWaiverSelection(input.dir, input.state)
  if (unbound) return { ...NO_APPROVAL, note: '待批准清单不属于这一次 review request，未批准任何豁免或受保护改动' }
  if (selection === undefined) return NO_APPROVAL
  const protectedOutcome = await approveProtectedChanges({
    repoRoot: input.repoRoot, change: input.change, actor: input.actor, recordedAt: input.recordedAt, frozen: selection.protected ?? [],
  })
  if (selection.waivers.length === 0) return { ...NO_APPROVAL, ...protectedOutcome }
  const plan = await readTestPlanState(input.dir, input.change)
  if (plan.state !== 'ok') {
    return { ...NO_APPROVAL, ...protectedOutcome, note: `测试计划${plan.state === 'missing' ? '不存在' : `不可信（${plan.reason}）`}，未批准任何豁免` }
  }
  const result = approveWaivers(plan.plan, selection.waivers, input.actor.id)
  if (result.approved.length === 0) return { ...NO_APPROVAL, ...protectedOutcome, skipped: result.skipped }
  const written = await writeTestPlanUnderLock(input.dir, result.plan, { actor: input.actor, recordedAt: input.recordedAt })
  return { approved: result.approved, skipped: result.skipped, digest: written.digest, note: null, ...protectedOutcome }
}
