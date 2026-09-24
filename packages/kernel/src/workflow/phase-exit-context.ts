/**
 * 相位出口规则表（flow/guard.ts 的 EXIT_RULES）的文件面上下文——一处构造，CLI 的 check / status /
 * transition 与 Dashboard 快照共用。
 *
 * 这张表原先只有 `tenon check` 一个调用点，于是同一份状态上几条命令给出不同答案：check 说 FAIL，
 * `status` 的 `exits[].ready` 说 true、blockers 空，Dashboard 也说「可进入下一阶段」。上下文的构造有
 * 真实内容——tasks.md 要按 TaskPlan 预算做有界读取、再判定投影是 current / legacy / invalid——所以它
 * 必须是同一份，而不是各处各抄一遍。
 *
 * coverageProfile 不在这里合成：它来自调用方已绑定的 effective plan（registry 损坏或 track 成
 * orphan 时要 fail-loud，不能由 fs 工厂猜）。
 */
import { classifyTaskPlanProjectionForChange, TASK_PLAN_CURRENT_FILE, TASK_PLAN_STATE_DIR } from '../state/task-plan-store.js'
import { TASK_PLAN_LIMITS } from '../task-plan/types.js'
import type { GuardContext } from '../types.js'
import { incompletePipelineTasksForExit } from './todo-projection.js'

export type BoundedFileRead =
  | { readonly kind: 'ok'; readonly text: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid' }

/** 宿主提供的文件面探针；`coverageProfile` 由调用方补齐后交给 `guardCheck`。 */
export type PhaseExitFileContext = Omit<GuardContext, 'coverageProfile'> & {
  /** 先认证普通文件身份和 byte cap，再物化文本；TaskPlan hostile-input 边界不得用 readFile 代替。 */
  readonly readFileBounded?: (path: string, maxBytes: number) => BoundedFileRead
}

/** 文件面上下文；`coverageProfile` 由调用方补齐后交给 `flow.guardCheck`。 */
export type PhaseExitGuardContext = Omit<GuardContext, 'coverageProfile'>

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength
}

/**
 * `fileContext` 为 undefined（宿主未注入文件面）时返回 undefined：规则表退化为纯字段面
 * （prd_path / pr_url / verify_result 这些槽不降级），文件、覆盖与任务面跳过。
 */
export async function phaseExitGuardContext(
  fileContext: PhaseExitFileContext | undefined,
  dir: string,
): Promise<PhaseExitGuardContext | undefined> {
  if (fileContext === undefined) return undefined
  const tasksPath = fileContext.changeDirRel === undefined
    ? undefined
    : `${fileContext.changeDirRel}/tasks.md`
  const canonicalStatePath = fileContext.changeDirRel === undefined
    ? undefined
    : `${fileContext.changeDirRel}/${TASK_PLAN_STATE_DIR}/${TASK_PLAN_CURRENT_FILE}`
  const boundedCanonicalState = canonicalStatePath === undefined
    ? undefined
    : fileContext.readFileBounded === undefined
      ? { kind: 'invalid' as const }
      : fileContext.readFileBounded(canonicalStatePath, TASK_PLAN_LIMITS.maxRevisionBytes)
  const canonicalStatePresent = boundedCanonicalState?.kind === 'ok'
  const tasksByteLimit = canonicalStatePresent
    ? TASK_PLAN_LIMITS.maxRevisionBytes
    : TASK_PLAN_LIMITS.maxLegacyProjectionBytes
  const boundedTasks = tasksPath === undefined
    ? undefined
    : fileContext.readFileBounded === undefined
      ? { kind: 'invalid' as const }
      : fileContext.readFileBounded(tasksPath, tasksByteLimit)
  const authenticatedTasksSource = boundedTasks?.kind === 'ok' ? boundedTasks.text : undefined
  let projection: 'current' | 'legacy' | 'invalid' =
    boundedCanonicalState?.kind === 'invalid'
    || boundedTasks?.kind === 'invalid'
    || (canonicalStatePresent && boundedTasks?.kind === 'missing')
      ? 'invalid'
      : 'legacy'
  if (authenticatedTasksSource !== undefined) {
    try {
      projection = await classifyTaskPlanProjectionForChange(dir, authenticatedTasksSource)
      if (
        projection === 'legacy'
        && byteLength(authenticatedTasksSource) > TASK_PLAN_LIMITS.maxLegacyProjectionBytes
      ) projection = 'invalid'
    } catch {
      // Corrupt or concurrently replaced canonical state is not legacy. It must block the guard.
      projection = 'invalid'
    }
  }
  // Invalid bounded input stays present as an empty sentinel so every phase reaches the explicit
  // authentication failure instead of treating an oversized legacy file as an absent optional one.
  const guardedTasksSource = projection === 'invalid' && authenticatedTasksSource === undefined
    ? ''
    : authenticatedTasksSource
  return {
    ...fileContext,
    readFile: (path: string) => path === tasksPath ? guardedTasksSource : fileContext.readFile?.(path),
    ...(guardedTasksSource === undefined
      ? {}
      : {
          canonicalTasksProjectionStatus: ({ changeDirRel, tasksMarkdown }) =>
            changeDirRel === fileContext.changeDirRel && tasksMarkdown === guardedTasksSource
              ? projection
              : 'invalid',
        }),
  }
}

/**
 * 截至本步仍未勾选的任务原文——与出口规则同一份有界读取与投影认证，让阻断自带要做的事，
 * 而不是只给一句「仍有 N 项未勾」。
 */
export function unfinishedTaskItems(
  context: PhaseExitGuardContext | undefined,
  changeDirRel: string | undefined,
  stepId: string,
): readonly string[] {
  if (context === undefined || changeDirRel === undefined) return []
  const tasksPath = `${changeDirRel}/tasks.md`
  const markdown = context.readFile?.(tasksPath)
  if (markdown === undefined || markdown === '') return []
  const projection = context.canonicalTasksProjectionStatus?.({ changeDirRel, tasksMarkdown: markdown }) ?? 'legacy'
  if (projection === 'invalid') return []
  return incompletePipelineTasksForExit({
    phase: stepId,
    tasksMarkdown: markdown,
    trustedCanonicalProjection: projection === 'current',
  }).items
}
