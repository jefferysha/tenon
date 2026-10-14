/**
 * 任务归档（M6）：任务以三种结果之一结束——完结、已升级、已终止——并且一律把任务目录移进
 * `openspec/changes/archive/<YYYY-MM-DD>-<名字>/`。这里是唯一的移动实现：`tenon task finish` 与
 * `tenon task terminate` 共用它，归档不再有别的入口，也不再有「隐藏」。
 *
 * 顺序固定，全部在调用方持有的两把锁里（先项目归档锁 `withArchiveLock`、再该任务的任务锁 `store.withLock`；
 * delete / terminate / finish 同序加锁，见 task-lifecycle.ts）：
 *   1. 校验布局（`openspec/`、`openspec/changes/`、任务目录、`archive/` 都必须是真目录，不跟随符号链接）；
 *   2. 经状态仓库写一次修订：规范状态字段 `task_result` = 任务结果（先于移动；移动失败时再写一次修订清回空值，
 *      失败后任务仍是原来的活跃任务、没有残留结果）。任务锁不可重入，所以这里一律走 `writeUnderLock`；
 *   3. 移动目录：`spec: openspec` 的轨道由 Tenon 调用 `openspec archive <c> --skip-specs --yes --json`，
 *      `spec: none` 的轨道直接 `rename`；目标名已存在就追加 `-2`、`-3`，绝不覆盖。任务锁目录在任务目录里，会跟着
 *      目录一起搬走，移动成功后把归档里这份没有持有者的锁目录删掉。
 *
 * 任务结果是任务状态的一部分（`task_result`，系统专写：`tenon set` / `set-many` / `cas` 不能写它），随目录
 * 一起搬走；归档位置就是目录本身，不另记。「已结束」只由目录位于 `archive/` 判定：写完结果、移动前进程被打断时
 * 活跃任务上会残留一个非空的 `task_result`，它不表示任务已结束，finish / terminate 入口会先把它清掉。
 */
