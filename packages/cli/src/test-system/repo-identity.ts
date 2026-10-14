/**
 * 测试信任用的仓库身份：当前检出所属仓库的 `git rev-parse --git-common-dir` 真实路径。同一仓库的所有 worktree
 * 共享一个身份，所以在主检出里信任过的命令，新建的 worktree 里不用再确认一遍。
 *
 * 身份会被借用吗？一个检出目录里的 `.git` 文件可以写成指向别处已信任仓库的 common dir（压缩包、克隆来的目录都能带），
 * git 也就认它是那个仓库的检出。所以只有 git 自己登记过的检出才算：
 *   · 主检出：git 报告的 git dir 就是 common dir，并且检出根就是 `git worktree list` 的第一项（主 worktree）；
 *   · 链接的 worktree：git dir 恰好是 `<common>/worktrees/<id>`，那里的 `gitdir` 文件回指的 `.git` 就在这个检出根，
 *     并且检出根出现在 `git worktree list` 的非 prunable 条目里。
 * 手写 `.git` 指向 common dir 或某个管理目录的伪造检出，检出根对不上，一律读不出身份（失败关闭）。prunable 条目
 * （worktree 目录被直接删掉后留下的）不为任何目录担保，也不影响主检出的判定。
 *
 * 结果分三种，调用方据此决定能不能退回检出里的旧封存：
 *   · `not-repo`：检出目录及其所有上级都没有 `.git`。这一条只看文件系统、不调用 git，所以 git 不可用时也能判定；
 *   · `repo`：读出了身份；
 *   · `unresolved`：有 `.git` 却读不出身份（git 出错、超时、不可用，`.git` 是伪造或损坏的指针，目录读不到）。
 *     这时不能当成「不是仓库」：克隆来的仓库带着自己的旧封存与密钥，只要把 git 弄出错就能让旧封存被无条件认下。
 *
 * git 调用经 git-exec.ts：清掉所有 `GIT_*` 环境变量（`GIT_DIR`、`GIT_COMMON_DIR`、`GIT_WORK_TREE`、`GIT_CONFIG_*` 都能把答案指到别的仓库，
 * agent 运行 `tenon test run` 时能设置它们）并带超时。
 */
import { lstat, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { runGit } from './git-exec.js'

const MAX_GITDIR_FILE_BYTES = 4096

function git(cwd: string, args: readonly string[]): Promise<string> {
  return runGit(cwd, ['-c', 'core.quotePath=false', ...args])
}

interface ListedWorktree {
  readonly path: string
  readonly prunable: boolean
}

/** `git worktree list --porcelain`：空行分隔的块，第一块是主 worktree，块里 `worktree <路径>` 一行，`prunable …` 表示目录已不存在。 */
function parseWorktreeList(stdout: string): readonly ListedWorktree[] {
  const listed: ListedWorktree[] = []
  for (const block of stdout.split(/\n{2,}/u)) {
    const lines = block.split('\n')
    const head = lines.find((line) => line.startsWith('worktree '))
    if (head === undefined) continue
    listed.push({ path: head.slice('worktree '.length), prunable: lines.some((line) => line === 'prunable' || line.startsWith('prunable ')) })
  }
  return listed
}

async function realpathOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await realpath(path)
  } catch {
    return undefined
  }
}

async function isListed(entries: readonly ListedWorktree[], root: string): Promise<boolean> {
  for (const entry of entries) {
    if (!entry.prunable && (await realpathOrUndefined(entry.path)) === root) return true
  }
  return false
}

/** 链接 worktree 的管理目录里 `gitdir` 文件记着它的检出根 `.git`；对不上说明 `.git` 文件是手写的。 */
async function backlinksTo(adminDir: string, root: string): Promise<boolean> {
  const file = join(adminDir, 'gitdir')
  // 只读普通小文件：管理目录来自被检的 `.git` 指针，不能让它把我们带进管道或巨大的文件。
  const entry = await lstat(file)
  if (!entry.isFile() || entry.size > MAX_GITDIR_FILE_BYTES) return false
  const recorded = (await readFile(file, 'utf8')).split('\n')[0]?.trim() ?? ''
  if (recorded === '') return false
  const dotGit = await realpath(resolve(adminDir, recorded))
  return basename(dotGit) === '.git' && dirname(dotGit) === root
}

async function resolveIdentity(cwd: string): Promise<string | undefined> {
  const base = await realpath(cwd)
  const lines = (await git(base, ['rev-parse', '--git-common-dir', '--git-dir', '--show-toplevel'])).split('\n')
  // 三行输出 + 结尾换行；路径里带换行的目录会让行数对不上，按失败处理。
  const [commonRaw, gitDirRaw, topRaw, end] = lines
  if (lines.length !== 4 || commonRaw === undefined || gitDirRaw === undefined || topRaw === undefined || end !== '') return undefined
  const common = await realpath(resolve(base, commonRaw))
  const gitDir = await realpath(resolve(base, gitDirRaw))
  const root = await realpath(resolve(base, topRaw))
  const [main, ...linked] = parseWorktreeList(await git(root, ['worktree', 'list', '--porcelain']))
  if (gitDir === common) {
    return main !== undefined && !main.prunable && (await realpathOrUndefined(main.path)) === root ? common : undefined
  }
  if (dirname(gitDir) !== join(common, 'worktrees')) return undefined
  return (await backlinksTo(gitDir, root)) && (await isListed(linked, root)) ? common : undefined
}

export type RepoTrustIdentity =
  /** common dir 的真实路径。 */
  | { readonly kind: 'repo'; readonly repo: string }
  /** 检出目录及其所有上级都没有 `.git`。 */
  | { readonly kind: 'not-repo' }
  /** 有 `.git` 却读不出身份：git 出错 / 超时 / 不可用、伪造的指针、不在 worktree 列表里。 */
  | { readonly kind: 'unresolved' }

/** 文件系统错误是不是「确定不存在」（ENOENT）；不做类型断言，从 unknown 收窄。 */
function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

/**
 * 从 `cwd` 的真实路径起逐级向上到文件系统根，有没有哪一级带 `.git`（文件、目录、链接都算）。
 * 只看文件系统，不调用 git。除「确定不存在」之外的任何失败（含 cwd 本身读不到）都按「有」处理，让调用方失败关闭。
 */
async function hasDotGit(cwd: string): Promise<boolean> {
  let dir: string
  try {
    dir = await realpath(cwd)
  } catch {
    return true
  }
  for (;;) {
    try {
      await lstat(join(dir, '.git'))
      return true
    } catch (error) {
      if (!isNotFound(error)) return true
    }
    const parent = dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
}

/**
 * `cwd` 所属仓库的信任身份；cwd 在子目录里时取所在检出根的身份。
 * 只有「确定没有 `.git`」才是 `not-repo`；其余读不出身份的情形都是 `unresolved`。
 */
export async function repoTrustIdentity(cwd: string): Promise<RepoTrustIdentity> {
  if (!(await hasDotGit(cwd))) return { kind: 'not-repo' }
  try {
    const repo = await resolveIdentity(cwd)
    return repo === undefined ? { kind: 'unresolved' } : { kind: 'repo', repo }
  } catch {
    return { kind: 'unresolved' }
  }
}
