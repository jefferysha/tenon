/**
 * 项目级与用户级指令文件（AGENTS.md / CLAUDE.md / GEMINI.md …）的读取、预览、应用、删除。
 *
 * - 项目级：已注册项目根目录下的三个文件，锚点来自注册表（workflowRootForRequest）。
 * - 用户级：各宿主文档化的用户级文件（kernel userInstructionPath），受信根为宿主 home、`$CODEX_HOME` 或 `%APPDATA%`。
 * - Tenon 受管块（`<!-- PIPELINE:<TAG>:START -->`）在编辑时不出现在正文里，应用时原样接回文件末尾；
 *   标记无效的文件拒绝写入。每次写入都带客户端最后看到的摘要，外部修改过就 409，不覆盖。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  INSTRUCTION_HOSTS, PROJECT_INSTRUCTION_FILES, containsManagedMarker, contentAfterDelete, hasUserInstructionFile,
  mergeManagedBlocks, parseManagedBlocks, userInstructionPath, zedEffectiveFile,
  type ManagedBlock,
} from '@tenon/kernel'
import {
  readTrustedFile, trustedFsFailure, unlinkTrustedFile, writeTrustedFile, type TargetFileError,
} from './instructionTrustedFs.js'
import {
  captureWorkflowRootAnchor, closeWorkflowRootAnchor, lstatIfExists, type WorkflowRootAnchor,
} from './workflowRootAnchor.js'

export const INSTRUCTION_TEXT_MAX_BYTES = 256 * 1024

export type InstructionScope =
  | { readonly level: 'project'; readonly anchor: WorkflowRootAnchor }
  | {
      readonly level: 'user'
      readonly homeDir: string
      readonly env: Readonly<Record<string, string | undefined>>
      readonly platform: NodeJS.Platform
    }

export interface InstructionResult { readonly status: number; readonly body: unknown }

type TargetError = 'managed-block-invalid' | TargetFileError | 'path-unsafe'

interface Location { readonly root: WorkflowRootAnchor | null; readonly owned: boolean; readonly dirs: readonly string[]; readonly name: string; readonly path: string }

interface CurrentFile { readonly bytes: Buffer | null; readonly digest: string; readonly text: string; readonly blocks: readonly ManagedBlock[] }

const fail = (status: number, code: string, error: string, extra: Record<string, unknown> = {}): InstructionResult =>
  ({ status, body: { ok: false, code, error, ...extra } })

export function targetIdsFor(scope: InstructionScope): string[] {
  return scope.level === 'project'
    ? [...PROJECT_INSTRUCTION_FILES]
    : INSTRUCTION_HOSTS.map((host) => host.id).filter((id) => hasUserInstructionFile(id))
}

function captureRoot(path: string, create: boolean): WorkflowRootAnchor | null {
  if (!lstatIfExists(path)) {
    if (!create) return null
    mkdirSync(path, { recursive: true })
  }
  return captureWorkflowRootAnchor(path)
}

function locate(scope: InstructionScope, id: string, create: boolean): Location | null {
  if (!targetIdsFor(scope).includes(id)) return null
  if (scope.level === 'project') return { root: scope.anchor, owned: false, dirs: [], name: id, path: join(scope.anchor.path, id) }
  const segments = userInstructionPath(id, scope)
  const [rootPath, ...rest] = segments ?? []
  const name = rest.at(-1)
  if (rootPath === undefined || name === undefined) return null
  return { root: captureRoot(rootPath, create), owned: true, dirs: rest.slice(0, -1), name, path: join(rootPath, ...rest) }
}

function release(location: Location): void {
  if (location.owned && location.root) closeWorkflowRootAnchor(location.root)
}

function withLocation<T>(scope: InstructionScope, id: string, create: boolean, use: (location: Location) => T): T | null {
  const location = locate(scope, id, create)
  if (!location) return null
  try {
    return use(location)
  } finally {
    release(location)
  }
}

/** 读当前文件并拆出受管块；返回错误码时不可写。 */
function readCurrent(location: Location): CurrentFile | { error: TargetError } {
  if (!location.root) return { bytes: null, digest: 'absent', text: '', blocks: [] }
  const read = readTrustedFile(location.root, location.dirs, location.name, INSTRUCTION_TEXT_MAX_BYTES)
  if (read.error) return { error: read.error }
  if (read.bytes === null) return { bytes: null, digest: read.digest, text: '', blocks: [] }
  const raw = read.bytes.toString('utf8')
  const parsed = parseManagedBlocks(raw)
  if (!parsed.ok) return { error: 'managed-block-invalid' }
  return { bytes: read.bytes, digest: read.digest, text: parsed.userText, blocks: parsed.blocks }
}