import { execFile } from 'node:child_process'
import { lstat, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { LOCK_DIR_NAME, withLock } from '../state/lock.js'
import { createStateStore } from '../state/store.js'
import type { PipelineState, StateStore } from '../types.js'
import { isPlainDirectory, TENON_PROJECT_DIR } from '../users/user-paths.js'
import { resolveRunTrack, UnknownTrackError } from '../workflow/resolve-track.js'
import type { TrackSpec } from '../workflow/types.js'

export type TaskResult = 'finished' | 'escalated' | 'terminated'
export const TASK_RESULTS: readonly TaskResult[] = ['finished', 'escalated', 'terminated']

export interface ArchivedTask {
  readonly change: string
  readonly result: TaskResult
  /** 仓库根相对路径，`/` 分隔：`openspec/changes/archive/<日期>-<名字>[-N]`。 */
  readonly archivedDir: string
  readonly endedAt: string
}

export interface ArchiveDeps {
  readonly repoRoot: string
  /** 任务状态仓库：移动之前经它写入 `task_result`。调用方已持有项目归档锁与该任务的任务锁。 */
  readonly store: StateStore
  readonly now: () => Date
  /** 调用本机的 `openspec archive <change> --skip-specs --yes --json`；失败时 reject 并带出原因。 */
  readonly runOpenspecArchive: (change: string) => Promise<void>
}

export type ArchiveTaskErrorCode =
  | 'invalid-name' | 'not-found' | 'unsafe-path' | 'state-failed' | 'openspec-failed' | 'move-failed'

export class ArchiveTaskError extends Error {
  /**
   * @param activeDir 失败之后任务所在的活跃目录，回滚据此清 `task_result`：缺省 = 原目录；改名没改回来时是带序号的
   *   那个；`null` = 目录已经离开活跃区（已被移走），没有可回滚的。
   */
  constructor(readonly code: ArchiveTaskErrorCode, message: string, readonly activeDir?: string | null) {
    super(message)
    this.name = 'ArchiveTaskError'
  }
}

const MAX_SUFFIX = 1000
const CHANGE_NAME = /^[A-Za-z0-9_-]+$/u
/** OpenSpec 自己的归档目录，永远不是一个任务。 */
const RESERVED_CHANGE_DIR = 'archive'

export function isTaskLifecycleName(name: string): boolean {
  return CHANGE_NAME.test(name) && name !== RESERVED_CHANGE_DIR
}

export function taskChangeDir(repoRoot: string, change: string): string {
  return join(repoRoot, 'openspec', 'changes', change)
}

function archiveRoot(repoRoot: string): string {
  return join(repoRoot, 'openspec', 'changes', RESERVED_CHANGE_DIR)
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 状态字段（单值或多值）的文本：多值以逗号相连，缺省为空串。 */
export function fieldText(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join(',') : (value ?? '')
}

/**
 * 状态机已走完（`archived=true`）的任务的结果：停在 `escalated` 终态是「已升级」，其余终态是「完结」。
 * 状态机没走完返回 null——那样的任务只能被终止。
 */
export function terminalTaskResult(fields: PipelineState['fields']): 'finished' | 'escalated' | null {
  if (fieldText(fields.archived) !== 'true') return null
  return fieldText(fields.phase) === 'escalated' ? 'escalated' : 'finished'
}

/**
 * 谁来做移动：任务冻结的计划走 OpenSpec 生命周期（`capabilities.documents.governed`）的轨道由 Tenon 调用
 * `openspec archive`，其余原子 rename。没有冻结快照的早期任务按 `none` 处理——两条路径落到同一个归档目录
 * 名，区别只在是否经过 OpenSpec 的校验。
 *
 * 带旧文档契约的计划（升级前创建）照旧是 `openspec`；没有契约的计划（新任务）读冻结定义里任务所在分支的
 * `spec`——OpenSpec 收尾与有没有文档契约无关。冻结定义里找不到任务记着的轨道时按 `none`（同「快照形状不认识」）。
 */
export function taskArchiveSpec(state: PipelineState): TrackSpec {
  const snapshot = state.runMetadata?.workflowPlanSnapshot
  if (snapshot === undefined || !('documentPolicy' in snapshot)) return 'none'
  if (snapshot.documentPolicy !== null && snapshot.documentPolicy !== undefined) return 'openspec'
  try {
    return resolveRunTrack({ ...snapshot.workflow, name: snapshot.workflowId }, fieldText(state.fields.track)).spec
  } catch (error) {
    if (error instanceof UnknownTrackError) return 'none'
    throw error
  }
}

/**
 * 任务目录规范状态里的任务结果。读不到、状态损坏或取值不在闭集里一律返回 undefined，从不抛——调用方据此当作
 * 「这个任务没有结束」。只有目录位于 `archive/` 下，读到的结果才表示任务已结束；活跃目录上的值是被打断的归档
 * 留下的残留，调用方不得据此判断任务已结束。
 */
export async function readTaskResult(
  taskDir: string,
  store: StateStore = createStateStore(),
): Promise<TaskResult | undefined> {
  try {
    const value = (await store.read(taskDir)).fields.task_result
    return TASK_RESULTS.find((known) => known === value)
  } catch {
    return undefined
  }
}

/** 经状态仓库写一次修订：`task_result` = `value`（空串 = 清回未结束）。调用方已持有任务锁。 */
async function writeTaskResult(store: StateStore, taskDir: string, value: TaskResult | ''): Promise<void> {
  const state = await store.read(taskDir)
  state.fields.task_result = value
  await store.writeUnderLock(taskDir, state, { kind: 'set' })
}

/**
 * finish / terminate 在锁内先做的对账：活跃任务上的非空 `task_result` 只可能是上一次归档写完结果、还没移动目录进程
 * 就被打断留下的残留（正常路径里它要么随目录搬进 archive/，要么在失败时被清回空值），先清掉再继续。状态读不出来
 * 不在这里报：后面的步骤会说读不到什么。
 */
export async function clearStaleTaskResult(store: StateStore, taskDir: string): Promise<void> {
  try {
    if (fieldText((await store.read(taskDir)).fields.task_result) === '') return
  } catch {
    return
  }
  try {
    await writeTaskResult(store, taskDir, '')
  } catch (error) {
    throw new ArchiveTaskError('state-failed', `活跃任务上残留的 task_result 没能清掉: ${reasonOf(error)}`)
  }
}

/** 移动失败：把已写的 task_result 清回空值。清不掉时把这件事连同原因一起报出来，不吞。 */
async function clearTaskResult(store: StateStore, taskDir: string, cause: unknown): Promise<never> {
  const original = cause instanceof ArchiveTaskError ? cause : undefined
  try {
    await writeTaskResult(store, taskDir, '')
  } catch (clearError) {
    const detail = `任务结果 task_result 没能清回空值（${reasonOf(clearError)}）；重试 tenon task finish|terminate 会覆盖它`
    throw new ArchiveTaskError(original?.code ?? 'move-failed', `${original?.message ?? reasonOf(cause)}；${detail}`)
  }
  throw cause
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** 真的锁：项目级，落在任务目录之外——任务目录会被移走，锁目录不能跟着走。 */
export async function withArchiveLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
  const dir = join(repoRoot, TENON_PROJECT_DIR)
  await mkdir(dir, { recursive: true })
  if (!(await isPlainDirectory(dir))) throw new ArchiveTaskError('unsafe-path', `目录不是普通目录: ${dir}`)
  return withLock(dir, fn)
}

/** 默认的 OpenSpec 调用：本机 PATH 上的 `openspec`，失败时把 OpenSpec 自己的话带出来。 */
export function openspecArchiveRunner(repoRoot: string): (change: string) => Promise<void> {
  return (change) => new Promise<void>((resolve, reject) => {
    execFile(
      'openspec',
      ['archive', change, '--skip-specs', '--yes', '--json'],
      { cwd: repoRoot, maxBuffer: 256 * 1024, timeout: 120_000 },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve()
          return
        }
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new Error('openspec-cli-missing：PATH 上没有 openspec，装上后重试'))
          return
        }
        reject(new Error(openspecFailure(String(stdout), String(stderr), error.message)))
      },
    )
  })
}

