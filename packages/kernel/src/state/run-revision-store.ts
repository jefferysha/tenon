/**
 * G1 canonical WorkflowRun state.
 *
 * `.pipeline-run/current.json` is the N-1-compatible committed wire revision. The matching immutable
 * file under `revisions/` must contain identical bytes; post-v1 logical fields may be restored only
 * from revision-bound companion records. A current file that is malformed, fails its digest, or
 * lacks its immutable twin is corruption and never authorizes a YAML fallback.
 */
import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { lstat, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type PipelineState,
  type StateProjectionMetadata,
} from '../types.js'
import type { TransitionRecord } from '../workflow/run-types.js'
import { atomicLinkPublish, atomicReplaceFile } from './atomic-publish.js'
import { diffWireFieldsToEffects } from './run-metadata.js'
import {
  createRunRevision,
  parseRunRevision,
  serializeRunRevision,
  type RunRevision,
  type RunStateMutation,
} from './run-revision-codec.js'
import {
  RUN_STATE_SCHEMA_VERSION,
  RunStateCorruptError,
  UnsupportedRunStateVersionError,
} from './run-revision-validation.js'
import { TRANSITION_RECORDS_DIR } from './transition-record-store.js'
import { hydrateCompanions, hydrateCompanionsFromSync, publishCompanions } from './revision-companions.js'
import {
  assertDirectPredecessor,
  assertMutationEffects,
  assertTransitionRevisionLink,
} from './run-revision-continuity.js'
import {
  validateAnchoredTransitionHead,
  validateAnchoredTransitionHeadFromSync,
  withTransitionHeadAnchor,
} from './transition-head-anchor.js'

export {
  hookStateFor,
  type RunHookState,
  type RunRevision,
  type RunStateMutation,
} from './run-revision-codec.js'
export {
  RUN_STATE_SCHEMA_VERSION,
  RunStateCorruptError,
  UnsupportedRunStateVersionError,
} from './run-revision-validation.js'

export const RUN_STATE_DIR = '.pipeline-run'
export const RUN_CURRENT_FILE = 'current.json'
export const RUN_REVISIONS_DIR = 'revisions'
const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/

function errnoCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined
  const record = Object.fromEntries(Object.entries(error))
  return typeof record.code === 'string' ? record.code : undefined
}

/**
 * 同步生产入口（CLI 枚举、server 路由、SSE fingerprint）统一使用的状态来源选择。
 * current 只按“目录项存在”取得优先权：即使内容损坏也不能回退 YAML；真正读取时必须继续
 * 经过 canonical validator。只有 current 不存在时才兼容 legacy `.pipeline.yaml`。
 */
export function stateStorageSourcePathSync(changeDir: string): string | undefined {
  const current = join(changeDir, RUN_STATE_DIR, RUN_CURRENT_FILE)
  try {
    lstatSync(current)
    return current
  } catch (error) {
    if (errnoCode(error) !== 'ENOENT') throw error
  }
  const legacy = join(changeDir, '.pipeline.yaml')
  try {
    lstatSync(legacy)
    return legacy
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return undefined
    throw error
  }
}

export function stateStorageExistsSync(changeDir: string): boolean {
  return stateStorageSourcePathSync(changeDir) !== undefined
}

function previousRevisionIdFor(revision: RunRevision): string {
  if (revision.previousRevisionId === undefined) {
    throw new RunStateCorruptError('非初始 revision 缺 previousRevisionId')
  }
  return revision.previousRevisionId
}

function revisionFileName(revision: number, revisionId: string): string {
  return `${String(revision).padStart(6, '0')}-${revisionId}.json`
}

async function assertTransitionRecordFile(
  changeDir: string,
  revision: RunRevision,
  previous?: RunRevision,
): Promise<TransitionRecord | undefined> {
  if (revision.mutation.kind !== 'transition') return undefined
  const metadata = revision.state.runMetadata
  if (metadata === undefined || metadata.transitionHead === undefined || metadata.transitionSequence < 1) {
    throw new RunStateCorruptError('transition revision 缺 canonical run head/sequence')
  }
  const transitionPath = join(
    changeDir, TRANSITION_RECORDS_DIR,
    `${String(metadata.transitionSequence).padStart(6, '0')}-${revision.mutation.transitionRecordId}.json`,
  )
  const transitionRaw = await readRegularTextIfExists(transitionPath)
  if (transitionRaw === undefined) {
    throw new RunStateCorruptError('transition revision 引用的 TransitionRecord 缺失')
  }
  let transition: unknown
  try {
    transition = JSON.parse(transitionRaw)
  } catch (error) {
    throw new RunStateCorruptError(`TransitionRecord 损坏: ${String(error)}`)
  }
  assertTransitionRevisionLink(revision, transition, transitionRaw, previous)
  return transition as TransitionRecord
}

