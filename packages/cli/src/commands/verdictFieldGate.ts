/**
 * 结论字段的写入闸：`pre_verify_review_result` 与 `verify_result` 是「本步已经通过」的结论，
 * 不是一个可以随手填的值。
 *
 * 真机验收：build 步的 `next` 给出 `set-field pre_verify_review_result recommended:"pass"`，模型
 * 照做 `tenon set`，没有任何证据或人工确认绑定——一次自批。契约
 * （docs/CONTRACT.md「Build pre-Verify readiness 门」、openspec/specs/plugin-runtime「Build→Verify
 * SHALL 先全量收敛再独立复核」）说的是「只有 readiness 证据完整时才可置 pass」；在数据驱动的
 * 工作流里，那份证据就是本步声明的必需测试、执行者与必需评审者。于是：
 *
 *   · 置 `pass` 要求本步声明的就绪证据全部成立（必需测试在当前候选上通过、执行者完成、必需评审者
 *     通过）；缺哪一条就点名哪一条和解开它的命令。置回 `pending` 永远允许——那是撤回，不是批准。
 *   · `verify_result` 由 verify-pass / verify-fail 转换落值；只有当前步的出口 guard 点名它为手填
 *     结论（default 的 pm verify）时才接受写入，且只接受 guard 要的值、同样要证据。
 *
 * default 的每条轨道 build 都声明了就绪证据：frontend / backend 是必需测试，pm 是必需评审者
 * `spec-consistency`（真机：这几条轨道从前什么都不声明，模型直接 set pass 自批）。
 * 自定义工作流的某一步没有声明任何就绪证据时，闸无从核对，照旧放行——让它可核对的办法是在
 * 工作流里给这一步声明测试或评审者。读不到任务的工作流计划（文件被删且没有冻结快照）则不同：没有声明可言，
 * 闸失败关闭，拒写这两个字段并说明修法，不放行自批。
 *
 * 「哪些字段是手填的结论、只接受哪些值」读的是离开条件：按 YAML 执行的任务取步骤 guards ∪ 前进边 guards
 * （`leaveGuards`），拒写原因用 kernel 的 guard 渲染，与离开条件失败是同一句话；旧执行模型（阶段清单）的任务
 * 沿用事件策略表与旧文案，旧引擎下个版本删除时这一支一并删。
 */
import {
  defaultEventGuardFields, evaluateWorkflowIrStepGuards, INLINE_SUITE_PREFIX, isForwardExit, phaseExitGuardFields,
  isValidWorkflowName, renderTestBlocker, resolveWorkflowName, testItemSettled,
  type CompiledGuardConfig, type EffectiveWorkflowPlan, type EventName, type FieldName, type PipelineState, type StepIR,
} from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'
import { resolveChangeDir } from '../paths.js'
import { str } from '../render.js'
import { testEvidenceContextFor, testEvidenceReaderFor } from '../testEvidenceContext.js'
import { effectiveWorkflowForState } from './effective-workflow.js'
import { isLegacyExecution } from './execution-cli-seam.js'
import { leaveGuards } from './exitGuards.js'
import { agentStepViews } from './statusStepAgents.js'

const PRE_VERIFY = 'pre_verify_review_result'
const VERIFY_RESULT = 'verify_result'
export const VERDICT_FIELDS: ReadonlySet<string> = new Set([PRE_VERIFY, VERIFY_RESULT])

type FieldGuard = Extract<CompiledGuardConfig, { readonly type: 'field-equals' | 'field-in' }>

function isFieldGuard(guard: CompiledGuardConfig): guard is FieldGuard {
  return guard.type === 'field-equals' || guard.type === 'field-in'
}

