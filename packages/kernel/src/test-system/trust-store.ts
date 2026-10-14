/**
 * 用户级测试信任存储 `<stateRoot>/test-trust/<user-slug>.json`：用户在本机确认过的「仓库 + 单条命令」。
 *
 * 为什么不放在检出目录里：信任是用户的决定，不是仓库的属性。存储和密钥都在用户级状态目录，被检仓库里的文件
 * 不能提供或影响这份存储本身；同一仓库的所有 worktree 因此共享同一份信任。
 *
 * 本模块不管检出里旧的 `test-seal.json`（kernel seal.ts）：它的整份信任按规格仍是兼容的来源，由 CLI 的
 * `tenon test run` / `trust` 判定（commands/test-trust.ts）。那里的规则是：git 仓库里一律不认检出里的旧封存
 * （检出里的封存连同密钥可能随仓库提交或压缩包一起带来，不能给自己授信），只有不是 git 仓库的项目才退回检出里的旧封存。
 *
 * 整份文件用 HMAC-SHA256 封印，密钥 `<slug>.key` 在同一目录，两者都是 0600。读取永不抛错：文件缺失、损坏、
 * 封印不符、密钥或目录权限过宽或属主不是当前用户一律读成空（失败关闭，调用方据此要求重新确认）。这不是对同 UID 恶意者的密码学防御
 * （能读密钥就能重算），而是让误写、顺手写必须刻意做，并配合 hook 拒绝 agent 写 test-trust 目录下的任何路径。
 * 写入：目录锁 + 临时文件 + rename（复用 users/user-paths 的 0600 原子写，拒绝符号链接目标），
 * 同一 (仓库, 摘要) 只记一条，最多 2000 条，满了按时间淘汰最旧的。写入时在锁内读现有存储：缺失或不可信从空起步，
 * 读不了（I/O 错误）则抛错、不写盘。
 *
 * 本模块不读 `process.env`：`stateRoot` 由调用方经 `resolveProductPaths` 传入。
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Stats } from 'node:fs'
import { withLock } from '../state/lock.js'
import { writeUserLocalFile } from '../users/user-paths.js'
import { canonicalJson } from './canonical.js'

export const TRUST_STORE_SCHEMA = 'tenon-test-trust/v1'
export const TRUST_STORE_DIR = 'test-trust'
export const TRUST_STORE_MAX_ENTRIES = 2000
/** `command` 只用于让用户事后看得懂记的是什么，不参与判定；超长的显示文字截断。 */
const COMMAND_MAX_CHARS = 500
const MAX_STORE_BYTES = 8 * 1024 * 1024
const MAX_KEY_BYTES = 4096

export interface TrustEntry {
  /** 仓库身份：`git rev-parse --git-common-dir` 的真实路径。 */
  readonly repo: string
  /** 单条可执行命令的摘要（catalogExecEntries / stepTestExecEntries）。 */
  readonly digest: string
  /** 确认时给用户看的那一行（审计用）。 */
  readonly command: string
  readonly by: string
  readonly at: string
}

/** 与 userSlug 的输出同形（`users/user-paths.ts` 的 SLUG）：只含 `[a-z0-9._-]` 且恒含 `-at-`，不可能是路径分隔或 `..`。 */
const SLUG = /^[a-z0-9._-]*-at-[a-z0-9._-]*$/u

