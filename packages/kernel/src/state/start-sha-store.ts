/**
 * Revision-bound storage for the logical canonical `start_sha`.
 *
 * `start_sha` is the HEAD recorded when the task was created. Every new task in a repository with a
 * commit carries one, so it is implicit data an earlier runtime must be able to read. The
 * schemaVersion=1 wire, mutation/TransitionRecord effects and the YAML projection keep the field
 * closure that earlier runtimes read; the value lives in its own immutable companion keyed by
 * revision + revisionId and bound to that revision's `stateDigest`.
 *
 * - The record is published before the immutable revision/current pointer, and only when the value
 *   is not empty; a crash can only leave an unreachable orphan.
 * - A missing record reads as an empty `start_sha` (no start point recorded). That covers tasks
 *   created before the field existed, repositories without a commit when the task was created, and
 *   any revision written by an earlier runtime (which never writes this record): after the previous
 *   release continues a task the current runtime reads an empty value and the task start falls back
 *   to the upstream / base-branch candidates.
 * - Revisions from unreleased development builds carried the value inside wire `state.fields`.
 *   Without a record the parsed wire value is kept; the next write publishes this companion shape.
 */
import { lstat, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { START_SHA_DEFAULT, START_SHA_FIELD } from '../review-gate-fields.js'
import { isGitCommitId } from '../workspace/change-start.js'
import { atomicLinkPublish } from './atomic-publish.js'
import type { RunRevision } from './run-revision-codec.js'
import { RunStateCorruptError } from './run-revision-validation.js'

export const START_SHA_DIR = 'start-sha'
const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/

interface StartShaRecord {
  readonly schemaVersion: 1
  readonly revision: number
  readonly revisionId: string
  readonly stateDigest: string
  readonly sha: string
}

function errnoCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined
  const code = Reflect.get(error, 'code')
  return typeof code === 'string' ? code : undefined
}

export function startShaRelativePath(revision: number, revisionId: string): string {
  return join(
    '.pipeline-run',
    START_SHA_DIR,
    `${String(revision).padStart(6, '0')}-${revisionId}.json`,
  )
}

function parseRecord(raw: string, source: string): StartShaRecord {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new RunStateCorruptError(`${source}: start_sha companion JSON 损坏（${String(error)}）`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RunStateCorruptError(`${source}: start_sha companion 不是对象`)
  }
  const record = Object.fromEntries(Object.entries(value))
  if (Object.keys(record).sort().join(',') !== 'revision,revisionId,schemaVersion,sha,stateDigest'
    || record.schemaVersion !== 1
    || typeof record.revision !== 'number'
    || !Number.isSafeInteger(record.revision) || record.revision < 0
    || typeof record.revisionId !== 'string' || !SAFE_ID_RE.test(record.revisionId)
    || typeof record.stateDigest !== 'string' || !/^[0-9a-f]{64}$/.test(record.stateDigest)
    || typeof record.sha !== 'string' || !isGitCommitId(record.sha)) {
    throw new RunStateCorruptError(`${source}: start_sha companion 形状非法`)
  }
  return {
    schemaVersion: 1,
    revision: record.revision,
    revisionId: record.revisionId,
    stateDigest: record.stateDigest,
    sha: record.sha,
  }
}

function attach(revision: RunRevision, record?: StartShaRecord): RunRevision {
  if (record === undefined) return revision
  if (record.revision !== revision.revision
    || record.revisionId !== revision.revisionId
    || record.stateDigest !== revision.stateDigest) {
    throw new RunStateCorruptError('start_sha companion 与 canonical revision 身份/摘要不一致')
  }
  return {
    ...revision,
    state: {
      ...revision.state,
      fields: { ...revision.state.fields, [START_SHA_FIELD]: record.sha },
    },
  }
}

/** `revision` must come from `createRunRevision`; the logical value is validated here, before any bytes are written. */
export async function publishStartShaRecord(
  changeDir: string,
  revision: RunRevision,
): Promise<void> {
  const sha = revision.state.fields[START_SHA_FIELD]
  if (sha === START_SHA_DEFAULT) return
  if (typeof sha !== 'string' || !isGitCommitId(sha)) {
    throw new RunStateCorruptError(`canonical ${START_SHA_FIELD} 非法：只接受 40 或 64 位小写十六进制提交 id`)
  }
  const dir = join(changeDir, '.pipeline-run', START_SHA_DIR)
  await mkdir(dir, { recursive: true })
  const record: StartShaRecord = {
    schemaVersion: 1,
    revision: revision.revision,
    revisionId: revision.revisionId,
    stateDigest: revision.stateDigest,
    sha,
  }
  await atomicLinkPublish(
    dir,
    '.tmp',
    join(changeDir, startShaRelativePath(revision.revision, revision.revisionId)),
    `${JSON.stringify(record)}\n`,
  )
}

export async function hydrateStartSha(
  changeDir: string,
  revision: RunRevision,
): Promise<RunRevision> {
  const target = join(changeDir, startShaRelativePath(revision.revision, revision.revisionId))
  let info
  try {
    info = await lstat(target)
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return attach(revision)
    throw error
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new RunStateCorruptError(`${target}: start_sha companion 必须是非 symlink 普通文件`)
  }
  return attach(revision, parseRecord(await readFile(target, 'utf8'), target))
}

export function hydrateStartShaFromSync(
  readText: (relativePath: string) => string | undefined,
  revision: RunRevision,
  sourceRoot = 'canonical state',
): RunRevision {
  const relative = startShaRelativePath(revision.revision, revision.revisionId)
  const raw = readText(relative)
  return attach(revision, raw === undefined ? undefined : parseRecord(raw, join(sourceRoot, relative)))
}