function targetState(scope: InstructionScope, id: string): Record<string, unknown> {
  const base = { id, path: '', exists: false, digest: 'absent', text: '', managed: [] as { tag: string }[], bytes: 0 }
  try {
    const state = withLocation(scope, id, false, (location) => {
      const current = readCurrent(location)
      if ('error' in current) return { ...base, path: location.path, exists: true, error: current.error }
      return {
        ...base, path: location.path, exists: current.bytes !== null, digest: current.digest, text: current.text,
        managed: current.blocks.map((block) => ({ tag: block.tag })), bytes: current.bytes?.length ?? 0, error: null,
      }
    })
    return state ?? { ...base, error: 'path-unsafe' }
  } catch {
    return { ...base, error: 'path-unsafe' }
  }
}

export function readInstructionTargets(scope: InstructionScope): InstructionResult {
  const hosts = INSTRUCTION_HOSTS.map((host) => {
    if (scope.level === 'user') return { id: host.id, levels: host.levels, target: hasUserInstructionFile(host.id) ? host.id : null }
    const row = { id: host.id, levels: host.levels, target: host.projectFile }
    if (host.id !== 'zed') return row
    return { ...row, effective_file: zedEffectiveFile((file) => lstatIfExists(join(scope.anchor.path, file)) !== undefined) }
  })
  return {
    status: 200,
    body: {
      ok: true, level: scope.level, root: scope.level === 'project' ? scope.anchor.path : '',
      hosts, targets: targetIdsFor(scope).map((id) => targetState(scope, id)),
    },
  }
}

function checkText(text: unknown): string | InstructionResult {
  if (typeof text !== 'string') return fail(400, 'invalid', 'text 必须是字符串')
  if (Buffer.byteLength(text, 'utf8') > INSTRUCTION_TEXT_MAX_BYTES) return fail(413, 'too-large', `超过 ${INSTRUCTION_TEXT_MAX_BYTES} 字节`)
  if (containsManagedMarker(text)) return fail(400, 'managed-marker-in-text', '正文不能包含 Tenon 受管块标记行')
  return text
}

const currentFailure = (id: string, error: TargetError): InstructionResult => fail(409, error, '指令文件不可写', { id })

export function previewInstructionApply(scope: InstructionScope, rawText: unknown, targetIds: readonly string[]): InstructionResult {
  const text = checkText(rawText)
  if (typeof text !== 'string') return text
  if (targetIds.length === 0 || new Set(targetIds).size !== targetIds.length) return fail(400, 'invalid-target', '目标文件不合法')
  try {
    const files: Record<string, unknown>[] = []
    for (const id of targetIds) {
      const preview = withLocation(scope, id, false, (location): InstructionResult | Record<string, unknown> => {
        const current = readCurrent(location)
        if ('error' in current) return currentFailure(id, current.error)
        return {
          id, path: location.path, base_digest: current.digest,
          current: current.bytes === null ? null : current.bytes.toString('utf8'),
          next: mergeManagedBlocks(text, current.blocks),
        }
      })
      if (preview === null) return fail(400, 'invalid-target', `未知目标：${id}`)
      if ('status' in preview && 'body' in preview) return preview as InstructionResult
      files.push(preview)
    }
    return { status: 200, body: { ok: true, files } }
  } catch (error) {
    return trustedFsFailure(error)
  }
}

