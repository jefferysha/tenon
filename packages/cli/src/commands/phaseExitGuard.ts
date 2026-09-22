/**
 * 相位出口规则表（kernel flow/guard.ts 的 EXIT_RULES）的文件面上下文——一处构造，三处消费。
 *
 * 这张表原先只有 `tenon check` 一个调用点，于是同一份状态上三条命令给三个答案：check 说 FAIL
 * exit 2，`status` 的 `exits[].ready` 说 true、blockers 空，`transition` 直接放行（pm 就这样带着
 * prd_path=null 走完 ship 与 archive）。上下文的构造有真实内容——tasks.md 要按 TaskPlan 预算做
 * 有界读取、再判定投影是 current / legacy / invalid——所以它必须是同一份，而不是三处各抄一遍。
 *
 * coverageProfile 不在这里合成：它来自调用方已绑定的 effective plan（registry 损坏或 track 成
 * orphan 时要 fail-loud，不能由 fs 工厂猜）。
 */
import {
  classifyTaskPlanProjectionForChange,
  TASK_PLAN_CURRENT_FILE,
  TASK_PLAN_LIMITS,
  TASK_PLAN_STATE_DIR,
  type GuardContext,
} from '@tenon/kernel'
import type { GuardFileContext } from '../deps.js'

/** 文件面上下文；`coverageProfile` 由调用方补齐后交给 `flow.guardCheck`。 */
export type PhaseExitGuardContext = Omit<GuardContext, 'coverageProfile'>

/**
 * `fileContext` 为 undefined（宿主未注入 `deps.guardCtx`）时返回 undefined：规则表退化为纯字段面
 * （prd_path / pr_url / verify_result 这些槽不降级），文件、覆盖与任务面跳过——与注入前的既有语义
 * 逐字一致。调用方把已解析好的 `deps.guardCtx(name)` 传进来，每条命令只解析一次。
 */
export async function phaseExitGuardContext(
  fileContext: GuardFileContext | undefined,
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
        && Buffer.byteLength(authenticatedTasksSource) > TASK_PLAN_LIMITS.maxLegacyProjectionBytes
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
