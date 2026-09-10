/**
 * Workflow editor storage facade.
 */
import { randomUUID } from 'node:crypto'
import {
  constants, fstatSync, fsyncSync, lstatSync, openSync,
  readSync, readdirSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { parseWorkflow, serializeWorkflow, validateWorkflowForStorage, validateWorkflowTrackReferences, materializeWorkflowIo, selectTrackBranch } from '@tenon/kernel'
import type { WorkflowDef } from '@tenon/kernel'
import {
  assertEntryMatches,
  assertTargetUnchanged,
  assertWorkflowName,
  assertWorkflowDirectoriesStillTrusted,
  childEntry,
  cleanupOwnedTempFile,
  lstatIfExists,
  safeClose,
  sameIdentity,
  withWorkflowDirectories,
  WorkflowDeleteConflictError,
  WorkflowNotFoundError,
  type FileIdentity,
  type WorkflowDeletePermit,
  type WorkflowRoot,
} from './workflowTrustedFs.js'
import { workflowWriteTrackRegistry } from './workflowReferenceScan.js'

export {
  captureWorkflowRootAnchor,
  assertWorkflowRootAnchor,
  closeWorkflowRootAnchor,
  ensureWorkflowProjectCoordinationPath,
  ensureWorkflowGovernanceCoordinationPath,
  WorkflowNotFoundError,
  WorkflowDeleteConflictError,
} from './workflowTrustedFs.js'
export type {
  WorkflowRootAnchor,
  WorkflowReference,
  WorkflowReferenceKind,
  WorkflowReferenceScanBlocker,
  WorkflowReferenceScanResult,
  WorkflowDeletePermit,
} from './workflowTrustedFs.js'
export { scanWorkflowReferencesForApi } from './workflowReferenceScan.js'

export class WorkflowPathError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'WorkflowPathError'
  }
}

export class WorkflowReadError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'WorkflowReadError'
  }
}

export const MAX_WORKFLOW_DEFINITION_BYTES = 256 * 1024
export type WorkflowFdReader = (fd: number, maxBytes: number) => string

export function readBoundedWorkflowSource(fd: number, maxBytes: number): string {
  const bytes = Buffer.allocUnsafe(maxBytes + 1)
  let total = 0
  while (total <= maxBytes) {
    const count = readSync(fd, bytes, total, maxBytes + 1 - total, null)
    if (count === 0) break
    total += count
  }
  if (total > maxBytes) throw new WorkflowReadError('workflow 超过安全读取上限')
  return bytes.subarray(0, total).toString('utf8')
}

function workflowIoError(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined
  return code === 'EACCES' || code === 'EIO' || code === 'EMFILE' || code === 'ENFILE'
}

