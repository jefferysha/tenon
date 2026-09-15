import { constants, fstatSync, openSync, readSync } from 'node:fs'
import { dirname, posix } from 'node:path'
import {
  LedgerContextBundleError,
  parseDocumentLedger,
  readValidatedTransitionHeadFromSync,
  RunStateCorruptError,
  type DocumentLedger,
  type LedgerContextBundleResourceLimits,
  type LedgerContextBundleSourceReadLimit,
  type LedgerContextBundleSourceReader,
  type PipelineState,
} from '@tenon/kernel'
import {
  assertDirectoryStillTrusted,
  assertEntryMatches,
  childEntry,
  safeClose,
  withTrustedDirectoryChain,
  type OpenDirectory,
  type WorkflowRootAnchor,
} from './workflowTrustedFs.js'

export interface TrustedChangeIdentity {
  readonly dev: number
  readonly ino: number
}

function safeParts(path: string): string[] {
  if (path === '' || path.startsWith('/') || path.includes('\\')) throw new Error('unsafe relative path')
  const parts = path.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error('unsafe relative path')
  }
  return parts
}

function decodeUtf8(bytes: Buffer): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
}

function isInvalidUtf8(error: unknown): boolean {
  return error instanceof TypeError
    && 'code' in error
    && error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA'
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && Reflect.get(error, 'code') === 'ENOENT'
}

export function readBounded(fd: number, maxBytes: number): Buffer {
  const chunks: Buffer[] = []
  let total = 0
  while (total <= maxBytes) {
    const remaining = maxBytes + 1 - total
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining))
    const bytesRead = readSync(fd, chunk, 0, chunk.byteLength, null)
    if (bytesRead === 0) break
    chunks.push(bytesRead === chunk.byteLength ? chunk : chunk.subarray(0, bytesRead))
    total += bytesRead
  }
  return Buffer.concat(chunks, total)
}

export class ContextBundleTrustedFileError extends Error {
  constructor(cause?: unknown) {
    super(
      'Context Bundle trusted file integrity check failed',
      cause === undefined ? undefined : { cause },
    )
    this.name = 'ContextBundleTrustedFileError'
  }
}

export function readTrustedFile(
  root: WorkflowRootAnchor,
  relativePath: string,
  maxBytes: number,
  readLimit?: LedgerContextBundleSourceReadLimit,
  changeIdentity?: TrustedChangeIdentity,
): { readonly text: string; readonly sourceBytes: number } {
  const parts = safeParts(relativePath)
  const name = parts.at(-1)
  if (name === undefined) throw new Error('missing file name')
  const directories = parts.slice(0, -1)
  const expectedChange = changeIdentity
    && parts[0] === 'openspec'
    && parts[1] === 'changes'
    ? { depth: 2, identity: changeIdentity }
    : undefined
  try {
    return withTrustedDirectoryChain(root, directories, false, () => {
      throw new LedgerContextBundleError(
        'CONTEXT_BUNDLE_DOCUMENT_MISSING',
        `Context Bundle document directory is missing: ${dirname(relativePath)}`,
        { path: relativePath, repairAction: '恢复项目内可信普通文件并重新 record/read' },
      )
    }, (directory: OpenDirectory) => {
      const paths = childEntry(directory, name)
      assertDirectoryStillTrusted(directory, root)
      let fd: number
      try {
        // O_NONBLOCK is a security/liveness boundary, not a performance hint: opening a FIFO
        // read-only otherwise blocks the single Node event loop before fstat can reject it.
        fd = openSync(
          paths.operation,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        )
      } catch (error) {
        if (isMissing(error)) {
          throw new LedgerContextBundleError(
            'CONTEXT_BUNDLE_DOCUMENT_MISSING',
            `Context Bundle document is missing: ${relativePath}`,
            { path: relativePath, repairAction: '恢复项目内可信普通文件并重新 record/read' },
          )
        }
        throw new ContextBundleTrustedFileError(error)
      }
      try {
        const opened = fstatSync(fd)
        if (!opened.isFile()) throw new ContextBundleTrustedFileError()
        const identity = { dev: opened.dev, ino: opened.ino }
        assertEntryMatches(paths, identity, 'Context Bundle source')
        assertDirectoryStillTrusted(directory, root)
        if (opened.size > maxBytes) {
          const metric = readLimit?.metric ?? 'sourceBytesPerDocument'
          const limit = readLimit?.limit ?? maxBytes
          const actual = (readLimit?.actualOffset ?? 0) + opened.size
          throw new LedgerContextBundleError(
            'CONTEXT_BUNDLE_RESOURCE_LIMIT_EXCEEDED',
            `Context Bundle resource limit exceeded: ${metric}=${actual}, limit=${limit}`,
            {
              path: relativePath,
              metric,
              limit,
              actual,
              repairAction: '拆分过大的治理文档后重试',
            },
          )
        }
        const bytes = readBounded(fd, maxBytes)
        if (bytes.byteLength > maxBytes) {
          const metric = readLimit?.metric ?? 'sourceBytesPerDocument'
          const limit = readLimit?.limit ?? maxBytes
          const actual = (readLimit?.actualOffset ?? 0) + bytes.byteLength
          throw new LedgerContextBundleError(
            'CONTEXT_BUNDLE_RESOURCE_LIMIT_EXCEEDED',
            `Context Bundle resource limit exceeded: ${metric}>${limit}`,
            {
              path: relativePath,
              metric,
              limit,
              actual,
              repairAction: '拆分过大的治理文档后重试',
            },
          )
        }
        assertEntryMatches(paths, identity, 'Context Bundle source')
        assertDirectoryStillTrusted(directory, root)
        return { text: decodeUtf8(bytes), sourceBytes: bytes.byteLength }
      } finally {
        safeClose(fd)
      }
    }, expectedChange)
  } catch (error) {
    if (isInvalidUtf8(error)) throw error
    if (error instanceof LedgerContextBundleError || error instanceof ContextBundleTrustedFileError) {
      throw error
    }
    throw new ContextBundleTrustedFileError(error)
  }
}

