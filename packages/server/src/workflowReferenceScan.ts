import { constants, fstatSync, openSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  FIELD_ORDER,
  listAutomationPolicyTemplates,
  loadRegistry,
  parsePipeline,
  readCurrentRunRevisionFromSync,
  resolveWorkflowName,
  unquoteScalar,
} from '@tenon/kernel'
import {
  assertDirectoryStillTrusted,
  assertEntryMatches,
  assertWorkflowName,
  assertWorkflowRootAnchor,
  childEntry,
  errText,
  isWorkflowName,
  openTrustedChildDirectory,
  safeClose,
  withTrustedDirectoryChain,
  type OpenDirectory,
  type WorkflowReference,
  type WorkflowReferenceScanBlocker,
  type WorkflowReferenceScanResult,
  type WorkflowRootAnchor,
} from './workflowTrustedFs.js'

function decodeUtf8Strict(bytes: Buffer, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    throw new Error(`${label} 不是合法 UTF-8：${errText(error)}`)
  }
}

function readTrustedRegularFile(
  directory: OpenDirectory,
  root: WorkflowRootAnchor,
  name: string,
  label: string,
  missing: 'null' | 'error',
): Buffer | null {
  const paths = childEntry(directory, name)
  assertDirectoryStillTrusted(directory, root)
  let fd: number
  try {
    fd = openSync(paths.operation, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && missing === 'null') return null
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`${label} 缺失: ${paths.lexical}`)
    throw error
  }
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile()) throw new Error(`${label} 不是可信普通文件: ${paths.lexical}`)
    const identity = { dev: opened.dev, ino: opened.ino }
    assertEntryMatches(paths, identity, label)
    assertDirectoryStillTrusted(directory, root)
    const bytes = readFileSync(fd)
    assertEntryMatches(paths, identity, label)
    assertDirectoryStillTrusted(directory, root)
    return bytes
  } finally {
    safeClose(fd)
  }
}

function collectPolicyTemplateReferences(workflow: string): WorkflowReference[] {
  return listAutomationPolicyTemplates()
    .filter((template) => template.recommendedWorkflow === workflow)
    .map((template) => ({
      kind: 'policy-template-recommended' as const,
      source: `template:${template.id}`,
    }))
}

function validateStateWorkflowText(text: string, change: string): string {
  if (text.includes('\0')) throw new Error('state 含 NUL 字节')
  const counts = new Map<string, number>()
  const workflowValues: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_]+):(.*)$/.exec(line)
    if (!match) continue
    const field = match[1]
    const scalar = match[2]
    if (field === undefined || scalar === undefined) continue
    counts.set(field, (counts.get(field) ?? 0) + 1)
    if (field === 'workflow') workflowValues.push(unquoteScalar(scalar.trim()))
  }
  for (const required of ['track', 'phase']) {
    if (counts.get(required) !== 1) {
      throw new Error(`state.${required} 须且只能出现一次（实际 ${counts.get(required) ?? 0}）`)
    }
  }
  const workflowCount = counts.get('workflow') ?? 0
  if (workflowCount > 1) throw new Error(`state.workflow 重复（${workflowCount} 次）`)

  const state = parsePipeline(text)
  const knownFields = new Set<string>(FIELD_ORDER)
  const hiddenKnownFields = state.opaqueTail.split(/\r?\n/)
    .map((line) => /^([A-Za-z0-9_]+):/.exec(line)?.[1])
    .filter((field): field is string => field !== undefined && knownFields.has(field))
  if (hiddenKnownFields.length > 0) {
    throw new Error(`state parser 在已知字段前提前停止；opaqueTail 隐藏字段: ${hiddenKnownFields.join(', ')}`)
  }
  const raw = state.fields.workflow
  if (Array.isArray(raw)) throw new Error('state.workflow 非标量')
  if (workflowValues.length === 1 && workflowValues[0] !== raw) {
    throw new Error(`state.workflow 原文字段 '${workflowValues[0]}' 未被 parser 消费（解析值 '${raw}'）`)
  }
  const workflow = resolveWorkflowName(state)
  if (workflow !== 'default' && !isWorkflowName(workflow)) {
    throw new Error(`state.workflow 非法: change '${change}' = '${workflow}'`)
  }
  return workflow
}

/**
 * 以 change 目录 fd 为锚读取 canonical state 的受控相对文件。每一层目录都拒绝 symlink，最终
 * 文件用 O_NOFOLLOW；reader 返回 undefined 只代表目录项不存在，安全/I/O 异常原样 fail-loud。
 */
function readTrustedChangeRelativeText(
  changeDir: OpenDirectory,
  root: WorkflowRootAnchor,
  relativePath: string,
): string | undefined {
  const parts = relativePath.split(/[\\/]/).filter((part) => part !== '')
  if (parts.length === 0 || parts.some((part) => part === '.' || part === '..')) {
    throw new Error(`canonical state reader 收到非法相对路径: ${relativePath}`)
  }
  const opened: OpenDirectory[] = []
  let parent = changeDir
  try {
    for (const part of parts.slice(0, -1)) {
      const next = openTrustedChildDirectory(root, parent, part, false)
      if (next === undefined) return undefined
      opened.push(next)
      parent = next
    }
    const fileName = parts.at(-1)
    if (fileName === undefined) throw new Error(`canonical state reader 收到空路径: ${relativePath}`)
    const bytes = readTrustedRegularFile(
      parent, root, fileName, `canonical state ${relativePath}`, 'null',
    )
    return bytes === null ? undefined : decodeUtf8Strict(bytes, `canonical state ${relativePath}`)
  } finally {
    for (const directory of opened.reverse()) safeClose(directory.fd)
  }
}