export function applyInstructions(
  scope: InstructionScope, rawText: unknown, targets: readonly { id: string; base_digest: string }[],
): InstructionResult {
  const text = checkText(rawText)
  if (typeof text !== 'string') return text
  const ids = targets.map((target) => target.id)
  if (ids.length === 0 || new Set(ids).size !== ids.length) return fail(400, 'invalid-target', '目标文件不合法')
  const unknown = ids.find((id) => !targetIdsFor(scope).includes(id))
  if (unknown !== undefined) return fail(400, 'invalid-target', `未知目标：${unknown}`)
  // 先全部核对摘要与标记，任何一个不符都不写。
  const planned: { id: string; base: string; next: string }[] = []
  try {
    for (const target of targets) {
      const checked = withLocation(scope, target.id, false, (location): InstructionResult | 'ok' => {
        const current = readCurrent(location)
        if ('error' in current) return currentFailure(target.id, current.error)
        if (current.digest !== target.base_digest) {
          return fail(409, 'instruction-file-changed', '文件已被外部修改', { id: target.id, digest: current.digest })
        }
        planned.push({ id: target.id, base: current.digest, next: mergeManagedBlocks(text, current.blocks) })
        return 'ok'
      })
      if (checked === null) return fail(400, 'invalid-target', `未知目标：${target.id}`)
      if (checked !== 'ok') return checked
    }
  } catch (error) {
    return trustedFsFailure(error)
  }
  const written: { id: string; digest: string }[] = []
  for (const plan of planned) {
    try {
      const result = withLocation(scope, plan.id, true, (location) => {
        if (!location.root) throw new Error('受信根目录不可用')
        return writeTrustedFile(location.root, location.dirs, location.name, plan.next, plan.base, INSTRUCTION_TEXT_MAX_BYTES)
      })
      if (result?.ok) {
        written.push({ id: plan.id, digest: result.digest })
        continue
      }
      if (written.length === 0) {
        return result && result.code === 'changed'
          ? fail(409, 'instruction-file-changed', '文件已被外部修改', { id: plan.id, digest: result.digest })
          : fail(409, result?.code ?? 'path-unsafe', '指令文件不可写', { id: plan.id })
      }
      return fail(500, 'instruction-apply-partial', '部分文件已写入', { written: written.map((entry) => entry.id), failed: plan.id })
    } catch (error) {
      if (written.length === 0) return trustedFsFailure(error)
      return fail(500, 'instruction-apply-partial', '部分文件已写入', { written: written.map((entry) => entry.id), failed: plan.id })
    }
  }
  return { status: 200, body: { ok: true, files: written } }
}

export function deleteInstructionTarget(scope: InstructionScope, targetId: string, digest: string): InstructionResult {
  try {
    const result = withLocation(scope, targetId, false, (location): InstructionResult => {
      const current = readCurrent(location)
      if ('error' in current) return currentFailure(targetId, current.error)
      if (current.bytes === null || !location.root) return fail(404, 'instruction-file-missing', '文件不存在', { id: targetId })
      if (current.digest !== digest) return fail(409, 'instruction-file-changed', '文件已被外部修改', { id: targetId, digest: current.digest })
      const remaining = contentAfterDelete(current.blocks)
      if (remaining === null) {
        const removed = unlinkTrustedFile(location.root, location.dirs, location.name, digest, INSTRUCTION_TEXT_MAX_BYTES)
        if (removed.ok) return { status: 200, body: { ok: true, result: 'removed' } }
        return removed.code === 'changed'
          ? fail(409, 'instruction-file-changed', '文件已被外部修改', { id: targetId, digest: removed.digest })
          : fail(409, removed.code, '指令文件不可删除', { id: targetId })
      }
      const kept = writeTrustedFile(location.root, location.dirs, location.name, remaining, digest, INSTRUCTION_TEXT_MAX_BYTES)
      if (kept.ok) return { status: 200, body: { ok: true, result: 'managed-kept' } }
      return kept.code === 'changed'
        ? fail(409, 'instruction-file-changed', '文件已被外部修改', { id: targetId, digest: kept.digest })
        : fail(409, kept.code, '指令文件不可写', { id: targetId })
    })
    return result ?? fail(400, 'invalid-target', `未知目标：${targetId}`)
  } catch (error) {
    return trustedFsFailure(error)
  }
}
