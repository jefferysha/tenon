import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import {
  type LedgerContextBundlePreview,
  LedgerContextBundleError,
  type ObservedContextBundlePreview,
} from '@tenon/kernel'
import { changeAreaSegments, type ChangeArea } from './changeArea.js'
import type { WorkflowRootAnchor } from './workflows.js'

const SCHEMA_VERSION = 'context-bundle-preview/v1'
const SIDE_EFFECTS = 'none'

interface PathIdentity {
  readonly path: string
  readonly dev: number
  readonly ino: number
  readonly mtimeNs?: bigint
  readonly ctimeNs?: bigint
}

export interface ChangePathAnchor {
  readonly changeDir: string
  readonly realPath: string
  readonly chain: readonly PathIdentity[]
}

export interface ChangeParentPathAnchor {
  readonly chain: readonly PathIdentity[]
  readonly missingPath?: string
}

export class ContextBundlePathError extends Error {
  constructor(
    readonly status: 400 | 403,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'ContextBundlePathError'
  }
}

function missingCode(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && Reflect.get(error, 'code') === 'ENOENT'
}

function inside(base: string, candidate: string): boolean {
  const fromBase = relative(base, candidate)
  return fromBase !== ''
    && fromBase !== '..'
    && !fromBase.startsWith(`..${sep}`)
    && !isAbsolute(fromBase)
}

function captureDirectoryIdentity(path: string): PathIdentity {
  const info = lstatSync(path, { bigint: true })
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new ContextBundlePathError(403, `Context Bundle 路径不安全（须为真实目录）: ${path}`)
  }
  return {
    path,
    dev: Number(info.dev),
    ino: Number(info.ino),
    mtimeNs: info.mtimeNs,
    ctimeNs: info.ctimeNs,
  }
}

export function captureChangeParentPathAnchor(root: WorkflowRootAnchor): ChangeParentPathAnchor {
  const chain: PathIdentity[] = []
  for (const path of [join(root.path, 'openspec'), join(root.path, 'openspec', 'changes')]) {
    try {
      chain.push(captureDirectoryIdentity(path))
    } catch (error) {
      if (missingCode(error)) return { chain, missingPath: path }
      throw error
    }
  }
  return { chain }
}

/**
 * 一个任务目录的路径身份链：从 `openspec/` 到任务目录，逐级都必须是真目录（符号链接一律拒绝），且真实路径在登记的根内。
 * `area: 'archive'` 把任务放在 `openspec/changes/archive/` 下（已结束任务，只读读取）。
 */
export function captureChangePathAnchor(
  root: WorkflowRootAnchor,
  change: string,
  area: ChangeArea = 'active',
): ChangePathAnchor {
  const chainPaths: string[] = []
  let level = root.path
  for (const segment of [...changeAreaSegments(area), change]) {
    level = join(level, segment)
    chainPaths.push(level)
  }
  const chain: PathIdentity[] = []
  for (const path of chainPaths) {
    try {
      chain.push(captureDirectoryIdentity(path))
    } catch (error) {
      if (missingCode(error)) {
        throw new ContextBundlePathError(400, '找不到该 Change 的 canonical workflow state')
      }
      throw error
    }
  }
  const changeDir = chainPaths.at(-1)
  if (changeDir === undefined) {
    throw new ContextBundlePathError(403, 'Context Bundle Change path capture failed')
  }
  let realPath: string
  try {
    realPath = realpathSync(changeDir)
  } catch (cause) {
    throw new ContextBundlePathError(
      403,
      `Context Bundle Change 路径在读取前被替换: ${changeDir}`,
      cause,
    )
  }
  if (!inside(root.realPath, realPath)) {
    throw new ContextBundlePathError(403, `Context Bundle Change 路径逃逸 registered root: ${realPath}`)
  }
  return { changeDir, realPath, chain }
}

function assertPathIdentityChain(chain: readonly PathIdentity[]): void {
  for (const expected of chain) {
    let actual
    try {
      actual = lstatSync(expected.path, { bigint: true })
    } catch {
      throw new ContextBundlePathError(403, `Context Bundle Change 路径在读取期间消失: ${expected.path}`)
    }
    if (
      actual.isSymbolicLink()
      || !actual.isDirectory()
      || Number(actual.dev) !== expected.dev
      || Number(actual.ino) !== expected.ino
      || (expected.mtimeNs !== undefined && actual.mtimeNs !== expected.mtimeNs)
      || (expected.ctimeNs !== undefined && actual.ctimeNs !== expected.ctimeNs)
    ) {
      throw new ContextBundlePathError(403, `Context Bundle Change 路径在读取期间被替换: ${expected.path}`)
    }
  }
}

export function assertChangePathAnchor(anchor: ChangePathAnchor): void {
  assertPathIdentityChain(anchor.chain)
  if (realpathSync(anchor.changeDir) !== anchor.realPath) {
    throw new ContextBundlePathError(403, `Context Bundle Change realpath 在读取期间变化: ${anchor.changeDir}`)
  }
}

