/**
 * 任务 worktree：新任务建在 `<主检出>/.worktrees/<change>`（分支 `tenon/<change>`，从当前 HEAD 分出），
 * 同仓多个任务各在自己的检出里并行，改动文件、测试登记与构建指纹互不污染。
 *
 * 三步：`planTaskWorktree` 只判定（能否建、为什么不能），`createTaskWorktree` 先查路径与分支冲突再建，
 * `rollbackTaskWorktree` 在初始化失败时清掉半成品。git 执行器由调用方传入——这里不自己起 git 进程，
 * 退出码非零不抛错、由本模块按退出码判定。`.worktrees/` 没被忽略时写进 `.git/info/exclude`，不改任何受版本控制的文件。
 */
import { appendFile, lstat, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'

export type GitRunner = (
  args: readonly string[],
  cwd: string,
) => Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>

export type TaskWorktreeInPlaceReason = 'not-git' | 'no-commits' | 'detached-head' | 'linked-worktree' | 'requested'

export type TaskWorktreePlan =
  | {
    readonly kind: 'create'
    readonly repoRoot: string
    readonly path: string
    readonly branch: string
    /** 分出它的分支（任务的 `base_branch`），不是 `tenon/<change>`。 */
    readonly sourceBranch: string
    /** 分出时的 HEAD（任务的 `start_sha`）。 */
    readonly head: string
  }
  | { readonly kind: 'in-place'; readonly reason: TaskWorktreeInPlaceReason }

type CreatePlan = Extract<TaskWorktreePlan, { kind: 'create' }>

/** 目标路径或分支已存在：不覆盖、不复用，由调用方让命令失败退出。 */
export class TaskWorktreeConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TaskWorktreeConflictError'
  }
}

const WORKTREES_DIR = '.worktrees'
const CHANGE_NAME = /^[A-Za-z0-9_-]+$/

async function sameDirectory(a: string, b: string): Promise<boolean> {
  try {
    return await realpath(a) === await realpath(b)
  } catch {
    return false
  }
}

/** 判定能否在 `repoRoot` 建任务 worktree；不能时给出原因（调用方原地初始化并告知用户）。不写任何东西。 */
export async function planTaskWorktree(input: {
  readonly repoRoot: string
  readonly change: string
  readonly inPlace: boolean
  readonly git: GitRunner
}): Promise<TaskWorktreePlan> {
  const { repoRoot, change, git } = input
  if (!CHANGE_NAME.test(change)) throw new Error(`任务名只能含字母、数字、- 与 _（收到 ${JSON.stringify(change)}）`)
  if (input.inPlace) return { kind: 'in-place', reason: 'requested' }

  const inside = await git(['rev-parse', '--is-inside-work-tree'], repoRoot)
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') return { kind: 'in-place', reason: 'not-git' }
  // 项目根必须就是仓库根：在子目录里建，worktree 的根与项目根对不上。
  const top = await git(['rev-parse', '--show-toplevel'], repoRoot)
  if (top.code !== 0 || !await sameDirectory(top.stdout.trim(), repoRoot)) return { kind: 'in-place', reason: 'not-git' }

  const head = await git(['rev-parse', '--verify', '-q', 'HEAD'], repoRoot)
  if (head.code !== 0 || head.stdout.trim() === '') return { kind: 'in-place', reason: 'no-commits' }
  const branch = await git(['symbolic-ref', '-q', '--short', 'HEAD'], repoRoot)
  if (branch.code !== 0 || branch.stdout.trim() === '') return { kind: 'in-place', reason: 'detached-head' }

  const gitDir = await git(['rev-parse', '--path-format=absolute', '--git-dir'], repoRoot)
  const commonDir = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], repoRoot)
  if (gitDir.code !== 0 || commonDir.code !== 0) return { kind: 'in-place', reason: 'not-git' }
  if (!await sameDirectory(gitDir.stdout.trim(), commonDir.stdout.trim())) return { kind: 'in-place', reason: 'linked-worktree' }

  return {
    kind: 'create',
    repoRoot,
    path: join(repoRoot, WORKTREES_DIR, change),
    branch: `tenon/${change}`,
    sourceBranch: branch.stdout.trim(),
    head: head.stdout.trim(),
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw e
  }
}

