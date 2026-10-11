/**
 * workflow 编辑器数据端（GOAL E8）——真读/写 `.pipeline/workflows/*.yaml`。
 * `default` 不在可写/可删集合内（运行时不读这个文件，见 CONTRACT/design doc 决策 2）。
 */
import { randomUUID } from 'node:crypto'
import {
  constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync,
  readdirSync, renameSync, unlinkSync, writeFileSync,
  type Stats,
} from 'node:fs'
import { isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path'
import {
  assertWorkflowRootAnchor,
  captureWorkflowRootAnchor,
  closeWorkflowRootAnchor,
  lstatIfExists,
  safeClose,
  sameIdentity,
  traversableDirectoryFdPath,
  type FileIdentity,
  type WorkflowRootAnchor,
} from './workflowRootAnchor.js'
export {
  assertWorkflowRootAnchor,
  captureWorkflowRootAnchor,
  closeWorkflowRootAnchor,
  lstatIfExists,
  safeClose,
  sameIdentity,
  traversableDirectoryFdPath,
} from './workflowRootAnchor.js'
export type { FileIdentity, WorkflowRootAnchor } from './workflowRootAnchor.js'

export const WORKFLOWS_DIR = '.pipeline/workflows'

export interface OpenDirectory extends FileIdentity {
  /** 用户可见的词法路径，只用于检测换位和错误信息。 */
  readonly lexicalPath: string
  /** fd-relative 可用时锚在父目录 fd；否则与 lexicalPath 相同。 */
  readonly operationPath: string
  readonly realPath: string
  readonly fd: number
  readonly fdPath?: string
}

export interface WorkflowDirectories {
  readonly root: WorkflowRootAnchor
  readonly pipeline: OpenDirectory
  readonly workflows: OpenDirectory
}

export type WorkflowRoot = string | WorkflowRootAnchor

function assertInsideRoot(realRoot: string, realPath: string, label: string): void {
  const fromRoot = relative(realRoot, realPath)
  if (fromRoot === '' || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`${label} 已逃逸 registered root: ${realPath}`)
  }
}

function rootDirectory(anchor: WorkflowRootAnchor): OpenDirectory {
  return {
    lexicalPath: anchor.path,
    operationPath: anchor.fdPath ?? anchor.path,
    realPath: anchor.realPath,
    dev: anchor.dev,
    ino: anchor.ino,
    fd: anchor.fd,
    ...(anchor.fdPath ? { fdPath: anchor.fdPath } : {}),
  }
}

/**
 * 安全边界（必须诚实）：
 *
 * - fdPath 可用时，子目录 lookup 及最终 rename/unlink 都锚在已打开父目录 fd，父 pathname 换位
 *   不会把操作重定向到替换目录。
 * - fdPath 不可用时（当前 Darwin/Node 即如此），Node 未暴露 renameat/unlinkat；这里持有目录 fd，
 *   并在最终 syscall 紧前同时复核 fd、词法路径与 dev/ino。它覆盖仓库里预置 symlink，以及无权
 *   改名父目录的不同权限攻击者；不声称绝对消除可任意改目录项的同 UID 恶意进程在最后两条
 *   syscall 之间的竞态。目标目录不应与不可信的同 principal 写者共享。
 */
export function assertDirectoryStillTrusted(directory: OpenDirectory, root: WorkflowRootAnchor): void {
  assertWorkflowRootAnchor(root)
  const opened = fstatSync(directory.fd)
  if (!opened.isDirectory() || !sameIdentity(opened, directory)) {
    throw new Error(`workflow 目录 fd 身份已变化（TOCTOU）: ${directory.lexicalPath}`)
  }
  const operationEntry = lstatSync(directory.operationPath)
  if (operationEntry.isSymbolicLink() || !operationEntry.isDirectory() || !sameIdentity(operationEntry, directory)) {
    throw new Error(`workflow 目录操作路径已被替换（TOCTOU）: ${directory.lexicalPath}`)
  }
  const lexicalEntry = lstatSync(directory.lexicalPath)
  if (lexicalEntry.isSymbolicLink() || !lexicalEntry.isDirectory() || !sameIdentity(lexicalEntry, directory)) {
    throw new Error(`workflow 目录词法路径已被替换（TOCTOU）: ${directory.lexicalPath}`)
  }
  const freshRealPath = realpathSync(directory.operationPath)
  if (freshRealPath !== directory.realPath) {
    throw new Error(`workflow 目录 canonical realpath 已变化（TOCTOU）: ${directory.lexicalPath}`)
  }
  assertInsideRoot(root.realPath, freshRealPath, 'workflow 目录')
}

