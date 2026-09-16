import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
  type Stats,
} from 'node:fs'
import { resolve as resolvePath, sep } from 'node:path'

export interface FileIdentity {
  readonly dev: number
  readonly ino: number
}

export interface WorkflowRootAnchor extends FileIdentity {
  readonly path: string
  readonly realPath: string
  readonly fd: number
  readonly fdPath?: string
}

export interface WorkflowRootMutationVersion {
  readonly mtimeNs: bigint
  readonly ctimeNs: bigint
}

/**
 * The path to hand a CHILD process. In-process readers use `fdPath` (`/proc/self/fd/<n>` on Linux) because
 * it pins the directory this server opened, but that path names an entry in *this* process's descriptor
 * table: a spawned git resolves it against its own table, where the descriptor was never opened, and dies
 * with a misleading ENOENT. Anything that runs `execFile`/`spawn` against a project root must go through
 * this accessor so the class stays greppable — it has already produced three silent Linux-only failures.
 */
export function anchorChildProcessPath(anchor: WorkflowRootAnchor): string {
  return anchor.realPath
}

export function sameIdentity(current: FileIdentity, expected: FileIdentity): boolean {
  return current.dev === expected.dev && current.ino === expected.ino
}

export function safeClose(fd: number): void {
  try {
    closeSync(fd)
  } catch {
    // Best-effort cleanup must not mask the original business error.
  }
}

export function lstatIfExists(path: string): Stats | undefined {
  try {
    return lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export function traversableDirectoryFdPath(fd: number, expected: FileIdentity): string | undefined {
  const candidates = process.platform === 'linux'
    ? [`/proc/self/fd/${fd}`, `/dev/fd/${fd}`]
    : [`/dev/fd/${fd}`, `/proc/self/fd/${fd}`]
  return traversableDirectoryFdPathFromCandidates(expected, candidates)
}

export function traversableDirectoryFdPathFromCandidates(
  expected: FileIdentity,
  candidates: readonly string[],
): string | undefined {
  for (const candidate of candidates) {
    try {
      // Do not use path.join here: it normalizes away the trailing `/.`, causing lstat to inspect
      // the procfs/devfs symlink itself instead of traversing it as an opened directory.
      const current = lstatSync(`${candidate}${sep}.`)
      if (current.isDirectory() && sameIdentity(current, expected)) return candidate
    } catch {
      // Try the next platform-specific fd path.
    }
  }
  return undefined
}

export function captureWorkflowRootAnchor(root: string): WorkflowRootAnchor {
  const path = resolvePath(root)
  const lexical = lstatSync(path)
  if (lexical.isSymbolicLink() || !lexical.isDirectory()) {
    throw new Error(`registered root 必须是非 symlink 的真实目录: ${path}`)
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(fd)
    if (!opened.isDirectory() || !sameIdentity(opened, lexical)) {
      throw new Error(`registered root 在捕获期间被替换: ${path}`)
    }
    const realPath = realpathSync(path)
    const fresh = lstatSync(path)
    if (fresh.isSymbolicLink() || !fresh.isDirectory() || !sameIdentity(fresh, opened)) {
      throw new Error(`registered root 在捕获期间被替换: ${path}`)
    }
    const fdPath = traversableDirectoryFdPath(fd, opened)
    return fdPath
      ? { path, realPath, dev: opened.dev, ino: opened.ino, fd, fdPath }
      : { path, realPath, dev: opened.dev, ino: opened.ino, fd }
  } catch (error) {
    safeClose(fd)
    throw error
  }
}

export function assertWorkflowRootAnchor(anchor: WorkflowRootAnchor): void {
  const lexical = lstatSync(anchor.path)
  if (lexical.isSymbolicLink() || !lexical.isDirectory() || !sameIdentity(lexical, anchor)) {
    throw new Error(`registered root 词法路径已不再指向注册时目录: ${anchor.path}`)
  }
  const opened = fstatSync(anchor.fd)
  if (!opened.isDirectory() || !sameIdentity(opened, anchor)) {
    throw new Error(`registered root 目录 fd 身份已失效: ${anchor.path}`)
  }
  if (realpathSync(anchor.path) !== anchor.realPath) {
    throw new Error(`registered root canonical realpath 已变化: ${anchor.path}`)
  }
}

export function captureWorkflowRootMutationVersion(
  anchor: WorkflowRootAnchor,
): WorkflowRootMutationVersion {
  assertWorkflowRootAnchor(anchor)
  const stat = lstatSync(anchor.path, { bigint: true })
  if (
    stat.isSymbolicLink()
    || !stat.isDirectory()
    || Number(stat.dev) !== anchor.dev
    || Number(stat.ino) !== anchor.ino
  ) {
    throw new Error(`registered root 在版本捕获期间被替换: ${anchor.path}`)
  }
  return { mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs }
}

export function assertWorkflowRootMutationVersion(
  anchor: WorkflowRootAnchor,
  expected: WorkflowRootMutationVersion,
): void {
  const current = captureWorkflowRootMutationVersion(anchor)
  if (current.mtimeNs !== expected.mtimeNs || current.ctimeNs !== expected.ctimeNs) {
    throw new Error(`registered root 在读取期间发生变化: ${anchor.path}`)
  }
}

export function closeWorkflowRootAnchor(anchor: WorkflowRootAnchor): void {
  safeClose(anchor.fd)
}
