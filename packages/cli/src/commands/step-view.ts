/**
 * 批量命令（`tenon step run`、`tenon document record --all`）共用的两个小工具：读一个活跃任务的 `step` 投影，
 * 以及一份「把输出收进数组」的 deps，让批量命令能调用既有命令函数、再把它们各自的输出整理成一份说明。
 *
 * 批量命令不另写业务逻辑——每一步都是既有命令函数（document scaffold / record / read、test plan --seed），
 * 动作的顺序与载荷就是 `tenon status --json` 的 `step.next` 给的。
 */
import type { CliDeps } from '../deps.js'
import { errMsg } from '../deps.js'
import { msg } from '../i18n/messages.js'
import { isValidChangeName, readChangeForDisplay } from '../paths.js'
import { effectiveWorkflowForState } from './effective-workflow.js'
import { buildStatusStep, finishedStatusStep, type StepBlock } from './statusStep.js'

/**
 * 任务的 step 投影，与 `tenon status <change> --json` 的 `step` 同一份（已完结的任务给 `stop finished`）；
 * 任务不存在或工作流不可用时给出一句人话原因。
 */
export async function loadStepBlock(deps: CliDeps, name: string): Promise<StepBlock | { readonly error: string }> {
  if (!isValidChangeName(name)) return { error: msg(deps, 'change.nameInvalid', { name }) }
  try {
    const { state, finished } = await readChangeForDisplay((dir) => deps.store.read(dir), deps.cwd, name)
    const plan = effectiveWorkflowForState(deps, state)
    if (finished) return await finishedStatusStep(deps, name, state, plan)
    if (plan === null) return { error: msg(deps, 'step.workflowUnavailable', { name }) }
    return await buildStatusStep(deps, name, state, plan)
  } catch (error) {
    const code = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined
    return { error: code === 'ENOENT' ? msg(deps, 'change.notFound', { name }) : errMsg(error) }
  }
}

export interface Captured {
  readonly deps: CliDeps
  readonly out: string[]
  readonly err: string[]
}

/** 把命令函数的 stdout / stderr 收进数组（每次调用前清空）；其余能力原样沿用。 */
export function capturing(deps: CliDeps): Captured {
  const out: string[] = []
  const err: string[] = []
  return { deps: { ...deps, io: { out: (line) => { out.push(line) }, err: (line) => { err.push(line) } } }, out, err }
}

/** 命令失败时最有信息量的一行：去掉 `ERROR: ` 前缀的第一条错误输出。 */
export function firstError(captured: Pick<Captured, 'err'>, fallback: string): string {
  const line = captured.err.find((item) => item.trim() !== '')
  return line === undefined ? fallback : line.replace(/^ERROR:\s*/u, '').trim()
}