export function openTrustedChildDirectory(
  root: WorkflowRootAnchor,
  parent: OpenDirectory,
  name: string,
  create: boolean,
): OpenDirectory | undefined {
  if (parent.lexicalPath === root.path) assertWorkflowRootAnchor(root)
  else assertDirectoryStillTrusted(parent, root)

  const lexicalPath = join(parent.lexicalPath, name)
  const operationPath = join(parent.fdPath ?? parent.lexicalPath, name)
  let before = lstatIfExists(operationPath)
  if (!before) {
    if (!create) return undefined
    try {
      mkdirSync(operationPath)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
    before = lstatIfExists(operationPath)
    if (!before) throw new Error(`workflow 目录创建后不存在: ${lexicalPath}`)
  }
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new Error(`workflow 路径不安全（须为真实目录）: ${lexicalPath}`)
  }

  const fd = openSync(operationPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(fd)
    if (!opened.isDirectory() || !sameIdentity(opened, before)) {
      throw new Error(`workflow 目录在打开期间被替换（TOCTOU）: ${lexicalPath}`)
    }
    const realPath = realpathSync(operationPath)
    assertInsideRoot(root.realPath, realPath, 'workflow 目录')
    const fdPath = traversableDirectoryFdPath(fd, opened)
    const directory: OpenDirectory = fdPath
      ? { lexicalPath, operationPath, realPath, dev: opened.dev, ino: opened.ino, fd, fdPath }
      : { lexicalPath, operationPath, realPath, dev: opened.dev, ino: opened.ino, fd }
    if (parent.lexicalPath === root.path) assertWorkflowRootAnchor(root)
    else assertDirectoryStillTrusted(parent, root)
    assertDirectoryStillTrusted(directory, root)
    return directory
  } catch (e) {
    safeClose(fd)
    throw e
  }
}

/**
 * 从已捕获 root fd 逐层打开真实目录。每一层都走 O_NOFOLLOW + inode/realpath 复核；回调退出后
 * 逆序关闭本调用拥有的 fd。root 自身 fd 归 anchor 所有，不在这里关闭。
 */
export function withTrustedDirectoryChain<T>(
  root: WorkflowRootAnchor,
  names: readonly string[],
  create: boolean,
  onMissing: () => T,
  use: (directory: OpenDirectory) => T,
  expected?: { readonly depth: number; readonly identity: FileIdentity },
): T {
  const opened: OpenDirectory[] = []
  try {
    let parent = rootDirectory(root)
    for (const [depth, name] of names.entries()) {
      const child = openTrustedChildDirectory(root, parent, name, create)
      if (!child) return onMissing()
      if (expected?.depth === depth && !sameIdentity(child, expected.identity)) {
        safeClose(child.fd)
        throw new Error(`workflow 目录与请求捕获身份不一致: ${child.lexicalPath}`)
      }
      opened.push(child)
      parent = child
    }
    return use(parent)
  } finally {
    for (const directory of opened.reverse()) safeClose(directory.fd)
  }
}

function assertOptionalRegularChild(
  directory: OpenDirectory,
  root: WorkflowRootAnchor,
  name: string,
  label: string,
): void {
  assertDirectoryStillTrusted(directory, root)
  const paths = childEntry(directory, name)
  const entry = lstatIfExists(paths.operation)
  if (!entry) return
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new Error(`${label} 必须是非 symlink 普通文件: ${paths.lexical}`)
  }
  if (paths.operation !== paths.lexical) {
    const lexical = lstatSync(paths.lexical)
    if (lexical.isSymbolicLink() || !lexical.isFile() || !sameIdentity(lexical, entry)) {
      throw new Error(`${label} 词法路径身份不一致: ${paths.lexical}`)
    }
  }
  assertDirectoryStillTrusted(directory, root)
}

function assertOptionalTrustedChildDirectory(
  directory: OpenDirectory,
  root: WorkflowRootAnchor,
  name: string,
): void {
  const child = openTrustedChildDirectory(root, directory, name, false)
  if (child) safeClose(child.fd)
}

/**
 * 为跨资源引用事务准备项目协调锁的 `<root>/.pipeline/.pipeline.lock` 父目录。
 * 这里只安全创建真实 `.pipeline` 目录；真正加锁仍由 kernel withProjectCoordinationLock 完成，
 * 因此 CLI init/fields 与 server workflow 操作共用同一把锁。
 */
export function ensureWorkflowProjectCoordinationPath(root: WorkflowRootAnchor): void {
  withTrustedDirectoryChain(root, ['.pipeline'], true, () => {
    throw new Error('workflow 引用协调目录创建失败')
  }, (pipeline) => {
    // kernel withProjectCoordinationLock 将在这里 mkdir/读 owner；预置 symlink 不能被它当成锁目录跟随。
    assertOptionalTrustedChildDirectory(pipeline, root, '.pipeline.lock')
  })
}

/**
 * 为 loop governance 锁准备安全父目录。锁序由 server 固定为 governance → project-registry；
 * 受支持的 loop writer 与删除由同一 governance 锁串行。Node/Darwin 最终 pathname 窗口边界仍与
 * 本文件 G6 注释一致，不把同 UID 任意目录项攻击宣称为绝对消除。
 */