export function assertChangeParentPathAnchor(anchor: ChangeParentPathAnchor): void {
  assertPathIdentityChain(anchor.chain)
  if (anchor.missingPath === undefined) return
  try {
    lstatSync(anchor.missingPath)
  } catch (error) {
    if (missingCode(error)) return
    throw new ContextBundlePathError(
      403,
      `Context Bundle Change parent 路径无法复核: ${anchor.missingPath}`,
      error,
    )
  }
  throw new ContextBundlePathError(
    403,
    `Context Bundle Change parent 路径在读取期间出现: ${anchor.missingPath}`,
  )
}

export function safeContextBundlePreview(
  preview: LedgerContextBundlePreview,
  fits: boolean,
  aggregateDigest?: string,
): Record<string, unknown> {
  return {
    schemaVersion: SCHEMA_VERSION,
    sideEffects: SIDE_EFFECTS,
    change: preview.change,
    from: preview.from,
    to: preview.to,
    tier: preview.tier,
    documentCount: preview.documentCount,
    budget: {
      maxBytes: preview.budget.maxBytes,
      usedBytes: preview.budget.usedBytes,
      fits,
    },
    inputs: preview.inputs.map((input) => ({
      kind: input.kind,
      path: input.path,
      digest: input.digest,
      reason: input.reason,
      reasonCode: input.reasonCode,
      mode: input.mode,
      sourceBytes: input.sourceBytes,
      materializedBytes: input.materializedBytes,
    })),
    ...(aggregateDigest === undefined ? {} : { aggregateDigest }),
  }
}

/**
 * 观察模式（新任务）的预览：包里是当前步骤的交接输入，没有文档种类——`kind` 固定为 `handoff`，原因点名上游步骤，
 * 另带上游步骤与来源技能；其余字段与契约模式同一个信封（schema / budget / aggregateDigest）。
 */
export function safeObservedContextBundlePreview(
  preview: ObservedContextBundlePreview,
  fits: boolean,
  aggregateDigest?: string,
): Record<string, unknown> {
  return {
    ...safeContextBundlePreview({ ...preview, inputs: [] }, fits, aggregateDigest),
    inputs: preview.inputs.map((input) => ({
      kind: 'handoff',
      path: input.path,
      digest: input.digest,
      reason: input.reason,
      reasonCode: 'context-bundle.reason.handoff',
      mode: input.mode,
      sourceBytes: input.sourceBytes,
      materializedBytes: input.materializedBytes,
      fromStep: input.fromStep,
      skill: input.skill,
    })),
  }
}

export function contextBundleErrorStatus(
  error: LedgerContextBundleError,
): 400 | 409 | 413 | 422 {
  switch (error.code) {
    case 'CONTEXT_BUNDLE_INVALID_REQUEST':
      return 400
    case 'CONTEXT_BUNDLE_STATE_CORRUPT':
    case 'CONTEXT_BUNDLE_LEDGER_MISSING':
    case 'CONTEXT_BUNDLE_DOCUMENT_MISSING':
    case 'CONTEXT_BUNDLE_DOCUMENT_STALE':
      return 409
    case 'CONTEXT_BUNDLE_RESOURCE_LIMIT_EXCEEDED':
      return 413
    case 'CONTEXT_BUNDLE_BUDGET_EXCEEDED':
      return 422
  }
  const unreachable: never = error.code
  return unreachable
}

export function safeContextBundleErrorText(error: LedgerContextBundleError): string {
  switch (error.code) {
    case 'CONTEXT_BUNDLE_INVALID_REQUEST':
      return 'Context Bundle request is invalid'
    case 'CONTEXT_BUNDLE_STATE_CORRUPT':
      return 'Context Bundle canonical state is corrupt'
    case 'CONTEXT_BUNDLE_LEDGER_MISSING':
      return 'Context Bundle document ledger is unavailable'
    case 'CONTEXT_BUNDLE_DOCUMENT_MISSING':
      return 'A required Context Bundle document is unavailable'
    case 'CONTEXT_BUNDLE_DOCUMENT_STALE':
      return 'A required Context Bundle document has changed'
    case 'CONTEXT_BUNDLE_RESOURCE_LIMIT_EXCEEDED':
      return 'Context Bundle source resource limit exceeded'
    case 'CONTEXT_BUNDLE_BUDGET_EXCEEDED':
      return 'Context Bundle materialized budget exceeded'
  }
}

export function safeContextBundleRepairAction(error: LedgerContextBundleError): string {
  switch (error.code) {
    case 'CONTEXT_BUNDLE_INVALID_REQUEST':
      return 'Use a registered root, safe identifiers, canonical target, and positive budget.'
    case 'CONTEXT_BUNDLE_STATE_CORRUPT':
      return 'Restore a valid canonical Change state, then retry.'
    case 'CONTEXT_BUNDLE_LEDGER_MISSING':
      return 'Initialize and record the document ledger, then retry.'
    case 'CONTEXT_BUNDLE_DOCUMENT_MISSING':
      return 'Restore or record the required project document, then retry.'
    case 'CONTEXT_BUNDLE_DOCUMENT_STALE':
      return 'Record and read the changed project document again, then retry.'
    case 'CONTEXT_BUNDLE_RESOURCE_LIMIT_EXCEEDED':
      return 'Reduce the number or source size of recorded documents, then retry.'
    case 'CONTEXT_BUNDLE_BUDGET_EXCEEDED':
      return 'Increase budgetBytes to the required materialized size, then retry.'
  }
}
