/**
 * 步骤产出账本 `.pipeline-step-outputs.json`（设计 §2）：每次步骤访问的检查点、离开记录、产出与读取回执。
 * 只做结构、严格解码、上限与原子写；谁产出了什么、哪些要读由 documents/step-outputs 决定。
 *
 * 读改写必须由调用方持有任务锁（转换与 `tenon document read` 都在锁内），这里没有读-改-写的 CAS。
 * 读到的任何不符都抛 StepOutputLedgerError，不静默修复；写出的内容先过同一套解码，保证写得出的一定读得回来。
 */
import { join } from 'node:path'
import { CHECKPOINT_PATH_LIMIT, isCommitId, OBSERVED_PATH_MAX_LENGTH, type StepCheckpoint } from '../workspace/step-checkpoint.js'
import { atomicReplaceFile } from './atomic-publish.js'
import { readOptionalBoundedRegularTextFile } from './document-path.js'

export const STEP_OUTPUT_LEDGER_FILE = '.pipeline-step-outputs.json'
export const MAX_LEDGER_VISITS = 512
export const MAX_VISIT_OUTPUTS = 2000
export const MAX_VISIT_READS = 4000
const MAX_LEDGER_BYTES = 4 * 1024 * 1024
const LABEL = '步骤产出账本'
const UNSAFE_TEXT = /[\u0000-\u001f\u007f]/u
const SHA256 = /^[0-9a-f]{64}$/u

export type StepObservation = 'observed' | 'unavailable' | 'truncated'
export interface StepOutputRecord { readonly path: string; readonly change: 'added' | 'modified' | 'deleted'; readonly sha256: string | null; readonly skill: string | null }
export interface StepInputRead { readonly path: string; readonly sha256: string; readonly read_at: string }
export interface StepVisitRecord {
  readonly run_id: string
  readonly sequence: number
  readonly step: string
  readonly entered_at: string
  readonly checkpoint: StepCheckpoint | null
  readonly exit: { readonly event: string; readonly to: string; readonly at: string; readonly observation: StepObservation } | null
  readonly outputs: readonly StepOutputRecord[]
  readonly reads: readonly StepInputRead[]
}
export interface StepOutputLedger { readonly version: 1; readonly visits: readonly StepVisitRecord[] }

export class StepOutputLedgerError extends Error {
  override readonly name = 'StepOutputLedgerError'
}

