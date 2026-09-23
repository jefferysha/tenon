/**
 * `next` 里读 git 事实（gitWorkspace.ts）的两条提交规则：交付步提交交付物（`commit`），状态机已完结
 * （`fields.archived=true`）之后收尾（`finish-change`）。与顺序表分开放，是因为顺序表的其余规则只读
 * 步骤证据。两条提交的形状相同：`{ paths, untrack, message }`，照原样执行、每条命令一次成功。
 */
import { WORKSPACE_COMMIT_PATHS, type GitFinishProbe } from '../gitWorkspace.js'
import { stop, type StepAction } from './statusStepAction.js'

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
 */
export function deliveryCommit(change: string, git: GitFinishProbe | null): StepCommit | null {
  if (git === null || !git.deliverablesDirty) return null
  return { paths: WORKSPACE_COMMIT_PATHS, untrack: git.untrack, message: `feat(${change}): deliver` }
}

/** 完结时要问 git 的事实（只在 `runArchived` 时由投影层取）。 */
export interface StepFinishFacts {
  /** gitWorkspace.ts probeGitFinish；null = 不是 git 仓或 git 跑不起来。 */
  readonly git: GitFinishProbe | null
  /** 这次运行以验证通过收尾（verify_result=pass）；scope-expanded 之类的放弃出口不提交。 */
  readonly verified: boolean
}

/**
 * 完结之后的收尾：治理归档（OpenSpec 工作流）与一次提交。
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
 * 非 OpenSpec 治理的工作流（内置 simple）没有归档命令，但以验证通过收尾时同样留下一整个工作区的
 * 改动（功能代码与任务状态文件）：`command: null`，只带提交 `paths: ['.', ':(exclude)<门禁标记>'…]`
 * （仓库根的本机门禁标记不入库）；工作区已干净（已提交）、不是 git 仓或以放弃出口（scope-expanded）
 * 收尾时就停（`stop finished`，与已搬进 archive/ 的 change 同一形态）。
 */
/** 已完结、没有可做的事了：所有工作流、目录搬没搬走都同一形态。 */
export function finishedStop(change: string): readonly StepAction[] {
  return stop('finished', `任务 '${change}' 已完结，没有要做的事了`)
}

export function finishActions(
  change: string,
  governedOpenspec: boolean,
  finish: StepFinishFacts,
): readonly StepAction[] {
  const git = finish.git
  if (!governedOpenspec) {
    if (!finish.verified || git === null || (!git.workspaceDirty && git.untrack.length === 0)) {
      return finishedStop(change)
    }
    return [{
      action: 'finish-change',
      change,
      command: null,
      commit: { paths: WORKSPACE_COMMIT_PATHS, untrack: git.untrack, message: `chore(tenon): finish ${change}` },
    }]
  }
  const command = `openspec archive ${change} --skip-specs --yes --json`
  const commit = git === null
    ? null
    : {
        paths: [
          ...(git.changeDirTracked ? [`openspec/changes/${change}`] : []),
          'openspec/changes/archive',
          ...git.housekeeping,
        ],
        untrack: git.untrack,
        message: `chore(openspec): archive ${change}`,
      }
  return [{ action: 'finish-change', change, command, commit }]
}