export function testTrustPaths(stateRoot: string, slug: string): { readonly file: string; readonly key: string } {
  if (!SLUG.test(slug)) throw new Error(`用户目录名非法: ${slug}`)
  const dir = join(stateRoot, TRUST_STORE_DIR)
  return { file: join(dir, `${slug}.json`), key: join(dir, `${slug}.key`) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function decodeEntries(value: unknown): readonly TrustEntry[] | undefined {
  if (!Array.isArray(value)) return undefined
  const entries: TrustEntry[] = []
  for (const item of value as readonly unknown[]) {
    if (!isRecord(item)) return undefined
    const repo = text(item.repo)
    const digest = text(item.digest)
    const command = text(item.command)
    const by = text(item.by)
    const at = text(item.at)
    if (repo === undefined || digest === undefined || command === undefined || by === undefined || at === undefined) return undefined
    entries.push({ repo, digest, command, by, at })
  }
  return entries
}

function macOf(key: string, entries: readonly TrustEntry[]): string {
  return createHmac('sha256', key).update(canonicalJson({ schema: TRUST_STORE_SCHEMA, entries })).digest('hex')
}

/** Windows 的权限位没有意义（产品不支持原生 Windows），不据此判定。 */
function groupOrOtherBits(entry: Stats, mask: number): boolean {
  return process.platform !== 'win32' && (entry.mode & mask) !== 0
}

/**
 * 属主不是当前用户。stateRoot 在共享位置时，别的用户放进来的目录 / 密钥不可信（能写它就能伪造存储），按不可用处理。
 * 没有 `process.getuid`（Windows）时不判定。
 */
function ownedByOtherUser(entry: Stats): boolean {
  return typeof process.getuid === 'function' && entry.uid !== process.getuid()
}

async function readKey(path: string): Promise<string | undefined> {
  try {
    const entry = await lstat(path)
    if (!entry.isFile() || entry.size === 0 || entry.size > MAX_KEY_BYTES || groupOrOtherBits(entry, 0o077) || ownedByOtherUser(entry)) return undefined
    const key = (await readFile(path, 'utf8')).trim()
    return key === '' ? undefined : key
  } catch {
    return undefined
  }
}

/** 存储目录必须是当前用户的普通目录（不是符号链接），且组 / 其他用户不能写：能往里写就能换掉密钥再伪造存储。 */
async function trustDirIsSafe(dir: string): Promise<boolean> {
  try {
    const entry = await lstat(dir)
    return entry.isDirectory() && !groupOrOtherBits(entry, 0o022) && !ownedByOtherUser(entry)
  } catch {
    return false
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT'
}

/**
 * 用已知的密钥读存储文件并验封印。文件不存在、不是普通文件、过大、解析不了、结构不对、封印不符都读成空（存储不可信）；
 * 其余读错误（EACCES、EIO 等）原样抛出：这时不知道文件里有什么，调用方不能当它是空的。
 */
async function readStoreFile(file: string, key: string): Promise<readonly TrustEntry[]> {
  let raw: string
  try {
    const entry = await lstat(file)
    if (!entry.isFile() || entry.size > MAX_STORE_BYTES) return []
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!isRecord(parsed) || parsed.schema !== TRUST_STORE_SCHEMA) return []
  const entries = decodeEntries(parsed.entries)
  const mac = text(parsed.mac)
  if (entries === undefined || mac === undefined) return []
  const expected = Buffer.from(macOf(key, entries), 'hex')
  const actual = Buffer.from(mac, 'hex')
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? entries : []
}

async function readVerified(stateRoot: string, slug: string): Promise<readonly TrustEntry[]> {
  const paths = testTrustPaths(stateRoot, slug)
  if (!(await trustDirIsSafe(dirname(paths.file)))) return []
  const key = await readKey(paths.key)
  return key === undefined ? [] : readStoreFile(paths.file, key)
}

/** 读存储；任何异常、缺失、损坏、封印不符都读成空。 */
export async function readTrustStore(stateRoot: string, slug: string): Promise<readonly TrustEntry[]> {
  try {
    return await readVerified(stateRoot, slug)
  } catch {
    return []
  }
}

async function ensureTrustDir(stateRoot: string, dir: string): Promise<void> {
  await mkdir(stateRoot, { recursive: true })
  try {
    await mkdir(dir, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  if (!(await trustDirIsSafe(dir))) throw new Error(`测试信任目录不是普通目录，或组 / 其他用户可写，或属主不是当前用户: ${dir}`)
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
    if (raced === undefined) throw new Error(`测试信任密钥已存在但不可用（须是 0600 的非空普通文件）: ${path}`)
    return raced
  }
}

function identityOf(entry: Pick<TrustEntry, 'repo' | 'digest'>): string {
  return `${entry.repo}\u0000${entry.digest}`
}

/** 超过上限时淘汰 `at` 最旧的（同一时间按写入先后），其余保持原有顺序。 */
function retainNewest(entries: readonly TrustEntry[]): readonly TrustEntry[] {
  const overflow = entries.length - TRUST_STORE_MAX_ENTRIES
  if (overflow <= 0) return entries
  const oldest = entries.map((entry, index) => ({ at: entry.at, index }))
    .sort((left, right) => (left.at < right.at ? -1 : left.at > right.at ? 1 : left.index - right.index))
    .slice(0, overflow)
  const dropped = new Set(oldest.map((item) => item.index))
  return entries.filter((_, index) => !dropped.has(index))
}

/**
 * 记下用户确认过的条目（锁内读—改—写 + 原子替换）。当前存储不存在，或不可信（损坏、封印不符）时从空起步：旧信任作废。
 * 存储目录或密钥不可用（符号链接、权限过宽），或存储文件读不了（EACCES、EIO 等 I/O 错误，不知道里面有什么）时
 * 抛错而不是写进去：暂时的读错误不能把已有的信任整份换掉。
 */
export async function addTrustEntries(stateRoot: string, slug: string, entries: readonly TrustEntry[]): Promise<void> {
  if (entries.length === 0) return
  const paths = testTrustPaths(stateRoot, slug)
  const dir = dirname(paths.file)
  await ensureTrustDir(stateRoot, dir)
  await withLock(dir, async () => {
    const key = await ensureKey(paths.key)
    const current = await readStoreFile(paths.file, key)
    const seen = new Set(current.map(identityOf))
    const fresh: TrustEntry[] = []
    for (const entry of entries) {
      if (seen.has(identityOf(entry))) continue
      seen.add(identityOf(entry))
      fresh.push({ ...entry, command: entry.command.slice(0, COMMAND_MAX_CHARS) })
    }
    if (fresh.length === 0) return
    const next = retainNewest([...current, ...fresh])
    await writeUserLocalFile(paths.file, `${JSON.stringify({ schema: TRUST_STORE_SCHEMA, entries: next, mac: macOf(key, next) }, null, 2)}\n`)
  })
}