function fail(at: string, expected: string): never {
  throw new StepOutputLedgerError(`${LABEL}损坏：${at} ${expected}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function record(value: unknown, at: string): Record<string, unknown> {
  return isRecord(value) ? value : fail(at, '必须是对象')
}

function list(value: unknown, at: string, max: number): unknown[] {
  if (!Array.isArray(value)) return fail(at, '必须是数组')
  return value.length > max ? fail(at, `不能超过 ${max} 项`) : value
}

function text(value: unknown, at: string, max = 256): string {
  return typeof value === 'string' && value !== '' && value.length <= max && !UNSAFE_TEXT.test(value) ? value : fail(at, '必须是非空文本')
}

function textOrNull(value: unknown, at: string): string | null {
  return value === null ? null : text(value, at)
}

function timestamp(value: unknown, at: string): string {
  const stamp = text(value, at, 64)
  return Number.isFinite(Date.parse(stamp)) ? stamp : fail(at, '必须是时间')
}

function digest(value: unknown, at: string): string {
  return typeof value === 'string' && SHA256.test(value) ? value : fail(at, '必须是 sha256 十六进制摘要')
}

function digestOrNull(value: unknown, at: string): string | null {
  return value === null ? null : digest(value, at)
}

/** 项目内相对路径：账本里的路径之后会被拼到项目根上读文件，所以绝对路径与 `..` 一律拒收。 */
function projectPath(value: unknown, at: string): string {
  const path = text(value, at, OBSERVED_PATH_MAX_LENGTH)
  return path.startsWith('/') || path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
    ? fail(at, '必须是项目内的相对路径')
    : path
}

function decodeCheckpoint(value: unknown, at: string): StepCheckpoint | null {
  if (value === null) return null
  const raw = record(value, at)
  const head = raw.head === null ? null : typeof raw.head === 'string' && isCommitId(raw.head) ? raw.head : fail(`${at}.head`, '必须是提交号')
  const entries = Object.entries(record(raw.files, `${at}.files`))
  if (entries.length > CHECKPOINT_PATH_LIMIT) fail(`${at}.files`, `不能超过 ${CHECKPOINT_PATH_LIMIT} 项`)
  // fromEntries 把 `__proto__` 之类的文件名当普通自有属性，不会改到原型。
  return { head, files: Object.fromEntries(entries.map(([path, sha]) => [projectPath(path, `${at}.files`), digestOrNull(sha, `${at}.files`)])) }
}

function decodeExit(value: unknown, at: string): StepVisitRecord['exit'] {
  if (value === null) return null
  const raw = record(value, at)
  const observation = raw.observation
  if (observation !== 'observed' && observation !== 'unavailable' && observation !== 'truncated') return fail(`${at}.observation`, '必须是 observed / unavailable / truncated')
  return { event: text(raw.event, `${at}.event`), to: text(raw.to, `${at}.to`), at: timestamp(raw.at, `${at}.at`), observation }
}

function decodeOutput(value: unknown, at: string): StepOutputRecord {
  const raw = record(value, at)
  const change = raw.change
  if (change !== 'added' && change !== 'modified' && change !== 'deleted') return fail(`${at}.change`, '必须是 added / modified / deleted')
  const sha256 = digestOrNull(raw.sha256, `${at}.sha256`)
  if ((change === 'deleted') !== (sha256 === null)) fail(`${at}.sha256`, '只有已删除的产出没有摘要')
  return { path: projectPath(raw.path, `${at}.path`), change, sha256, skill: textOrNull(raw.skill, `${at}.skill`) }
}

function decodeRead(value: unknown, at: string): StepInputRead {
  const raw = record(value, at)
  return { path: projectPath(raw.path, `${at}.path`), sha256: digest(raw.sha256, `${at}.sha256`), read_at: timestamp(raw.read_at, `${at}.read_at`) }
}

function decodeVisit(value: unknown, at: string): StepVisitRecord {
  const raw = record(value, at)
  const sequence = raw.sequence
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 0) return fail(`${at}.sequence`, '必须是非负整数')
  return {
    run_id: text(raw.run_id, `${at}.run_id`),
    sequence,
    step: text(raw.step, `${at}.step`),
    entered_at: timestamp(raw.entered_at, `${at}.entered_at`),
    checkpoint: decodeCheckpoint(raw.checkpoint, `${at}.checkpoint`),
    exit: decodeExit(raw.exit, `${at}.exit`),
    outputs: list(raw.outputs, `${at}.outputs`, MAX_VISIT_OUTPUTS).map((item, index) => decodeOutput(item, `${at}.outputs[${index}]`)),
    reads: list(raw.reads, `${at}.reads`, MAX_VISIT_READS).map((item, index) => decodeRead(item, `${at}.reads[${index}]`)),
  }
}

function decodeLedger(value: unknown): StepOutputLedger {
  const raw = record(value, '账本')
  if (raw.version !== 1) fail('version', '必须是 1')
  const seen = new Set<string>()
  const visits = list(raw.visits, 'visits', MAX_LEDGER_VISITS).map((item, index) => {
    const visit = decodeVisit(item, `visits[${index}]`)
    const key = JSON.stringify([visit.run_id, visit.sequence])
    if (seen.has(key)) fail(`visits[${index}]`, '的 (run_id, sequence) 重复')
    seen.add(key)
    return visit
  })
  return { version: 1, visits }
}

/** 文件不存在 = 还没有任何访问记录；存在但读不了、超限或结构不符一律抛 StepOutputLedgerError。 */
export async function readStepOutputLedger(changeDir: string): Promise<StepOutputLedger> {
  let raw: string | undefined
  try {
    raw = await readOptionalBoundedRegularTextFile(join(changeDir, STEP_OUTPUT_LEDGER_FILE), MAX_LEDGER_BYTES, LABEL)
  } catch (cause) {
    throw new StepOutputLedgerError(`${LABEL}无法读取：${cause instanceof Error ? cause.message : String(cause)}`, { cause })
  }
  if (raw === undefined) return { version: 1, visits: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    throw new StepOutputLedgerError(`${LABEL}不是有效 JSON`, { cause })
  }
  return decodeLedger(parsed)
}

export async function writeStepOutputLedger(changeDir: string, ledger: StepOutputLedger): Promise<void> {
  const content = serialize(decodeLedger(ledger))
  if (Buffer.byteLength(content) > MAX_LEDGER_BYTES) throw new StepOutputLedgerError(`${LABEL}超过 4 MiB 上限`)
  await atomicReplaceFile(join(changeDir, STEP_OUTPUT_LEDGER_FILE), content)
}

function serialize(ledger: StepOutputLedger): string {
  return `${JSON.stringify(ledger, null, 2)}\n`
}

/**
 * 按 (run_id, sequence) 覆盖或追加一次访问。超过 512 次访问或 4 MiB 时先丢最旧的已离开访问（下一步的交接只看
 * 紧邻的上一次访问，丢旧的不影响）；仍放不下，才丢未离开访问的检查点（观察降级为 unavailable，而不是卡住转换）。
 */
export function upsertVisit(ledger: StepOutputLedger, visit: StepVisitRecord): StepOutputLedger {
  const index = ledger.visits.findIndex((existing) => existing.run_id === visit.run_id && existing.sequence === visit.sequence)
  let visits = index < 0 ? [...ledger.visits, visit] : ledger.visits.map((existing, at) => (at === index ? visit : existing))
  const oversize = (): boolean => visits.length > MAX_LEDGER_VISITS || Buffer.byteLength(serialize({ version: 1, visits })) > MAX_LEDGER_BYTES
  while (oversize()) {
    const oldest = visits.findIndex((existing) => existing.exit !== null)
    if (oldest < 0) break
    visits = visits.filter((_, at) => at !== oldest)
  }
  if (oversize()) visits = visits.map((existing) => (existing.exit === null ? { ...existing, checkpoint: null } : existing))
  return { version: 1, visits }
}
