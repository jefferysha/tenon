/**
 * `task delete|terminate|finish <name> [--yes] [--json]`. Progress text goes to stderr, machine output to
 * stdout, and the exit code says what happened: 0 done · 1 usage, name, missing task, missing identity,
 * wrong state or failure · 2 confirmation required (rerun with `--yes`) · 3 blocked. Every refusal is decided
 * by the shared kernel application, so the Dashboard agrees exactly.
 *
 * 结束一个任务只有两条路，都把任务目录移进 `openspec/changes/archive/`：`finish`（状态机已走到终态：完结 /
 * 已升级）与 `terminate`（任何还没走完的任务）。没有「隐藏」；`archive` / `unarchive` 已退役，报错并指向 `terminate`。
 */
import { taskLifecycleUnlockHint, USER_MISSING_HINT } from '@tenon/kernel'
import type {
  PathCommitOutcome, TaskLifecycleApplication, TaskLifecycleOutcome, TaskLifecycleReason, TaskLifecycleReasonCode,
  TaskResult,
} from '@tenon/kernel'
import type { CliDeps } from '../deps.js'
import { pruneHostAgents } from './agent-host.js'

const REASON_TEXT: Readonly<Record<TaskLifecycleReasonCode, string>> = {
  'afk-running': 'AFK 运行中',
  'afk-queued': 'AFK 排队',
  'review-pending': '评审待确认',
  'host-session-live': '会话活跃',
  'has-dependents': '被依赖',
  'owned-by-other': '他人负责',
}

const RESULT_TEXT: Readonly<Record<TaskResult, string>> = {
  finished: '完结',
  escalated: '已升级',
  terminated: '已终止',
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

/**
 * 任务被删除或终止之后，回收不再被任何在途任务引用的宿主 agent 文件（此前只有转换到完结才回收）。
 * 尽力而为：失败只 WARN，任务的删除 / 终止已经成功。
 */
async function reclaimHostAgents(deps: CliDeps, change: string): Promise<void> {
  const pruned = await pruneHostAgents(deps, change)
  if (pruned !== undefined && pruned.removed.length > 0) {
    deps.io.err(`[AGENT] 已回收宿主 agent 文件：${pruned.removed.join(', ')}`)
  }
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
    case 'delete-failed':
      deps.io.err(`ERROR: 删除失败: ${outcome.cause}`)
      return 1
    case 'archive-failed':
      deps.io.err(`ERROR: 归档失败（${outcome.code}）: ${outcome.cause}`)
      return 1
    case 'not-terminal':
      deps.io.err(
        `ERROR: 任务 '${change}' 还没走到终态（phase=${outcome.phase}），不能完结；`
        + `要放弃它请执行 tenon task terminate ${change}`,
      )
      return 1
    case 'already-terminal':
      deps.io.err(
        `ERROR: 任务 '${change}' 的状态机已走完（${RESULT_TEXT[outcome.result]}），不能终止；`
        + `执行 tenon task finish ${change} 归档它`,
      )
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
  await reclaimHostAgents(deps, name)
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

function commitLine(commit: PathCommitOutcome, change: string): string | null {
  if (commit.kind === 'committed') return `[COMMIT] chore(tenon): terminate ${change}`
  if (commit.kind === 'failed') return `WARN: 终止已完成，但提交失败：${commit.detail}；任务目录改动留在工作区`
  return null
}

export async function cmdTaskTerminate(deps: CliDeps, name: string, opts: TaskLifecycleOpts): Promise<number> {
  const app = application(deps)
  if (app === null) return 1
  const outcome = await app.terminate({
    repoRoot: deps.cwd,
    change: name,
    user: deps.user(),
    channel: 'terminal',
    acknowledged: opts.yes === true ? 'all' : [],
  })
  const refusal = reportRefusal(deps, name, outcome)
  if (refusal !== null) return refusal
  if (outcome.kind !== 'terminated') return 1
  for (const warning of outcome.warnings) deps.io.err(`WARN: ${warning}`)
  await reclaimHostAgents(deps, name)
  if (opts.json === true) {
    deps.io.out(JSON.stringify({
      change: outcome.change,
      result: outcome.archived.result,
      archived_dir: outcome.archived.archivedDir,
      ended_at: outcome.archived.endedAt,
      commit: outcome.commit.kind,
    }))
    return 0
  }
  deps.io.err(`[TERMINATE] ${outcome.change} → ${outcome.archived.archivedDir}`)
  const line = commitLine(outcome.commit, outcome.change)
  if (line !== null) deps.io.err(line)
  return 0
}

export async function cmdTaskFinish(deps: CliDeps, name: string, opts: TaskLifecycleOpts): Promise<number> {
  const app = application(deps)
  if (app === null) return 1
  const outcome = await app.finish({ repoRoot: deps.cwd, change: name })
  const refusal = reportRefusal(deps, name, outcome)
  if (refusal !== null) return refusal
  if (outcome.kind !== 'finished') return 1
  if (opts.json === true) {
    deps.io.out(JSON.stringify({
      change: outcome.change,
      result: outcome.archived.result,
      archived_dir: outcome.archived.archivedDir,
      ended_at: outcome.archived.endedAt,
    }))
    return 0
  }
  deps.io.err(`[FINISH] ${outcome.change} ${RESULT_TEXT[outcome.archived.result]} → ${outcome.archived.archivedDir}`)
  return 0
}

/** `task archive|unarchive`：「隐藏」已删除，结束任务只剩 finish 与 terminate。 */
export function cmdTaskRetired(deps: CliDeps, sub: 'archive' | 'unarchive', name: string): number {
  const target = name === '' ? '<任务>' : name
  deps.io.err(
    `ERROR: tenon task ${sub} 已退役：任务不再有「隐藏」，结束任务只有两条路——`
    + `走完状态机后 tenon task finish ${target}，中途放弃用 tenon task terminate ${target}`,
  )
  return 1
}
