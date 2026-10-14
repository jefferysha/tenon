/**
 * 从主检出找到建在 worktree 里的任务：`git worktree list --porcelain` 里位于 `<主检出>/.worktrees/` 下、
 * 带着未搬进 `archive/` 的任务（`openspec/changes/<c>` 里有状态存储）的 worktree。
 *
 * `tenon list`、按名读取找不到任务时的报错、`tenon workflow progress` 共用这份清单；`hooks/router.sh` 在热路径上
 * 不能起 git，自己用纯 bash 遍历同一个目录布局。git 执行器由调用方传入——这里不自己起 git 进程，
 * 任何读不出来的情形（不是仓库、git 失败、worktree 目录已被删）都当作「没有」，不抛错。
 *
 * `changes` 只看目录是否搬进了 `archive/`：状态里 `archived=true` 但目录还没搬走的任务仍会列出，
 * 是否按完结过滤由读状态的调用方决定（`tenon list` 与活跃表同一口径）。
 */
import { readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { stateStorageExistsSync } from '../state/run-revision-store.js'
import type { GitRunner } from './task-worktree.js'

export interface TaskWorktreeEntry {
  /** worktree 的绝对路径：沿用调用方给的 `repoRoot` 拼出（与 `tenon init` 输出的路径同一写法，不换成 git 的真实路径）。 */
  readonly path: string
  /** worktree 检出的分支名（`tenon/<change>`）；HEAD 分离时为空串。 */
  readonly branch: string
  /** 该 worktree 里未归档的任务名，按名排序。 */
  readonly changes: readonly string[]
}

const WORKTREES_DIR = '.worktrees'
const CHANGE_NAME = /^[A-Za-z0-9_-]+$/

interface PorcelainBlock {
  readonly path: string
  readonly branch: string
}

/** `git worktree list --porcelain`：空行分隔的块，每块 `worktree <路径>`，检出分支时另有 `branch refs/heads/<名>`。 */
function parsePorcelain(stdout: string): readonly PorcelainBlock[] {
  const blocks: PorcelainBlock[] = []
  let path: string | undefined
  let branch = ''
  const flush = (): void => {
    if (path !== undefined) blocks.push({ path, branch })
    path = undefined
    branch = ''
  }
  for (const line of stdout.split(/\r?\n/)) {
    if (line === '') flush()
    else if (line.startsWith('worktree ')) {
      flush()
      path = line.slice('worktree '.length)
    } else if (line.startsWith('branch ')) branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
  }
  flush()
  return blocks
}

async function realOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await realpath(path)
  } catch {
    return undefined
  }
}

async function changesOf(worktree: string): Promise<readonly string[]> {
  const root = join(worktree, 'openspec', 'changes')
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isDirectory() && entry.name !== 'archive' && CHANGE_NAME.test(entry.name))
    .filter((entry) => stateStorageExistsSync(join(root, entry.name)))
    .map((entry) => entry.name)
    .sort()
}

export async function listTaskWorktrees(input: {
  readonly repoRoot: string
  readonly git: GitRunner
}): Promise<readonly TaskWorktreeEntry[]> {
  const { repoRoot, git } = input
  // 没有 .worktrees 目录就不可能有任务 worktree：不必起 git。
  const base = await realOrUndefined(join(repoRoot, WORKTREES_DIR))
  if (base === undefined) return []
  const listed = await git(['worktree', 'list', '--porcelain'], repoRoot)
  if (listed.code !== 0) return []

  const entries: TaskWorktreeEntry[] = []
  for (const block of parsePorcelain(listed.stdout)) {
    // macOS 的 /var 与 /private/var：两边都先 realpath 再比较。
    const real = await realOrUndefined(block.path)
    if (real === undefined) continue
    const inside = relative(base, real)
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) continue
    const changes = await changesOf(real)
    if (changes.length === 0) continue
    entries.push({ path: join(repoRoot, WORKTREES_DIR, inside), branch: block.branch, changes })
  }
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}