function openspecFailure(stdout: string, stderr: string, fallback: string): string {
  try {
    const parsed: unknown = JSON.parse(stdout)
    const status = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'status') : undefined
    const first: unknown = Array.isArray(status) ? status[0] : undefined
    const message = typeof first === 'object' && first !== null ? Reflect.get(first, 'message') : undefined
    const code = typeof first === 'object' && first !== null ? Reflect.get(first, 'code') : undefined
    if (typeof message === 'string' && message !== '') return typeof code === 'string' ? `${code}：${message}` : message
  } catch {
    // 不是 JSON：落到 stderr。
  }
  return stderr.trim() === '' ? fallback : stderr.trim()
}

/** `openspec/`、`openspec/changes/` 与任务目录都必须是真目录；`archive/` 可以不存在，存在就必须是真目录。 */
async function assertSafeLayout(repoRoot: string, change: string): Promise<void> {
  const source = taskChangeDir(repoRoot, change)
  for (const dir of [join(repoRoot, 'openspec'), join(repoRoot, 'openspec', 'changes'), source]) {
    if (!(await exists(dir))) throw new ArchiveTaskError('not-found', `任务不存在: ${change}`)
    if (!(await isPlainDirectory(dir))) throw new ArchiveTaskError('unsafe-path', `目录不是普通目录: ${dir}`)
  }
  const archive = archiveRoot(repoRoot)
  if ((await exists(archive)) && !(await isPlainDirectory(archive))) {
    throw new ArchiveTaskError('unsafe-path', `归档目录不是普通目录: ${archive}`)
  }
}

function datedName(date: string, name: string, sequence: number): string {
  return sequence === 1 ? `${date}-${name}` : `${date}-${name}-${sequence}`
}

