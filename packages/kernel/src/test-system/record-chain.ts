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
 *
 * 保留上限清理（pruneRecordChain，同一把锁）：记录是入版本库的，不清理会随每次运行无界增长，一次交付提交带上几十份。
 * 清理只删最老的前缀，并在同目录写一个链基点标记 `chain-base`：`base` 是被删的最后一条记录的摘要，保留下来的最老
 * 一条的 `prev_digest` 必须等于它，链才算从这里开始；`pruned` 列出本次要删的文件（先写标记、再删文件，中途崩溃时这些
 * 文件被当作不存在）。标记只放行「最老一端的前缀被清理」：中间缺记录、基点对不上、标记损坏，照旧是断链。
 */
import { lstat, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { sha256Hex } from '../sha256.js'
import { atomicLinkPublish, atomicReplaceFile } from '../state/atomic-publish.js'
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

/**
 * 由 RecordChainCache 解码出来的记录对象，及其摘要校验结果。这些对象只在文件未变时才被复用，也不会交给调用方改写，
 * 所以同一个对象再次校验时不必重新规范化、重算 sha256。调用方自己构造的记录不在此集合里，每次照旧重算。
 */
const cacheOwned = new WeakSet<object>()
const digestVerdicts = new WeakMap<object, boolean>()

function digestMatches(record: TestRunRecordV2): boolean {
  if (!cacheOwned.has(record)) return recordV2Digest(record) === record.digest
  const known = digestVerdicts.get(record)
  if (known !== undefined) return known
  const verdict = recordV2Digest(record) === record.digest
  digestVerdicts.set(record, verdict)
  return verdict
}

export interface RecordFileEntry {
  readonly file: string
  readonly record: TestRunRecordV2
}

/** 链基点标记：最老一端的前缀已被清理，链从 `prev_digest === base` 的那条记录开始。 */
export interface ChainBase {
  readonly base: string
  /** 已决定清理、可能还没删干净的文件名；校验时当作不存在。 */
  readonly pruned: readonly string[]
}

/** 每个用户每个任务保留的运行记录条数（v1 按测试项、v2 按链）；更老的在下一次运行后被清理。 */
export const RECORD_RETENTION = 20
export const CHAIN_BASE_FILE = 'chain-base'
const CHAIN_BASE_SCHEMA = 'tenon-record-chain-base/v1'
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/

export interface RecordDirectoryListing {
  readonly records: readonly RecordFileEntry[]
  /** 无法读取、非 JSON、schema 不认识或声明 v2 却解码失败的文件名。v1 记录不在此列。 */
  readonly problems: readonly string[]
  /** 目录里的链基点标记；没有标记（从未清理过）时缺省。 */
  readonly base?: ChainBase
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
  const base = listing.base
  const pruned = new Set(base?.pruned ?? [])
  const visible = listing.records.filter((entry) => !pruned.has(entry.file))
  const geneses = visible.filter((entry) => entry.record.prev_digest === null
    || (base !== undefined && entry.record.prev_digest === base.base))
    .sort((left, right) => order(left.record, right.record))
  const genesis = geneses.at(-1)
  if (genesis === undefined) {
    if (visible.length === 0 && listing.problems.length === 0) return { state: 'empty' }
    const files = [...listing.problems, ...visible.map((entry) => entry.file)].sort()
    return { state: 'broken', reason: '找不到链首记录', files }
  }
  const superseded = new Set(genesis.record.chain_reset?.superseded ?? [])
  const problems = listing.problems.filter((file) => !superseded.has(file))
  if (problems.length > 0) return { state: 'broken', reason: '有记录文件无法读取或格式非法', files: problems }
  const remaining = visible.filter((entry) => !superseded.has(entry.file))
  const tampered = remaining.filter((entry) => entry.file !== `${entry.record.run_id}.json`
    || !digestMatches(entry.record))
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

async function readChainBase(dir: string): Promise<ChainBase | 'problem' | undefined> {
  let text: string
  try {
    text = await readFile(join(dir, CHAIN_BASE_FILE), 'utf8')
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : 'problem'
  }
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'problem'
    const record = Object.fromEntries(Object.entries(value))
    const keys = Object.keys(record).sort().join(',')
    if (keys !== 'base,pruned,schema' || record.schema !== CHAIN_BASE_SCHEMA) return 'problem'
    const { base, pruned } = record
    if (typeof base !== 'string' || !DIGEST_RE.test(base) || !Array.isArray(pruned)) return 'problem'
    if (pruned.length > 100_000 || !pruned.every((file) => typeof file === 'string' && /^[A-Za-z0-9._-]+\.json$/.test(file))) return 'problem'
    return { base, pruned: pruned.map(String) }
  } catch {
    return 'problem'
  }
}

/** 一个记录文件的解码结果，连同读它之前的文件身份：身份没变就不必再读、再解码、再算摘要。 */
interface CachedRecordFile {
  readonly stamp: string
  readonly parsed: 'v1' | 'problem' | TestRunRecordV2
}

interface CachedRecordDirectory {
  readonly files: ReadonlyMap<string, CachedRecordFile>
  /** 链基点标记 `chain-base` 的文件身份与解码结果；标记换了（清理写过它）才重读。 */
  readonly baseStamp: string
  readonly base: ChainBase | 'problem' | undefined
  /** 目录里每个 .json 与链基点标记的「文件名 + 身份」；整体没变就直接复用下面的列表与链报告。 */
  readonly listingKey: string
  readonly listing: RecordDirectoryListing
  chain?: ChainReport
}

/**
 * 记录链校验结果的缓存，按记录文件与链基点标记的指纹（inode、大小、mtime、ctime）判定是否仍然有效。
 * 只给长驻进程的读取路径用（Dashboard 快照每次轮询都要看链；链上 N 条记录每次都重读、重解码、重算摘要是 O(N) 的读+哈希）。
 * ctime 由内核维护、写文件的人改不了，所以「改内容后把大小和 mtime 还原」也会让指纹失效——缓存不会放过被改动的记录。
 * 转换门禁与 `tenon test` 命令不传缓存，判定仍然每次从磁盘完整重算。
 */
export interface RecordChainCache {
  /** @internal */
  readonly directories: Map<string, CachedRecordDirectory>
  readonly maxDirectories: number
}

export function createRecordChainCache(maxDirectories = 256): RecordChainCache {
  return { directories: new Map(), maxDirectories }
}

async function fileStamp(path: string): Promise<string> {
  try {
    const entry = await lstat(path, { bigint: true })
    return `${entry.ino}:${entry.size}:${entry.mtimeNs}:${entry.ctimeNs}:${entry.isFile() ? 'f' : 'x'}`
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unreadable'
  }
}

function listingOf(
  files: ReadonlyMap<string, CachedRecordFile>,
  names: readonly string[],
  base: ChainBase | 'problem' | undefined,
): RecordDirectoryListing {
  const records: RecordFileEntry[] = []
  const problems: string[] = []
  if (base === 'problem') problems.push(CHAIN_BASE_FILE)
  for (const file of names) {
    const result = files.get(file)?.parsed
    if (result === undefined || result === 'v1') continue
    if (result === 'problem') problems.push(file)
    else records.push({ file, record: result })
  }
  return { records, problems, ...(base === undefined || base === 'problem' ? {} : { base }) }
}

async function listCachedRecordDirectory(dir: string, names: readonly string[], cache: RecordChainCache): Promise<RecordDirectoryListing> {
  const previous = cache.directories.get(dir)
  const [baseStamp, ...stamps] = await Promise.all([
    fileStamp(join(dir, CHAIN_BASE_FILE)),
    ...names.map((file) => fileStamp(join(dir, file))),
  ])
  // 记录文件在 readdir 与 lstat 之间消失（absent）和读不了（unreadable）一样不可缓存；标记不存在是常态，只有读不了才不可缓存。
  const cacheable = baseStamp !== 'unreadable' && !stamps.some((stamp) => stamp === 'unreadable' || stamp === 'absent')
  const listingKey = [`${CHAIN_BASE_FILE}\0${baseStamp}`, ...names.map((file, index) => `${file}\0${stamps[index]}`)].join('\n')
  if (previous !== undefined && cacheable && previous.listingKey === listingKey) {
    cache.directories.delete(dir)
    cache.directories.set(dir, previous)
    return previous.listing
  }
  const files = new Map<string, CachedRecordFile>()
  for (const [index, file] of names.entries()) {
    const stamp = stamps[index] ?? 'unreadable'
    const known = previous?.files.get(file)
    if (known !== undefined && known.stamp === stamp && stamp !== 'unreadable' && stamp !== 'absent') {
      files.set(file, known)
      continue
    }
    const parsed = await readRecordFile(join(dir, file))
    if (typeof parsed === 'object') cacheOwned.add(parsed)
    files.set(file, { stamp, parsed })
  }
  const base = previous !== undefined && baseStamp !== 'unreadable' && previous.baseStamp === baseStamp
    ? previous.base
    : await readChainBase(dir)
  const entry: CachedRecordDirectory = { files, baseStamp, base, listingKey, listing: listingOf(files, names, base) }
  cache.directories.delete(dir)
  cache.directories.set(dir, entry)
  while (cache.directories.size > cache.maxDirectories) {
    const oldest = cache.directories.keys().next().value
    if (oldest === undefined) break
    cache.directories.delete(oldest)
  }
  return entry.listing
}

/**
 * 列出一个记录目录：v2 记录解码，v1 记录跳过，其余 `.json` 文件记为问题。目录不存在 = 空。
 * 传 `cache` 时，指纹没变的文件不重读；不传则每次从磁盘完整读取。
 */
export async function listRecordDirectory(dir: string, cache?: RecordChainCache): Promise<RecordDirectoryListing> {
  let names: string[]
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      cache?.directories.delete(dir)
      return { records: [], problems: [] }
    }
    throw error
  }
  if (cache !== undefined) return listCachedRecordDirectory(dir, names, cache)
  const records: RecordFileEntry[] = []
  const problems: string[] = []
  const base = await readChainBase(dir)
  if (base === 'problem') problems.push(CHAIN_BASE_FILE)
  for (const file of names) {
    const result = await readRecordFile(join(dir, file))
    if (result === 'v1') continue
    if (result === 'problem') problems.push(file)
    else records.push({ file, record: result })
  }
  return { records, problems, ...(base === undefined || base === 'problem' ? {} : { base }) }
}