/** 按 YAML 执行的任务：当前步离开条件（步骤 guards ∪ 前进边 guards）里点名每个字段的 field-equals / field-in。 */
function leaveFieldGuards(plan: EffectiveWorkflowPlan, state: PipelineState, step: StepIR): ReadonlyMap<string, readonly FieldGuard[]> {
  const out = new Map<string, FieldGuard[]>()
  for (const guard of leaveGuards(plan, step, state)) {
    if (!isFieldGuard(guard)) continue
    out.set(guard.field, [...(out.get(guard.field) ?? []), guard])
  }
  return out
}

/** 旧执行模型的任务：当前步出口会读的手填字段 → guard 接受的值（undefined = 只要求非空）。 */
function legacyFieldRequirements(
  plan: EffectiveWorkflowPlan,
  state: PipelineState,
  step: StepIR,
): ReadonlyMap<string, readonly string[] | undefined> {
  const out = new Map<string, readonly string[] | undefined>()
  for (const guard of step.guards) {
    if (guard.type === 'field-equals') out.set(guard.field, [guard.value])
    else if (guard.type === 'field-in') out.set(guard.field, guard.values)
  }
  for (const transition of step.transitions) {
    if (!isForwardExit(plan, step.id, transition.to, transition.event)) continue
    for (const item of defaultEventGuardFields(transition.event as EventName, state)) {
      if (!out.has(item.field)) out.set(item.field, item.required)
    }
  }
  for (const item of phaseExitGuardFields(state)) {
    if (!out.has(item.field)) out.set(item.field, item.required)
  }
  return out
}

const MANAGED_BY_TRANSITION = `ERROR: 字段 '${VERIFY_RESULT}' 由 tenon transition 管理，禁止通过 set/set-many/cas 写入（verify-pass / verify-fail 落值）`

/**
 * `verify_result` 的手填闸：只有当前步出口点名它为手填结论、且写入的值被那条离开条件接受才放行。
 * 返回拒写原因（整行 ERROR），放行返回 null。
 */
async function verifyResultRefusal(
  plan: EffectiveWorkflowPlan,
  state: PipelineState,
  dir: string,
  step: StepIR,
  raw: string,
): Promise<string | null> {
  if (isLegacyExecution(plan)) {
    const requirements = legacyFieldRequirements(plan, state, step)
    if (!requirements.has(VERIFY_RESULT)) return MANAGED_BY_TRANSITION
    const required = requirements.get(VERIFY_RESULT)
    return required !== undefined && !required.includes(raw)
      ? `ERROR: 字段 '${VERIFY_RESULT}' 在步骤 '${step.id}' 只接受 ${required.join(' / ')}`
      : null
  }
  const guards = leaveFieldGuards(plan, state, step).get(VERIFY_RESULT)
  if (guards === undefined) return MANAGED_BY_TRANSITION
  // 把要写的值代入后求值同一批离开条件：不接受就原样用它们的失败文案，不在这里另拼。
  const result = await evaluateWorkflowIrStepGuards(
    { ...state, fields: { ...state.fields, [VERIFY_RESULT]: raw } },
    { ...step, guards },
    { changeDirAbs: dir },
  )
  return result.pass ? null : `ERROR: 拒绝写入 ${VERIFY_RESULT}=${raw}：${result.failures.join('；')}`
}