/** `spec: none`：原子 rename；目标名冲突时追加序号。 */
async function moveByRename(repoRoot: string, change: string, date: string): Promise<string> {
  const archive = archiveRoot(repoRoot)
  await mkdir(archive, { recursive: true })
  for (let sequence = 1; sequence <= MAX_SUFFIX; sequence += 1) {
    const name = datedName(date, change, sequence)
    if (await exists(join(archive, name))) continue
    await rename(taskChangeDir(repoRoot, change), join(archive, name))
    return name
  }
  throw new ArchiveTaskError('move-failed', `归档目录里同名任务过多: ${change}`)
}

async function archiveEntries(repoRoot: string): Promise<ReadonlySet<string>> {
  try {
    return new Set(await readdir(archiveRoot(repoRoot)))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set()
    throw error
  }
}

/**
 * 交给 `openspec archive` 的活跃目录名：目标名是 `<日期>-<活跃目录名>`，OpenSpec 遇到同名会报错而不是追加序号，
 * 所以同日同名时改用带序号的活跃名（目标名随之带上序号）。
 */
async function openspecRunName(repoRoot: string, change: string, date: string): Promise<string> {
  const archive = archiveRoot(repoRoot)
  if (!(await exists(join(archive, datedName(date, change, 1))))) return change
  for (let sequence = 2; sequence <= MAX_SUFFIX; sequence += 1) {
    const candidate = `${change}-${sequence}`
    if (!(await exists(taskChangeDir(repoRoot, candidate))) && !(await exists(join(archive, datedName(date, candidate, 1))))) {
      return candidate
    }
  }
  throw new ArchiveTaskError('move-failed', `归档目录里同名任务过多: ${change}`)
}

/**
 * 目录没被移走时的失败：把带序号的活跃名改回原名，返回要抛的错误。改不回来就把这件事连同原因一起写进错误（不让它
 * 盖掉原始原因），任务停在带序号的目录下，`activeDir` 指向它。
 */
async function failedBeforeMove(repoRoot: string, change: string, runName: string, reason: string): Promise<ArchiveTaskError> {
  if (runName === change) return new ArchiveTaskError('openspec-failed', reason)
  const runDir = taskChangeDir(repoRoot, runName)
  try {
    if (await exists(runDir)) await rename(runDir, taskChangeDir(repoRoot, change))
  } catch (restoreError) {
    return new ArchiveTaskError(
      'openspec-failed',
      `${reason}；活跃目录名没能从 ${runName} 改回 ${change}（${reasonOf(restoreError)}），任务停在 openspec/changes/${runName} 下，需要手动改回`,
      runDir,
    )
  }
  return new ArchiveTaskError('openspec-failed', reason)
}

/** `spec: openspec`：交给 `openspec archive`；失败或目录没动时把活跃目录名改回来，目录已被移走则不回滚。 */
async function moveByOpenspec(deps: ArchiveDeps, change: string, date: string): Promise<string> {
  const { repoRoot } = deps
  const runName = await openspecRunName(repoRoot, change, date)
  const runDir = taskChangeDir(repoRoot, runName)
  // 先读 archive/ 再改名：读失败（EACCES…）时什么都还没动，回滚清的原目录就是任务实际所在的目录。
  const before = await archiveEntries(repoRoot)
  if (runName !== change) await rename(taskChangeDir(repoRoot, change), runDir)
  try {
    await deps.runOpenspecArchive(runName)
  } catch (error) {
    throw await failedBeforeMove(repoRoot, change, runName, `openspec archive 失败: ${reasonOf(error)}`)
  }
  // 以 OpenSpec 实际建出来的目录为准（它的日期取自自己的时钟），而不是假设它与这里的日期一致。
  // 此时目录已经改过名、可能已被移走，读失败不能抛裸错误让调用方按原目录回滚：当作认不出归档目录，走下面的分支。
  let created: string[] = []
  let unreadable: string | undefined
  try {
    created = [...await archiveEntries(repoRoot)].filter((name) =>
      !before.has(name) && name.length > runName.length && name.endsWith(`-${runName}`)
      && /^\d{4}-\d{2}-\d{2}$/u.test(name.slice(0, name.length - runName.length - 1)))
  } catch (error) {
    unreadable = reasonOf(error)
  }
  const landed = created[0]
  if (landed !== undefined && created.length === 1) return landed
  // 认不出归档目录：先看活跃目录还在不在——在，说明 openspec 什么也没移；不在，目录已经移走了（外部并发写入让
  // 新增条目数不是 1，或 archive/ 读不了），这时回滚只会误报失败，要说清楚「已移动、但无法确定归档目录」。
  const archive = archiveRoot(repoRoot)
  if (await exists(runDir)) {
    const unseen = unreadable === undefined ? `也没有在 ${archive} 里建出它的归档目录` : `也读不了 ${archive} 确认它的归档目录（${unreadable}）`
    throw await failedBeforeMove(repoRoot, change, runName, `openspec archive 返回成功，但 ${runName} 仍在活跃目录里，${unseen}`)
  }
  const cause = unreadable === undefined ? `${archive} 里新增的同名目录有 ${created.length} 个` : `读 ${archive} 失败: ${unreadable}`
  throw new ArchiveTaskError(
    'move-failed',
    `openspec archive 已把 ${runName} 移出活跃目录，但无法确定归档目录（${cause}）；task_result 已随目录保留，请到 archive/ 里核对`,
    null,
  )
}

