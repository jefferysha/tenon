/**
 * The one 删除 / 归档 / 取消归档 application; CLI and server both call it so both see the same reasons,
 * the same refusals and the same records. Reasons are assessed twice: once for display, again inside the
 * lock right before anything is written, so a task that started running between the two calls is refused.
 * Every non-success outcome writes nothing at all.
 */
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { REVIEW_GATE_PENDING, reviewGateStatus } from '../state/review-gate.js'
import { stateStorageSourcePathSync } from '../state/run-revision-store.js'
import { directChildren, loadTaskTree } from '../state/tasks.js'
import type { ChangeNode } from '../state/tasks.js'
import type { FieldName, PipelineState, StateStore } from '../types.js'
import { userProjectPaths } from '../users/user-paths.js'
import { formatUserRef, isTenonUser } from '../users/user.js'
import type { RecordActor, TenonUser, TenonUserResolution, UserRef } from '../users/user.js'
import { ownerOf } from '../users/owner.js'
import {
  isTaskLifecycleName, readTaskArchiveOf, taskChangeDir, withTaskArchiveLock, withoutTaskArchiveEntry,
  writeTaskArchiveOf,
} from './task-archive.js'
import type { TaskArchiveEntry } from './task-archive.js'
import { cleanupDeletedChangeReferences, stageTaskForDelete, sweepTaskTombstones } from './task-delete.js'
import { defaultTerminalActivityLive } from './task-terminal-activity.js'
import { countUncommittedTaskDeletions } from './uncommitted-deletions.js'
import type { GitStatusRunner } from './uncommitted-deletions.js'

/** A Change whose canonical state cannot be decoded still deletes; it simply reports no phase. */
const UNKNOWN_PHASE = 'unknown'
const AFK_BLOCKING = ['scheduled', 'running']

export type TaskLifecycleAction = 'delete' | 'archive'
export type TaskLifecycleChannel = 'terminal' | 'dashboard'

export type TaskLifecycleReasonCode =
  | 'afk-running' | 'afk-queued' | 'review-pending' | 'host-session-live' | 'has-dependents' | 'owned-by-other'

export interface TaskLifecycleReason {
  readonly code: TaskLifecycleReasonCode
  readonly detail?: string
}

export interface TaskLifecycleAssessment {
  readonly action: TaskLifecycleAction
  readonly change: string
  readonly phase: string
  readonly blockers: readonly TaskLifecycleReason[]
  readonly confirmations: readonly TaskLifecycleReason[]
}

export interface TaskLifecycleAuditRecord {
  readonly ts: string
  readonly action: 'delete' | 'archive' | 'unarchive'
  readonly change: string
  readonly phase: string
  readonly actor: RecordActor
  readonly channel: TaskLifecycleChannel
  readonly acknowledged: readonly TaskLifecycleReasonCode[]
  readonly removed?: readonly string[]
}

export interface TaskLifecycleDeps {
  readonly store: StateStore
  readonly clock: () => string
  readonly nowMs: () => number
  /** Hardened sidecar reader; the kernel default is replaced by an adapter that already has one. */
  readonly terminalActivityLive?: (changeDir: string, change: string, nowMs: number) => Promise<boolean>
  readonly loadTaskTree?: (repoRoot: string, store: StateStore) => Promise<ChangeNode[]>
  readonly git?: GitStatusRunner
}

export interface TaskLifecycleCommand {
  readonly repoRoot: string
  readonly change: string
  readonly user: TenonUserResolution
  readonly channel: TaskLifecycleChannel
  /** CLI `--yes` → `'all'`; the Dashboard sends exactly the codes it displayed. */
  readonly acknowledged: readonly TaskLifecycleReasonCode[] | 'all'
}

