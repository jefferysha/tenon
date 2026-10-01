/**
 * 本机封存文件 `<user-dir>/local/test-seal.json`（按用户、gitignored、0600）：Tenon 命令写下的、只有本机知道的
 * 证据来源。四类内容，整份用 HMAC-SHA256 封存（密钥 `local/env.key`，缺则首次写入时创建）：
 *
 *   · heads     —— 每个任务 v2 记录链当前的链头摘要，由 `appendTestRunRecordV2` 在链锁内更新；
 *   · writes    —— 共享受保护文件（基线、已知失败清单）被 Tenon 命令写出后的内容摘要；
 *   · approvals —— 用户在评审确认里批准过的受保护改动（change + 路径 + 摘要）；
 *   · trusted   —— 用户信任过的目录可执行摘要（R6，首次执行仓库自带测试命令前的确认）。
 *
 * 读取永不抛错：文件缺失、损坏、mac 不符一律读成空封存（失败关闭——没有信任、没有批准、没有链头，
 * 相应的门禁自己给出阻塞）。这不是对同 UID 恶意者的密码学防御（能读密钥就能重算），
 * 是让误改与顺手改必须刻意做，并配合 hook 拒绝对这两个文件的写入。
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { lstat, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withLock } from '../state/lock.js'
import { atomicReplaceFile } from '../state/atomic-publish.js'
import { ensureUserLocalDir, userProjectPaths } from '../users/user-paths.js'
import { canonicalJson } from './canonical.js'

export const TEST_SEAL_SCHEMA = 'tenon-test-seal/v1'
export const TEST_SEAL_FILE = 'test-seal.json'
const MAX_SEAL_BYTES = 4 * 1024 * 1024
const MAX_KEY_BYTES = 4096

export interface SealWrite { readonly digest: string; readonly at: string }
export interface SealApproval {
  readonly change: string
  readonly path: string
  /** 批准时文件内容的摘要；文件删除记为 `deleted`。 */
  readonly digest: string
  readonly by: string
  readonly at: string
}
export interface SealTrust { readonly digest: string; readonly by: string; readonly at: string }

export interface TestSeal {
  readonly heads: Readonly<Record<string, string>>
  readonly writes: Readonly<Record<string, SealWrite>>
  readonly approvals: readonly SealApproval[]
  readonly trusted: readonly SealTrust[]
}

export const EMPTY_TEST_SEAL: TestSeal = { heads: {}, writes: {}, approvals: [], trusted: [] }

export type SealState = 'ok' | 'missing' | 'invalid'