export function ensureWorkflowGovernanceCoordinationPath(root: WorkflowRootAnchor): void {
  ensureWorkflowProjectCoordinationPath(root)
  withTrustedDirectoryChain(root, ['.pipeline'], false, () => {
    throw new Error('workflow 引用协调目录意外消失')
  }, (pipeline) => {
    assertOptionalRegularChild(pipeline, root, 'loops.yaml', 'loops registry')
  })
  withTrustedDirectoryChain(root, ['.pipeline', 'loops', 'governance'], true, () => {
    throw new Error('workflow governance 协调目录创建失败')
  }, (governance) => {
    assertDirectoryStillTrusted(governance, root)
    assertOptionalTrustedChildDirectory(governance, root, '.pipeline.lock')
  })
}

function acquireRoot(root: WorkflowRoot): { anchor: WorkflowRootAnchor; owned: boolean } {
  if (typeof root === 'string') return { anchor: captureWorkflowRootAnchor(root), owned: true }
  assertWorkflowRootAnchor(root)
  return { anchor: root, owned: false }
}

export function withWorkflowDirectories<T>(
  rootInput: WorkflowRoot,
  create: boolean,
  onMissing: () => T,
  use: (directories: WorkflowDirectories) => T,
): T {
  const { anchor: root, owned } = acquireRoot(rootInput)
  let pipeline: OpenDirectory | undefined
  let workflows: OpenDirectory | undefined
  try {
    const rootDir = rootDirectory(root)
    pipeline = openTrustedChildDirectory(root, rootDir, '.pipeline', create)
    if (!pipeline) return onMissing()
    workflows = openTrustedChildDirectory(root, pipeline, 'workflows', create)
    if (!workflows) return onMissing()
    const directories = { root, pipeline, workflows }
    assertWorkflowDirectoriesStillTrusted(directories)
    return use(directories)
  } finally {
    if (workflows) safeClose(workflows.fd)
    if (pipeline) safeClose(pipeline.fd)
    if (owned) closeWorkflowRootAnchor(root)
  }
}

export function assertWorkflowDirectoriesStillTrusted(directories: WorkflowDirectories): void {
  assertWorkflowRootAnchor(directories.root)
  assertDirectoryStillTrusted(directories.pipeline, directories.root)
  assertDirectoryStillTrusted(directories.workflows, directories.root)
}

export interface EntryPaths {
  readonly lexical: string
  readonly operation: string
}

export function childEntry(directory: OpenDirectory, name: string): EntryPaths {
  return {
    lexical: join(directory.lexicalPath, name),
    operation: join(directory.fdPath ?? directory.lexicalPath, name),
  }
}

const WORKFLOW_NAME_RE = /^[\p{L}\p{N}\p{M}_-]+$/u

export function isWorkflowName(name: string): boolean {
  return name !== '' && WORKFLOW_NAME_RE.test(name)
}

export function assertWorkflowName(name: string): void {
  if (!isWorkflowName(name)) {
    throw new Error('非法 workflow 名（允许中文、字母、数字、- 与 _；不允许空格、点或路径符号）')
  }
}

export function assertEntryMatches(paths: EntryPaths, expected: FileIdentity, label: string): void {
  const operationEntry = lstatSync(paths.operation)
  if (operationEntry.isSymbolicLink() || !operationEntry.isFile() || !sameIdentity(operationEntry, expected)) {
    throw new Error(`${label} 已被替换（TOCTOU）: ${paths.lexical}`)
  }
  if (paths.operation !== paths.lexical) {
    const lexicalEntry = lstatSync(paths.lexical)
    if (lexicalEntry.isSymbolicLink() || !lexicalEntry.isFile() || !sameIdentity(lexicalEntry, expected)) {
      throw new Error(`${label} 词法路径已被替换（TOCTOU）: ${paths.lexical}`)
    }
  }
}

export function assertTargetUnchanged(paths: EntryPaths, expected: FileIdentity | undefined): void {
  const current = lstatIfExists(paths.operation)
  if (!expected) {
    if (current) throw new Error(`workflow 写入目标在发布前出现（TOCTOU）: ${paths.lexical}`)
    return
  }
  if (!current || current.isSymbolicLink() || !current.isFile() || !sameIdentity(current, expected)) {
    throw new Error(`workflow 写入目标在发布前被替换（TOCTOU）: ${paths.lexical}`)
  }
}

export function cleanupOwnedTempFile(
  paths: EntryPaths,
  expected: FileIdentity | undefined,
  directories: WorkflowDirectories,
): void {
  if (!expected) return
  try {
    assertWorkflowDirectoriesStillTrusted(directories)
    const current = lstatIfExists(paths.operation)
    if (!current || current.isSymbolicLink() || !current.isFile() || !sameIdentity(current, expected)) return
    unlinkSync(paths.operation)
  } catch {
    // 复核失败时宁可遗留本调用的临时 inode，也绝不 unlink 一个已经换位的未知目录项。
  }
}

export function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export {
  WorkflowDeleteConflictError,
  WorkflowNotFoundError,
} from './workflowTypes.js'
export type {
  WorkflowDeletePermit,
  WorkflowReference,
  WorkflowReferenceKind,
  WorkflowReferenceScanBlocker,
  WorkflowReferenceScanResult,
} from './workflowTypes.js'
