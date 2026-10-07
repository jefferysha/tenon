/**
 * Host-local files: per-machine configuration of the coding-agent hosts that is never committed, and which of
 * them the portable workspace fingerprint (`fingerprint.ts`) leaves out.
 */
import { execFile } from 'node:child_process'
import { lstat, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

/**
 * Host-local files: per-machine configuration of the coding-agent hosts that is never committed (the hosts
 * create it git-ignored, or tell the user to ignore it).  They are not implementation, but they differ
 * between the author's workspace and any clone, so a fingerprint that counted them could never be
 * reproduced from the committed files.  The list is explicit on purpose; nothing else is excluded by name
 * pattern, and every entry is a path from the project root:
 *
 *   · `.claude/settings.local.json` — Claude Code's personal project settings (permission allow-lists, hook
 *     logging); Claude Code rewrites it whenever the user answers a permission prompt.
 *   · `CLAUDE.local.md` — Claude Code's personal, uncommitted project memory next to `CLAUDE.md`.
 *   · `.claude/worktrees/` — checkouts of this project that Claude Code creates for its sub-agents; every
 *     file in them is a copy of source that already counts at its real path.
 *
 * `.claude/settings.json`, `.claude/commands/`, `.claude/skills/`, `.mcp.json` and `CLAUDE.md` are shared,
 * committed configuration and stay part of the candidate.  Codex needs no entry: `.codex/` and `.agents/`
 * are excluded as a whole.
 *
 * The exclusion is only for files git does not track.  A host-local path that is tracked (committed or
 * staged) is part of the repository, so the portable fingerprint counts it: otherwise a pull request could
 * commit code under one of these paths, point a test at it, and change it later without moving the candidate.
 */
export const HOST_LOCAL_FILES = ['.claude/settings.local.json', 'CLAUDE.local.md'] as const
export const HOST_LOCAL_DIRS = ['.claude/worktrees'] as const

/** Whether a path is on the host-local list (by name only; whether git tracks it is a separate question, see `trackedHostLocalPaths`). */
export function isHostLocalPath(relativePath: string): boolean {
  return (HOST_LOCAL_FILES as readonly string[]).includes(relativePath)
    || HOST_LOCAL_DIRS.some((dir) => relativePath === dir || relativePath.startsWith(`${dir}/`))
}

/** True when the project has at least one host-local path, i.e. when the two fingerprints can differ. */
export async function hasHostLocalFiles(root: string): Promise<boolean> {
  for (const path of [...HOST_LOCAL_FILES, ...HOST_LOCAL_DIRS]) {
    try {
      await lstat(join(root, ...path.split('/')))
      return true
    } catch {
      // absent
    }
  }
  return false
}

const runGit = promisify(execFile)
const GIT_TIMEOUT_MS = 30_000
const GIT_MAX_BUFFER = 64 * 1024 * 1024

/**
 * Variables that point git at a repository (or change what it reads) instead of letting it discover the one
 * that holds the project.  A git hook runs with several of them set (`GIT_DIR`, `GIT_INDEX_FILE`, ...), and
 * Tenon can run inside one, so the answer would come from whatever repository the hook is working on.
 */
const GIT_REPOSITORY_ENV = new Set([
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR', 'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM',
])

/** The process environment without the repository-selecting git variables, and with the C locale git's messages are matched in. */
function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(process.env)) {
    // Windows environment names are case-insensitive.
    if (!GIT_REPOSITORY_ENV.has(name.toUpperCase())) env[name] = value
  }
  return { ...env, LC_ALL: 'C', LANG: 'C' }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT'
}

/** Lower-cases the ASCII letters only: the fold git's own `--icase-pathspecs` matching applies, and all the list's names need. */
function foldAsciiCase(path: string): string {
  return path.replace(/[A-Z]/gu, (letter) => letter.toLowerCase())
}

function swapAsciiCase(name: string): string {
  return name.replace(/[A-Za-z]/gu, (letter) => (letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase()))
}

/**
 * Whether the project root sits on a case-insensitive file system (macOS APFS and Windows by default).  The probe
 * looks up the first host-local entry that exists at the root under the other spelling (`.claude` as `.CLAUDE`):
 * the same file (same device and inode) means the file system folds case, a missing name means it does not.  It
 * reads only metadata and writes nothing.  When the probe cannot decide (no entry to try, an unexpected error)
 * the answer is "case-insensitive": that only ever makes the portable fingerprint count more, never less.
 */
export async function isCaseInsensitiveRoot(root: string): Promise<boolean> {
  for (const name of new Set([...HOST_LOCAL_FILES, ...HOST_LOCAL_DIRS].map((path) => path.split('/')[0] ?? path))) {
    const swapped = swapAsciiCase(name)
    if (swapped === name) continue
    let original
    try {
      original = await lstat(join(root, name))
    } catch {
      continue
    }
    try {
      const other = await lstat(join(root, swapped))
      return other.dev === original.dev && other.ino === original.ino
    } catch (error) {
      return !isMissing(error)
    }
  }
  return true
}

/**
 * `git ls-files` said there is no repository here.  Only git's own "not a git repository (or any of the parent
 * directories)" is that answer; the neighbouring failures are not:
 *   · `fatal: not a git repository: <path>` is a `.git` gitfile whose `gitdir` target is gone;
 *   · `fatal: not a git repository (or any parent up to mount point <dir>)` is a repository above the project
 *     that git will not look into because it is on another file system.
 */