export async function readRecordChain(repoRoot: string, slug: string, change: string, cache?: RecordChainCache): Promise<ChainReport> {
  const dir = testRunRecordsDir(repoRoot, slug, change)
  const listing = await listRecordDirectory(dir, cache)
  if (cache === undefined) return verifyRecordChain(listing)
  const entry = cache.directories.get(dir)
  if (entry?.listing === listing && entry.chain !== undefined) return entry.chain
  const chain = verifyRecordChain(listing)
  if (entry?.listing === listing) entry.chain = chain
  return chain
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

/**
 * 保留上限清理：链完好且记录多于 `keep` 时，只留最新的 `keep` 条。链已断、没有多余记录或目录不存在时什么都不做。
 * 返回被删的文件名。先写链基点标记（列出要删的文件）、再删文件、最后把标记收敛成只有基点；中途崩溃时链依然完好，
 * 下一次清理把遗留的文件收掉。
 */
export async function pruneRecordChain(
  repoRoot: string,
  slug: string,
  change: string,
  keep: number,
): Promise<readonly string[]> {
  const dir = testRunRecordsDir(repoRoot, slug, change)
  if ((await listRecordDirectory(dir)).records.length === 0) return []
  const lockDir = testRecordChainLockDir(repoRoot, slug, change)
  await mkdir(lockDir, { recursive: true })
  return withLock(lockDir, async () => {
    const listing = await listRecordDirectory(dir)
    const report = verifyRecordChain(listing)
    if (report.state !== 'intact') return []
    const present = new Set(listing.records.map((entry) => entry.file))
    const leftovers = (listing.base?.pruned ?? []).filter((file) => present.has(file))
    const dropped = report.active.slice(0, Math.max(0, report.active.length - Math.max(1, keep)))
    const base = dropped.at(-1)?.digest ?? listing.base?.base
    if (base === undefined || (dropped.length === 0 && leftovers.length === 0)) return []
    const files = [...new Set([...leftovers, ...dropped.map((record) => `${record.run_id}.json`)])]
    const marker = (pruned: readonly string[]): string =>
      `${JSON.stringify({ schema: CHAIN_BASE_SCHEMA, base, pruned }, null, 2)}\n`
    await atomicReplaceFile(join(dir, CHAIN_BASE_FILE), marker(files))
    for (const file of files) await rm(join(dir, file), { force: true })
    await atomicReplaceFile(join(dir, CHAIN_BASE_FILE), marker([]))
    return files
  })
}