function assertTransitionRecordFromSync(
  readText: RunRevisionTextReader, revision: RunRevision, sourceRoot: string, previous?: RunRevision,
): TransitionRecord | undefined {
  if (revision.mutation.kind !== 'transition') return undefined
  const metadata = revision.state.runMetadata
  if (!metadata?.transitionHead || metadata.transitionSequence < 1) {
    throw new RunStateCorruptError('transition revision 缺 canonical run head/sequence')
  }
  const transitionRel = join(TRANSITION_RECORDS_DIR,
    `${String(metadata.transitionSequence).padStart(6, '0')}-${revision.mutation.transitionRecordId}.json`)
  const transitionRaw = readText(transitionRel)
  if (transitionRaw === undefined) throw new RunStateCorruptError('transition revision 引用的 TransitionRecord 缺失')
  try {
    const transition: unknown = JSON.parse(transitionRaw)
    assertTransitionRevisionLink(revision, transition, transitionRaw, previous)
    return transition as TransitionRecord
  } catch (error) {
    if (error instanceof RunStateCorruptError) throw error
    throw new RunStateCorruptError(
      `${join(sourceRoot, transitionRel)}: TransitionRecord 损坏: ${String(error)}`,
    )
  }
}

export function projectionMetadataFor(revision: RunRevision): StateProjectionMetadata {
  return {
    stateRevision: revision.revision,
    stateRevisionId: revision.revisionId,
    stateDigest: revision.stateDigest,
  }
}

export async function publishInitialRunRevision(
  changeDir: string,
  state: PipelineState,
  observedAt: string,
  kind: 'init' | 'migration' = 'init',
): Promise<RunRevision> {
  const runDir = join(changeDir, RUN_STATE_DIR)
  const revisionsDir = join(runDir, RUN_REVISIONS_DIR)
  await mkdir(revisionsDir, { recursive: true })
  const revision = createRunRevision({
    state,
    revision: 0,
    mutation: { kind, observedAt, effects: [] },
  })
  await publishCompanions(changeDir, revision, state)
  const raw = serializeRunRevision(revision)
  await atomicLinkPublish(
    revisionsDir,
    '.tmp',
    join(revisionsDir, revisionFileName(revision.revision, revision.revisionId)),
    raw,
  )
  await atomicLinkPublish(runDir, '.current.tmp', join(runDir, RUN_CURRENT_FILE), raw)
  return revision
}

export async function publishRunRevision(
  changeDir: string,
  current: RunRevision,
  state: PipelineState,
  mutation: Omit<RunStateMutation, 'effects' | 'transitionRecordDigest'>,
): Promise<RunRevision> {
  const runDir = join(changeDir, RUN_STATE_DIR)
  const revisionsDir = join(runDir, RUN_REVISIONS_DIR)
  await mkdir(revisionsDir, { recursive: true })
  let transitionRaw: string | undefined
  let transition: unknown
  let revisionState = state
  let mutationWithDigest: Omit<RunStateMutation, 'effects'> = mutation
  if (mutation.kind === 'transition') {
    const metadata = state.runMetadata
    if (metadata === undefined || metadata.transitionHead !== mutation.transitionRecordId
      || metadata.transitionSequence < 1) {
      throw new RunStateCorruptError('transition publish 缺匹配的 canonical run head/sequence')
    }
    const transitionPath = join(
      changeDir, TRANSITION_RECORDS_DIR,
      `${String(metadata.transitionSequence).padStart(6, '0')}-${mutation.transitionRecordId}.json`,
    )
    transitionRaw = await readRegularTextIfExists(transitionPath)
    if (transitionRaw === undefined) {
      throw new RunStateCorruptError('transition publish 引用的 TransitionRecord 缺失')
    }
    try {
      transition = JSON.parse(transitionRaw)
    } catch (error) {
      throw new RunStateCorruptError(`transition publish 的 TransitionRecord 损坏: ${String(error)}`)
    }
    mutationWithDigest = {
      ...mutation,
      transitionRecordDigest: createHash('sha256').update(transitionRaw).digest('hex'),
    }
    const transitionRecordDigest = mutationWithDigest.transitionRecordDigest
    if (transitionRecordDigest === undefined) {
      throw new RunStateCorruptError('transition publish 缺 TransitionRecord digest')
    }
    revisionState = withTransitionHeadAnchor(
      state,
      metadata,
      transitionRecordDigest,
    )
  }
  const revision = createRunRevision({
    state: revisionState,
    revision: current.revision + 1,
    previousRevisionId: current.revisionId,
    mutation: {
      ...mutationWithDigest,
      effects: diffWireFieldsToEffects(current.state.fields, state.fields),
    },
  })
  // Reject an invalid metadata/effects chain before publishing the companion or immutable bytes;
  // every successful publish must be readable by the same validator immediately.
  assertMutationEffects(revision, current)
  if (transitionRaw !== undefined) {
    assertTransitionRevisionLink(revision, transition, transitionRaw, current)
  }
  await publishCompanions(changeDir, revision, revisionState)
  const raw = serializeRunRevision(revision)
  await atomicLinkPublish(
    revisionsDir,
    '.tmp',
    join(revisionsDir, revisionFileName(revision.revision, revision.revisionId)),
    raw,
  )
  await atomicReplaceFile(join(runDir, RUN_CURRENT_FILE), raw)
  return revision
}