export interface TrustedContextBundleStateSnapshot {
  readonly phase: string
  readonly revisionId: string
  readonly stateDigest: string
  /** Canonical state the plan (and its document policy) is resolved from. */
  readonly state: PipelineState
}

export function trustedContextBundleCurrentSnapshot(
  root: WorkflowRootAnchor,
  change: string,
  changeIdentity: TrustedChangeIdentity,
): TrustedContextBundleStateSnapshot {
  const prefix = posix.join('openspec', 'changes', change)
  let current
  try {
    current = readValidatedTransitionHeadFromSync((relativePath) => {
      try {
        return readTrustedFile(
          root,
          posix.join(prefix, relativePath),
          1_048_576,
          undefined,
          changeIdentity,
        ).text
      } catch (error) {
        if (
          error instanceof LedgerContextBundleError
          && error.code === 'CONTEXT_BUNDLE_DOCUMENT_MISSING'
        ) return undefined
        throw error
      }
    })?.current
  } catch (error) {
    if (
      error instanceof RunStateCorruptError
      || error instanceof ContextBundleTrustedFileError
      || isInvalidUtf8(error)
    ) {
      throw new LedgerContextBundleError(
        'CONTEXT_BUNDLE_STATE_CORRUPT',
        'Context Bundle canonical state is corrupt',
        { cause: error, repairAction: '恢复有效的 canonical Change state 后重试' },
      )
    }
    throw error
  }
  const phase = current?.state.fields.phase
  if (typeof phase !== 'string' || !/^[A-Za-z0-9_-]+$/.test(phase)) {
    throw new LedgerContextBundleError(
      'CONTEXT_BUNDLE_STATE_CORRUPT',
      'Context Bundle canonical state has no safe current phase',
      { repairAction: '恢复有效的 canonical Change state 后重试' },
    )
  }
  if (current === undefined) {
    throw new LedgerContextBundleError(
      'CONTEXT_BUNDLE_STATE_CORRUPT',
      'Context Bundle canonical state is unavailable',
      { repairAction: '恢复有效的 canonical Change state 后重试' },
    )
  }
  return {
    phase,
    revisionId: current.revisionId,
    stateDigest: current.stateDigest,
    state: current.state,
  }
}

export function trustedContextBundleCurrentPhase(
  root: WorkflowRootAnchor,
  change: string,
  changeIdentity: TrustedChangeIdentity,
): string {
  return trustedContextBundleCurrentSnapshot(root, change, changeIdentity).phase
}

export function trustedContextBundleInputs(
  root: WorkflowRootAnchor,
  change: string,
  changeIdentity: TrustedChangeIdentity,
  limits: LedgerContextBundleResourceLimits,
): { readonly ledger: DocumentLedger; readonly sourceReader: LedgerContextBundleSourceReader } {
  const ledgerPath = posix.join('openspec', 'changes', change, '.pipeline-documents.json')
  let ledgerSource: { readonly text: string; readonly sourceBytes: number }
  try {
    ledgerSource = readTrustedFile(root, ledgerPath, 16 * 1024 * 1024, undefined, changeIdentity)
  } catch (error) {
    if (
      error instanceof LedgerContextBundleError
      && error.code === 'CONTEXT_BUNDLE_DOCUMENT_MISSING'
    ) {
      throw new LedgerContextBundleError(
        'CONTEXT_BUNDLE_LEDGER_MISSING',
        'Context Bundle document ledger is unavailable',
        {
          cause: error,
          path: ledgerPath,
          repairAction: '初始化并重新登记 document ledger 后重试',
        },
      )
    }
    if (
      error instanceof LedgerContextBundleError
      && error.code === 'CONTEXT_BUNDLE_RESOURCE_LIMIT_EXCEEDED'
    ) {
      throw new LedgerContextBundleError(
        'CONTEXT_BUNDLE_LEDGER_MISSING',
        'Context Bundle document ledger exceeds the trusted transport cap',
        { cause: error, path: ledgerPath, repairAction: '精简或修复 document ledger 后重试' },
      )
    }
    if (isInvalidUtf8(error)) {
      throw new LedgerContextBundleError(
        'CONTEXT_BUNDLE_LEDGER_MISSING',
        'Context Bundle document ledger is malformed',
        { cause: error, path: ledgerPath, repairAction: '修复并重新登记 document ledger 后重试' },
      )
    }
    if (error instanceof ContextBundleTrustedFileError) {
      throw new LedgerContextBundleError(
        'CONTEXT_BUNDLE_LEDGER_MISSING',
        'Context Bundle document ledger failed integrity checks',
        { cause: error, path: ledgerPath, repairAction: '修复并重新登记 document ledger 后重试' },
      )
    }
    throw error
  }
  let ledger: DocumentLedger
  try {
    ledger = parseDocumentLedger(ledgerSource.text)
  } catch (cause) {
    throw new LedgerContextBundleError(
      'CONTEXT_BUNDLE_LEDGER_MISSING',
      'Context Bundle document ledger is malformed',
      { cause, path: ledgerPath, repairAction: '修复并重新登记 document ledger 后重试' },
    )
  }
  return {
    ledger,
    sourceReader: {
      read: async (path, readLimit) => readTrustedFile(
        root,
        path,
        readLimit?.maxBytes ?? limits.maxSourceBytesPerDocument,
        readLimit,
        changeIdentity,
      ),
    },
  }
}