export type TaskLifecycleOutcome =
  | {
    readonly kind: 'deleted'; readonly change: string; readonly removed: readonly string[]
    readonly uncommittedDeletions: number | null; readonly warnings: readonly string[]
  }
  | { readonly kind: 'archived'; readonly change: string; readonly changed: boolean; readonly entry: TaskArchiveEntry }
  | { readonly kind: 'unarchived'; readonly change: string; readonly changed: boolean }
  | { readonly kind: 'invalid-name'; readonly change: string }
  | { readonly kind: 'not-found'; readonly change: string }
  | { readonly kind: 'identity-missing' }
  | { readonly kind: 'blocked'; readonly reasons: readonly TaskLifecycleReason[] }
  | { readonly kind: 'confirmation-required'; readonly reasons: readonly TaskLifecycleReason[] }
  | { readonly kind: 'archive-store-corrupt'; readonly path: string }
  | { readonly kind: 'delete-failed'; readonly cause: string }

export type TaskLifecycleAssessOutcome =
  | TaskLifecycleAssessment
  | Extract<TaskLifecycleOutcome, { kind: 'invalid-name' | 'not-found' }>

export interface TaskLifecycleApplication {
  assess(input: {
    repoRoot: string; change: string; action: TaskLifecycleAction; user: TenonUserResolution
  }): Promise<TaskLifecycleAssessOutcome>
  delete(command: TaskLifecycleCommand): Promise<TaskLifecycleOutcome>
  archive(command: TaskLifecycleCommand): Promise<TaskLifecycleOutcome>
  unarchive(command: Omit<TaskLifecycleCommand, 'acknowledged'>): Promise<TaskLifecycleOutcome>
}

/** How to clear a blocker; confirmations are acknowledged instead and have none. */
export function taskLifecycleUnlockHint(code: TaskLifecycleReasonCode, change: string): string | undefined {
  if (code === 'afk-running') return `tenon afk cancel ${change}`
  if (code === 'afk-queued') return `tenon cas ${change} automation queued off`
  return undefined
}

function scalar(state: PipelineState, field: FieldName): string {
  const value = state.fields[field]
  return Array.isArray(value) ? value.join(',') : (value ?? '')
}

function stateExists(changeDir: string): boolean {
  try {
    return stateStorageSourcePathSync(changeDir) !== undefined
  } catch {
    return false
  }
}

interface ChangeFacts {
  readonly phase: string
  readonly automation: string
  readonly reviewPending: boolean
  readonly owner: UserRef | null
}

async function changeFacts(store: StateStore, changeDir: string): Promise<ChangeFacts | null> {
  try {
    const state = await store.read(changeDir)
    return {
      phase: scalar(state, 'phase') === '' ? UNKNOWN_PHASE : scalar(state, 'phase'),
      automation: scalar(state, 'automation'),
      reviewPending: reviewGateStatus(state) === REVIEW_GATE_PENDING,
      owner: ownerOf(state.fields),
    }
  } catch {
    return null
  }
}

function auditPathFor(repoRoot: string, user: TenonUser, action: TaskLifecycleAuditRecord['action']): string {
  const paths = userProjectPaths(repoRoot, user.slug)
  // A deletion is a shared fact and travels with the commit; hiding a task is personal and never synced.
  return action === 'delete' ? paths.audit : paths.localAudit
}

async function appendAudit(path: string, record: TaskLifecycleAuditRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
}

function acknowledgedCodes(
  confirmations: readonly TaskLifecycleReason[],
  acknowledged: readonly TaskLifecycleReasonCode[] | 'all',
): readonly TaskLifecycleReasonCode[] {
  return confirmations.filter((reason) => acknowledged === 'all' || acknowledged.includes(reason.code))
    .map((reason) => reason.code)
}

function unacknowledged(
  confirmations: readonly TaskLifecycleReason[],
  acknowledged: readonly TaskLifecycleReasonCode[] | 'all',
): readonly TaskLifecycleReason[] {
  return acknowledged === 'all' ? [] : confirmations.filter((reason) => !acknowledged.includes(reason.code))
}

