/**
 * 未提交删除 count: how many Changes 删除 removed from the working tree without committing. Delete never
 * touches git history or the index, so this is the only signal that tells the user what is still theirs
 * to commit. Paths in porcelain output are repository-relative, so Tenon projects keep `openspec/` at the
 * git root.
 *
 * The probe reports *why* it could not count. Two outcomes are deliberately distinct: a directory with no
 * repository has nothing to count and is not a failure, while a repository whose git probe fails is a real
 * gap that a caller may surface. A count that silently becomes `null` is how a Linux-only regression once
 * reached CI, so `countUncommittedTaskDeletions` is a thin wrapper over the typed probe, not the source.
 */
import { execFile } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { isPlainDirectory } from '../users/user-paths.js'
import { isTaskLifecycleName, taskChangeDir } from './task-archive.js'

const execFileAsync = promisify(execFile)
const CHANGES_PREFIX = 'openspec/changes/'

/**
 * `/proc/self/fd/<n>` and `/dev/fd/<n>` name an entry in *this* process's descriptor table. A spawned git
 * resolves such a path against its own table, where the descriptor was never opened, and fails with a
 * misleading `cannot change to …: No such file or directory`. A child process must be handed a real path,
 * so these are refused by name instead of turning into an unexplained non-zero exit.
 */
const PROCESS_LOCAL_FD_PATH = /^\/(?:proc\/(?:self|[0-9]+)|dev)\/fd\/[0-9]+(?:\/|$)/u

export function isProcessLocalFdPath(path: string): boolean {
  return PROCESS_LOCAL_FD_PATH.test(path)
}

export interface GitStatusResult {
  readonly code: number
  readonly stdout: string
  /** git's own diagnosis; the probe quotes it so a failure names itself. */
  readonly stderr?: string
}

export type GitStatusRunner = (repoRoot: string, args: readonly string[]) => Promise<GitStatusResult>

export type UncommittedDeletionsProbe =
  | { readonly kind: 'ok'; readonly count: number }
  /** No repository at this root: nothing to count, and nothing to report. */
  | { readonly kind: 'absent'; readonly reason: string }
  /** A repository is here but the probe failed; the count is unknown and the reason is worth surfacing. */
  | { readonly kind: 'unavailable'; readonly reason: string }

export const gitStatusRunner: GitStatusRunner = async (repoRoot, args) => {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoRoot, ...args], {
      timeout: 5_000,
      maxBuffer: 4_194_304,
      windowsHide: true,
    })
    return { code: 0, stdout: String(stdout) }
  } catch (error) {
    const failure = error as { code?: unknown; stderr?: unknown }
    const code = typeof failure.code === 'number' && failure.code !== 0 ? failure.code : 1
    return { code, stdout: '', stderr: typeof failure.stderr === 'string' ? failure.stderr : String(failure.code ?? '') }
  }
}

/** `openspec/changes/<name>/…` → `<name>`; a bare Change directory entry or another path → `null`. */
function changeNameOf(path: string): string | null {
  if (!path.startsWith(CHANGES_PREFIX)) return null
  const rest = path.slice(CHANGES_PREFIX.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return null
  const name = rest.slice(0, slash)
  return isTaskLifecycleName(name) ? name : null
}

/** A worktree's `.git` is a file, a primary checkout's is a directory; either proves a repository is here. */
async function hasRepository(repoRoot: string): Promise<boolean> {
  try {
    await lstat(join(repoRoot, '.git'))
    return true
  } catch {
    return false
  }
}

export async function probeUncommittedTaskDeletions(
  repoRoot: string,
  git: GitStatusRunner = gitStatusRunner,
): Promise<UncommittedDeletionsProbe> {
  if (isProcessLocalFdPath(repoRoot)) {
    return { kind: 'unavailable', reason: `进程私有 fd 路径无法交给子进程解析：${repoRoot}` }
  }
  if (!(await hasRepository(repoRoot))) {
    return { kind: 'absent', reason: `不是 git 仓库根：${repoRoot}` }
  }
  const result = await git(repoRoot, [
    'status', '--porcelain=v1', '-z', '--untracked-files=no', '--', 'openspec/changes',
  ])
  if (result.code !== 0) {
    const detail = (result.stderr ?? '').trim()
    return { kind: 'unavailable', reason: `git status 退出码 ${result.code}${detail === '' ? '' : `：${detail}`}` }
  }
  const fields = result.stdout.split('\0')
  const names = new Set<string>()
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index] ?? ''
    if (field.length < 4) continue
    const [x, y] = [field[0] ?? '', field[1] ?? '']
    // A rename or copy carries its source path in the following NUL-terminated field.
    if (x === 'R' || x === 'C') index += 1
    if (x !== 'D' && y !== 'D') continue
    const name = changeNameOf(field.slice(3))
    if (name !== null) names.add(name)
  }
  let count = 0
  for (const name of names) {
    if (!(await isPlainDirectory(taskChangeDir(repoRoot, name)))) count += 1
  }
  return { kind: 'ok', count }
}

/**
 * Whether git can bring a deleted Change back: `tracked` when the index holds at least one file under the
 * Change directory (删除 never touches the index, so `git checkout -- <dir>` restores it), `untracked` when
 * there is no repository or nothing under the directory is tracked, `unknown` when the probe itself fails.
 */
export type ChangeTrackingProbe = 'tracked' | 'untracked' | 'unknown'

export async function probeChangeTracked(
  repoRoot: string,
  name: string,
  git: GitStatusRunner = gitStatusRunner,
): Promise<ChangeTrackingProbe> {
  if (!isTaskLifecycleName(name) || isProcessLocalFdPath(repoRoot)) return 'unknown'
  if (!(await hasRepository(repoRoot))) return 'untracked'
  const result = await git(repoRoot, ['ls-files', '-z', '--', `${CHANGES_PREFIX}${name}`])
  if (result.code !== 0) return 'unknown'
  return result.stdout.split('\0').some((path) => path !== '') ? 'tracked' : 'untracked'
}

/** `null` when the count is unknown; callers that need the reason use `probeUncommittedTaskDeletions`. */
export async function countUncommittedTaskDeletions(
  repoRoot: string,
  git: GitStatusRunner = gitStatusRunner,
): Promise<number | null> {
  const probe = await probeUncommittedTaskDeletions(repoRoot, git)
  return probe.kind === 'ok' ? probe.count : null
}
