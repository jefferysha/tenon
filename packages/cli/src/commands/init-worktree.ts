/**
 * `tenon init` 的落点：新任务建在自己的 git worktree（`.worktrees/<change>`）里，不能建或用户不要时原地。
 * 判定、创建、回滚在 kernel（task-worktree.ts），这里只补 CLI 侧的三件事：git 执行器、原地原因的文案、
 * 建好之后的输出（文本两行 / `--json`）。
 */
import { execFile } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  createTaskWorktree, planTaskWorktree, rollbackTaskWorktree,
  type GitRunner, type TaskWorktreeInPlaceReason, type TaskWorktreePlan,
} from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'

type CreatePlan = Extract<TaskWorktreePlan, { kind: 'create' }>

const GIT_TIMEOUT_MS = 60_000
const GIT_MAX_BUFFER = 8 * 1024 * 1024

/** 真 git 执行器：退出码非零不抛错，由 kernel 按退出码判定；起不来（没装 git）按退出码 127 返回。 */
export const execGit: GitRunner = (args, cwd) => new Promise((resolve) => {
  execFile('git', [...args], { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, windowsHide: true }, (error, stdout, stderr) => {
    if (error === null) return resolve({ code: 0, stdout, stderr })
    const code = (error as NodeJS.ErrnoException).code
    resolve({ code: typeof code === 'number' ? code : 127, stdout, stderr: stderr === '' ? error.message : stderr })
  })
})

const IN_PLACE_REASON_TEXT: Readonly<Record<TaskWorktreeInPlaceReason, string>> = {
  'not-git': '当前目录不是 git 仓库（或不是仓库根目录）',
  'no-commits': '仓库还没有提交',
  'detached-head': 'HEAD 处于分离状态',
  'linked-worktree': '当前目录本身已是一个 linked worktree',
  requested: '已指定原地建立（--in-place）',
}

/** 任务落在哪：建了 worktree，或原地（带原因）。 */
export type InitPlacement =
  | { readonly kind: 'worktree'; readonly plan: CreatePlan }
  | { readonly kind: 'in-place'; readonly reason: TaskWorktreeInPlaceReason }

/**
 * 判定并（能建时）建好 worktree。原地时说明原因；只有环境变量 `TENON_INIT_IN_PLACE=1`（测试工装统一导出）
 * 要求原地时不打印——那是工装的约定，不是用户在这次命令里的选择。路径或分支冲突抛 `TaskWorktreeConflictError`。
 */
export async function placeInitTask(deps: CliDeps, name: string, inPlaceFlag: boolean): Promise<InitPlacement> {
  const plan = await planTaskWorktree({
    repoRoot: deps.cwd, change: name, inPlace: inPlaceFlag || process.env.TENON_INIT_IN_PLACE === '1', git: execGit,
  })
  if (plan.kind === 'in-place') {
    if (plan.reason !== 'requested' || inPlaceFlag) deps.io.err(`[INIT] 原地建立任务，不建 worktree：${IN_PLACE_REASON_TEXT[plan.reason]}`)
    return plan
  }
  await assertNoSameNameChange(deps.cwd, name)
  await createTaskWorktree(plan, execGit)
  return { kind: 'worktree', plan }
}

/**
 * 主检出里已有同名任务（状态目录未提交或被忽略，新 worktree 里不会有它）时拒绝：原地 init 撞名由 `store.init` 拒绝，
 * worktree 路径不能比它宽松，否则同一个仓库里出现两个同名任务。文案与 `store.init` 的撞名错误一致；先于建 worktree 判定。
 */
async function assertNoSameNameChange(repoRoot: string, name: string): Promise<void> {
  const existing = join(repoRoot, 'openspec', 'changes', name)
  try {
    await lstat(existing)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
    throw e
  }
  throw new Error(`init: change 已存在，拒绝覆盖: ${existing}`)
}

/** 初始化失败后清掉刚建的 worktree 与分支；清不掉只 WARN（给出手动命令），不盖住原来的错误。 */
export async function rollbackInitPlacement(deps: CliDeps, placement: InitPlacement | undefined): Promise<void> {
  if (placement?.kind !== 'worktree') return
  try {
    await rollbackTaskWorktree(placement.plan, execGit)
  } catch (e) {
    deps.io.err(`WARN: ${errMsg(e)}；请手动执行 git worktree remove --force ${placement.plan.path} 与 git branch -D ${placement.plan.branch}`)
  }
}

/** 建好之后的输出：`--json` 在 stdout 一行；文本在 stderr，worktree 路径与切进去的做法放在最后两行。 */
export function reportInitPlacement(
  deps: CliDeps, placement: InitPlacement, created: { readonly change: string; readonly dir: string; readonly json: boolean },
): void {
  const worktree = placement.kind === 'worktree' ? placement.plan.path : null
  if (created.json) {
    deps.io.out(JSON.stringify({
      change: created.change,
      path: created.dir,
      worktree,
      worktree_reason: placement.kind === 'in-place' ? placement.reason : null,
    }))
    return
  }
  if (worktree === null) return
  deps.io.err(`worktree: ${worktree}`)
  deps.io.err(`Claude Code：EnterWorktree path=${worktree} 后执行 tenon session activate；Codex：在该目录开新会话`)
}
