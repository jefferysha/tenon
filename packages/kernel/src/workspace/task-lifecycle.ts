/**
 * The one 删除 / 终止 / 完结 application; CLI and server both call it so both see the same reasons, the
 * same refusals and the same records. Reasons are assessed twice: once for display, again inside the locks
 * right before anything is written, so a task that started running between the two calls is refused.
 * Every non-success outcome writes nothing at all, with one exception: a `task_result` an interrupted archive
 * left on an active task is cleared first, because it is not a decision but a leftover. That leftover only
 * appears after an interrupted archive; finish / terminate clear it inside the lock before evaluating, so even
 * when the evaluation then refuses (an AFK run in progress, say) that one cleanup revision stays behind.
 *
 * All three actions lock in the same order — the project archive lock, then the task lock — and decide and act
 * inside both, so they exclude each other and nothing (an AFK start, a `tenon set`) can slip in between the
 * assessment and the first write. Whoever waits behind a lock whose task has since been deleted or archived
 * finds it gone (`not-found`).
 *
 * 终止 and 完结 are the two ways a task ends and both move the task directory into `openspec/changes/archive/`
 * through `archiveTask`; there is no "hide" any more. 完结 only accepts a task whose state machine reached a
 * terminal step; 终止 accepts any task that has not. What follows the move (audit row, commit) is best effort:
 * a failure there is a warning on a successful outcome, never a failure of the move that already happened.
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
import type { TrackSpec } from '../workflow/types.js'
import {
  archiveTask, ArchiveTaskError, clearStaleTaskResult, isTaskLifecycleName, openspecArchiveRunner, taskArchiveSpec,
  taskChangeDir, terminalTaskResult, withArchiveLock,
} from './archive-task.js'
import type { ArchivedTask, ArchiveDeps, ArchiveTaskErrorCode, TaskResult } from './archive-task.js'
import { commitOnlyPaths } from './commit-paths.js'
import type { PathCommitOutcome } from './commit-paths.js'
import { cleanupDeletedChangeReferences, stageTaskForDelete, sweepTaskTombstones } from './task-delete.js'
import { defaultTerminalActivityLive } from './task-terminal-activity.js'
import { countUncommittedTaskDeletions, gitStatusRunner, probeChangeTracked } from './uncommitted-deletions.js'
import type { GitStatusRunner } from './uncommitted-deletions.js'

/** A Change whose canonical state cannot be decoded still deletes; it simply reports no phase. */
const UNKNOWN_PHASE = 'unknown'
const AFK_BLOCKING = ['scheduled', 'running']

export type TaskLifecycleAction = 'delete' | 'terminate'
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
  readonly action: TaskLifecycleAction
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
  /** Who moves the directory: `openspec` hands it to `openspec archive`, `none` renames it. Default: the frozen plan. */
  readonly specOf?: (state: PipelineState) => TrackSpec
  /** `openspec archive <change> --skip-specs --yes --json` in `repoRoot`; tests inject a stand-in. */
  readonly runOpenspecArchive?: (repoRoot: string, change: string) => Promise<void>
}

export interface TaskLifecycleCommand {
  readonly repoRoot: string
  readonly change: string
  readonly user: TenonUserResolution
  readonly channel: TaskLifecycleChannel
  /** CLI `--yes` → `'all'`; the Dashboard sends exactly the codes it displayed. */
  readonly acknowledged: readonly TaskLifecycleReasonCode[] | 'all'
}

export interface TaskFinishCommand {
  readonly repoRoot: string
  readonly change: string
}

export type TaskLifecycleOutcome =
  | {
    readonly kind: 'deleted'; readonly change: string; readonly removed: readonly string[]
    readonly uncommittedDeletions: number | null; readonly warnings: readonly string[]
  }
  | {
    readonly kind: 'terminated'; readonly change: string; readonly archived: ArchivedTask
    readonly commit: PathCommitOutcome
    /** Failures after the move (the audit row); the termination itself stands. */
    readonly warnings: readonly string[]
  }
  | { readonly kind: 'finished'; readonly change: string; readonly archived: ArchivedTask }
  /** 完结 on a task whose state machine has not reached a terminal step. */
  | { readonly kind: 'not-terminal'; readonly change: string; readonly phase: string }
  /** 终止 on a task whose state machine already finished: it is 完结 / 已升级, not 终止. */
  | { readonly kind: 'already-terminal'; readonly change: string; readonly result: 'finished' | 'escalated' }
  | { readonly kind: 'archive-failed'; readonly code: ArchiveTaskErrorCode; readonly cause: string }
  | { readonly kind: 'invalid-name'; readonly change: string }
  | { readonly kind: 'not-found'; readonly change: string }
  | { readonly kind: 'identity-missing' }
  | { readonly kind: 'blocked'; readonly reasons: readonly TaskLifecycleReason[] }
  | { readonly kind: 'confirmation-required'; readonly reasons: readonly TaskLifecycleReason[] }
  | { readonly kind: 'delete-failed'; readonly cause: string }

