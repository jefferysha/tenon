/**
 * 完结时下发的提交动作要问 git 的两件事：某条路径下有没有已跟踪的文件，工作区有没有待提交的改动。
 *
 * `finish-change` 的 `git add -A -- <paths…>` 必须一次成功。`openspec archive` 搬走的原目录如果从来
 * 没被 git 跟踪过，搬走之后这条 pathspec 什么也匹配不到，`git add` 就以
 * `fatal: pathspec … did not match any files`（exit 128）整条失败；只有被跟踪过的原目录才需要、
 * 也才能出现在 paths 里（`-A` 据索引项把删除一起暂存）。
 *
 * 两者都用 null 表示「判定不了」（不是 git 仓，或 git 跑不起来）：调用方据此不发提交动作，
 * 不把「不知道」当成「可以提交」。
 */
import { execFile } from 'node:child_process'

function git(cwd: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', [...args], { cwd, timeout: 5000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      resolve(error === null ? String(stdout) : null)
    })
  })
}

/** `rel` 之下有没有已跟踪的文件；非 git 仓或 git 跑不起来 → null。 */
export async function gitTracksPath(cwd: string, rel: string): Promise<boolean | null> {
  const out = await git(cwd, ['ls-files', '-z', '--', rel])
  return out === null ? null : out !== ''
}

/** 工作区（含未跟踪、不含 .gitignore 忽略的）有没有待提交的改动；判定不了 → null。 */
export async function gitWorkspaceDirty(cwd: string): Promise<boolean | null> {
  const out = await git(cwd, ['status', '--porcelain', '-z', '--untracked-files=normal'])
  return out === null ? null : out !== ''
}
