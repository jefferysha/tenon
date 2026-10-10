/**
 * 终端会话绑定（`session activate --host-session`）的写入：非 canonical 的会话→Change 投影，
 * 位于 `.pipeline/terminal-sessions/<session-id>.json`。移交（删其他会话对同一 Change 的绑定）见 session-handover.ts。
 */
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ensureOpenspecGitignore,
  ensurePipelineGitignore,
  isTerminalSessionId,
  TERMINAL_SESSION_BINDINGS_DIR,
  TERMINAL_SESSION_PROTOCOL,
  withLock,
} from '@tenon/kernel'
import { changeDir } from '../paths.js'
import { removeOtherSessionBindings } from './session-handover.js'

/** UTC 秒级时间戳（`2026-10-08T01:02:03Z`），写进投影文件与历史行。 */
export function isoSecondTimestamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export async function assertRegularOrMissing(path: string): Promise<void> {
  try {
    const entry = await lstat(path)
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('目标不是普通文件')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
}

/** Create only ordinary directories for the hook-facing, non-canonical session projection. */
async function ensurePlainDirectory(path: string): Promise<void> {
  try {
    const entry = await lstat(path)
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('目录不是普通目录')
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  try {
    await mkdir(path, { recursive: false, mode: 0o700 })
  } catch (error) {
    // Another terminal in the same project may create this projection directory between lstat and
    // mkdir.  Treat only that benign race as success; the lstat below still rejects links/files.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const created = await lstat(path)
  if (!created.isDirectory() || created.isSymbolicLink()) throw new Error('目录不是普通目录')
}

/** temp + rename 原子替换；写或 rename 失败都清掉临时文件，且不改动 target。 */
async function writeBindingAtomically(target: string, body: string): Promise<void> {
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`
  try {
    await writeFile(temp, body, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await assertRegularOrMissing(target)
    await rename(temp, target)
  } finally {
    await rm(temp, { force: true }).catch(() => {})
  }
}

/**
 * Bind a native host session to the exact Change selected by the pipeline root skill.  This is an
 * non-canonical session identity projection: it prevents a per-user `active-change` pointer
 * from routing or displaying an unrelated conversation as an old Change.
 *
 * 一个 Change 同时只绑一个会话，所以「写本会话绑定 + 移交」必须是一个临界区：
 *   · 先原子写入本会话绑定，成功后才删其他会话对同一 Change 的绑定。写失败（抛错）时一个绑定都不删，
 *     不会出现「旧的删了、新的没写上」两边都没有绑定。
 *   · 锁用 Change 目录锁（`withLock(changeDir)`）：移交的对象恰好是「同一 Change 的其他会话」，所以争用者一定
 *     在同一把锁上串行，后到的会话一定看见并移走先到的；不同 Change 的 activate 互不等待。选它而不是
 *     terminal-sessions 目录锁，是为了不在 hook 与 task-delete 都会扫描的投影目录里留下锁目录。
 *     调用方（cmdActivate）此前取的 Change 锁都已释放，这里不嵌套。
 */
export async function writeTerminalSessionBinding(cwd: string, name: string, sessionId: string): Promise<readonly string[]> {
  if (!isTerminalSessionId(sessionId)) throw new Error('host session id 格式非法')
  const pipelineDir = join(cwd, '.pipeline')
  const sessionsDir = join(cwd, TERMINAL_SESSION_BINDINGS_DIR)
  await ensurePipelineGitignore(cwd)
  // A binding is what lets the host hook write the Change's heartbeat sidecar; keep that file out of git.
  await ensureOpenspecGitignore(cwd)
  await ensurePlainDirectory(pipelineDir)
  await ensurePlainDirectory(sessionsDir)
  const target = join(sessionsDir, `${sessionId}.json`)
  await assertRegularOrMissing(target)
  return withLock(changeDir(cwd, name), async () => {
    const body = `${JSON.stringify({
      protocol: TERMINAL_SESSION_PROTOCOL,
      session_id: sessionId,
      change: name,
      bound_at: isoSecondTimestamp(),
    })}\n`
    await writeBindingAtomically(target, body)
    return removeOtherSessionBindings(sessionsDir, name, sessionId)
  })
}