export async function readCurrentRunRevision(changeDir: string): Promise<RunRevision | undefined> {
  const currentPath = join(changeDir, RUN_STATE_DIR, RUN_CURRENT_FILE)
  const raw = await readRegularTextIfExists(currentPath)
  if (raw === undefined) return undefined
  const current = await hydrateCompanions(changeDir, parseRunRevision(raw, currentPath))
  const immutablePath = join(
    changeDir,
    RUN_STATE_DIR,
    RUN_REVISIONS_DIR,
    revisionFileName(current.revision, current.revisionId),
  )
  const immutableRaw = await readRegularTextIfExists(immutablePath)
  if (immutableRaw === undefined) {
    throw new RunStateCorruptError(`current 引用的 immutable revision 缺失: ${immutablePath}`)
  }
  await hydrateCompanions(changeDir, parseRunRevision(immutableRaw, immutablePath))
  if (immutableRaw !== raw) throw new RunStateCorruptError('current 与 immutable revision 字节不一致')
  let previous: RunRevision | undefined
  if (current.revision > 0) {
    const previousRevisionId = previousRevisionIdFor(current)
    previous = await readImmutableRunRevision(
      changeDir, current.revision - 1, previousRevisionId,
    )
    if (previous === undefined) {
      throw new RunStateCorruptError('current 引用的 previous revision 缺失')
    }
    if (previous.revisionId !== previousRevisionId
      || previous.revision !== current.revision - 1) {
      throw new RunStateCorruptError('current 引用的 previous revision 身份不一致')
    }
    assertMutationEffects(current, previous)
  }
  await assertTransitionRecordFile(changeDir, current, previous)
  await validateAnchoredTransitionHead(
    current,
    (relativePath) => readRegularTextIfExists(join(changeDir, relativePath)),
    changeDir,
  )
  if (previous?.mutation.kind === 'transition') {
    const predecessor = assertDirectPredecessor(
      previous,
      await readImmutableRunRevision(
        changeDir,
        previous.revision - 1,
        previousRevisionIdFor(previous),
      ),
    )
    await assertTransitionRecordFile(changeDir, previous, predecessor)
  }
  return current
}

/**
 * History/audit 冷路径使用的全链验证。普通 state read 只校验 current、自身 twin、直接 previous
 * 与 head record，保持 current 自包含读的 O(1) 特性；history 展示前才沿 immutable revision 链
 * 回溯，并验证每一代 previous/effects 与每条 transition record digest。
 */
export async function validateCanonicalRevisionHistory(changeDir: string): Promise<void> {
  let cursor = await readCurrentRunRevision(changeDir)
  if (cursor === undefined) return
  while (cursor.revision > 0) {
    const previousRevisionId = previousRevisionIdFor(cursor)
    const previous = await readImmutableRunRevision(
      changeDir, cursor.revision - 1, previousRevisionId,
    )
    if (previous === undefined) {
      throw new RunStateCorruptError(`canonical history revision ${cursor.revision - 1} 缺失`)
    }
    if (previous.revision !== cursor.revision - 1
      || previous.revisionId !== previousRevisionId) {
      throw new RunStateCorruptError('canonical history previous revision 身份不一致')
    }
    assertMutationEffects(cursor, previous)
    await assertTransitionRecordFile(changeDir, cursor, previous)
    cursor = previous
  }
}

async function readRegularTextIfExists(pathname: string): Promise<string | undefined> {
  let entry
  try {
    entry = await lstat(pathname)
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return undefined
    throw error
  }
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new RunStateCorruptError(`${pathname}: canonical 文件必须是非 symlink 普通文件`)
  }
  try {
    return await readFile(pathname, 'utf8')
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') {
      throw new RunStateCorruptError(`${pathname}: canonical 文件在校验期间消失`)
    }
    throw error
  }
}

