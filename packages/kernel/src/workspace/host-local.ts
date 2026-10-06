/**
 * Host-local files: per-machine configuration of the coding-agent hosts that is never committed, and which of
 * them the portable workspace fingerprint (`fingerprint.ts`) leaves out.
 */
import { execFile } from 'node:child_process'
import { lstat } from 'node:fs/promises'
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
 * The files under the host-local list that git tracks (committed or staged), as paths from the project root.
 * A directory that is not a git repository tracks nothing.  Any other failure (git missing, a corrupt index,
 * a timeout) is `undefined`: the caller must then count every host-local path, because "unknown" must never
 * widen what the fingerprint leaves out.
 */
export async function trackedHostLocalPaths(root: string): Promise<ReadonlySet<string> | undefined> {
  try {
    const { stdout } = await runGit('git', ['ls-files', '-z', '--cached', '--', ...HOST_LOCAL_FILES, ...HOST_LOCAL_DIRS], {
      cwd: root, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    })
    return new Set(stdout.split('\0').filter((path) => path !== ''))
  } catch (error) {
    const stderr = typeof error === 'object' && error !== null ? Reflect.get(error, 'stderr') : undefined
    return typeof stderr === 'string' && /not a git repository/iu.test(stderr) ? new Set() : undefined
  }
}

/** Which paths a fingerprint leaves out in addition to the common exclusions. */
export type HostLocalSkip = (relativePath: string) => boolean

/** The full fingerprint counts every host-local path. */
export const SKIP_NOTHING: HostLocalSkip = () => false

/** The portable fingerprint leaves out the host-local paths git does not track (and the directories holding only those). */
export function skipUntrackedHostLocal(tracked: ReadonlySet<string>): HostLocalSkip {
  const holdingTracked = new Set<string>()
  for (const path of tracked) {
    const parts = path.split('/')
    for (let end = 1; end < parts.length; end++) holdingTracked.add(parts.slice(0, end).join('/'))
  }
  return (relativePath) => isHostLocalPath(relativePath) && !tracked.has(relativePath) && !holdingTracked.has(relativePath)
}