const NO_REPOSITORY_MESSAGE = /^fatal: not a git repository \(or any of the parent directories\)/imu

/**
 * Whether the project root has a `.git` entry (directory or gitfile).  Git reports an empty, corrupt or unreadable
 * `.git` directory with the same "no repository" message as a directory that was never a repository, so the
 * message alone cannot tell them apart.  Only a missing entry is "no"; any other failure is treated as "yes".
 */
async function hasGitEntry(root: string): Promise<boolean> {
  try {
    await lstat(join(root, '.git'))
    return true
  } catch (error) {
    return !isMissing(error)
  }
}

/** Whether the project root's `.git` is a directory (a symbolic link to one counts); a gitfile or a missing entry is not. */
async function hasGitDirectory(root: string): Promise<boolean> {
  try {
    return (await stat(join(root, '.git'))).isDirectory()
  } catch {
    return false
  }
}

/** What git says about the host-local list: the tracked paths (spelled as in the index) and how to compare them with the disk's spelling. */
export interface HostLocalTracking {
  readonly tracked: ReadonlySet<string>
  /** The root's file system folds case, so a tracked path matches the disk's spelling of it whatever the case. */
  readonly caseInsensitive: boolean
}

/**
 * The files under the host-local list that git tracks (committed or staged).  A directory that is genuinely not a
 * git repository (git finds none in it or in any parent directory, and there is no `.git` entry at the root)
 * tracks nothing.  Every other failure (git missing, a corrupt index, a broken gitfile, an unreadable or corrupt
 * `.git`, a repository behind a file system boundary, a timeout) is `undefined`: the caller must then count every
 * host-local path, because "unknown" must never widen what the fingerprint leaves out.
 *
 * On a case-insensitive file system git lists the index's spelling (`.Claude/Settings.local.json`) while the disk
 * says `.claude/settings.local.json`, and a plain pathspec does not find the entry at all, so the list is asked
 * for with `--icase-pathspecs` there.
 *
 * When the root has a `.git` directory, git is told to use exactly that one (`--git-dir`).  Left to discover it,
 * git skips a `.git` directory it finds invalid (corrupt, half-written, unreadable) and carries on upward, so
 * inside a larger repository it would answer from the parent, which does not track what this project tracks, and
 * the portable fingerprint would drop host-local files that are part of this repository.  With `--git-dir` an invalid
 * `.git` is an error, i.e. "git cannot answer", in the same single spawn.  A `.git` gitfile needs no such help:
 * git stops with an error when its `gitdir` target is not a repository.
 */
export async function hostLocalTracking(root: string): Promise<HostLocalTracking | undefined> {
  const caseInsensitive = await isCaseInsensitiveRoot(root)
  const gitDir = await hasGitDirectory(root) ? [`--git-dir=${join(root, '.git')}`] : []
  const args = [
    ...gitDir, ...caseInsensitive ? ['--icase-pathspecs'] : [],
    'ls-files', '-z', '--cached', '--', ...HOST_LOCAL_FILES, ...HOST_LOCAL_DIRS,
  ]
  try {
    const { stdout } = await runGit('git', args, {
      cwd: root, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, env: gitEnvironment(),
    })
    return { tracked: new Set(stdout.split('\0').filter((path) => path !== '')), caseInsensitive }
  } catch (error) {
    const stderr = typeof error === 'object' && error !== null ? Reflect.get(error, 'stderr') : undefined
    const noRepository = typeof stderr === 'string' && NO_REPOSITORY_MESSAGE.test(stderr) && !(await hasGitEntry(root))
    return noRepository ? { tracked: new Set(), caseInsensitive } : undefined
  }
}

/** The tracked host-local paths alone, spelled as the index spells them; `undefined` when git cannot answer (see `hostLocalTracking`). */
export async function trackedHostLocalPaths(root: string): Promise<ReadonlySet<string> | undefined> {
  return (await hostLocalTracking(root))?.tracked
}

/** Which paths a fingerprint leaves out in addition to the common exclusions. */
export type HostLocalSkip = (relativePath: string) => boolean

/** The full fingerprint counts every host-local path. */
export const SKIP_NOTHING: HostLocalSkip = () => false

/**
 * The portable fingerprint leaves out the host-local paths git does not track (and the directories holding only
 * those).  With `caseInsensitive` a path counts as tracked when git tracks it under any ASCII-case spelling,
 * because the disk and the index may spell it differently.
 */
export function skipUntrackedHostLocal(tracked: ReadonlySet<string>, caseInsensitive = false): HostLocalSkip {
  const key = caseInsensitive ? foldAsciiCase : (path: string): string => path
  const trackedKeys = new Set([...tracked].map(key))
  const holdingTracked = new Set<string>()
  for (const path of trackedKeys) {
    const parts = path.split('/')
    for (let end = 1; end < parts.length; end++) holdingTracked.add(parts.slice(0, end).join('/'))
  }
  return (relativePath) => {
    if (!isHostLocalPath(relativePath)) return false
    const folded = key(relativePath)
    return !trackedKeys.has(folded) && !holdingTracked.has(folded)
  }
}
