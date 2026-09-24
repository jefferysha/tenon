/**
 * 相位出口规则表的文件面（PhaseExitFileContext）的本机文件系统实现：CLI 与 Dashboard server 读同一份，
 * 同一个 Change 在两处得到同样的出口判定。路径相对项目根解析；tasks.md 等 TaskPlan 输入走有界读取。
 */
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  type BigIntStats,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { readCurrentRunRevisionSync, stateStorageExistsSync } from '../state/run-revision-store.js'
import type { BoundedFileRead, PhaseExitFileContext } from '../workflow/phase-exit-context.js'

function sameBoundedFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
}

interface BoundedAncestor {
  readonly path: string
  readonly info: BigIntStats
  readonly real: string
}

interface BoundedRegularFileSyncHooks {
  readonly openFile?: (path: string, flags: number) => number
}

function boundedAncestors(root: string, path: string): readonly BoundedAncestor[] | undefined {
  const fromRoot = relative(root, path)
  if (
    fromRoot === ''
    || fromRoot === '..'
    || fromRoot.startsWith(`..${sep}`)
    || isAbsolute(fromRoot)
  ) return undefined
  const rootInfo = lstatSync(root, { bigint: true })
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return undefined
  const rootReal = realpathSync(root)
  const parentFromRoot = dirname(fromRoot)
  const segments = parentFromRoot === '.' ? [] : parentFromRoot.split(sep)
  const ancestors: BoundedAncestor[] = [{ path: root, info: rootInfo, real: rootReal }]
  let candidate = root
  for (const segment of segments) {
    candidate = join(candidate, segment)
    const info = lstatSync(candidate, { bigint: true })
    if (!info.isDirectory() || info.isSymbolicLink()) return undefined
    ancestors.push({ path: candidate, info, real: realpathSync(candidate) })
  }
  const parentReal = realpathSync(dirname(path))
  const fromRealRoot = relative(rootReal, parentReal)
  if (
    fromRealRoot === '..'
    || fromRealRoot.startsWith(`..${sep}`)
    || isAbsolute(fromRealRoot)
  ) return undefined
  return ancestors
}

function sameBoundedAncestors(ancestors: readonly BoundedAncestor[]): boolean {
  return ancestors.every((ancestor) => {
    const current = lstatSync(ancestor.path, { bigint: true })
    return current.isDirectory()
      && !current.isSymbolicLink()
      && sameBoundedFile(ancestor.info, current)
      && realpathSync(ancestor.path) === ancestor.real
  })
}

/**
 * Synchronous because GuardContext is synchronous, but still opens before reading and fences the
 * regular-file identity before/after materialization. Oversized/symlink/replaced inputs are never
 * returned as text, so TaskPlan byte budgets apply before allocation rather than after it.
 */
export function readBoundedRegularFileSync(
  path: string,
  maxBytes: number,
  root: string,
  hooks: BoundedRegularFileSyncHooks = {},
): BoundedFileRead {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) return { kind: 'invalid' }
  let fd: number | undefined
  let inspected = false
  try {
    const ancestors = boundedAncestors(root, path)
    if (ancestors === undefined || !sameBoundedAncestors(ancestors)) return { kind: 'invalid' }
    const lexical = lstatSync(path, { bigint: true })
    inspected = true
    if (!lexical.isFile() || lexical.size > BigInt(maxBytes)) return { kind: 'invalid' }
    fd = (hooks.openFile ?? openSync)(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    const opened = fstatSync(fd, { bigint: true })
    if (!opened.isFile() || !sameBoundedFile(lexical, opened)) return { kind: 'invalid' }
    // Never let a concurrent grow race make readFileSync allocate past the admitted size. One
    // bounded extra byte is enough to prove overflow without materializing attacker-controlled tail.
    const raw = Buffer.allocUnsafe(maxBytes + 1)
    let length = 0
    while (length < raw.byteLength) {
      const read = readSync(fd, raw, length, raw.byteLength - length, null)
      if (read === 0) break
      length += read
    }
    if (length > maxBytes || BigInt(length) !== opened.size) return { kind: 'invalid' }
    const after = fstatSync(fd, { bigint: true })
    const current = lstatSync(path, { bigint: true })
    if (
      !sameBoundedFile(opened, after)
      || !sameBoundedFile(opened, current)
      || !sameBoundedAncestors(ancestors)
    ) return { kind: 'invalid' }
    return {
      kind: 'ok',
      text: new TextDecoder('utf-8', { fatal: true }).decode(raw.subarray(0, length)),
    }
  } catch (error) {
    return !inspected && (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { kind: 'missing' }
      : { kind: 'invalid' }
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* Best-effort cleanup; the read result is already bounded. */ }
    }
  }
}

function activeCanonicalArchived(cwd: string, dep: string): boolean {
  try {
    const current = readCurrentRunRevisionSync(join(cwd, 'openspec', 'changes', dep))
    return current?.state.fields.archived === 'true'
  } catch {
    return false
  }
}

function physicallyArchived(cwd: string, dep: string): boolean {
  try {
    return readdirSync(join(cwd, 'openspec', 'changes', 'archive'), { withFileTypes: true })
      .some((entry) => entry.isDirectory() && entry.name.endsWith(`-${dep}`))
  } catch {
    return false
  }
}

export function makeGuardFileContext(
  cwd: string,
  options: { readonly automationRunner: boolean },
): (name: string) => PhaseExitFileContext {
  const abs = (relativePath: string): string => join(cwd, relativePath)
  return (name) => ({
    changeDirRel: `openspec/changes/${name}`,
    stateExists: (changeDirRel) => stateStorageExistsSync(abs(changeDirRel)),
    fileExists: (path) => {
      try { return statSync(abs(path)).isFile() } catch { return false }
    },
    fileNonempty: (path) => {
      try {
        const state = statSync(abs(path))
        return state.isFile() && state.size > 0
      } catch {
        return false
      }
    },
    readFile: (path) => {
      try { return readFileSync(abs(path), 'utf8') } catch { return undefined }
    },
    readFileBounded: (path, maxBytes) => readBoundedRegularFileSync(abs(path), maxBytes, cwd),
    dirExists: (path) => {
      try { return statSync(abs(path)).isDirectory() } catch { return false }
    },
    activeChangeArchived: (dep) => activeCanonicalArchived(cwd, dep),
    changeArchived: (dep) => physicallyArchived(cwd, dep),
    automationRunner: options.automationRunner,
  })
}