/** `.worktrees/` 没被 git 忽略（`.gitignore`、全局忽略都没有）时，追加到主检出的 `.git/info/exclude`。 */
async function ensureWorktreesExcluded(plan: CreatePlan, git: GitRunner): Promise<void> {
  const ignored = await git(['check-ignore', '-q', `${WORKTREES_DIR}/`], plan.repoRoot)
  if (ignored.code === 0) return
  const common = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], plan.repoRoot)
  if (common.code !== 0 || common.stdout.trim() === '') {
    throw new Error(`读不到 git 公共目录，无法把 ${WORKTREES_DIR}/ 加入本机排除：${common.stderr.trim()}`)
  }
  const infoDir = join(common.stdout.trim(), 'info')
  const excludeFile = join(infoDir, 'exclude')
  await mkdir(infoDir, { recursive: true })
  let current = ''
  try {
    current = await readFile(excludeFile, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  if (current.split(/\r?\n/).includes(`${WORKTREES_DIR}/`)) return
  await appendFile(excludeFile, `${current === '' || current.endsWith('\n') ? '' : '\n'}${WORKTREES_DIR}/\n`, 'utf8')
}

/**
 * 建 worktree 与分支。路径或分支已存在 → 抛 `TaskWorktreeConflictError`，什么都不改；
 * 其余失败（git 报错、写排除文件失败）抛普通错误，且已建出的 worktree 与分支一并回滚。
 */
export async function createTaskWorktree(plan: CreatePlan, git: GitRunner): Promise<void> {
  if (await pathExists(plan.path)) {
    throw new TaskWorktreeConflictError(`${plan.path} 已存在，不覆盖：换一个任务名，或先移走该目录`)
  }
  const branch = await git(['rev-parse', '--verify', '-q', `refs/heads/${plan.branch}`], plan.repoRoot)
  if (branch.code === 0) {
    throw new TaskWorktreeConflictError(`分支 ${plan.branch} 已存在：换一个任务名，或先删除该分支（git branch -D ${plan.branch}）`)
  }
  try {
    const added = await git(
      ['-c', 'branch.autoSetupMerge=false', 'worktree', 'add', '-b', plan.branch, plan.path, plan.head],
      plan.repoRoot,
    )
    if (added.code !== 0) throw new Error(`git worktree add 失败：${added.stderr.trim() || added.stdout.trim()}`)
    await ensureWorktreesExcluded(plan, git)
  } catch (e) {
    // 走到这里路径与分支原本都不存在，现在剩下的都是这次建出来的（git 在检出阶段失败时会留下分支）。
    const reason = e instanceof Error ? e.message : String(e)
    try {
      await rollbackTaskWorktree(plan, git)
    } catch (rollbackError) {
      throw new Error(`${reason}（${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}）`)
    }
    throw e
  }
}

/**
 * 清掉这次建出来的 worktree 与分支（初始化失败时由调用方在 `createTaskWorktree` 成功之后调用）。什么都不剩时是空操作；
 * 登记不上的半成品目录直接删——路径是本次新建的；清不掉才抛错（带 git 的输出）。
 */
export async function rollbackTaskWorktree(plan: CreatePlan, git: GitRunner): Promise<void> {
  const failures: string[] = []
  if (await pathExists(plan.path)) {
    const removed = await git(['worktree', 'remove', '--force', plan.path], plan.repoRoot)
    if (removed.code !== 0) {
      try {
        await rm(plan.path, { recursive: true, force: true })
      } catch (e) {
        failures.push(`删除 ${plan.path}：${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }
  const branch = await git(['rev-parse', '--verify', '-q', `refs/heads/${plan.branch}`], plan.repoRoot)
  if (branch.code === 0) {
    const deleted = await git(['branch', '-D', plan.branch], plan.repoRoot)
    if (deleted.code !== 0) failures.push(`git branch -D ${plan.branch}：${deleted.stderr.trim()}`)
  }
  if (failures.length > 0) throw new Error(`回滚任务 worktree 未完成：${failures.join('；')}`)
}
