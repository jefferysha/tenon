/**
 * `task delete|archive|unarchive <name> [--yes] [--json]` and `list --archived`. Progress text goes to
 * stderr, machine output to stdout, and the exit code says what happened: 0 done · 1 usage, name, missing
 * task, missing identity, malformed store or failure · 2 confirmation required (rerun with `--yes`) ·
 * 3 blocked. Every refusal is decided by the shared kernel application, so the Dashboard agrees exactly.
 */
import { readTaskArchive, taskLifecycleUnlockHint, USER_MISSING_HINT } from '@tenon/kernel'
import type { TaskLifecycleApplication, TaskLifecycleOutcome, TaskLifecycleReason, TaskLifecycleReasonCode } from '@tenon/kernel'
import type { CliDeps } from '../deps.js'
import { renderTable } from '../render.js'
import { requireUser } from '../userIdentity.js'

const REASON_TEXT: Readonly<Record<TaskLifecycleReasonCode, string>> = {
  'afk-running': 'AFK 运行中',
  'afk-queued': 'AFK 排队',
  'review-pending': '评审待确认',
  'host-session-live': '会话活跃',
  'has-dependents': '被依赖',
  'owned-by-other': '他人负责',
}

export interface TaskLifecycleOpts {
  readonly yes?: boolean
  readonly json?: boolean
}

function application(deps: CliDeps): TaskLifecycleApplication | null {
  if (deps.taskLifecycle !== undefined) return deps.taskLifecycle
  deps.io.err('ERROR: 任务生命周期能力未装配')
  return null
}

function reportReasons(deps: CliDeps, change: string, reasons: readonly TaskLifecycleReason[]): void {
  for (const reason of reasons) {
    const hint = taskLifecycleUnlockHint(reason.code, change)
    deps.io.err([
      `  ${REASON_TEXT[reason.code]}`,
      reason.detail === undefined ? '' : ` ${reason.detail}`,
      hint === undefined ? '' : ` → ${hint}`,
    ].join(''))
  }
}

/** Maps every non-success outcome to its exit code; a success outcome returns `null`. */
function reportRefusal(deps: CliDeps, change: string, outcome: TaskLifecycleOutcome): number | null {
  switch (outcome.kind) {
    case 'invalid-name':
      deps.io.err(`ERROR: change-name 非法: '${outcome.change}'（仅允许 a-z A-Z 0-9 - _，且不能是 archive）`)
      return 1
    case 'not-found':
      deps.io.err(`ERROR: 任务不存在: ${outcome.change}`)
      return 1
    case 'identity-missing':
      deps.io.err(`ERROR: ${USER_MISSING_HINT}`)
      return 1
    case 'archive-store-corrupt':
      deps.io.err(`ERROR: 归档记录损坏: ${outcome.path}`)
      return 1
    case 'delete-failed':
      deps.io.err(`ERROR: 删除失败: ${outcome.cause}`)
      return 1
    case 'blocked':
      deps.io.err(`ERROR: 任务 '${change}' 被阻止`)
      reportReasons(deps, change, outcome.reasons)
      return 3
    case 'confirmation-required':
      deps.io.err(`ERROR: 任务 '${change}' 需要确认；确认后加 --yes 重试`)
      reportReasons(deps, change, outcome.reasons)
      return 2
    default:
      return null
  }
}

export async function cmdTaskDelete(deps: CliDeps, name: string, opts: TaskLifecycleOpts): Promise<number> {
  const app = application(deps)
  if (app === null) return 1
  const outcome = await app.delete({
    repoRoot: deps.cwd,
    change: name,
    user: deps.user(),
    channel: 'terminal',
    acknowledged: opts.yes === true ? 'all' : [],
  })
  const refusal = reportRefusal(deps, name, outcome)
  if (refusal !== null) return refusal
  if (outcome.kind !== 'deleted') return 1
  for (const warning of outcome.warnings) deps.io.err(`WARN: ${warning}`)
  if (opts.json === true) {
    deps.io.out(JSON.stringify({
      change: outcome.change,
      removed: outcome.removed,
      uncommitted_deletions: outcome.uncommittedDeletions,
    }))
    return 0
  }
  deps.io.err(`[DELETE] ${outcome.change}`)
  if (outcome.uncommittedDeletions !== null) deps.io.err(`未提交删除 ${outcome.uncommittedDeletions}`)
  return 0
}

export async function cmdTaskArchive(deps: CliDeps, name: string, opts: TaskLifecycleOpts): Promise<number> {
  const app = application(deps)
  if (app === null) return 1
  const outcome = await app.archive({
    repoRoot: deps.cwd,
    change: name,
    user: deps.user(),
    channel: 'terminal',
    acknowledged: opts.yes === true ? 'all' : [],
  })
  const refusal = reportRefusal(deps, name, outcome)
  if (refusal !== null) return refusal
  if (outcome.kind !== 'archived') return 1
  if (opts.json === true) {
    deps.io.out(JSON.stringify({
      change: outcome.change,
      changed: outcome.changed,
      archived_at: outcome.entry.archivedAt,
      phase: outcome.entry.phase,
    }))
    return 0
  }
  deps.io.err(`[ARCHIVE] ${outcome.change} phase=${outcome.entry.phase}`)
  return 0
}

export async function cmdTaskUnarchive(deps: CliDeps, name: string, opts: TaskLifecycleOpts): Promise<number> {
  const app = application(deps)
  if (app === null) return 1
  const outcome = await app.unarchive({ repoRoot: deps.cwd, change: name, user: deps.user(), channel: 'terminal' })
  const refusal = reportRefusal(deps, name, outcome)
  if (refusal !== null) return refusal
  if (outcome.kind !== 'unarchived') return 1
  if (opts.json === true) {
    deps.io.out(JSON.stringify({ change: outcome.change, changed: outcome.changed }))
    return 0
  }
  deps.io.err(`[UNARCHIVE] ${outcome.change}`)
  return 0
}

export async function cmdListArchived(deps: CliDeps, opts: { readonly json?: boolean }): Promise<number> {
  const user = requireUser(deps)
  if (user === null) return 1
  const read = await readTaskArchive(deps.cwd, user)
  if (read.kind === 'corrupt') {
    deps.io.err(`ERROR: 归档记录损坏: ${read.path}`)
    return 1
  }
  const rows = Object.keys(read.archive.changes).sort().map((name) => {
    const entry = read.archive.changes[name]
    return { name, phase: entry?.phase ?? '', archivedAt: entry?.archivedAt ?? '', actor: entry?.actor.name ?? '' }
  })
  if (opts.json === true) {
    deps.io.out(JSON.stringify({
      changes: rows.map((row) => ({
        name: row.name, phase: row.phase, archived_at: row.archivedAt, actor: row.actor,
      })),
    }))
    return 0
  }
  if (rows.length === 0) {
    deps.io.out('无已归档 change')
    return 0
  }
  const table = renderTable(
    ['NAME', 'PHASE', 'ARCHIVED_AT', 'BY'],
    rows.map((row) => [row.name, row.phase, row.archivedAt, row.actor]),
  )
  for (const line of table) deps.io.out(line)
  return 0
}
