/**
 * 运行记录 v2 的哈希链：每用户每任务一条链，记录按 `prev_digest` 串联，`digest` 是除自身外全部字段的
 * 规范 JSON 摘要。不做密码学签名（本机单用户威胁模型）：hook 拦截写入，链负责发现事后改动。
 *
 * 校验（纯函数 verifyRecordChain）：
 *   1. 取最新的链首（prev_digest 为 null 的记录）为当前链首；它若带 chain_reset，其中列出的文件被取代、
 *      一律视为未运行。
 *   2. 其余每个 v2 记录都必须内容摘要正确，并从链首起一条线串到链尾（不许分叉、不许断环、不许游离）。
 *   3. 无法读取或声明 v2 却解码失败的文件，只要没被取代，就判链断。
 * 链断 → 该用户该任务的 v2 记录全部视为未运行；重跑时写入方另起新链并取代当时的全部文件。
 *
 * 追加（appendTestRunRecordV2，只供 `tenon test run`）：在本机锁内列目录、校验、补链字段、独占发布，
 * 两个并发运行不会分叉。
 */
import { lstat, mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { sha256Hex } from '../sha256.js'
import { atomicLinkPublish } from '../state/atomic-publish.js'
import { withLock } from '../state/lock.js'
import { TEST_RUN_SCHEMA } from '../test-evidence/types.js'
import { canonicalJson } from './canonical.js'
import { testRecordChainLockDir, testRunRecordsDir } from './paths.js'
import { declaresRecordV2, decodeTestRunRecordV2 } from './record-v2-codec.js'
import type { TestRunRecordV2, TestRunRecordV2Draft } from './record-v2-types.js'
import { readTestSeal, sealRecordHead } from './seal.js'

const MAX_RECORD_BYTES = 16 * 1024 * 1024

export function recordV2Digest(record: Omit<TestRunRecordV2, 'digest'> | TestRunRecordV2): string {
  const { digest: _digest, ...content } = record as TestRunRecordV2
  return `sha256:${sha256Hex(canonicalJson(content))}`
}

export interface RecordFileEntry {
  readonly file: string
  readonly record: TestRunRecordV2
}

export interface RecordDirectoryListing {
  readonly records: readonly RecordFileEntry[]
  /** 无法读取、非 JSON、schema 不认识或声明 v2 却解码失败的文件名。v1 记录不在此列。 */
  readonly problems: readonly string[]
}

export type ChainReport =
  | { readonly state: 'empty' }
  | {
      readonly state: 'intact'
      readonly head: string
      /** 当前链上的记录，链序（链首在前）。 */
      readonly active: readonly TestRunRecordV2[]
      readonly superseded: readonly string[]
    }
  | { readonly state: 'broken'; readonly reason: string; readonly files: readonly string[] }

function order(left: TestRunRecordV2, right: TestRunRecordV2): number {
  if (left.finished_at !== right.finished_at) return left.finished_at < right.finished_at ? -1 : 1
  return left.run_id < right.run_id ? -1 : left.run_id > right.run_id ? 1 : 0
}

export function verifyRecordChain(listing: RecordDirectoryListing): ChainReport {
  const geneses = listing.records.filter((entry) => entry.record.prev_digest === null)
    .sort((left, right) => order(left.record, right.record))
  const genesis = geneses.at(-1)
  if (genesis === undefined) {
    if (listing.records.length === 0 && listing.problems.length === 0) return { state: 'empty' }
    const files = [...listing.problems, ...listing.records.map((entry) => entry.file)].sort()
    return { state: 'broken', reason: '找不到链首记录', files }
  }
  const superseded = new Set(genesis.record.chain_reset?.superseded ?? [])
  const problems = listing.problems.filter((file) => !superseded.has(file))
  if (problems.length > 0) return { state: 'broken', reason: '有记录文件无法读取或格式非法', files: problems }
  const remaining = listing.records.filter((entry) => !superseded.has(entry.file))
  const tampered = remaining.filter((entry) => entry.file !== `${entry.record.run_id}.json`
    || recordV2Digest(entry.record) !== entry.record.digest)
  if (tampered.length > 0) return { state: 'broken', reason: '记录内容与摘要不符（被改动）', files: tampered.map((entry) => entry.file) }
  const byPrev = new Map<string, RecordFileEntry[]>()
  for (const entry of remaining) {
    const prev = entry.record.prev_digest
    if (prev === null) continue
    byPrev.set(prev, [...(byPrev.get(prev) ?? []), entry])
  }
  const active: TestRunRecordV2[] = [genesis.record]
  const visited = new Set<string>([genesis.file])
  let current = genesis
  for (;;) {
    const next = byPrev.get(current.record.digest) ?? []
    if (next.length > 1) return { state: 'broken', reason: '记录链出现分叉', files: next.map((entry) => entry.file) }
    const entry = next[0]
    if (entry === undefined) break
    if (visited.has(entry.file)) return { state: 'broken', reason: '记录链成环', files: [entry.file] }
    visited.add(entry.file)
    active.push(entry.record)
    current = entry
  }
  const stray = remaining.filter((entry) => !visited.has(entry.file))
  if (stray.length > 0) return { state: 'broken', reason: '有记录不在当前链上（中间记录缺失或被替换）', files: stray.map((entry) => entry.file) }
  return { state: 'intact', head: current.record.digest, active, superseded: [...superseded].sort() }
}

async function readRecordFile(path: string): Promise<'v1' | 'problem' | TestRunRecordV2> {
  try {
    const entry = await lstat(path)
    if (!entry.isFile() || entry.size > MAX_RECORD_BYTES) return 'problem'
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (typeof value === 'object' && value !== null && !Array.isArray(value)
      && (value as Record<string, unknown>).schema === TEST_RUN_SCHEMA) return 'v1'
    if (!declaresRecordV2(value)) return 'problem'
    return decodeTestRunRecordV2(value) ?? 'problem'
  } catch {
    return 'problem'
  }
}

/** 列出一个记录目录：v2 记录解码，v1 记录跳过，其余 `.json` 文件记为问题。目录不存在 = 空。 */
export async function listRecordDirectory(dir: string): Promise<RecordDirectoryListing> {
  let names: string[]
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { records: [], problems: [] }
    throw error
  }
  const records: RecordFileEntry[] = []
  const problems: string[] = []
  for (const file of names) {
    const result = await readRecordFile(join(dir, file))
    if (result === 'v1') continue
    if (result === 'problem') problems.push(file)
    else records.push({ file, record: result })
  }
  return { records, problems }
}