/** 本步就绪证据里还差的项，每项一句话 + 解开它的命令；空 = 证据齐全（或本步没声明证据）。 */
async function missingEvidence(
  deps: CliDeps,
  name: string,
  dir: string,
  state: PipelineState,
  plan: EffectiveWorkflowPlan,
  stepId: string,
): Promise<readonly string[]> {
  const missing: string[] = []
  const tests = await testEvidenceReaderFor(deps)({
    repoRoot: deps.cwd, changeDir: dir, changeName: name, plan, stepId,
    context: testEvidenceContextFor(deps, name),
  })
  for (const item of tests.items) {
    if (!item.test.required || testItemSettled(item)) continue
    missing.push(`必需测试 ${item.test.id} 未通过（${item.status}）；运行：tenon test run ${name} ${item.test.id}`)
  }
  // 步骤测试策略（目录套件 × 计划）：旧步骤测试已在上面逐项列过（内联套件 id 以 `step:` 开头，即 INLINE_SUITE_PREFIX），
  // 待评审批准的豁免与待确认的测试配置改动留给这一步之后的 review request，不算「结论之前的证据缺口」。
  for (const blocker of tests.policy?.blockers ?? []) {
    if (!blocker.blocking || blocker.code === 'waiver-unapproved' || blocker.code === 'protected-file-unapproved'
      || blocker.code === 'protected-file-tampered' || blocker.subject?.startsWith(INLINE_SUITE_PREFIX) === true) continue
    missing.push(renderTestBlocker(blocker))
  }
  const agents = await agentStepViews(deps, name, dir, state, plan, stepId)
  for (const view of agents.executors) {
    if (view.status !== 'pass') missing.push(`执行者 ${view.agent} 未完成（${view.status}）；运行：tenon agent next ${name}`)
  }
  for (const view of agents.reviewers) {
    if (view.required && view.status !== 'pass') {
      missing.push(`必需评审者 ${view.agent} 未通过（${view.status}）；运行：tenon agent next ${name}`)
    }
  }
  return missing
}

/**
 * 读不到工作流计划的拒写原因。状态里记的 workflow 名可被改成任意文本，只有合法的工作流名才回显、才拼进恢复路径。
 */
function unreadablePlanMessage(name: string, field: FieldName, workflow: string): string {
  const named = isValidWorkflowName(workflow) ? `workflow '${workflow}'` : '它记着的 workflow（名字不合法，不予回显）'
  const restore = isValidWorkflowName(workflow) ? `恢复 .pipeline/workflows/${workflow}.yaml，或运行` : '运行'
  return `ERROR: 无法核对字段 '${field}' 的证据：读不到任务 '${name}' 的工作流计划（${named}未找到，任务也没有冻结的计划快照）。`
    + `${restore} tenon task terminate ${name} 后新建任务`
}

/**
 * true = 已拒写并打印原因。在 set / set-many / cas 的字段校验之后、落盘之前调用。
 * 判定在写锁之外：证据在判定与落盘之间被并发改动的窗口与其余 guard 预检同一口径。
 */
export async function refuseUnprovenVerdict(
  deps: CliDeps,
  name: string,
  field: FieldName,
  value: string | string[],
): Promise<boolean> {
  if (!VERDICT_FIELDS.has(field)) return false
  const raw = Array.isArray(value) ? value.join(',') : value
  if (field === PRE_VERIFY && raw !== 'pass') return false
  try {
    const dir = resolveChangeDir(deps.cwd, name)
    const state = await deps.store.read(dir)
    const plan = effectiveWorkflowForState(deps, state)
    if (plan === null) {
      // 结论是「本步已通过」的批准，读不到计划就没有声明的证据可核对：失败关闭，不能当成「无需核对」放行。
      deps.io.err(unreadablePlanMessage(name, field, resolveWorkflowName(state)))
      return true
    }
    const stepId = str(state.fields.phase)
    if (field === VERIFY_RESULT) {
      const step = plan.workflow.steps.find((candidate) => candidate.id === stepId)
      const refusal = step === undefined ? MANAGED_BY_TRANSITION : await verifyResultRefusal(plan, state, dir, step, raw)
      if (refusal !== null) {
        deps.io.err(refusal)
        return true
      }
    }
    const missing = await missingEvidence(deps, name, dir, state, plan, stepId)
    if (missing.length === 0) return false
    deps.io.err(`ERROR: 字段 '${field}' 是步骤 '${stepId}' 的通过结论，只能在本步就绪证据齐全后写入 '${raw}'：`)
    for (const line of missing) deps.io.err(`  - ${line}`)
    return true
  } catch (error) {
    deps.io.err(`ERROR: 无法核对字段 '${field}' 的证据：${errMsg(error)}`)
    return true
  }
}
