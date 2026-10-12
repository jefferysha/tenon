/**
 * 只提交给定的几个路径：`git add -A -- <paths…>`，再 `git commit --only -m <message> -- <paths…>`。
 * `--only` 让提交忽略索引里别处已暂存的内容，工作区里别的任务、别的改动一概不进这次提交，也不被动。
 *
 * 提交是尽力而为：目录移动已经完成，提交失败（钩子拒绝、没有身份、git 跑不起来）只报告原因，不回滚。
 */
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import type { GitStatusRunner } from './uncommitted-deletions.js'

export type PathCommitOutcome =
  | { readonly kind: 'committed' }
  /** 没有要提交的东西，或这里不是 git 仓库。 */
  | { readonly kind: 'skipped'; readonly reason: string }
  | { readonly kind: 'failed'; readonly detail: string }

function detailOf(result: { readonly stdout: string; readonly stderr?: string }, fallback: string): string {
  const text = (result.stderr ?? '').trim() || result.stdout.trim()
  return text === '' ? fallback : text
}

async function hasRepository(repoRoot: string): Promise<boolean> {
  try {
    await lstat(join(repoRoot, '.git'))
    return true
  } catch {
    return false
  }
}

export async function commitOnlyPaths(
  repoRoot: string,
  git: GitStatusRunner,
  paths: readonly string[],
  message: string,
): Promise<PathCommitOutcome> {
  if (paths.length === 0) return { kind: 'skipped', reason: '没有要提交的路径' }
  if (!(await hasRepository(repoRoot))) return { kind: 'skipped', reason: `不是 git 仓库根：${repoRoot}` }
  const added = await git(repoRoot, ['add', '-A', '--', ...paths])
  if (added.code !== 0) return { kind: 'failed', detail: `git add 退出码 ${added.code}：${detailOf(added, '无输出')}` }
  const staged = await git(repoRoot, ['diff', '--cached', '--quiet', '--', ...paths])
  if (staged.code === 0) return { kind: 'skipped', reason: '这些路径没有可提交的改动' }
  if (staged.code !== 1) return { kind: 'failed', detail: `git diff 退出码 ${staged.code}：${detailOf(staged, '无输出')}` }
  const committed = await git(repoRoot, ['commit', '--only', '-m', message, '--', ...paths])
  return committed.code === 0
    ? { kind: 'committed' }
    : { kind: 'failed', detail: `git commit 退出码 ${committed.code}：${detailOf(committed, '无输出')}` }
}