export async function readRecordChain(repoRoot: string, slug: string, change: string): Promise<ChainReport> {
  return verifyRecordChain(await listRecordDirectory(testRunRecordsDir(repoRoot, slug, change)))
}

export interface AppendResult {
  readonly record: TestRunRecordV2
  readonly path: string
  /** appended = 接在完好且已封存的链尾；started = 第一条；reset = 旧链已断或来源不明（链头没有封存），另起新链。 */
  readonly chain: 'appended' | 'started' | 'reset'
  readonly previous: ChainReport
}

/**
 * 只供 `tenon test run` 调用。锁在本机 gitignored 目录；同一 run-id 已存在即失败（绝不覆盖）。
 * 写完后把新链头封存进本机封存文件（seal.ts）：之后门禁只承认链头等于封存链头的记录链。
 * 追加前当前链若完好却与封存链头不符（记录是绕开命令写进来的），一律另起新链取代它们，不在伪造的记录后面接续。
 */
export async function appendTestRunRecordV2(
  repoRoot: string,
  slug: string,
  draft: TestRunRecordV2Draft,
): Promise<AppendResult> {
  const dir = testRunRecordsDir(repoRoot, slug, draft.change)
  const lockDir = testRecordChainLockDir(repoRoot, slug, draft.change)
  await mkdir(lockDir, { recursive: true })
  return withLock(lockDir, async () => {
    await mkdir(dir, { recursive: true })
    const listing = await listRecordDirectory(dir)
    const previous = verifyRecordChain(listing)
    const sealedHead = (await readTestSeal(repoRoot, slug)).seal.heads[draft.change]
    const continuing = previous.state === 'intact' && previous.head === sealedHead
    const base = previous.state === 'intact' && continuing
      ? { ...draft, prev_digest: previous.head }
      : previous.state === 'empty'
        ? { ...draft, prev_digest: null }
        : {
            ...draft,
            prev_digest: null,
            chain_reset: { superseded: [...listing.problems, ...listing.records.map((entry) => entry.file)].sort() },
          }
    const record: TestRunRecordV2 = { ...base, digest: recordV2Digest(base) }
    if (decodeTestRunRecordV2(JSON.parse(JSON.stringify(record))) === undefined) {
      throw new Error('appendTestRunRecordV2: 记录形状非法，拒绝写入')
    }
    const path = join(dir, `${record.run_id}.json`)
    await atomicLinkPublish(dir, '.test-run-v2', path, `${JSON.stringify(record, null, 2)}\n`)
    await sealRecordHead(repoRoot, slug, draft.change, record.digest)
    return {
      record,
      path,
      chain: continuing ? 'appended' : previous.state === 'empty' ? 'started' : 'reset',
      previous,
    }
  })
}
