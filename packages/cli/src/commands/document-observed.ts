/**
 * 观察模式（冻结计划没有旧文档契约的新任务）下的 `tenon document` 子命令。
 *
 * 新任务不预先规定文档：Tenon 在离开步骤时观察实际产出并标注来源技能，只把直接上游的文档产出交给下一步，
 * 下一步读完（`document read`）才能离开。所以这里只有两个有意义的命令——`read` 写读取回执，`status` 看输入 / 产出 /
 * 必须产出——其余（`scaffold` / `record` / `init` / `migrate-delta`）只服务升级前创建的、带契约的任务，在观察模式
 * 一律以退出码 2 拒绝。契约模式的实现仍在 document.ts，两种模式由 `capabilities.documents.mode` 分流。
 */
import { isAbsolute, relative, resolve, sep } from 'node:path'
import {
  recordInputReads, stepOutputsContextFor,
  type EffectiveWorkflowPlan, type PipelineState,
} from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'
import { refuseArchived } from '../endedTaskGuard.js'
import { msg } from '../i18n/messages.js'
import { isValidChangeName, resolveChangeDir } from '../paths.js'
import { str } from '../render.js'
import { effectiveWorkflowForState } from './effective-workflow.js'
import { observedStepDocuments, type StepObservedDocumentsView } from './statusStepParts.js'

/**
 * 冻结计划没有旧文档契约（观察模式）才返回计划，否则 undefined。计划读不了（工作流缺失、不可编译）时也返回
 * undefined：这只是分流前的探测，那个错由随后走契约路径的命令用同一份输入重新读到并自己报出，不在这里吞掉结论。
 */
export function observedPlanOf(deps: CliDeps, state: PipelineState): EffectiveWorkflowPlan | undefined {
  try {
    const plan = effectiveWorkflowForState(deps, state)
    return plan?.capabilities.documents.mode === 'observed' ? plan : undefined
  } catch {
    return undefined
  }
}

/** 任务目录对应的任务是否按观察模式；状态读不了时 false（由随后的命令自己报错，退出码 1）。 */
export async function isObservedChange(deps: CliDeps, dir: string): Promise<boolean> {
  try {
    return observedPlanOf(deps, await deps.store.read(dir)) !== undefined
  } catch {
    return false
  }
}

/**
 * 旧命令在观察模式的统一拒绝：返回要结束命令的退出码（stderr 已写，什么都不写），`undefined` = 不拒绝，继续原路径。
 * 已结束（终止 / 归档）的任务先按结束任务的口径拒绝（退出码 1），其余观察模式任务以退出码 2 说明产出由 Tenon 自动记录。
 * 任务名不合法或状态读不了时不拒绝，让命令自己的校验去报错（退出码 1）。
 */
export async function refuseObservedDocumentCommand(deps: CliDeps, name: string, command: string): Promise<number | undefined> {
  if (!isValidChangeName(name) || !await isObservedChange(deps, resolveChangeDir(deps.cwd, name))) return undefined
  if (await refuseArchived(deps, name)) return 1
  deps.io.err(`ERROR: ${msg(deps, 'document.observed.autoRecorded', { command })}`)
  return 2
}

/** 用户给的路径折成项目相对 POSIX 路径；越出项目（含绝对路径落在项目外）返回 null。只做词法折算，不碰文件系统。 */
function projectRelativePath(cwd: string, input: string): string | null {
  const rel = relative(resolve(cwd), resolve(cwd, input))
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
  return rel.split(sep).join('/')
}

/**
 * `tenon document read <change> all|<path>`：对当前内容取摘要，写进当前步骤访问的读取回执。
 * 给路径时它必须正好是本步的交接输入（kernel 核对），项目外的路径连折算都过不了；回执的读-改-写在任务锁里，
 * 与转换（锁内校验读取、提交前记录产出）互斥。
 */