export function captureWorkflowDeletePermit(root: WorkflowRoot, name: string): WorkflowDeletePermit | null {
  assertWorkflowName(name)
  return withWorkflowDirectories(root, false, () => null, (directories) => {
    const target = childEntry(directories.workflows, `${name}.yaml`)
    assertWorkflowDirectoriesStillTrusted(directories)
    let fd: number
    try {
      fd = openSync(target.operation, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    try {
      const opened = fstatSync(fd)
      if (!opened.isFile()) throw new Error(`workflow 删除目标不安全（须为普通文件）: ${target.lexical}`)
      const identity = { dev: opened.dev, ino: opened.ino }
      assertEntryMatches(target, identity, 'workflow 删除目标')
      assertWorkflowDirectoriesStillTrusted(directories)
      return { name, ...identity }
    } finally {
      safeClose(fd)
    }
  })
}

/** 扫 `<root>/.pipeline/workflows/*.yaml`（含 default 的项目覆盖文件）；目录不存在 → 空数组。 */
export function listWorkflowNames(root: WorkflowRoot): string[] {
  return withWorkflowDirectories(root, false, () => [], (directories) => {
    assertWorkflowDirectoriesStillTrusted(directories)
    const names = readdirSync(directories.workflows.fdPath ?? directories.workflows.lexicalPath)
      .filter((file) => file.endsWith('.yaml'))
    // list 也拒绝 target symlink：不能先把不安全目录项广告给客户端，再等 read 才报错。
    for (const file of names) {
      const paths = childEntry(directories.workflows, file)
      const entry = lstatSync(paths.operation)
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new Error(`workflow 列表目标不安全（须为普通文件）: ${paths.lexical}`)
      }
    }
    assertWorkflowDirectoriesStillTrusted(directories)
    return names.map((file) => file.slice(0, -'.yaml'.length))
  })
}

/** 从 O_NOFOLLOW 打开的普通文件 fd 读字节，再 parse + validate；不调用会重走 pathname 的 loadWorkflow。 */
/**
 * GET /api/workflows/:name 的分支视图：通用分支（键 `_base`）与每条 track 分支各自的物化 IO。
 * 分支是完整 pipeline，IO 单独物化（不与通用分支叠加）。
 */
export function workflowBranchesForApi(def: WorkflowDef): Record<string, { label?: string; effectiveIo: ReturnType<typeof materializeWorkflowIo> }> {
  const out: Record<string, { label?: string; effectiveIo: ReturnType<typeof materializeWorkflowIo> }> = {
    _base: { effectiveIo: materializeWorkflowIo(selectTrackBranch(def, undefined)) },
  }
  for (const [track, branch] of Object.entries(def.tracks ?? {})) {
    out[track] = {
      ...(branch.label === undefined ? {} : { label: branch.label }),
      effectiveIo: materializeWorkflowIo(selectTrackBranch(def, track)),
    }
  }
  return out
}

export function readWorkflowForApi(
  root: WorkflowRoot,
  name: string,
  readSource: WorkflowFdReader = readBoundedWorkflowSource,
): WorkflowDef {
  const source = readWorkflowSourceForApi(root, name, readSource)
  const workflow = parseWorkflow(source)
  const errors = validateWorkflowForStorage(name, workflow)
  if (errors.length > 0) {
    throw new Error(
      `ERROR: workflow '${name}' 校验失败：\n${errors.map((error) => `  - ${error}`).join('\n')}`,
    )
  }
  return workflow
}

/** 同 readWorkflowForApi 的受信 fd 读边界，但返回 YAML 原文（导出用）；不解析、不校验。 */
export function readWorkflowSourceForApi(
  root: WorkflowRoot,
  name: string,
  readSource: WorkflowFdReader = readBoundedWorkflowSource,
): string {
  assertWorkflowName(name)
  let source: string
  try {
    source = withWorkflowDirectories(
      root,
      false,
      () => { throw new WorkflowNotFoundError(`workflow '${name}' 未找到`) },
      (directories) => {
        const paths = childEntry(directories.workflows, `${name}.yaml`)
        assertWorkflowDirectoriesStillTrusted(directories)
        let fd: number
        try {
          fd = openSync(
            paths.operation,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          )
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new WorkflowNotFoundError(`workflow '${name}' 未找到`)
          }
          if ((e as NodeJS.ErrnoException).code === 'ELOOP') {
            throw new WorkflowPathError(`workflow '${name}' 路径不可信`, e)
          }
          throw new WorkflowReadError(`workflow '${name}' 读取失败`, e)
        }
        let opened
        try {
          opened = fstatSync(fd)
        } catch (error) {
          safeClose(fd)
          throw new WorkflowReadError(`workflow '${name}' 读取失败`, error)
        }
        try {
          if (!opened.isFile()) {
            throw new WorkflowPathError(`workflow '${name}' 读取目标不是可信普通文件`)
          }
          if (opened.size > MAX_WORKFLOW_DEFINITION_BYTES) {
            throw new WorkflowReadError(`workflow '${name}' 超过安全读取上限`)
          }
          assertEntryMatches(paths, opened, 'workflow 读取目标')
          assertWorkflowDirectoriesStillTrusted(directories)
          try {
            const result = readSource(fd, MAX_WORKFLOW_DEFINITION_BYTES)
            const after = fstatSync(fd)
            if (
              !after.isFile()
              || after.dev !== opened.dev
              || after.ino !== opened.ino
              || after.size !== opened.size
            ) {
              throw new WorkflowReadError(`workflow '${name}' 在读取期间变化`)
            }
            assertEntryMatches(paths, opened, 'workflow 读取目标')
            assertWorkflowDirectoriesStillTrusted(directories)
            return result
          } catch (error) {
            if (error instanceof WorkflowReadError) throw error
            throw new WorkflowReadError(`workflow '${name}' 读取失败`, error)
          }
        } finally {
          safeClose(fd)
        }
      },
    )
  } catch (error) {
    if (error instanceof WorkflowNotFoundError
      || error instanceof WorkflowPathError
      || error instanceof WorkflowReadError) throw error
    if (workflowIoError(error)) {
      throw new WorkflowReadError(`workflow '${name}' 读取失败`, error)
    }
    throw new WorkflowPathError(`workflow '${name}' 路径不可信`, error)
  }
  return source
}

/** 存储键 'default' 走 default 契约（七阶段 + effective-phase-skills artifact），其余走 custom 契约。 */
export function workflowOrigin(name: string): 'default' | 'custom' {
  return name === 'default' ? 'default' : 'custom'
}

export type WriteWorkflowResult = { ok: true } | { ok: false; errors: string[] }

