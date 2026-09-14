/**
 * mkdir 原子锁 —— POSIX mkdir 原子性，macOS/Linux/BSD 通吃（flock 在 macOS 默认缺席），
 * 语义对齐老内核 state-lib.sh portable_lock。锁目录固定 `<changeDir>/.pipeline.lock/`。
 *
 * 双层互斥：
 * - 进程内：按锁目录路径 FIFO 排队（Promise 链），并发 withLock 严格串行、零忙等；
 * - 跨进程：mkdir 抢占 + 轮询等待 + 陈锁回收（owner 文件 mtime 超 60s 视为持有者已死，接管）。
 *
 * 跨进程正确性（B1 修复）：
 * - **owner token**：先在私有 claim 目录写完整 `<lockDir>/owner.json`，再用 rename 一次发布；
 *   public installer 与 native lifecycle 共用同一 wire protocol，不再出现各持一把“同名锁”。
 * - **心跳刷新 mtime**：持锁期间周期性 utimes owner 文件，令「活着的长任务（fn>60s）」的锁不被误判陈锁
 *   （老实现 mtime 从不刷新 → 长任务被夺锁双持）。
 * - **存活检测**：owner PID 已消失时立即接管；PID 仍存活或无法确认时才等待心跳陈旧阈值，
 *   避免真实进程崩溃后每次恢复固定等待 60 秒。
 * - **原子回收**：废弃锁不再 `rm -rf` 后 mkdir（两进程都判废弃会各 rm+mkdir 双持）；改为把锁目录
 *   `rename` 到唯一坟墓名——rename 原子，多个回收者只有一个成功「移走」，其余得 ENOENT 退回重试 mkdir，
 *   最终持有者恒由原子 mkdir 唯一裁定。
 * - **token 守卫的 release**：只有 owner 仍等于自己的 token 才删锁；被夺锁（token 变更）→ 不删他人的锁
 *   （老实现无条件 rmdir → 夺锁后原持有者 release 会删掉夺锁者的锁）。
 *
 * 注意：锁不可重入——fn 内组合多步请用 read/write 原语，勿嵌套 set/setMany/cas/withLock。
 */
import { randomUUID } from 'node:crypto'
import { link, lstat, mkdir, readFile, rename, rm, rmdir, unlink, utimes, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

export const LOCK_DIR_NAME = '.pipeline.lock'
/** 当前锁归属协议；public installer 与 native lifecycle 必须共同使用。 */
export const LOCK_OWNER_FILE = 'owner.json'
/** 只读兼容旧 native 版本；新锁永不再写这个文件。 */
export const LEGACY_LOCK_OWNER_FILE = 'owner'
/** 陈锁阈值：锁 owner 文件 mtime 超过 60s 视为陈锁，可回收接管 */
export const STALE_LOCK_MS = 60_000
/** 心跳周期：持锁期间每 STALE_LOCK_MS/3 刷新一次 owner 文件 mtime，令活锁永不被误判陈锁 */
const HEARTBEAT_MS = Math.floor(STALE_LOCK_MS / 3)
const ACQUIRE_TIMEOUT_MS = 10_000
const POLL_MS = 10

/** 进程内 FIFO 队尾（按解析后的锁目录路径），存入的 promise 永不 reject */
const queues = new Map<string, Promise<void>>()

/** 持锁凭据：token（release/回收据此校验归属）+ 心跳计时器（release 时清除）。 */
interface Held {
  owner: string
  heartbeat: ReturnType<typeof setInterval>
}

interface LockOwnerRecord {
  version: 1
  owner: string
  pid: number
  pidStart?: string
  createdAt: number
}

interface ObservedLock {
  ageMs: number
  processState: 'alive' | 'dead' | 'unknown'
  retirementKey: string
}

function lockDirFor(changeDir: string): string {
  return path.join(path.resolve(changeDir), LOCK_DIR_NAME)
}

function ownerPathFor(lockDir: string): string {
  return path.join(lockDir, LOCK_OWNER_FILE)
}

function legacyOwnerPathFor(lockDir: string): string {
  return path.join(lockDir, LEGACY_LOCK_OWNER_FILE)
}

function ownRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null
}

/** 锁年龄（ms）：优先按 owner 文件 mtime（心跳刷新的真相源）；无 owner 文件回退锁目录 mtime；
 *  两者皆 stat 失败（锁刚消失）→ null，调用方立刻重试 mkdir。 */