export type TaskLifecycleAssessOutcome =
  | TaskLifecycleAssessment
  | Extract<TaskLifecycleOutcome, { kind: 'invalid-name' | 'not-found' }>

export interface TaskLifecycleApplication {
  assess(input: {
    repoRoot: string; change: string; action: TaskLifecycleAction; user: TenonUserResolution
  }): Promise<TaskLifecycleAssessOutcome>
  delete(command: TaskLifecycleCommand): Promise<TaskLifecycleOutcome>
  terminate(command: TaskLifecycleCommand): Promise<TaskLifecycleOutcome>
  finish(command: TaskFinishCommand): Promise<TaskLifecycleOutcome>
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
  /** Set once the state machine reached a terminal step (`archived=true`). */
  readonly terminal: 'finished' | 'escalated' | null
  readonly spec: TrackSpec
}

async function changeFacts(
  store: StateStore,
  changeDir: string,
  specOf: (state: PipelineState) => TrackSpec,
): Promise<ChangeFacts | null> {
  try {
    const state = await store.read(changeDir)
    return {
      phase: scalar(state, 'phase') === '' ? UNKNOWN_PHASE : scalar(state, 'phase'),
      automation: scalar(state, 'automation'),
      reviewPending: reviewGateStatus(state) === REVIEW_GATE_PENDING,
      owner: ownerOf(state.fields),
      terminal: terminalTaskResult(state.fields),
      spec: specOf(state),
    }
  } catch {
    return null
  }
}

function auditPathFor(repoRoot: string, user: TenonUser, action: TaskLifecycleAction): string {
  const paths = userProjectPaths(repoRoot, user.slug)
  // A deletion is a shared fact and travels with the commit; a termination commits only the moved task
  // directory, so its audit row stays with the acting user and never dirties the checkout.
  return action === 'delete' ? paths.audit : paths.localAudit
}

/**
 * The audit row is written after the directory has moved or been staged away, so a failure here must not turn
 * that into a reported failure (a retry would only find the task gone): it comes back as a warning instead.
 */