export async function cmdDocumentObservedRead(deps: CliDeps, name: string, dir: string, target: string): Promise<number> {
  let path = target
  if (target !== 'all') {
    const inside = projectRelativePath(deps.cwd, target)
    if (inside === null) {
      deps.io.err(`ERROR: ${msg(deps, 'document.observed.pathOutsideProject', { path: target })}`)
      return 1
    }
    path = inside
  }
  try {
    await deps.store.withLock(dir, () => recordInputReads(stepOutputsContextFor(dir), path, deps.clock()))
    return 0
  } catch (error) {
    deps.io.err(`ERROR: ${errMsg(error)}`)
    return 1
  }
}

/** 本步还缺的必须产出，每条一句（与 `tenon check` 的守卫失败同一句式）。 */
function missingRequirementLines(deps: CliDeps, stepId: string, documents: StepObservedDocumentsView): readonly string[] {
  return documents.required
    .filter((item) => item.status === 'missing')
    .map((item) => msg(deps, 'document.observed.requiredMissing', { step: stepId, path: item.path }))
}

/**
 * 当前访问还没满足的必须产出（给 `tenon review request` 的 verify-fail 就绪检查用：观察模式没有
 * `verification_report` 字段，改为要求本次验证访问写出验证步声明的必须产出）。
 */
export async function observedRequiredOutputBlockers(
  deps: CliDeps,
  name: string,
  dir: string,
  plan: EffectiveWorkflowPlan,
  state: PipelineState,
  stepId: string,
): Promise<readonly string[]> {
  return missingRequirementLines(deps, stepId, await observedStepDocuments(name, dir, plan, state, stepId))
}

function renderObserved(deps: CliDeps, name: string, plan: EffectiveWorkflowPlan, stepId: string, documents: StepObservedDocumentsView): void {
  const unknown = msg(deps, 'document.observed.skillUnknown')
  deps.io.out(`[DOCUMENT] ${name} (workflow=${plan.id}, step=${stepId}, observation=${documents.observation})`)
  for (const input of documents.inputs) {
    deps.io.out(msg(deps, 'document.observed.inputLine', {
      mark: input.status.toUpperCase(), path: input.path, from: input.from_step, skill: input.skill ?? unknown,
    }))
  }
  for (const output of documents.outputs) {
    deps.io.out(msg(deps, 'document.observed.outputLine', { change: output.change, path: output.path, skill: output.skill ?? unknown }))
  }
  for (const item of documents.required) deps.io.out(`  [${item.status === 'produced' ? 'PRODUCED' : 'MISSING'}] ${item.path}`)
}

/**
 * `tenon document status <change>`（观察模式）：当前步骤的输入（含已读）、本步产出与必须产出。
 * 有未读输入或必须产出缺失退出码 2（状态本身有效，只是离开本步的证据不齐）。
 */
export async function cmdDocumentObservedStatus(
  deps: CliDeps,
  name: string,
  dir: string,
  state: PipelineState,
  plan: EffectiveWorkflowPlan,
  json: boolean,
): Promise<number> {
  const stepId = str(state.fields.phase)
  const documents = await observedStepDocuments(name, dir, plan, state, stepId)
  const unread = documents.inputs.filter((input) => input.status === 'unread')
  const missing = missingRequirementLines(deps, stepId, documents)
  if (json) {
    deps.io.out(JSON.stringify({
      change: name, workflow: plan.id, mode: documents.mode, observation: documents.observation,
      inputs: documents.inputs, outputs: documents.outputs, required: documents.required,
    }))
  } else {
    renderObserved(deps, name, plan, stepId, documents)
    if (unread.length > 0) deps.io.out(`  [FAIL] ${msg(deps, 'document.observed.unreadSummary', { count: unread.length, change: name })}`)
    for (const line of missing) deps.io.out(`  [FAIL] ${line}`)
    if (unread.length === 0 && missing.length === 0) deps.io.out(`  [PASS] ${msg(deps, 'document.observed.pass')}`)
  }
  return unread.length === 0 && missing.length === 0 ? 0 : 2
}
