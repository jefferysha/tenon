/**
 * 受信根目录下的普通文件读写：模板库（config 根）、项目指令文件（已注册项目根）、用户级指令文件（宿主 home）共用。
 *
 * - 目录逐层经 withTrustedDirectoryChain 打开（O_NOFOLLOW + inode / realpath 复核），祖先是 symlink 或被换位即抛错；
 * - 目标文件拒绝 symlink 与非普通文件，读取绑定 inode；
 * - 写入先按摘要比对（与客户端最后看到的不同 → changed，不覆盖外部修改），再同目录独占临时文件 + fsync + rename；
 * - 删除同样先比对摘要，unlink 紧前复核 inode。
 */
import { randomUUID } from 'node:crypto'
import {
  constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { ABSENT_DIGEST, instructionDigest } from '@tenon/kernel'
import {
  assertDirectoryStillTrusted, assertEntryMatches, assertTargetUnchanged, childEntry, withTrustedDirectoryChain,
  type EntryPaths, type OpenDirectory,
} from './workflowTrustedFs.js'
import {
  assertWorkflowRootAnchor, lstatIfExists, safeClose, sameIdentity, type FileIdentity, type WorkflowRootAnchor,
} from './workflowRootAnchor.js'

export type TargetFileError = 'target-symlink' | 'not-file' | 'too-large'

export interface TrustedRead {
  readonly bytes: Buffer | null
  readonly digest: string
  readonly error?: TargetFileError
  readonly identity?: FileIdentity
}

export type TrustedWriteResult =
  | { ok: true; digest: string }
  | { ok: false; code: 'changed'; digest: string }
  | { ok: false; code: TargetFileError }

export type TrustedUnlinkResult =
  | { ok: true }
  | { ok: false; code: 'missing' }
  | { ok: false; code: 'changed'; digest: string }
  | { ok: false; code: TargetFileError }

function assertTrusted(directory: OpenDirectory, root: WorkflowRootAnchor): void {
  if (directory.lexicalPath === root.path) assertWorkflowRootAnchor(root)
  else assertDirectoryStillTrusted(directory, root)
}

function readChild(root: WorkflowRootAnchor, directory: OpenDirectory, name: string, maxBytes: number): TrustedRead {
  assertTrusted(directory, root)
  const entry = childEntry(directory, name)
  const before = lstatIfExists(entry.operation)
  if (!before) return { bytes: null, digest: ABSENT_DIGEST }
  if (before.isSymbolicLink()) return { bytes: null, digest: ABSENT_DIGEST, error: 'target-symlink' }
  if (!before.isFile()) return { bytes: null, digest: ABSENT_DIGEST, error: 'not-file' }
  if (before.size > maxBytes) return { bytes: null, digest: ABSENT_DIGEST, error: 'too-large' }
  const fd = openSync(entry.operation, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile() || !sameIdentity(opened, before)) throw new Error(`文件在读取期间被替换: ${entry.lexical}`)
    const bytes = readFileSync(fd)
    if (bytes.length > maxBytes) return { bytes: null, digest: ABSENT_DIGEST, error: 'too-large' }
    assertTrusted(directory, root)
    return { bytes, digest: instructionDigest(bytes), identity: { dev: opened.dev, ino: opened.ino } }
  } finally {
    safeClose(fd)
  }
}

export function readTrustedFile(root: WorkflowRootAnchor, dirs: readonly string[], name: string, maxBytes: number): TrustedRead {
  return withTrustedDirectoryChain(root, dirs, false, (): TrustedRead => ({ bytes: null, digest: ABSENT_DIGEST }), (directory) =>
    readChild(root, directory, name, maxBytes))
}

/** 目录下的条目名（排序）；目录不存在 → 空。 */
export function listTrustedDirectory(root: WorkflowRootAnchor, dirs: readonly string[]): string[] {
  return withTrustedDirectoryChain(root, dirs, false, () => [], (directory) => {
    assertTrusted(directory, root)
    return readdirSync(directory.fdPath ?? directory.lexicalPath).sort()
  })
}

