/**
 * 完结时下发的提交动作要问 git 的事实。提交命令（`git add -A -- <paths…>`、可选的
 * `git rm --cached -q --ignore-unmatch -- <untrack…>`、`git commit`）必须一次成功，所以 paths 里
 * 只能出现 git 接受的路径：
 *
 *   · `openspec archive` 搬走的原目录如果从来没被 git 跟踪过，搬走之后这条 pathspec 什么也匹配
 *     不到，`git add` 以 `fatal: pathspec … did not match any files`（exit 128）整条失败；只有被
 *     跟踪过的原目录才需要、也才能出现在 paths 里（`-A` 据索引项把删除一起暂存）。
 *   · 状态目录自己的 `.gitignore`（`.pipeline/`、`.tenon/`、`openspec/`）首次生成后常处于未跟踪
 *     状态，不一起提交收尾后 `git status` 就不干净；但它们只在存在、且没有被上层规则忽略时才能
 *     `git add`（被忽略的路径 `git add` 会 exit 1）。
 *   · 旧版本已经提交进 git 的终端心跳（`openspec/changes/**\/.pipeline-terminal-activity.*`）不会因为
 *     后来加的忽略规则而取消跟踪：已跟踪且已被忽略的那些列进 `untrack`，由 `git rm --cached` 移出索引。
 *
 * 不是 git 仓（或 git 跑不起来）时返回 null：调用方据此不发提交动作，不把「不知道」当成「可以提交」。
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'

export interface GitFinishProbe {
  /** `openspec/changes/<c>` 之下有没有已跟踪的文件。 */
  readonly changeDirTracked: boolean
  /** 工作区（含未跟踪、不含被忽略的）有没有待提交的改动。 */
  readonly workspaceDirty: boolean
  /** 存在且未被忽略、可以一起 `git add` 的状态目录 `.gitignore`。 */
  readonly housekeeping: readonly string[]
  /** 已跟踪、但按当前忽略规则应被忽略的终端心跳文件。 */
  readonly untrack: readonly string[]
}

export const FINISH_HOUSEKEEPING_PATHS: readonly string[] = [
  '.pipeline/.gitignore',
  '.tenon/.gitignore',
  'openspec/.gitignore',
]

const TERMINAL_ACTIVITY_PREFIX = '.pipeline-terminal-activity.'

interface GitOutcome {
  readonly code: number | null
  readonly stdout: string
}

function git(cwd: string, args: readonly string[]): Promise<GitOutcome> {
  return new Promise((resolve) => {
    execFile('git', [...args], { cwd, timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error === null) {
        resolve({ code: 0, stdout: String(stdout) })
        return
      }
      const code = (error as NodeJS.ErrnoException).code
      resolve({ code: typeof code === 'number' ? code : null, stdout: String(stdout) })
    })
  })
}

function nulList(stdout: string): readonly string[] {
  return stdout.split('\0').filter((entry) => entry !== '')
}

export async function probeGitFinish(cwd: string, change: string): Promise<GitFinishProbe | null> {
  const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree'])
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') return null
  const [tracked, status, ignoredTracked] = await Promise.all([
    git(cwd, ['ls-files', '-z', '--', `openspec/changes/${change}`]),
    git(cwd, ['status', '--porcelain', '-z', '--untracked-files=normal']),
    git(cwd, ['ls-files', '-z', '-c', '-i', '--exclude-standard', '--', 'openspec/changes']),
  ])
  if (tracked.code !== 0 || status.code !== 0) return null
  const housekeeping: string[] = []
  for (const path of FINISH_HOUSEKEEPING_PATHS) {
    if (!existsSync(join(cwd, path))) continue
    // check-ignore：0 = 被忽略，1 = 没被忽略；其余（128）按判定不了处理，不列。
    if ((await git(cwd, ['check-ignore', '-q', '--', path])).code === 1) housekeeping.push(path)
  }
  const untrack = ignoredTracked.code === 0
    ? nulList(ignoredTracked.stdout).filter((path) => basename(path).startsWith(TERMINAL_ACTIVITY_PREFIX))
    : []
  return {
    changeDirTracked: tracked.stdout !== '',
    workspaceDirty: status.stdout !== '',
    housekeeping,
    untrack,
  }
}
