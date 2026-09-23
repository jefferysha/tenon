/**
 * `next` 在状态机已完结（`fields.archived=true`）之后的唯一一条规则：收尾。与顺序表分开放，
 * 是因为它读的是 git 的事实（gitWorkspace.ts），而顺序表的其余规则只读步骤证据。
 */
import type { GitFinishProbe } from '../gitWorkspace.js'
import { stop, type StepAction } from './statusStepAction.js'

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
 * 改动（功能代码与任务状态文件）：`command: null`，只带提交 `paths: ['.']`；工作区已干净（已提交）、
 * 不是 git 仓或以放弃出口（scope-expanded）收尾时就停。
 */
export function finishActions(
  change: string,
  governedOpenspec: boolean,
  finish: StepFinishFacts,
): readonly StepAction[] {
  const git = finish.git
  if (!governedOpenspec) {
    if (!finish.verified || git === null || (!git.workspaceDirty && git.untrack.length === 0)) {
      return stop('run-archived', `任务 '${change}' 已完结`)
    }
    return [{
      action: 'finish-change',
      change,
      command: null,
      commit: { paths: ['.'], untrack: git.untrack, message: `chore(tenon): finish ${change}` },
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