function scanActiveChangeReferences(
  root: WorkflowRootAnchor,
  workflow: string,
): { references: WorkflowReference[]; blockers: WorkflowReferenceScanBlocker[] } {
  const references: WorkflowReference[] = []
  const blockers: WorkflowReferenceScanBlocker[] = []
  try {
    return withTrustedDirectoryChain(root, ['openspec', 'changes'], false, () => ({ references, blockers }), (changes) => {
      assertDirectoryStillTrusted(changes, root)
      const entries = readdirSync(changes.fdPath ?? changes.lexicalPath, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of entries) {
        if (entry.name === 'archive') {
          try {
            const archive = openTrustedChildDirectory(root, changes, entry.name, false)
            if (!archive) throw new Error('archive 在枚举后消失')
            safeClose(archive.fd)
          } catch (error) {
            blockers.push({ source: 'changes:archive', detail: errText(error) })
          }
          continue
        }
        const source = `change:${entry.name}`
        if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[a-zA-Z0-9_-]+$/.test(entry.name) || entry.name.includes('..')) {
          blockers.push({ source, detail: '活跃 changes 枚举项必须是安全命名的非 symlink 目录' })
          continue
        }
        let changeDir: OpenDirectory | undefined
        try {
          changeDir = openTrustedChildDirectory(root, changes, entry.name, false)
          if (!changeDir) throw new Error('change 在枚举后消失')
          const capturedChangeDir = changeDir
          const canonical = readCurrentRunRevisionFromSync(
            (relativePath) => readTrustedChangeRelativeText(capturedChangeDir, root, relativePath),
            capturedChangeDir.lexicalPath,
          )
          let observed: string
          if (canonical !== undefined) {
            observed = resolveWorkflowName(canonical.state)
            if (observed !== 'default'
              && !isWorkflowName(observed)) {
              throw new Error(`canonical state.workflow 非法: change '${entry.name}' = '${observed}'`)
            }
          } else {
            const bytes = readTrustedRegularFile(changeDir, root, '.pipeline.yaml', 'legacy change state', 'error')
            if (!bytes) throw new Error('change state 缺失')
            observed = validateStateWorkflowText(decodeUtf8Strict(bytes, 'legacy change state'), entry.name)
          }
          if (observed === workflow) references.push({ kind: 'active-change', source })
        } catch (error) {
          blockers.push({ source, detail: errText(error) })
        } finally {
          if (changeDir) safeClose(changeDir.fd)
        }
      }
      assertDirectoryStillTrusted(changes, root)
      return { references, blockers }
    })
  } catch (error) {
    blockers.push({ source: 'changes', detail: errText(error) })
    return { references, blockers }
  }
}

function scanLoopReferences(
  root: WorkflowRootAnchor,
  workflow: string,
): { references: WorkflowReference[]; blockers: WorkflowReferenceScanBlocker[] } {
  const references: WorkflowReference[] = []
  const blockers: WorkflowReferenceScanBlocker[] = []
  try {
    return withTrustedDirectoryChain(root, ['.pipeline'], false, () => ({ references, blockers }), (pipeline) => {
      const bytes = readTrustedRegularFile(pipeline, root, 'loops.yaml', 'loops registry', 'null')
      if (!bytes) return { references, blockers }
      const text = decodeUtf8Strict(bytes, 'loops registry')
      const loaded = loadRegistry(root.path, { readText: () => text })
      if (loaded.errors.length > 0 || !loaded.data) {
        blockers.push({
          source: 'loops-registry',
          detail: loaded.errors.length > 0 ? loaded.errors.join('；') : 'loops registry 无法形成有效快照',
        })
        return { references, blockers }
      }
      for (const loop of loaded.data.loops) {
        if (loop.workflow_id === workflow) references.push({ kind: 'loop-binding', source: `loop:${loop.id}` })
      }
      return { references, blockers }
    })
  } catch (error) {
    blockers.push({ source: 'loops-registry', detail: errText(error) })
    return { references, blockers }
  }
}

/**
 * 调用方必须已持 governance → project coordination 两把锁。函数在同一临界区内读 strict active
 * changes 与 loops workflow_id，并合入进程内 policy-template catalog；I/O/解析不确定性进入
 * blockers，绝不降级成“零引用”。轨道是工作流自己的分支，没有别的资源按名字引用一个工作流。
 */
export function scanWorkflowReferencesForApi(
  root: WorkflowRootAnchor,
  workflow: string,
): WorkflowReferenceScanResult {
  assertWorkflowName(workflow)
  assertWorkflowRootAnchor(root)
  const changes = scanActiveChangeReferences(root, workflow)
  const loops = scanLoopReferences(root, workflow)
  return {
    references: [
      ...collectPolicyTemplateReferences(workflow),
      ...changes.references,
      ...loops.references,
    ]
      .sort((a, b) => a.source.localeCompare(b.source) || a.kind.localeCompare(b.kind)),
    blockers: [...changes.blockers, ...loops.blockers]
      .sort((a, b) => a.source.localeCompare(b.source) || a.detail.localeCompare(b.detail)),
  }
}

/** 扫描前钉住目标 inode；不存在返回 null。 */
