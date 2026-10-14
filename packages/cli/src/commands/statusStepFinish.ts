/**
 * `next` 里读 git 事实（gitWorkspace.ts）的两条提交规则：交付步提交交付物（`commit`），状态机已完结
 * （`fields.archived=true`）之后收尾（`finish-change`）。与顺序表分开放，是因为顺序表的其余规则只读
 * 步骤证据。两条提交的形状相同：`{ paths, untrack, message }`，照原样执行、每条命令一次成功。
 */
import type { TaskResult } from '@tenon/kernel'
import { firstDeliveryMessage, WORKSPACE_COMMIT_PATHS, type GitFinishProbe } from '../gitWorkspace.js'
import type { StepAction } from './statusStepAction.js'

/** 提交动作的载荷：`git add -A -- <paths…>` → 可选 `git rm --cached …` → `git commit -m <message>`。 */
export interface StepCommit {
  readonly paths: readonly string[]
  readonly untrack: readonly string[]
  readonly message: string
}

/**
 * 交付步（声明了交付值 pr_url / prd_path 的那一步）的交付物提交；没有要提交的就是 null。
 *
 * 真机（第三轮）：交付步 in-place、不建分支，tenon 技能又要求模型不自行提交，finish-change 只提交
 * 归档目录——backend 与 free 走完后 `package.json`、`src/`、`docs/`、`openspec/specs/`、测试记录与
 * `.tenon/users/` 全留在工作区。交付物因此由 `next` 在交付值之前点名提交：
 *   · 范围是整个工作区（代码、文档、已应用的主规格、测试记录、状态目录的 .gitignore、change 目录），
 *     只排除仓库根的本机门禁标记（exclude pathspec，与 simple 的收尾同一组）；
 *   · 是否还要提交只看 change 目录之外（`deliverablesDirty`）：change 目录每次 hook 都在追加历史，
 *     拿它判定会让这条动作永远发不完；它之后的改动由完结的 finish-change 提交；
 *   · 不是 git 仓（或 git 跑不起来）时不发：没有一次成功的写法。
 *
 * `scope`：`deliverables` 只看 change 目录之外（勾任务之前那次提交用它——勾选只改 tasks.md，不该再
 * 触发一次提交）；`step` 看整个工作区、只去掉 hook 追加的历史（交付步收尾用它——`set pr_url` 写下的
 * 状态文件也要入库，ship 暂停时工作区才是干净的；真机第五轮）。
 *
 * 标题：首次是 `feat(<c>): deliver`；之后的补交（应用进主规格、交付值、交付步的测试记录）是
 * `chore(<c>): update deliverables`——真机第五轮两次提交同名，看不出第二次补了什么。
 */
export function deliveryCommit(
  change: string,
  git: GitFinishProbe | null,
  scope: 'deliverables' | 'step' = 'deliverables',
): StepCommit | null {
  if (git === null || !(scope === 'step' ? git.stepDirty : git.deliverablesDirty)) return null
  const message = git.delivered ? `chore(${change}): update deliverables` : firstDeliveryMessage(change)
  return { paths: WORKSPACE_COMMIT_PATHS, untrack: git.untrack, message }
}

/** 完结时要问 git 的事实（只在 `runArchived` 时由投影层取）。 */
export interface StepFinishFacts {
  /** gitWorkspace.ts probeGitFinish；null = 不是 git 仓或 git 跑不起来。 */
  readonly git: GitFinishProbe | null
  /**
   * 这次运行成功收尾：以验证通过收尾（verify_result=pass），或是没有验证步的设计体系任务走完了最后一步；
   * scope-expanded 之类的放弃出口不提交。
   */
  readonly verified: boolean
  /**
   * 这是设计体系任务（design-system 工作流）：`DESIGN.md` 与 `design/` 是它的交付物，随完结提交入库——
   * 否则它们留在工作区，被后续任务的 code-size 算成候选改动（真机验收 F7）。缺省 false。
   * 现行模板不走 OpenSpec，收尾是整个工作区的提交（设计文件已在 `.` 之内）；这里的专门列出只服务升级前创建、
   * 冻结计划仍走 OpenSpec 的设计体系任务（它们的收尾只提交 archive/ 与 housekeeping，设计文件要单独点名）。
   */
  readonly designSystem?: boolean
  /**
   * `isolation=worktree` 的任务所在的 worktree（路径与分支）；原地任务缺省。完结后 worktree 与分支还在，
   * `finish-change` 与 `stop finished` 据此附带 `cleanup`——Tenon 只提示，不自己删。
   */
  readonly worktree?: TaskWorktreeFacts
}

/** worktree 任务的位置：路径取当前项目根，分支固定为 `tenon/<任务名>`（`createTaskWorktree` 的命名）。 */
export interface TaskWorktreeFacts {
  readonly path: string
  readonly branch: string
}