async function processStartIdentity(pid: number): Promise<string | null> {
  try {
    if (process.platform === 'linux') {
      const raw = await readFile(`/proc/${pid}/stat`, 'utf8')
      const close = raw.lastIndexOf(')')
      if (close < 0) return null
      const fields = raw.slice(close + 2).trim().split(/\s+/u)
      const start = fields[19]
      return start !== undefined && /^[0-9]+$/u.test(start) ? `linux:${start}` : null
    }
    const ps = process.platform === 'darwin' ? '/bin/ps' : '/usr/bin/ps'
    const result = spawnSync(ps, ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const start = result.status === 0 && typeof result.stdout === 'string' ? result.stdout.trim() : ''
    return start === '' ? null : `${process.platform}:${start}`
  } catch {
    return null
  }
}

function parseOwnerRecord(text: string): LockOwnerRecord | null {
  try {
    const value = ownRecord(JSON.parse(text))
    if (value === null) return null
    const keys = Object.keys(value).sort().join(',')
    if (keys !== 'createdAt,owner,pid,pidStart,version' && keys !== 'createdAt,owner,pid,version') return null
    if (value.version !== 1 || typeof value.owner !== 'string' || !/^[0-9a-f-]{36}$/u.test(value.owner)) return null
    if (typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid <= 0) return null
    if (typeof value.createdAt !== 'number'
      || !Number.isSafeInteger(value.createdAt)
      || value.createdAt <= 0) return null
    if (value.pidStart !== undefined && (typeof value.pidStart !== 'string' || value.pidStart === '')) return null
    return {
      version: 1,
      owner: value.owner,
      pid: value.pid,
      ...(value.pidStart === undefined ? {} : { pidStart: value.pidStart }),
      createdAt: value.createdAt,
    }
  } catch {
    return null
  }
}

function parseLegacyOwner(text: string): { pid: number; pidStart?: string } | null {
  const owner = text.trim()
  const pidText = owner.split('.', 1)[0] ?? ''
  if (!/^[1-9][0-9]*$/.test(pidText)) return null
  const pid = Number(pidText)
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  const encodedStart = owner.split('.')[3]
  if (encodedStart === undefined) return { pid }
  try {
    return { pid, pidStart: Buffer.from(encodedStart, 'base64url').toString('utf8') }
  } catch {
    return null
  }
}

/** 仅 ESRCH 或 PID start identity 不同能证明 owner 已死；其余情况一律 fail closed。 */
async function processState(pid: number, expectedStart?: string): Promise<'alive' | 'dead' | 'unknown'> {
  try {
    process.kill(pid, 0)
    if (expectedStart === undefined) return 'alive'
    const actualStart = await processStartIdentity(pid)
    return actualStart === null ? 'alive' : actualStart === expectedStart ? 'alive' : 'dead'
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown'
  }
}

async function observeLock(lockDir: string): Promise<ObservedLock | null> {
  let dirItem
  try {
    dirItem = await lstat(lockDir)
  } catch {
    return null
  }
  if (!dirItem.isDirectory() || dirItem.isSymbolicLink()) {
    return { ageMs: 0, processState: 'unknown', retirementKey: `${dirItem.dev}-${dirItem.ino}` }
  }

  let ownerMtime = dirItem.mtimeMs
  let ownerIdentity: { pid: number; pidStart?: string } | null = null
  try {
    const item = await lstat(ownerPathFor(lockDir))
    if (!item.isFile() || item.isSymbolicLink()) {
      return { ageMs: Date.now() - item.mtimeMs, processState: 'unknown', retirementKey: `${dirItem.dev}-${dirItem.ino}` }
    }
    ownerMtime = item.mtimeMs
    ownerIdentity = parseOwnerRecord(await readFile(ownerPathFor(lockDir), 'utf8'))
  } catch {
    try {
      const item = await lstat(legacyOwnerPathFor(lockDir))
      if (item.isFile() && !item.isSymbolicLink()) {
        ownerMtime = item.mtimeMs
        ownerIdentity = parseLegacyOwner(await readFile(legacyOwnerPathFor(lockDir), 'utf8'))
      }
    } catch {
      // An owner-less directory is an unknown generation and is reclaimable only after staleness.
    }
  }
  return {
    ageMs: Date.now() - ownerMtime,
    processState: ownerIdentity === null
      ? 'unknown'
      : await processState(ownerIdentity.pid, ownerIdentity.pidStart),
    retirementKey: `${dirItem.dev}-${dirItem.ino}`,
  }
}

/** 原子回收废弃锁：把锁目录 rename 到唯一坟墓名（原子，多回收者只有一个成功），再删坟墓。
 *  rename 失败（他人已移走/替换）→ 静默返回，调用方退回循环重试 mkdir。 */
async function reclaimAbandoned(lockDir: string, retirementKey: string): Promise<void> {
  // 同一目录 generation 使用同一个永久 tombstone。并发回收者中首个 rename 成功后，后续
  // 回收者不能把刚发布的 successor 移走，因为 no-overwrite 目标已经存在。
  const grave = `${lockDir}.stale-${retirementKey}`
  try {
    await rename(lockDir, grave)
  } catch {
    return
  }
}

/** 持锁期间周期刷新 owner 文件 mtime（unref，不拖住事件循环/进程退出）。 */
function startHeartbeat(lockDir: string): ReturnType<typeof setInterval> {
  const owner = ownerPathFor(lockDir)
  const t = setInterval(() => {
    const now = new Date()
    void utimes(owner, now, now).catch(() => {})
  }, HEARTBEAT_MS)
  if (typeof t.unref === 'function') t.unref() // 对应 daemon timer，不吊住进程/事件循环
  return t
}

async function acquire(lockDir: string): Promise<Held> {
  // Codex's workspace-write sandbox denies /bin/ps, so the start identity can be unreadable. The
  // owner record then carries only the pid, like records written before start identities existed:
  // observers keep it while that pid exists and never reclaim it before it is stale.
  const processStart = await processStartIdentity(process.pid)
  const owner = randomUUID()
  const claim = `${lockDir}.claim-${owner}`
  const record: LockOwnerRecord = {
    version: 1,
    owner,
    pid: process.pid,
    ...(processStart === null ? {} : { pidStart: processStart }),
    createdAt: Date.now(),
  }
  await mkdir(claim, { mode: 0o700 })
  await writeFile(ownerPathFor(claim), `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS
  try {
    for (;;) {
      let created = false
      try {
        // mkdir is the portable no-overwrite namespace claim. The owner file is already complete
        // in the private directory and is hard-linked in one step; observers treat the tiny
        // owner-less crash window as unknown/live until it is stale, never as immediately free.
        await mkdir(lockDir, { mode: 0o700 })
        created = true
        await link(ownerPathFor(claim), ownerPathFor(lockDir))
        await rm(claim, { recursive: true, force: true }).catch(() => {})
        return { owner, heartbeat: startHeartbeat(lockDir) }
      } catch (err) {
        if (created) {
          await unlink(ownerPathFor(lockDir)).catch(() => {})
          await rmdir(lockDir).catch(() => {})
          throw err
        }
        const code = (err as NodeJS.ErrnoException).code
        if (code !== 'EEXIST') throw err
      }
      const observed = await observeLock(lockDir)
      if (observed === null) continue
      if (observed.processState === 'dead'
        || (observed.ageMs > STALE_LOCK_MS && observed.processState !== 'alive')) {
        await reclaimAbandoned(lockDir, observed.retirementKey)
        continue
      }
      if (Date.now() >= deadline) {
        throw new Error(`withLock: acquire timeout after ${ACQUIRE_TIMEOUT_MS}ms: ${lockDir}`)
      }
      await sleep(POLL_MS)
    }
  } catch (error) {
    await rm(claim, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

async function release(lockDir: string, held: Held): Promise<void> {
  clearInterval(held.heartbeat)
  // 只移除自己的 immutable owner，再 rmdir 已空目录；绝不 recursive-delete 同名路径。
  // 即使第三方增加了新内容，rmdir 也会失败并保留它，而不会删除后继者状态。
  let owner: LockOwnerRecord | null = null
  try {
    owner = parseOwnerRecord(await readFile(ownerPathFor(lockDir), 'utf8'))
  } catch {
    owner = null
  }
  if (owner?.owner !== held.owner) return
  await unlink(ownerPathFor(lockDir)).catch(() => {})
  await rmdir(lockDir).catch(() => {})
}

/** mkdir 原子锁 + 陈锁回收，锁内串行执行 fn；透传 fn 结果，异常时保证释放。 */
export async function withLock<T>(changeDir: string, fn: () => Promise<T>): Promise<T> {
  const lockDir = lockDirFor(changeDir)
  const prev = queues.get(lockDir) ?? Promise.resolve()
  const run = prev.then(async () => {
    const held = await acquire(lockDir)
    try {
      return await fn()
    } finally {
      await release(lockDir, held)
    }
  })
  const settled = run.then(
    () => undefined,
    () => undefined,
  )
  queues.set(lockDir, settled)
  void settled.then(() => {
    if (queues.get(lockDir) === settled) queues.delete(lockDir)
  })
  return run
}
