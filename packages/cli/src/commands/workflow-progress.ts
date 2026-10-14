import { stepProgressLine } from '@tenon/kernel'
import type { EffectiveWorkflowPlan, PipelineState } from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'
import { changeDir, isValidChangeName, worktreeOfChange } from '../paths.js'
import { effectiveWorkflowForState } from './effective-workflow.js'
import { msg } from '../i18n/messages.js'

function scalar(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join(',') : (value ?? '')
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT'
}

/**
 * 读任务状态：当前根里找不到（ENOENT）时，看它是不是建在 `.worktrees/` 下的某个 worktree 里——在主检出执行
 * `tenon init` 之后、或 `cd <worktree> && tenon transition …` 时 hook 的 cwd 仍是主检出，清单要照常打印。
 * 其余读取失败（状态损坏之类）不回退，原样报错。
 */
async function readForProgress(deps: CliDeps, name: string): Promise<PipelineState> {
  try {
    return await deps.store.read(changeDir(deps.cwd, name))
  } catch (error) {
    if (!isMissing(error)) throw error
    const path = await worktreeOfChange(deps, name)
    if (path === null) throw error
    return await deps.store.read(changeDir(path, name))
  }
}

/**
 * 终端步骤清单：stdout 只写一行（`立项 ✓ → 调研 ● → …`），供 step-progress hook 原样转发。
 * 任何读不到的情形（名字非法、状态读不了、计划解析不出、步骤为空）都退出 1 且 stdout 为空，
 * 原因只写 stderr，hook 因此不会打印半截内容。计划解析与 `workflow plan` 同一路径。
 */
export async function cmdWorkflowProgress(deps: CliDeps, name: string): Promise<number> {
  if (!isValidChangeName(name)) {
    deps.io.err(`ERROR: ${msg(deps, 'change.nameInvalid', { name })}`)
    return 1
  }
  let state: PipelineState
  try {
    state = await readForProgress(deps, name)
  } catch (error) {
    deps.io.err(`ERROR: ${errMsg(error)}`)
    return 1
  }
  let plan: EffectiveWorkflowPlan | null
  try {
    plan = effectiveWorkflowForState(deps, state)
  } catch (error) {
    deps.io.err(`ERROR: ${errMsg(error)}`)
    return 1
  }
  if (plan === null) {
    deps.io.err(`ERROR: workflow '${scalar(state.fields.workflow)}' 未找到`)
    return 1
  }
  const steps = plan.projection.steps
  if (steps.length === 0) {
    deps.io.err(`ERROR: workflow '${plan.id}' 没有可列出的步骤`)
    return 1
  }
  deps.io.out(stepProgressLine(steps, scalar(state.fields.phase), scalar(state.fields.archived) === 'true'))
  return 0
}