export function testSealPath(repoRoot: string, slug: string): string {
  return join(userProjectPaths(repoRoot, slug).localDir, TEST_SEAL_FILE)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function decodeSeal(value: unknown): TestSeal | undefined {
  if (!isRecord(value) || value.schema !== TEST_SEAL_SCHEMA) return undefined
  if (!isRecord(value.heads) || !isRecord(value.writes) || !Array.isArray(value.approvals) || !Array.isArray(value.trusted)) return undefined
  const heads: Record<string, string> = {}
  for (const [change, digest] of Object.entries(value.heads)) {
    if (text(digest) === undefined) return undefined
    heads[change] = digest as string
  }
  const writes: Record<string, SealWrite> = {}
  for (const [path, entry] of Object.entries(value.writes)) {
    if (!isRecord(entry) || text(entry.digest) === undefined || text(entry.at) === undefined) return undefined
    writes[path] = { digest: entry.digest as string, at: entry.at as string }
  }
  const approvals: SealApproval[] = []
  for (const entry of value.approvals) {
    if (!isRecord(entry)) return undefined
    const { change, path, digest, by, at } = entry
    if (text(change) === undefined || text(path) === undefined || text(digest) === undefined || text(by) === undefined || text(at) === undefined) return undefined
    approvals.push({ change: change as string, path: path as string, digest: digest as string, by: by as string, at: at as string })
  }
  const trusted: SealTrust[] = []
  for (const entry of value.trusted) {
    if (!isRecord(entry)) return undefined
    const { digest, by, at } = entry
    if (text(digest) === undefined || text(by) === undefined || text(at) === undefined) return undefined
    trusted.push({ digest: digest as string, by: by as string, at: at as string })
  }
  return { heads, writes, approvals, trusted }
}

function macOf(key: string, seal: TestSeal): string {
  return createHmac('sha256', key).update(canonicalJson({ schema: TEST_SEAL_SCHEMA, ...seal })).digest('hex')
}

async function readKey(path: string): Promise<string | undefined> {
  try {
    const entry = await lstat(path)
    if (!entry.isFile() || entry.size === 0 || entry.size > MAX_KEY_BYTES) return undefined
    const key = (await readFile(path, 'utf8')).trim()
    return key === '' ? undefined : key
  } catch {
    return undefined
  }
}

export interface SealRead {
  readonly state: SealState
  readonly seal: TestSeal
}

/** 读封存；任何异常都读成空封存（`state` 说明为什么）。 */
export async function readTestSeal(repoRoot: string, slug: string): Promise<SealRead> {
  const paths = userProjectPaths(repoRoot, slug)
  let raw: string
  try {
    const entry = await lstat(testSealPath(repoRoot, slug))
    if (!entry.isFile() || entry.size > MAX_SEAL_BYTES) return { state: 'invalid', seal: EMPTY_TEST_SEAL }
    raw = await readFile(testSealPath(repoRoot, slug), 'utf8')
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'invalid', seal: EMPTY_TEST_SEAL }
  }
  const key = await readKey(paths.envKey)
  if (key === undefined) return { state: 'invalid', seal: EMPTY_TEST_SEAL }
  try {
    const parsed: unknown = JSON.parse(raw)
    const seal = decodeSeal(parsed)
    const mac = isRecord(parsed) ? text(parsed.mac) : undefined
    if (seal === undefined || mac === undefined) return { state: 'invalid', seal: EMPTY_TEST_SEAL }
    const expected = Buffer.from(macOf(key, seal), 'hex')
    const actual = Buffer.from(mac, 'hex')
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return { state: 'invalid', seal: EMPTY_TEST_SEAL }
    return { state: 'ok', seal }
  } catch {
    return { state: 'invalid', seal: EMPTY_TEST_SEAL }
  }
}

async function ensureKey(path: string): Promise<string> {
  const existing = await readKey(path)
  if (existing !== undefined) return existing
  const key = randomBytes(32).toString('hex')
  try {
    await writeFile(path, `${key}\n`, { mode: 0o600, flag: 'wx' })
    return key
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const raced = await readKey(path)
    if (raced === undefined) throw new Error('env.key 已存在但不可读')
    return raced
  }
}

/**
 * 读—改—写封存（本机锁 + 原子替换）。当前封存不可信（损坏或 mac 不符）时从空封存起步：旧的信任与批准作废，
 * 这正是「被改动的封存不再被承认」的语义，写入方不需要再特殊处理。
 */
export async function updateTestSeal(
  repoRoot: string,
  slug: string,
  mutate: (seal: TestSeal) => TestSeal,
): Promise<TestSeal> {
  const paths = await ensureUserLocalDir(repoRoot, slug)
  return withLock(paths.localDir, async () => {
    const key = await ensureKey(paths.envKey)
    const next = mutate((await readTestSeal(repoRoot, slug)).seal)
    const body = { schema: TEST_SEAL_SCHEMA, ...next, mac: macOf(key, next) }
    await atomicReplaceFile(testSealPath(repoRoot, slug), `${JSON.stringify(body, null, 2)}\n`)
    return next
  })
}

/** 记录链头（appendTestRunRecordV2 在链锁内调用）。 */
export async function sealRecordHead(repoRoot: string, slug: string, change: string, head: string): Promise<void> {
  await updateTestSeal(repoRoot, slug, (seal) => ({ ...seal, heads: { ...seal.heads, [change]: head } }))
}

/** 共享受保护文件被 Tenon 命令写出（digest = 写出后的内容摘要；文件已删记 `deleted`）。 */
export async function sealSharedWrite(
  repoRoot: string,
  slug: string,
  writes: readonly { readonly path: string; readonly digest: string }[],
  at: string,
): Promise<void> {
  await updateTestSeal(repoRoot, slug, (seal) => ({
    ...seal,
    writes: { ...seal.writes, ...Object.fromEntries(writes.map((entry) => [entry.path, { digest: entry.digest, at }])) },
  }))
}

export function isApproved(seal: TestSeal, change: string, path: string, digest: string): boolean {
  return seal.approvals.some((entry) => entry.change === change && entry.path === path && entry.digest === digest)
}

export function isTrusted(seal: TestSeal, digest: string): boolean {
  return seal.trusted.some((entry) => entry.digest === digest)
}
