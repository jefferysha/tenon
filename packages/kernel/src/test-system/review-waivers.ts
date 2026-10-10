/**
 * 评审请求时冻结的「待批准」清单（change 目录内的边车 `.pipeline-review-waivers.json`）：待批准的测试豁免，
 * 以及本任务 diff 里待人确认的受保护配置改动（测试目录、基线、已知失败清单、工作流；见 protected-files.ts）。
 *
 * `tenon review request` 列出未批准的项并把清单写在这里；`tenon review acknowledge` 只批准
 * 清单里的那几条，且清单必须绑定同一次请求（phase / event / requestedAt 与 receipt 逐项相同）。
 * 请求之后才加进计划的豁免、请求之后又改过内容的受保护文件因此不会被这次确认顺带批准。
 * 豁免的批准写进任务测试计划；受保护改动的批准（路径 + 内容摘要）写进本机封存文件（seal.ts）。
 *
 * 清单里除了计划豁免（`kind:<k>` / `covers:<…>` / `test:<步骤测试 id>`），还有目录里未批准的项目级「不适用」声明
 * （`not-applicable:<k>`，见 catalog-na.ts）：确认时它们写回 `catalog.yaml` 的 `approved_by`，一次批准对全项目生效。
 *
 * 读取失败一律当作「没有清单」（失败关闭：什么都不批准）；写入与清除由持有 Change 锁的调用方负责。
 */
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicReplaceFile } from '../state/atomic-publish.js'
import { readOptionalBoundedRegularTextFile } from '../state/document-path.js'
import { reviewGateEvent } from '../state/review-gate.js'
import type { PipelineState } from '../types.js'
import { userSlug, type RecordActor } from '../users/user.js'
import { changeStartOfFields, type PathChangeStatus } from '../workspace/changed-files.js'
import { isWorkspaceBaseline } from '../workspace/fingerprint.js'
import { isNotApplicableKey, approveNotApplicable, pendingNotApplicable } from './catalog-na.js'
import { readCatalogFile, updateCatalog } from './catalog-file.js'
import { readTestPlanState, writeTestPlanUnderLock } from './plan-ledger.js'
import {
  acceptFrozenResiduals, decodeAccepted, decodeResidual, type AcceptedResidual, type FrozenResidual, type ResidualAcceptance,
} from './review-residual.js'
import {
  approveWaivers, pendingWaivers, type PendingWaiver, type StepTestFailures, type WaiverSkipReason,
} from './plan-waivers.js'
import {
  PROTECTED_CATALOG_PATH, protectedChangesSinceChangeStart, protectedFileDigest, protectedFileDigestSync, protectedKindOf,
  type ProtectedChange, type ProtectedKind, type ProtectedOrigin,
} from './protected-files.js'
import { updateTestSeal } from './seal.js'

export const REVIEW_WAIVERS_FILE = '.pipeline-review-waivers.json'
const MAX_REVIEW_WAIVERS_BYTES = 64 * 1024
const KEY_RE = /^(kind|covers|test|not-applicable):\S.*$/
const SELECTION_KEYS: ReadonlySet<string> = new Set([
  'accepted', 'event', 'phase', 'protected', 'requestedAt', 'residual', 'version', 'waivers',
])

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
  /** 缺省 = 没有待接受的剩余阻断（验证轮次用完后评审者仍不通过，见 review-residual.ts）。 */
  readonly residual?: readonly FrozenResidual[]
  /** 已接受的剩余阻断；跨请求保留（清掉待批准项时不清它），解码失败时整份清单读不出。 */
  readonly accepted?: readonly ResidualAcceptance[]
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
  const keys = Object.keys(record)
  if (!['event', 'phase', 'requestedAt', 'version', 'waivers'].every((key) => keys.includes(key))) return undefined
  if (keys.some((key) => !SELECTION_KEYS.has(key)) || record.version !== 1) return undefined
  const frozen = record.protected === undefined ? [] : decodeProtected(record.protected)
  const residual = record.residual === undefined ? [] : decodeResidual(record.residual)
  const accepted = record.accepted === undefined ? [] : decodeAccepted(record.accepted)
  if (frozen === undefined || residual === undefined || accepted === undefined) return undefined
  const phase = text(record.phase)
  const event = text(record.event)
  const requestedAt = text(record.requestedAt)
  if (phase === undefined || event === undefined || requestedAt === undefined || !Array.isArray(record.waivers)) return undefined
  const waivers: PendingWaiver[] = []
  for (const raw of record.waivers as unknown[]) {
    const waiver = decodeWaiver(raw)
    if (waiver === undefined) return undefined
    waivers.push(waiver)
  }
  return {
    version: 1, phase, event, requestedAt, waivers,
    ...(frozen.length === 0 ? {} : { protected: frozen }),
    ...(residual.length === 0 ? {} : { residual }),
    ...(accepted.length === 0 ? {} : { accepted }),
  }
}

