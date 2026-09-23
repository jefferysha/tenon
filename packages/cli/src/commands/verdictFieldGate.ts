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
 * 本步没有声明任何就绪证据时（default 的 pm / free / chat build），闸无从核对，照旧放行——
 * 让它可核对的办法是在工作流里给这一步声明测试或评审者。
 */
import {
  defaultEventGuardFields, isForwardExit, phaseExitGuardFields,
  type EffectiveWorkflowPlan, type EventName, type FieldName, type PipelineState,
} from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'
import { resolveChangeDir } from '../paths.js'
import { str } from '../render.js'
import { testEvidenceContextFor, testEvidenceReaderFor } from '../testEvidenceContext.js'
import { effectiveWorkflowForState } from './effective-workflow.js'
import { agentStepViews } from './statusStepAgents.js'

const PRE_VERIFY = 'pre_verify_review_result'
const VERIFY_RESULT = 'verify_result'
export const VERDICT_FIELDS: ReadonlySet<string> = new Set([PRE_VERIFY, VERIFY_RESULT])

/** 当前步出口会读的手填字段 → guard 接受的值（undefined = 只要求非空）。 */
function stepFieldRequirements(
  plan: EffectiveWorkflowPlan,
  state: PipelineState,
  stepId: string,
): ReadonlyMap<string, readonly string[] | undefined> {
  const out = new Map<string, readonly string[] | undefined>()
  const step = plan.workflow.steps.find((candidate) => candidate.id === stepId)
  if (step === undefined) return out
  for (const guard of step.guards) {
    if (guard.type === 'field-equals') out.set(guard.field, [guard.value])
    else if (guard.type === 'field-in') out.set(guard.field, guard.values)
  }
  if (plan.capabilities.execution.model !== 'phase-manifest') return out
  for (const transition of step.transitions) {
    if (!isForwardExit(plan, stepId, transition.to, transition.event)) continue
    for (const item of defaultEventGuardFields(transition.event as EventName, state)) {
      if (!out.has(item.field)) out.set(item.field, item.required)
    }
  }
  for (const item of phaseExitGuardFields(state)) {
    if (!out.has(item.field)) out.set(item.field, item.required)
  }
  return out
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
    if (!item.test.required || item.status === 'passed') continue
    missing.push(`必需测试 ${item.test.id} 未通过（${item.status}）；运行：tenon test run ${name} ${item.test.id}`)
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
    if (plan === null) return false
    const stepId = str(state.fields.phase)
    if (field === VERIFY_RESULT) {
      const requirements = stepFieldRequirements(plan, state, stepId)
      if (!requirements.has(field)) {
        deps.io.err(`ERROR: 字段 '${field}' 由 tenon transition 管理，禁止通过 set/set-many/cas 写入（verify-pass / verify-fail 落值）`)
        return true
      }
      const required = requirements.get(field)
      if (required !== undefined && !required.includes(raw)) {
        deps.io.err(`ERROR: 字段 '${field}' 在步骤 '${stepId}' 只接受 ${required.join(' / ')}`)
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