async function recordAudit(path: string, record: TaskLifecycleAuditRecord): Promise<readonly string[]> {
  try {
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
    return []
  } catch (error) {
    return [`审计记录没写进去（${error instanceof Error ? error.message : String(error)}）：${path}`]
  }
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
  const git = deps.git ?? gitStatusRunner
  const specOf = deps.specOf ?? taskArchiveSpec
  const runOpenspec = deps.runOpenspecArchive ?? ((repoRoot: string, change: string) => openspecArchiveRunner(repoRoot)(change))

  function archiveDeps(repoRoot: string): ArchiveDeps {
    return {
      repoRoot,
      store: deps.store,
      now: () => new Date(deps.clock()),
      runOpenspecArchive: (change) => runOpenspec(repoRoot, change),
    }
  }

  async function evaluate(
    repoRoot: string,
    change: string,
    action: TaskLifecycleAction,
    user: TenonUserResolution,
  ): Promise<{ readonly assessment: TaskLifecycleAssessment; readonly facts: ChangeFacts | null }> {
    const changeDir = taskChangeDir(repoRoot, change)
    const facts = await changeFacts(deps.store, changeDir, specOf)
    const blockers: TaskLifecycleReason[] = []
    const confirmations: TaskLifecycleReason[] = []
    const automation = facts?.automation ?? ''
    if (AFK_BLOCKING.includes(automation)) blockers.push({ code: 'afk-running' })
    // A queued Change loses its queue entry together with the directory, but the local scheduler would
    // keep a terminated one's entry, so 终止 refuses while 删除 only confirms.
    else if (automation === 'queued') (action === 'terminate' ? blockers : confirmations).push({ code: 'afk-queued' })
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
    return { assessment: { action, change, phase: facts?.phase ?? UNKNOWN_PHASE, blockers, confirmations }, facts }
  }

  async function assess(input: {
    repoRoot: string; change: string; action: TaskLifecycleAction; user: TenonUserResolution
  }): Promise<TaskLifecycleAssessOutcome> {
    if (!isTaskLifecycleName(input.change)) return { kind: 'invalid-name', change: input.change }
    if (!stateExists(taskChangeDir(input.repoRoot, input.change))) return { kind: 'not-found', change: input.change }
    return (await evaluate(input.repoRoot, input.change, input.action, input.user)).assessment
  }

  /** Name, identity and existence: the three checks every acting command shares before taking a lock. */
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

  /** An archive failure is an outcome, not a crash: the task is exactly where it was. */
  async function guarded(run: () => Promise<TaskLifecycleOutcome>): Promise<TaskLifecycleOutcome> {
    try {
      return await run()
    } catch (error) {
      if (error instanceof ArchiveTaskError) return { kind: 'archive-failed', code: error.code, cause: error.message }
      throw error
    }
  }

  /**
   * The one lock order for delete, terminate and finish: project archive lock, then the task lock. The task is
   * looked up again once both are held (whoever held them before may have deleted or archived it), and `act`
   * runs inside both.
   */
  function lockedTask(
    repoRoot: string,
    change: string,
    act: () => Promise<TaskLifecycleOutcome>,
  ): Promise<TaskLifecycleOutcome> {
    return guarded(() => withArchiveLock(repoRoot, async () => {
      const changeDir = taskChangeDir(repoRoot, change)
      if (!stateExists(changeDir)) return { kind: 'not-found', change }
      return deps.store.withLock(changeDir, act)
    }))
  }

  /** Ending a task (terminate, finish): a `task_result` an interrupted archive left behind goes first. */
  function lockedEnding(
    repoRoot: string,
    change: string,
    act: () => Promise<TaskLifecycleOutcome>,
  ): Promise<TaskLifecycleOutcome> {
    return lockedTask(repoRoot, change, async () => {
      await clearStaleTaskResult(deps.store, taskChangeDir(repoRoot, change))
      return act()
    })
  }

  async function runDelete(command: TaskLifecycleCommand): Promise<TaskLifecycleOutcome> {
    const ready = preflight(command)
    if ('kind' in ready) return ready
    const { repoRoot, change } = command
    const changeDir = taskChangeDir(repoRoot, change)
    const paths = userProjectPaths(repoRoot, ready.user.slug)
    return lockedTask(repoRoot, change, async () => {
      await sweepTaskTombstones(paths.deletingDir)
      const { assessment } = await evaluate(repoRoot, change, 'delete', ready.user)
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
      const warnings = [...await recordAudit(auditPathFor(repoRoot, ready.user, 'delete'), {
        ts: deps.clock(),
        action: 'delete',
        change,
        phase: assessment.phase,
        actor: { id: ready.user.id, name: ready.user.name, trust: 'declared' },
        channel: command.channel,
        acknowledged: acknowledgedCodes(assessment.confirmations, command.acknowledged),
        removed,
      })]
      try {
        await sweepTaskTombstones(paths.deletingDir)
      } catch {
        warnings.push(`未提交删除暂存未清理: ${tombstone}`)
      }
      return {
        kind: 'deleted',
        change,
        removed,
        uncommittedDeletions: await countUncommittedTaskDeletions(repoRoot, git),
        warnings,
      }
    })
  }

  /** Commit exactly the moved task: its archived directory, and the original path when git tracked it. */
  async function commitTermination(repoRoot: string, change: string, archived: ArchivedTask): Promise<PathCommitOutcome> {
    try {
      const tracked = await probeChangeTracked(repoRoot, change, git) === 'tracked'
      const paths = [archived.archivedDir, ...(tracked ? [`openspec/changes/${change}`] : [])]
      return await commitOnlyPaths(repoRoot, git, paths, `chore(tenon): terminate ${change}`)
    } catch (error) {
      return { kind: 'failed', detail: error instanceof Error ? error.message : String(error) }
    }
  }

  async function runTerminate(command: TaskLifecycleCommand): Promise<TaskLifecycleOutcome> {
    const ready = preflight(command)
    if ('kind' in ready) return ready
    const { repoRoot, change } = command
    return lockedEnding(repoRoot, change, async () => {
      const { assessment, facts } = await evaluate(repoRoot, change, 'terminate', ready.user)
      if (facts !== null && facts.terminal !== null) return { kind: 'already-terminal', change, result: facts.terminal }
      const refusal = refuse(assessment, command.acknowledged)
      if (refusal !== null) return refusal
      const archived = await archiveTask(archiveDeps(repoRoot), change, 'terminated', facts?.spec ?? 'none')
      const warnings = await recordAudit(auditPathFor(repoRoot, ready.user, 'terminate'), {
        ts: archived.endedAt,
        action: 'terminate',
        change,
        phase: assessment.phase,
        actor: { id: ready.user.id, name: ready.user.name, trust: 'declared' },
        channel: command.channel,
        acknowledged: acknowledgedCodes(assessment.confirmations, command.acknowledged),
      })
      return { kind: 'terminated', change, archived, commit: await commitTermination(repoRoot, change, archived), warnings }
    })
  }

  async function runFinish(command: TaskFinishCommand): Promise<TaskLifecycleOutcome> {
    const { repoRoot, change } = command
    if (!isTaskLifecycleName(change)) return { kind: 'invalid-name', change }
    if (!stateExists(taskChangeDir(repoRoot, change))) return { kind: 'not-found', change }
    return lockedEnding(repoRoot, change, async () => {
      const facts = await changeFacts(deps.store, taskChangeDir(repoRoot, change), specOf)
      if (facts === null || facts.terminal === null) {
        return { kind: 'not-terminal', change, phase: facts?.phase ?? UNKNOWN_PHASE }
      }
      const result: TaskResult = facts.terminal
      return { kind: 'finished', change, archived: await archiveTask(archiveDeps(repoRoot), change, result, facts.spec) }
    })
  }

  return { assess, delete: runDelete, terminate: runTerminate, finish: runFinish }
}