/**
 * 清单项恰好是 `{ key, reason }`，或 `test:` 键另带 `candidate`（请求时失败记录的代码候选，必须是工作区指纹）。
 * 其它键、其它种类的键带 `candidate` 一律拒绝：清单只能说「批准哪一条」，不能借多出来的字段塞进别的批准。
 */
function decodeWaiver(raw: unknown): PendingWaiver | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const item = raw as Record<string, unknown>
  const key = text(item.key)
  const reason = text(item.reason)
  if (key === undefined || reason === undefined || !KEY_RE.test(key)) return undefined
  const names = Object.keys(item).sort().join(',')
  if (names === 'key,reason') return { key, reason }
  const candidate = text(item.candidate)
  if (names !== 'candidate,key,reason' || !key.startsWith('test:') || candidate === undefined || !isWorkspaceBaseline(candidate)) return undefined
  return { key, reason, candidate }
}

/**
 * 调用方已持有 Change 锁。重新冻结待批准项不丢已接受的剩余阻断：`accepted` 缺省时沿用边车里现有的那份。
 */
export async function writeReviewWaiverSelection(
  changeDir: string,
  selection: Omit<ReviewWaiverSelection, 'version'>,
): Promise<void> {
  const accepted = selection.accepted ?? (await readReviewWaiverSelection(changeDir))?.accepted
  const body: ReviewWaiverSelection = { version: 1, ...selection, ...(accepted === undefined ? {} : { accepted }) }
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

/**
 * 调用方已持有 Change 锁。清掉待批准项（豁免、受保护改动、待接受的剩余阻断）；已接受的剩余阻断是跨请求的
 * 持久记录，还在时只清空待批准项、保留它们，没有时删文件。
 */
export async function clearReviewWaiverSelection(changeDir: string): Promise<void> {
  const current = await readReviewWaiverSelection(changeDir)
  if (current?.accepted === undefined) {
    await rm(join(changeDir, REVIEW_WAIVERS_FILE), { force: true })
    return
  }
  const { phase, event, requestedAt, accepted } = current
  await atomicReplaceFile(
    join(changeDir, REVIEW_WAIVERS_FILE),
    `${JSON.stringify({ version: 1, phase, event, requestedAt, waivers: [], accepted })}\n`,
  )
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
  if (selection === undefined || (selection.waivers.length === 0 && (selection.protected ?? []).length === 0 && (selection.residual ?? []).length === 0)) {
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
  /** 本次确认接受的剩余阻断（带冻结时的发现摘要，供历史行用）；没有时缺席。 */
  readonly residualAccepted?: readonly AcceptedResidual[]
}

const NO_APPROVAL: WaiverApprovalOutcome = {
  approved: [], skipped: [], digest: null, note: null, protectedApproved: [], protectedSkipped: [],
}

/**
 * 冻结清单里的受保护改动逐项重读当前摘要：仍等于冻结摘要的才可批准（请求之后又被改过的不批准，留给下一次请求）。
 * 只读：必须在任何批准写入之前做，因为批准目录里的「不适用」声明会重写 catalog.yaml，而 catalog.yaml 本身就是受保护文件。
 */
async function checkProtectedChanges(
  repoRoot: string,
  frozen: readonly FrozenProtectedChange[],
): Promise<{
  readonly matched: readonly FrozenProtectedChange[]
  readonly skipped: readonly { readonly path: string; readonly why: ProtectedSkipReason }[]
}> {
  const matched: FrozenProtectedChange[] = []
  const skipped: { path: string; why: ProtectedSkipReason }[] = []
  for (const item of frozen) {
    const current = await protectedFileDigest(repoRoot, item.path)
    if (current === 'unreadable' || item.digest === 'unreadable') skipped.push({ path: item.path, why: 'unreadable' })
    else if (current !== item.digest) skipped.push({ path: item.path, why: 'content-changed' })
    else matched.push(item)
  }
  return { matched, skipped }
}

/**
 * 把通过检查的受保护改动写进封存 approvals（change + 路径 + 摘要）。已经批准过的原样保留，重试同一条确认是幂等的。
 * 批准目录里的「不适用」声明会让 catalog.yaml 多出批准人，这一次确认批准的正是带批准人的那份内容，
 * 所以目录项按批准写入之后的摘要记；其余文件不会被批准动作改写，仍记冻结摘要。
 */
async function sealProtectedApprovals(input: {
  readonly repoRoot: string
  readonly change: string
  readonly actor: RecordActor
  readonly recordedAt: string
  readonly matched: readonly FrozenProtectedChange[]
}): Promise<readonly string[]> {
  if (input.matched.length === 0) return []
  const entries: { path: string; digest: string }[] = []
  for (const item of input.matched) {
    const digest = item.kind === 'catalog' ? await protectedFileDigest(input.repoRoot, item.path) : item.digest
    if (digest === 'unreadable') continue
    entries.push({ path: item.path, digest })
  }
  if (entries.length === 0) return []
  await updateTestSeal(input.repoRoot, userSlug(input.actor.id), (seal) => ({
    ...seal,
    approvals: [
      ...seal.approvals.filter((entry) => !entries.some((item) => entry.change === input.change && entry.path === item.path && entry.digest === item.digest)),
      ...entries.map((item) => ({ change: input.change, path: item.path, digest: item.digest, by: input.actor.id, at: input.recordedAt })),
    ],
  }))
  return entries.map((item) => item.path)
}

/**
 * 目录自任务起点以来没有任何改动（读不出 diff 时按「有改动」算，失败关闭）。
 *
 * 批准「不适用」声明会把批准人写回 catalog.yaml。声明如果早在任务起点之前就已提交（还没批准），评审请求时目录不在
 * 任务的 diff 里，冻结清单里就没有它的摘要；而批准写完之后，目录相对起点多了批准人这一处改动，成了没有批准行的
 * 受保护改动，任务从此卡在出口（F19）。只有批准之前目录与起点完全一致，这次改写才能确定「只是批准本身」；
 * 目录在任务里另有改动而冻结清单没能带上它时，那些改动用户没看过，不能顺带批准。
 */
async function catalogUntouchedSinceChangeStart(input: {
  readonly repoRoot: string
  readonly state: PipelineState
  readonly protectedChanges?: () => Promise<readonly ProtectedChange[]>
}): Promise<boolean> {
  try {
    const changes = input.protectedChanges !== undefined
      ? await input.protectedChanges()
      : await protectedChangesSinceChangeStart(input.repoRoot, changeStartOfFields(input.state.fields))
    return !changes.some((item) => item.path === PROTECTED_CATALOG_PATH)
  } catch {
    return false
  }
}

/** 批准写目录之前观察到的目录状态：当时的内容摘要，以及它相对任务起点是否原样。 */
interface CatalogSighting {
  readonly digest: string
  readonly untouched: boolean
}

/** 先取摘要、再查 diff：之后（持锁写之前）摘要对不上，就说明查的那份内容已经不是现在这份。 */
async function sightCatalog(input: Parameters<typeof catalogUntouchedSinceChangeStart>[0]): Promise<CatalogSighting> {
  const digest = await protectedFileDigest(input.repoRoot, PROTECTED_CATALOG_PATH)
  return { digest, untouched: await catalogUntouchedSinceChangeStart(input) }
}

/**
 * 评审请求要列给用户的待批准项：计划里未批准的豁免 + 目录里未批准的项目级「不适用」声明。
 * 计划缺失 / 不可信、目录缺失 / 无效时对应的一半为空（那些状态由测试门禁自己挡）。
 * `failures`（当前步骤各测试新鲜失败的豁免事实）让批准绑定的代码已不是现在这份的 `test:` 豁免再次列出，并带上候选。
 */
export async function pendingReviewWaivers(input: {
  readonly repoRoot: string
  readonly dir: string
  readonly change: string
  readonly failures?: StepTestFailures
}): Promise<readonly PendingWaiver[]> {
  const [plan, catalog] = await Promise.all([
    readTestPlanState(input.dir, input.change),
    readCatalogFile(input.repoRoot).catch(() => undefined),
  ])
  return [
    ...(plan.state === 'ok' ? pendingWaivers(plan.plan, input.failures) : []),
    ...(catalog?.state === 'ok' ? pendingNotApplicable(catalog.catalog) : []),
  ]
}

/**
 * 在提交 approved receipt 的那把锁内批准冻结清单里的豁免（调用方持有 Change 锁；CLI 人工确认与 Dashboard
 * 确认共用）。清单必须绑定 `state` 里的这一次请求，否则什么都不批准。写入失败向上抛：receipt 尚未提交，
 * 用户重试同一条确认即可（已批准的豁免会被识别为「已经批准过」）。
 *
 * 计划豁免写进计划（`approved_by`），项目级「不适用」声明写进 `catalog.yaml`；两处各自幂等，批准人都是确认者。
 */
export async function approveFrozenWaivers(input: {
  readonly repoRoot: string
  readonly dir: string
  readonly change: string
  readonly state: PipelineState
  readonly actor: RecordActor
  readonly recordedAt: string
  /** 自任务起点以来的受保护改动；缺省读真实 git diff（CLI 传入它自己可被测试装配覆写的那一份）。 */
  readonly protectedChanges?: () => Promise<readonly ProtectedChange[]>
  /**
   * 是否接受冻结的剩余阻断（缺省接受）。只有把待接受项逐条列给了用户的确认通道才该接受：终端的人工确认列了；
   * Dashboard 没有展示它们，传 false——用户在那里确认不会顺带接受没看过的评审结论。
   */
  readonly acceptResidual?: boolean
}): Promise<WaiverApprovalOutcome> {
  const { selection, unbound } = await boundReviewWaiverSelection(input.dir, input.state)
  if (unbound) return { ...NO_APPROVAL, note: '待批准清单不属于这一次 review request，未批准任何豁免或受保护改动' }
  if (selection === undefined) return NO_APPROVAL
  const checked = await checkProtectedChanges(input.repoRoot, selection.protected ?? [])
  const planPart = selection.waivers.filter((item) => !isNotApplicableKey(item.key))
  const catalogPart = selection.waivers.filter((item) => isNotApplicableKey(item.key))
  const approved: string[] = []
  const skipped: { key: string; why: WaiverSkipReason }[] = []
  let digest: string | null = null
  let note: string | null = null
  if (planPart.length > 0) {
    const plan = await readTestPlanState(input.dir, input.change)
    if (plan.state !== 'ok') {
      note = `测试计划${plan.state === 'missing' ? '不存在' : `不可信（${plan.reason}）`}，${catalogPart.length === 0 ? '未批准任何豁免' : '未批准计划里的豁免'}`
    } else {
      const result = approveWaivers(plan.plan, planPart, input.actor.id)
      skipped.push(...result.skipped)
      if (result.approved.length > 0) {
        const written = await writeTestPlanUnderLock(input.dir, result.plan, { actor: input.actor, recordedAt: input.recordedAt })
        approved.push(...result.approved)
        digest = written.digest
      }
    }
  }
  // 批准写回 approved_by 的那次改写本身要被识别为「这次批准」：它的摘要和其余受保护改动一样封存、写进审计行；
  // 其余手写的 approved_by（没有这条封存与审计行）仍然是没有批准的受保护改动。
  let ownCatalogWrite = false
  if (catalogPart.length > 0) {
    const catalog = await readCatalogFile(input.repoRoot).catch(() => undefined)
    if (catalog?.state !== 'ok') {
      note = `${note === null ? '' : `${note}；`}测试目录（catalog.yaml）${catalog?.state === 'missing' ? '不存在' : '无效或读不了'}，未批准「不适用」声明`
    } else {
      // 冻结清单已带着目录摘要时，下面的封存已按批准后的内容处理；否则（声明早于任务起点就已提交）在写之前、持目录锁观察
      // 一次：写完之后目录相对起点永远有改动，只能在这里判定「批准之前它是不是原样」。
      const frozenCatalog = checked.matched.find((item) => item.kind === 'catalog')
      const outcome = await updateCatalog(
        input.repoRoot,
        (current, sighted: CatalogSighting | undefined) => {
          // 这次改写要被封存，依据的是刚才观察到的、相对任务起点原样的那份目录。紧贴写盘再核对一次：观察到写入之间
          // 有人改了目录（人手直接改文件不受目录锁约束）就拒绝，不把没看过的改动一起封存。
          if (sighted?.untouched === true && protectedFileDigestSync(input.repoRoot, PROTECTED_CATALOG_PATH) !== sighted.digest) {
            return 'catalog.yaml 在评审确认的检查与写入之间被改动；未批准任何「不适用」声明，请重新运行同一条确认'
          }
          const result = approveNotApplicable(current, catalogPart, input.actor.id)
          return { catalog: result.catalog, value: { result, sealsItself: sighted?.untouched === true } }
        },
        () => frozenCatalog === undefined ? sightCatalog(input) : Promise.resolve(undefined),
      )
      if (!outcome.ok) throw new Error(outcome.message)
      approved.push(...outcome.value.result.approved)
      skipped.push(...outcome.value.result.skipped)
      ownCatalogWrite = outcome.value.sealsItself && outcome.value.result.approved.length > 0
    }
  }
  // 目录项的摘要在 sealProtectedApprovals 里按写入之后的内容重算，这里的摘要字段只是占位。
  const catalogWrite: FrozenProtectedChange = {
    path: PROTECTED_CATALOG_PATH, kind: 'catalog', status: 'modified', digest: 'sealed-after-write', origin: 'pending',
  }
  const protectedApproved = await sealProtectedApprovals({
    repoRoot: input.repoRoot, change: input.change, actor: input.actor, recordedAt: input.recordedAt,
    matched: ownCatalogWrite ? [...checked.matched, catalogWrite] : checked.matched,
  })
  const residualAccepted = input.acceptResidual === false ? [] : await acceptResidual(input, selection)
  return {
    approved, skipped, digest, note, protectedApproved, protectedSkipped: checked.skipped,
    ...(residualAccepted.length === 0 ? {} : { residualAccepted }),
  }
}

/**
 * 接受冻结清单里待接受的剩余阻断：落成接受记录写回边车（待批准项仍在，直到调用方在回执提交之后清掉它们）。
 * 接受绑定的运行与候选由 kernel 的评审者判定逐项核对，冻结之后评审者有了新运行、代码变了，这条记录就对不上、不生效。
 */
async function acceptResidual(
  input: { readonly dir: string; readonly actor: RecordActor; readonly recordedAt: string },
  selection: ReviewWaiverSelection,
): Promise<readonly AcceptedResidual[]> {
  const frozen = selection.residual ?? []
  if (frozen.length === 0) return []
  const { added, all } = acceptFrozenResiduals({
    frozen, existing: selection.accepted, acceptedBy: input.actor.id, acceptedAt: input.recordedAt,
  })
  await writeReviewWaiverSelection(input.dir, {
    phase: selection.phase, event: selection.event, requestedAt: selection.requestedAt, waivers: selection.waivers,
    ...(selection.protected === undefined ? {} : { protected: selection.protected }), residual: frozen, accepted: all,
  })
  return added
}