/** `isolation=worktree` 时给出该任务的 worktree 事实，其余为 undefined。`root` 是命令所在的项目根（就是该 worktree）。 */
export function taskWorktreeFacts(isolation: string, root: string, change: string): TaskWorktreeFacts | undefined {
  return isolation === 'worktree' ? { path: root, branch: `tenon/${change}` } : undefined
}

/** shell 单引号字面量：内部的单引号写成 `'\''`。 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * 清理命令（在主检出里执行，不能在要删的 worktree 里执行）：先移除 worktree，再删分支。
 * 分支用 `-d`：还没合并时 git 会拒绝，不会丢提交。原地任务没有可清理的，返回 null。
 */
export function worktreeCleanup(worktree: TaskWorktreeFacts | undefined): string | null {
  if (worktree === undefined) return null
  return `git worktree remove ${shellQuote(worktree.path)} && git branch -d ${shellQuote(worktree.branch)}`
}

/**
 * 已结束、没有可做的事了：目录已移进 archive/，所有轨道同一形态。`cleanup` 是 worktree 任务留下的清理命令
 * （原地任务没有这一键）：用户最后看到的就是这条 stop，清理提示不能只挂在 finish-change 上。
 */
export function finishedStop(
  change: string,
  result: TaskResult = 'finished',
  worktree?: TaskWorktreeFacts,
): readonly StepAction[] {
  const text = result === 'terminated' ? '已终止' : result === 'escalated' ? '已升级' : '已完结'
  const cleanup = worktreeCleanup(worktree)
  return [{
    action: 'stop',
    code: 'finished',
    message: `任务 '${change}' ${text}，没有要做的事了`,
    ...(cleanup === null ? {} : { cleanup }),
  }]
}

/**
 * 状态机走完之后的收尾：归档命令与一次提交。
 *
 * 命令对所有轨道都是 `tenon task finish <c>`：目录移进 `openspec/changes/archive/` 与任务结果记录由 Tenon
 * 自己做（`spec: openspec` 的轨道由它调用 `openspec archive`），agent 不再直接执行 openspec 命令。
 * 命令移动目录，提交由 agent 照 `commit` 在命令之后执行。
 *
 * 提交是 `git add -A -- <paths…>`，`untrack` 非空时再 `git rm --cached -q --ignore-unmatch --
 * <untrack…>`，最后 `git commit -m <message>`；三条都必须一次成功（真机：原目录从未被 git 跟踪，
 * 搬走之后 `fatal: pathspec 'openspec/changes/<c>' did not match any files`，exit 128）。所以：
 *   · archive/ 目录在搬移后一定存在，恒列出；
 *   · 原目录只有被跟踪过才列出——`-A` 据索引项暂存删除；没被跟踪过就没有什么删除可提交；
 *   · 状态目录自己的 `.gitignore` 存在且没被忽略时一起列出，收尾后 `git status` 才干净；
 *   · 已被旧版本提交、如今按忽略规则应被忽略的终端心跳列进 `untrack`（`--ignore-unmatch` 让它在
 *     搬移之后不再存在时也不报错）。
 * 不是 git 仓（或 git 跑不起来）时不发提交（`commit: null`）：没有可以一次成功的写法。
 *
 * 非 OpenSpec 治理的轨道（如轻量）以验证通过收尾时留下一整个工作区的改动（功能代码、任务状态文件，
 * 以及刚移动的任务目录）：`commit` 是 `paths: ['.', ':(exclude)<门禁标记>'…]`（仓库根的本机门禁标记
 * 不入库），工作区此刻是否干净都要提交——移动目录本身就是要入库的改动。以放弃出口（scope-expanded，
 * 已升级）收尾时 `commit` 为 null：改动留在工作区，由用户决定。
 */
export function finishActions(
  change: string,
  governedOpenspec: boolean,
  finish: StepFinishFacts,
): readonly StepAction[] {
  const git = finish.git
  const cleanup = worktreeCleanup(finish.worktree)
  const command = `tenon task finish ${change}`
  if (!governedOpenspec) {
    const commit = finish.verified && git !== null
      ? { paths: WORKSPACE_COMMIT_PATHS, untrack: git.untrack, message: `chore(tenon): finish ${change}` }
      : null
    return [{ action: 'finish-change', change, command, commit, cleanup }]
  }
  const commit = git === null
    ? null
    : {
        paths: [
          ...(git.changeDirTracked ? [`openspec/changes/${change}`] : []),
          'openspec/changes/archive',
          ...(finish.designSystem === true ? git.designSystem : []),
          ...git.housekeeping,
        ],
        untrack: git.untrack,
        message: `chore(openspec): archive ${change}`,
      }
  return [{ action: 'finish-change', change, command, commit, cleanup }]
}