export function createTaskLifecycleApplication(deps: TaskLifecycleDeps): TaskLifecycleApplication {
  const terminalActivityLive = deps.terminalActivityLive ?? defaultTerminalActivityLive
  const tree = deps.loadTaskTree ?? loadTaskTree

  async function assessKnown(
    repoRoot: string,
    change: string,
    action: TaskLifecycleAction,
    user: TenonUserResolution,
  ): Promise<TaskLifecycleAssessment> {
    const changeDir = taskChangeDir(repoRoot, change)
    const facts = await changeFacts(deps.store, changeDir)
    const blockers: TaskLifecycleReason[] = []
    const confirmations: TaskLifecycleReason[] = []
    const automation = facts?.automation ?? ''
    if (AFK_BLOCKING.includes(automation)) blockers.push({ code: 'afk-running' })
    // A queued Change loses its queue entry together with the directory, but the local scheduler would
    // keep advancing a merely hidden one, so 归档 refuses while 删除 only confirms.
    else if (automation === 'queued') (action === 'archive' ? blockers : confirmations).push({ code: 'afk-queued' })
    if (facts?.reviewPending === true) confirmations.push({ code: 'review-pending' })
    if (await terminalActivityLive(changeDir, change, deps.nowMs())) confirmations.push({ code: 'host-session-live' })
    if (action === 'delete') {
      const dependents = directChildren(await tree(repoRoot, deps.store), change)
        .filter((child) => !child.archived).map((child) => child.name)
      if (dependents.length > 0) confirmations.push({ code: 'has-dependents', detail: [...new Set(dependents)].sort().join(',') })
      const owner = facts?.owner ?? null
      if (owner !== null && isTenonUser(user) && owner.slug !== user.slug) {
        confirmations.push({ code: 'owned-by-other', detail: formatUserRef(owner) })
      }
    }
    return { action, change, phase: facts?.phase ?? UNKNOWN_PHASE, blockers, confirmations }
  }

  async function assess(input: {
    repoRoot: string; change: string; action: TaskLifecycleAction; user: TenonUserResolution
  }): Promise<TaskLifecycleAssessOutcome> {
    if (!isTaskLifecycleName(input.change)) return { kind: 'invalid-name', change: input.change }
    if (!stateExists(taskChangeDir(input.repoRoot, input.change))) return { kind: 'not-found', change: input.change }
    return assessKnown(input.repoRoot, input.change, input.action, input.user)
  }

  /** Name, identity and existence: the three checks every command shares before taking a lock. */
  function preflight(
    command: Pick<TaskLifecycleCommand, 'repoRoot' | 'change' | 'user'>,
  ): { user: TenonUser } | Extract<TaskLifecycleOutcome, { kind: 'invalid-name' | 'not-found' | 'identity-missing' }> {
    if (!isTaskLifecycleName(command.change)) return { kind: 'invalid-name', change: command.change }
    if (!isTenonUser(command.user)) return { kind: 'identity-missing' }
    if (!stateExists(taskChangeDir(command.repoRoot, command.change))) {
      return { kind: 'not-found', change: command.change }
    }
    return { user: command.user }
  }

  function refuse(
    assessment: TaskLifecycleAssessment,
    acknowledged: readonly TaskLifecycleReasonCode[] | 'all',
  ): TaskLifecycleOutcome | null {
    if (assessment.blockers.length > 0) return { kind: 'blocked', reasons: assessment.blockers }
    const pending = unacknowledged(assessment.confirmations, acknowledged)
    return pending.length > 0 ? { kind: 'confirmation-required', reasons: pending } : null
  }

  async function runDelete(command: TaskLifecycleCommand): Promise<TaskLifecycleOutcome> {
    const ready = preflight(command)
    if ('kind' in ready) return ready
    const { repoRoot, change } = command
    const changeDir = taskChangeDir(repoRoot, change)
    const paths = userProjectPaths(repoRoot, ready.user.slug)
    return deps.store.withLock(changeDir, async () => {
      await sweepTaskTombstones(paths.deletingDir)
      const assessment = await assessKnown(repoRoot, change, 'delete', ready.user)
      const refusal = refuse(assessment, command.acknowledged)
      if (refusal !== null) return refusal
      let tombstone: string
      try {
        tombstone = await stageTaskForDelete(changeDir, paths.deletingDir, change, deps.nowMs())
      } catch (error) {
        return { kind: 'delete-failed', cause: String((error as { code?: unknown }).code ?? error) }
      }
      const cleanup = await cleanupDeletedChangeReferences(repoRoot, change, ready.user.slug)
      const removed = [`openspec/changes/${change}`, ...cleanup.removed]
      await appendAudit(auditPathFor(repoRoot, ready.user, 'delete'), {
        ts: deps.clock(),
        action: 'delete',
        change,
        phase: assessment.phase,
        actor: { id: ready.user.id, name: ready.user.name, trust: 'declared' },
        channel: command.channel,
        acknowledged: acknowledgedCodes(assessment.confirmations, command.acknowledged),
        removed,
      })
      const warnings = cleanup.archiveCorrupt.map((path) => `归档记录未清理: ${path}`)
      try {
        await sweepTaskTombstones(paths.deletingDir)
      } catch {
        warnings.push(`未提交删除暂存未清理: ${tombstone}`)
      }
      return {
        kind: 'deleted',
        change,
        removed,
        uncommittedDeletions: await countUncommittedTaskDeletions(repoRoot, deps.git),
        warnings,
      }
    })
  }

  async function runArchive(command: TaskLifecycleCommand): Promise<TaskLifecycleOutcome> {
    const ready = preflight(command)
    if ('kind' in ready) return ready
    const { repoRoot, change } = command
    return withTaskArchiveLock(repoRoot, ready.user.slug, async () => {
      const stored = await readTaskArchiveOf(repoRoot, ready.user.slug)
      if (stored.kind === 'corrupt') return { kind: 'archive-store-corrupt', path: stored.path }
      const existing = stored.archive.changes[change]
      if (existing !== undefined) return { kind: 'archived', change, changed: false, entry: existing }
      const assessment = await assessKnown(repoRoot, change, 'archive', ready.user)
      const refusal = refuse(assessment, command.acknowledged)
      if (refusal !== null) return refusal
      const entry: TaskArchiveEntry = {
        archivedAt: deps.clock(),
        phase: assessment.phase,
        actor: { id: ready.user.id, name: ready.user.name, trust: 'declared' },
      }
      await writeTaskArchiveOf(repoRoot, ready.user.slug, {
        version: 1,
        changes: { ...stored.archive.changes, [change]: entry },
      })
      await appendAudit(auditPathFor(repoRoot, ready.user, 'archive'), {
        ts: entry.archivedAt,
        action: 'archive',
        change,
        phase: entry.phase,
        actor: entry.actor,
        channel: command.channel,
        acknowledged: acknowledgedCodes(assessment.confirmations, command.acknowledged),
      })
      return { kind: 'archived', change, changed: true, entry }
    })
  }

  async function runUnarchive(command: Omit<TaskLifecycleCommand, 'acknowledged'>): Promise<TaskLifecycleOutcome> {
    const ready = preflight(command)
    if ('kind' in ready) return ready
    const { repoRoot, change } = command
    return withTaskArchiveLock(repoRoot, ready.user.slug, async () => {
      const stored = await readTaskArchiveOf(repoRoot, ready.user.slug)
      if (stored.kind === 'corrupt') return { kind: 'archive-store-corrupt', path: stored.path }
      const entry = stored.archive.changes[change]
      if (entry === undefined) return { kind: 'unarchived', change, changed: false }
      const next = withoutTaskArchiveEntry(stored.archive, change)
      if (next !== null) await writeTaskArchiveOf(repoRoot, ready.user.slug, next)
      await appendAudit(auditPathFor(repoRoot, ready.user, 'unarchive'), {
        ts: deps.clock(),
        action: 'unarchive',
        change,
        phase: entry.phase,
        actor: { id: ready.user.id, name: ready.user.name, trust: 'declared' },
        channel: command.channel,
        acknowledged: [],
      })
      return { kind: 'unarchived', change, changed: true }
    })
  }

  return { assess, delete: runDelete, archive: runArchive, unarchive: runUnarchive }
}
