/**
 * 测试计划的摘要台账（与文档台账同一机制：change 目录内的 `.pipeline-*` 边车，持 Change 锁写入）。
 *
 * 写入顺序：先原子替换计划文件，再原子替换台账。两步之间崩溃只会留下「文件新、台账旧」，判定为
 * `test-plan-tampered`（失败关闭），重跑同一条 CLI 命令即可恢复——两步都是幂等的整份覆盖。
 *
 * 读取判定：
 *   · 文件与台账都不在 → missing；
 *   · 只有其一、字节摘要与台账不符、或文件无法按当前 schema 解析 → tampered（附原因）；
 *   · 否则 ok（附解析出的计划与摘要）。
 */
import { lstat, readFile } from 'node:fs/promises'
import { atomicReplaceFile } from '../state/atomic-publish.js'
import { withLock } from '../state/lock.js'
import { decodeRecordActor, type RecordActor } from '../users/user.js'
import { appendTestAudit, testAuditEntry, type TestAuditOutcome } from './audit.js'
import { testPlanLedgerPath, testPlanPath } from './paths.js'
import { parseTestPlan, serializeTestPlan, testPlanBytesDigest, type TestPlan } from './plan.js'

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/
const MAX_PLAN_BYTES = 1024 * 1024

export interface TestPlanLedger {
  readonly version: 1
  readonly digest: string
  readonly recorded_at: string
  readonly actor: RecordActor
}

export type TestPlanState =
  | { readonly state: 'missing' }
  | { readonly state: 'tampered'; readonly reason: string }
  | { readonly state: 'ok'; readonly plan: TestPlan; readonly digest: string; readonly ledger: TestPlanLedger }

export function decodeTestPlanLedger(value: unknown): TestPlanLedger | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort().join(',')
  if (keys !== 'actor,digest,recorded_at,version') return undefined
  if (record.version !== 1 || typeof record.digest !== 'string' || !DIGEST_RE.test(record.digest)) return undefined
  if (typeof record.recorded_at !== 'string' || record.recorded_at === '') return undefined
  const actor = decodeRecordActor(record.actor)
  if (actor === undefined || actor === null) return undefined
  return { version: 1, digest: record.digest, recorded_at: record.recorded_at, actor }
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    const entry = await lstat(path)
    if (!entry.isFile()) return ''
    if (entry.size > MAX_PLAN_BYTES) return ''
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export async function readTestPlanState(changeDir: string, changeName: string): Promise<TestPlanState> {
  const [text, ledgerText] = await Promise.all([
    readOptional(testPlanPath(changeDir)),
    readOptional(testPlanLedgerPath(changeDir)),
  ])
  if (text === undefined && ledgerText === undefined) return { state: 'missing' }
  if (text === undefined) return { state: 'tampered', reason: '计划文件被删除，台账仍在' }
  if (ledgerText === undefined) return { state: 'tampered', reason: '计划文件不是由 tenon test 写入（没有摘要台账）' }
  let parsed: unknown
  try {
    parsed = JSON.parse(ledgerText)
  } catch {
    parsed = undefined
  }
  const ledger = decodeTestPlanLedger(parsed)
  if (ledger === undefined) return { state: 'tampered', reason: '计划摘要台账损坏' }
  const digest = testPlanBytesDigest(text)
  if (digest !== ledger.digest) return { state: 'tampered', reason: '计划文件内容与登记摘要不符（被手工改动）' }
  const result = parseTestPlan(text, changeName)
  if (!result.ok) {
    const first = result.issues[0]
    return { state: 'tampered', reason: `计划文件无法解析${first === undefined ? '' : `：第 ${first.line} 行 ${first.message}`}` }
  }
  return { state: 'ok', plan: result.plan, digest, ledger }
}

export interface PlanWriteMeta {
  readonly actor: RecordActor
  readonly recordedAt: string
  /** 触发这次写入的子命令（register / unregister / waive / seed …）；只进审计行。 */
  readonly op?: string
}

export interface PlanWriteResult {
  readonly digest: string
  /** 计划字节相对台账里的上一份是否真的变了；没变（幂等重写）不留审计行。 */
  readonly changed: boolean
  /** 审计行的结果；没变时 `unchanged`。 */
  readonly audit: TestAuditOutcome | 'unchanged'
}

/**
 * 只供 CLI 写入（`tenon test register|unregister|waive|plan --seed`）。持 Change 锁，锁不可重入：
 * 调用方不得在另一个 withLock(changeDir) 回调里调用本函数——已经持锁的调用方（review acknowledge 在同一次
 * 确认里批准豁免）用 `writeTestPlanUnderLock`。计划真的变了就在 change 历史里留一行 `test:plan-write`。
 */
export async function writeTestPlan(
  changeDir: string,
  plan: TestPlan,
  meta: PlanWriteMeta,
): Promise<PlanWriteResult> {
  return withLock(changeDir, async () => {
    const written = await writeTestPlanUnderLock(changeDir, plan, meta)
    if (!written.changed) return { ...written, audit: 'unchanged' as const }
    const audit = await appendTestAudit(changeDir, testAuditEntry(
      'plan-write',
      { op: meta.op, plan: written.digest },
      { ts: meta.recordedAt, actor: meta.actor },
    ))
    return { ...written, audit }
  })
}

async function ledgerDigest(changeDir: string): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(testPlanLedgerPath(changeDir), 'utf8'))
    return decodeTestPlanLedger(parsed)?.digest
  } catch {
    return undefined
  }
}

/** 调用方已持有该 Change 的锁；写入顺序与失败恢复同文件头。不留审计行（批准豁免的调用方自己记）。 */
export async function writeTestPlanUnderLock(
  changeDir: string,
  plan: TestPlan,
  meta: PlanWriteMeta,
): Promise<{ readonly digest: string; readonly changed: boolean }> {
  const bytes = serializeTestPlan(plan)
  const digest = testPlanBytesDigest(bytes)
  const changed = (await ledgerDigest(changeDir)) !== digest
  const ledger: TestPlanLedger = { version: 1, digest, recorded_at: meta.recordedAt, actor: meta.actor }
  await atomicReplaceFile(testPlanPath(changeDir), bytes)
  await atomicReplaceFile(testPlanLedgerPath(changeDir), `${JSON.stringify(ledger, null, 2)}\n`)
  return { digest, changed }
}

/** mutate 的结果：给出新计划，或拒绝（原因原样返回给调用方，磁盘不动）。 */
export type PlanUpdate = { readonly plan: TestPlan } | { readonly reject: string }

/**
 * 读—改—写在同一把 Change 锁内完成：两个并发的 `tenon test register` 不会互相覆盖。mutate 看到的是锁内读到的
 * 当前状态（missing / tampered / ok），由它决定新计划或拒绝。锁不可重入，mutate 里不得再取 Change 锁。
 */
export async function updateTestPlan(
  changeDir: string,
  changeName: string,
  meta: PlanWriteMeta,
  mutate: (state: TestPlanState) => PlanUpdate | Promise<PlanUpdate>,
): Promise<{ readonly digest: string } | { readonly rejected: string }> {
  return withLock(changeDir, async () => {
    const result = await mutate(await readTestPlanState(changeDir, changeName))
    if ('reject' in result) return { rejected: result.reject }
    return writeTestPlanUnderLock(changeDir, result.plan, meta)
  })
}