function removeOwnedTemp(temp: EntryPaths, identity: FileIdentity | undefined, directory: OpenDirectory, root: WorkflowRootAnchor): void {
  if (!identity) return
  try {
    assertTrusted(directory, root)
    const current = lstatIfExists(temp.operation)
    if (current && !current.isSymbolicLink() && current.isFile() && sameIdentity(current, identity)) unlinkSync(temp.operation)
  } catch {
    // 复核失败时宁可遗留本调用的临时文件，也不 unlink 一个已经换位的目录项。
  }
}

/** 按 baseDigest 比对后原子写入；缺失的中间目录经受信链创建。 */
export function writeTrustedFile(
  root: WorkflowRootAnchor,
  dirs: readonly string[],
  name: string,
  content: string,
  baseDigest: string,
  maxBytes: number,
): TrustedWriteResult {
  return withTrustedDirectoryChain(root, dirs, true, () => { throw new Error('目标目录创建失败') }, (directory): TrustedWriteResult => {
    const current = readChild(root, directory, name, maxBytes)
    if (current.error) return { ok: false, code: current.error }
    if (current.digest !== baseDigest) return { ok: false, code: 'changed', digest: current.digest }
    const target = childEntry(directory, name)
    const existing = lstatIfExists(target.operation)
    const expected = existing ? { dev: existing.dev, ino: existing.ino } : undefined
    const temp = childEntry(directory, `.${name}.tmp.${process.pid}.${randomUUID()}`)
    let fd: number | undefined
    let identity: FileIdentity | undefined
    let committed = false
    try {
      assertTrusted(directory, root)
      fd = openSync(temp.operation, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, existing ? existing.mode & 0o777 : 0o644)
      writeFileSync(fd, content, 'utf8')
      fsyncSync(fd)
      const written = fstatSync(fd)
      identity = { dev: written.dev, ino: written.ino }
      assertEntryMatches(temp, identity, '临时文件')
      assertTrusted(directory, root)
      assertTargetUnchanged(target, expected)
      assertEntryMatches(temp, identity, '临时文件')
      renameSync(temp.operation, target.operation)
      committed = true
      return { ok: true, digest: instructionDigest(Buffer.from(content, 'utf8')) }
    } catch (error) {
      if (!committed) removeOwnedTemp(temp, identity, directory, root)
      throw error
    } finally {
      if (fd !== undefined) safeClose(fd)
    }
  })
}

/** 按摘要比对后删除；unlink 紧前复核读取时绑定的 inode。 */
export function unlinkTrustedFile(
  root: WorkflowRootAnchor,
  dirs: readonly string[],
  name: string,
  digest: string,
  maxBytes: number,
): TrustedUnlinkResult {
  return withTrustedDirectoryChain(root, dirs, false, (): TrustedUnlinkResult => ({ ok: false, code: 'missing' }), (directory): TrustedUnlinkResult => {
    const current = readChild(root, directory, name, maxBytes)
    if (current.error) return { ok: false, code: current.error }
    if (current.bytes === null || current.identity === undefined) return { ok: false, code: 'missing' }
    if (current.digest !== digest) return { ok: false, code: 'changed', digest: current.digest }
    const target = childEntry(directory, name)
    assertTrusted(directory, root)
    assertEntryMatches(target, current.identity, '目标文件')
    const entry = lstatSync(target.operation)
    if (!sameIdentity(entry, current.identity)) throw new Error(`文件在删除前被替换: ${target.lexical}`)
    unlinkSync(target.operation)
    return { ok: true }
  })
}

/** 文件系统异常 → HTTP：权限不足 422；受信链校验失败（symlink 祖先、换位）409 path-unsafe；其余 500。 */
export function trustedFsFailure(error: unknown): { status: number; body: { ok: false; code: string; error: string } } {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    return { status: 422, body: { ok: false, code: 'write-denied', error: '没有写入权限' } }
  }
  if (code === undefined || code === 'ELOOP' || code === 'ENOTDIR' || code === 'EEXIST') {
    return { status: 409, body: { ok: false, code: 'path-unsafe', error: '路径不安全（符号链接或目录被替换）' } }
  }
  return { status: 500, body: { ok: false, code: 'fs-error', error: '文件读写失败' } }
}