function readTextSyncIfExists(pathname: string): string | undefined {
  let entry
  try {
    entry = lstatSync(pathname)
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return undefined
    throw error
  }
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new RunStateCorruptError(`${pathname}: canonical 文件必须是非 symlink 普通文件`)
  }
  try {
    return readFileSync(pathname, 'utf8')
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') {
      throw new RunStateCorruptError(`${pathname}: canonical 文件在校验期间消失`)
    }
    throw error
  }
}

/**
 * 同步消费者使用的完整 canonical reader。校验面与 async reader 相同：current schema/digest、
 * immutable twin、直接 previous revision、transition record linkage；current 缺失返回 undefined，
 * current 已存在但任一依赖损坏均 fail-loud。
 */
export type RunRevisionTextReader = (relativePath: string) => string | undefined

/**
 * 对受信任目录 fd 等自定义存储入口开放的同步 validator。reader 只接收受控相对路径；返回
 * undefined 表示该目录项不存在，其他 I/O/安全异常必须抛出。这样 server 可保留 O_NOFOLLOW
 * 边界，同时与普通路径 reader 共用完全相同的 canonical linkage 校验。
 */
export function readCurrentRunRevisionFromSync(
  readText: RunRevisionTextReader,
  sourceRoot = 'canonical state',
): RunRevision | undefined {
  const currentRel = join(RUN_STATE_DIR, RUN_CURRENT_FILE)
  const raw = readText(currentRel)
  if (raw === undefined) return undefined
  const currentSource = join(sourceRoot, currentRel)
  const current = hydrateCompanionsFromSync(readText, parseRunRevision(raw, currentSource), sourceRoot)
  const revisionsRel = join(RUN_STATE_DIR, RUN_REVISIONS_DIR)
  const immutableRel = join(revisionsRel, revisionFileName(current.revision, current.revisionId))
  const immutableRaw = readText(immutableRel)
  if (immutableRaw === undefined) {
    throw new RunStateCorruptError(`current 引用的 immutable revision 缺失: ${join(sourceRoot, immutableRel)}`)
  }
  hydrateCompanionsFromSync(
    readText,
    parseRunRevision(immutableRaw, join(sourceRoot, immutableRel)),
    sourceRoot,
  )
  if (immutableRaw !== raw) throw new RunStateCorruptError('current 与 immutable revision 字节不一致')
  let previous: RunRevision | undefined
  if (current.revision > 0) {
    const previousRevisionId = previousRevisionIdFor(current)
    const previousRel = join(
      revisionsRel,
      revisionFileName(current.revision - 1, previousRevisionId),
    )
    const previousRaw = readText(previousRel)
    if (previousRaw === undefined) throw new RunStateCorruptError('current 引用的 previous revision 缺失')
    previous = hydrateCompanionsFromSync(
      readText,
      parseRunRevision(previousRaw, join(sourceRoot, previousRel)),
      sourceRoot,
    )
    if (previous.revisionId !== previousRevisionId
      || previous.revision !== current.revision - 1) {
      throw new RunStateCorruptError('current 引用的 previous revision 身份不一致')
    }
    assertMutationEffects(current, previous)
  }
  assertTransitionRecordFromSync(readText, current, sourceRoot, previous)
  validateAnchoredTransitionHeadFromSync(current, readText, sourceRoot)
  if (previous?.mutation.kind === 'transition') {
    const predecessorId = previousRevisionIdFor(previous)
    const predecessorRel = join(
      revisionsRel,
      revisionFileName(previous.revision - 1, predecessorId),
    )
    const predecessorRaw = readText(predecessorRel)
    const predecessor = assertDirectPredecessor(
      previous,
      predecessorRaw === undefined
        ? undefined
        : hydrateCompanionsFromSync(
            readText,
            parseRunRevision(predecessorRaw, join(sourceRoot, predecessorRel)),
            sourceRoot,
          ),
    )
    assertTransitionRecordFromSync(readText, previous, sourceRoot, predecessor)
  }
  return current
}

export function readCurrentRunRevisionSync(changeDir: string): RunRevision | undefined {
  return readCurrentRunRevisionFromSync(
    (relativePath) => readTextSyncIfExists(join(changeDir, relativePath)),
    changeDir,
  )
}

export async function readImmutableRunRevision(
  changeDir: string,
  revision: number,
  revisionId: string,
): Promise<RunRevision | undefined> {
  if (!Number.isSafeInteger(revision) || revision < 0 || !SAFE_ID_RE.test(revisionId)) return undefined
  const pathname = join(changeDir, RUN_STATE_DIR, RUN_REVISIONS_DIR, revisionFileName(revision, revisionId))
  const raw = await readRegularTextIfExists(pathname)
  return raw === undefined
    ? undefined
    : hydrateCompanions(changeDir, parseRunRevision(raw, pathname))
}