/** 任务锁目录在任务目录里，已经跟着目录搬进了归档；那把锁在新位置上没有持有者，留着会被当成陈锁并随归档提交。 */
async function dropMovedLock(repoRoot: string, landed: string): Promise<void> {
  // 任务已经移动成功：清不掉只是留下一个无主的空锁目录，不值得把成功报成失败。
  await rm(join(archiveRoot(repoRoot), landed, LOCK_DIR_NAME), { recursive: true, force: true }).catch(() => undefined)
}

/**
 * 把任务以 `result` 结束并归档；`spec` 决定移动由谁做（见文件头）。调用方必须已持有项目归档锁与该任务的任务锁。
 * 任何一步失败都不留下半截状态：目录没移动就把 `task_result` 清回空值（任务仍是原来的活跃任务），已经移动的目录
 * 不会被覆盖，也不会被当成没移动而回滚。
 */
export async function archiveTask(
  deps: ArchiveDeps,
  change: string,
  result: TaskResult,
  spec: TrackSpec,
): Promise<ArchivedTask> {
  if (!isTaskLifecycleName(change)) throw new ArchiveTaskError('invalid-name', `change-name 非法: '${change}'`)
  // 任务名作为 argv 交给 openspec：以 - 开头会被当成命令行选项。
  if (spec === 'openspec' && change.startsWith('-')) {
    throw new ArchiveTaskError('invalid-name', `change-name '${change}' 以 - 开头，不能交给 openspec archive`)
  }
  const { repoRoot, store } = deps
  await assertSafeLayout(repoRoot, change)
  const source = taskChangeDir(repoRoot, change)
  const endedAt = deps.now().toISOString()
  const date = endedAt.slice(0, 10)
  try {
    await writeTaskResult(store, source, result)
  } catch (error) {
    throw new ArchiveTaskError('state-failed', `任务状态写入失败: ${reasonOf(error)}`)
  }
  let landed: string
  try {
    landed = spec === 'openspec' ? await moveByOpenspec(deps, change, date) : await moveByRename(repoRoot, change, date)
  } catch (error) {
    // 文件系统自己的错误（mkdir / rename / readdir 的 EXDEV、EACCES…）也是「移动失败」：归成 ArchiveTaskError 再回滚，
    // 不让裸异常冲出调用方的 guarded。不是 ArchiveTaskError 就没有 activeDir，回滚位置仍是原目录。
    const failure = error instanceof ArchiveTaskError
      ? error
      : new ArchiveTaskError('move-failed', `移动任务目录失败: ${reasonOf(error)}`)
    const activeDir = failure.activeDir !== undefined ? failure.activeDir : source
    if (activeDir === null) throw failure
    return clearTaskResult(store, activeDir, failure)
  }
  await dropMovedLock(repoRoot, landed)
  return { change, result, archivedDir: `openspec/changes/archive/${landed}`, endedAt }
}