/** 校验通过才落盘；同目录独占 tmp + 原子 rename，不覆盖发布前被换位的目标。 */
export function writeWorkflowForApi(
  root: WorkflowRoot,
  name: string,
  wf: WorkflowDef,
): WriteWorkflowResult {
  assertWorkflowName(name)
  const errors = validateWorkflowForStorage(name, wf)
  if (wf.name !== name) errors.unshift(`workflow name '${wf.name}' 必须与存储键 '${name}' 一致`)
  if (errors.length > 0) return { ok: false, errors }
  const content = serializeWorkflow(wf)

  return withWorkflowDirectories(root, true, () => { throw new Error('workflow 目录创建失败') }, (directories) => {
    const trackSnapshot = workflowWriteTrackRegistry(directories)
    if ('errors' in trackSnapshot) return { ok: false, errors: trackSnapshot.errors }
    const referenceErrors = validateWorkflowTrackReferences(wf, trackSnapshot.registry)
    if (referenceErrors.length > 0) return { ok: false, errors: referenceErrors }

    const target = childEntry(directories.workflows, `${name}.yaml`)
    const temp = childEntry(
      directories.workflows,
      `${name}.yaml.tmp.${process.pid}.${randomUUID()}`,
    )
    let tempFd: number | undefined
    let tempIdentity: FileIdentity | undefined
    let committed = false
    try {
      assertWorkflowDirectoriesStillTrusted(directories)
      tempFd = openSync(
        temp.operation,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      )
      writeFileSync(tempFd, content, 'utf8')
      fsyncSync(tempFd)
      const tempStat = fstatSync(tempFd)
      if (!tempStat.isFile()) throw new Error(`workflow 临时目标不是可信普通文件: ${temp.lexical}`)
      tempIdentity = { dev: tempStat.dev, ino: tempStat.ino }
      assertEntryMatches(temp, tempIdentity, 'workflow 临时文件')

      const existing = lstatIfExists(target.operation)
      if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
        throw new Error(`workflow 写入目标不是可信普通文件: ${target.lexical}`)
      }
      const expectedTarget = existing ? { dev: existing.dev, ino: existing.ino } : undefined

      // 最终 syscall 紧前复核；fdPath 可用时 rename 两端都锚在同一已打开 workflows 目录。
      assertWorkflowDirectoriesStillTrusted(directories)
      assertTargetUnchanged(target, expectedTarget)
      assertEntryMatches(temp, tempIdentity, 'workflow 临时文件')
      renameSync(temp.operation, target.operation)
      committed = true
      // POSIX rename 成功即为原子 commit point。这里不再做会把“已提交成功”翻成失败的 pathname
      // 后置断言；同 UID 在 commit 后立即替换目标属于上方明确排除的并发攻击边界。
      return { ok: true }
    } catch (e) {
      if (!committed) cleanupOwnedTempFile(temp, tempIdentity, directories)
      throw e
    } finally {
      if (tempFd !== undefined) safeClose(tempFd)
    }
  })
}

/**
 * 真删；不存在返回 false。目标以 O_NOFOLLOW 打开并绑定 inode，unlink 紧前再次复核。
 * expected 提供时是扫描前 permit：扫描期间目标被替换/删除一律 CAS 冲突，绝不删后来出现的 inode。
 */
export function deleteWorkflowForApi(
  root: WorkflowRoot,
  name: string,
  permit?: WorkflowDeletePermit,
): boolean {
  assertWorkflowName(name)
  if (permit && permit.name !== name) {
    throw new WorkflowDeleteConflictError(`workflow 删除 permit 名称不匹配：${permit.name} != ${name}`)
  }
  return withWorkflowDirectories(root, false, () => false, (directories) => {
    const target = childEntry(directories.workflows, `${name}.yaml`)
    assertWorkflowDirectoriesStillTrusted(directories)
    let fd: number
    try {
      fd = openSync(target.operation, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        if (permit) throw new WorkflowDeleteConflictError(`workflow '${name}' 在引用扫描期间消失`)
        return false
      }
      throw e
    }
    try {
      const opened = fstatSync(fd)
      if (!opened.isFile()) throw new Error(`workflow 删除目标不安全（须为普通文件）: ${target.lexical}`)
      const expectedIdentity = { dev: opened.dev, ino: opened.ino }
      if (permit && !sameIdentity(opened, permit)) {
        throw new WorkflowDeleteConflictError(`workflow '${name}' 在引用扫描期间已被替换`)
      }
      assertEntryMatches(target, expectedIdentity, 'workflow 删除目标')

      // fdPath 可用时等价于以已打开父目录为锚执行 unlink；fallback 的同-principal 边界见上方注释。
      assertWorkflowDirectoriesStillTrusted(directories)
      assertEntryMatches(target, expectedIdentity, 'workflow 删除目标')
      unlinkSync(target.operation)
      return true
    } finally {
      safeClose(fd)
    }
  })
}
