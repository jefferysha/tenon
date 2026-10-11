import {
  loadTrack,
  parseMaxRoundsText,
  type FieldName,
  type PipelineState,
} from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'
import { msg } from '../i18n/messages.js'
import { resolveChangeDir } from '../paths.js'
import { effectiveWorkflowForState } from './effective-workflow.js'
import { isLegacyExecution } from './execution-cli-seam.js'

const REVIEWISH = ['pending', 'pass', 'fail', 'handled', 'skipped'] as const
const PRE_VERIFY_REVIEW = ['pending', 'pass'] as const
export const REVIEW_GATE_FIELDS = new Set<FieldName>([
  'review_gate_phase', 'review_gate_status', 'review_gate_event', 'review_requested_at', 'review_acknowledged_at', 'review_acknowledged_via',
])

/**
 * 不接受字段写入的槽：值由 transition / owner / review 这些命令的副作用落下。
 *
 * 一处声明两处消费——fields.ts 据它拒写，`status --json` 的 step 投影据它不把这些槽当成「运行器
 * 要填的字段」。两边分开维护时，投影会发出一条 CLI 当场拒绝的 set-field（`archived` 就是这样被
 * 当成「完结要填的值」写成了 archived=true / archived_at=null 的半盖章终态）。
 */
export const TRANSITION_MANAGED_FIELDS: ReadonlySet<string> = new Set<string>([
  'phase', 'phase_status', 'updated_at', 'verified_at',
  'created_by', 'assignee', 'archived', 'archived_at', 'build_sha', 'task_result', ...REVIEW_GATE_FIELDS,
])

const STATIC_ENUMS: Partial<Record<FieldName, readonly string[]>> = {
  preset: ['full', 'hotfix', 'tweak'],
  phase_status: ['pending', 'in_progress', 'done', 'failed'],
  verify_result: REVIEWISH,
  pre_verify_review_result: PRE_VERIFY_REVIEW,
  archived: ['true', 'false'],
  automation: ['off', 'queued', 'scheduled', 'running', 'merged', 'failed', 'conflict', 'paused'],
}

/**
 * 旧执行模型（阶段清单）才有的「怎么做」决定：实现出口的 build_mode / isolation / direct_override，
 * 验证出口的 branch_status。新任务按 YAML 执行，这些决定已删除（设计 §1b Q1、Q2），所以它们的可选值与推荐值
 * 不在通用表里；只对快照记着旧模型的在途任务生效（status 投影里由旧引擎的原生 guard 字段带出，`set` 的取值校验
 * 见 `legacyDecisionValueAllowed`）。旧引擎下个版本删除时，这一段与两处调用一并删。
 */
const LEGACY_DECISION_ENUMS: Partial<Record<FieldName, readonly string[]>> = {
  build_mode: ['direct', 'subagent-driven-development', 'parallel-team', 'prototype'],
  isolation: ['branch', 'worktree', 'in-place'],
  branch_status: REVIEWISH,
  direct_override: ['true', 'false'],
}

export function legacyDecisionEnum(field: string): readonly string[] | undefined {
  return LEGACY_DECISION_ENUMS[field as FieldName]
}

/** 已退役的字段：槽位还在 canonical 闭集里，但没有任何读者，手填也不再有意义。 */
const RETIRED_FIELDS = new Set<FieldName>(['agent_review_result', 'codex_review_result'])

/** 枚举字段的可选值，供 `status --json` 的 step.fields 直接呈现（`phase` 由 manifest 决定，不在此表）。 */
export const STEP_FIELD_ENUMS: Readonly<Record<string, readonly string[] | undefined>> = STATIC_ENUMS

/**
 * 推荐值：原先写在阶段 skill 的散文里，现在与枚举同处一地。持续 / AFK 模式直接取推荐值，人工模式把它排在第一位。
 *
 * 结论字段（pre_verify_review_result / verify_result）没有推荐值——推荐一个 pass 等于让模型自批；
 * 它们的写入由 verdictFieldGate 按本步证据核对，投影只说出口要哪个值（`required`）。
 */
const STATIC_RECOMMENDED: Readonly<Record<string, string>> = {
  preset: 'full',
}

export function RECOMMENDED(field: string): string | undefined {
  return STATIC_RECOMMENDED[field]
}

/**
 * 旧执行模型任务里决定字段的推荐值（原先写在阶段 skill 的散文里：「默认 in-place」）。
 * direct_override 没有推荐值——它是 full + direct 这一组合的显式风险确认；推荐 direct 再推荐豁免 true
 * 是自相矛盾，也等于替人签了风险确认。所以 build_mode 的推荐值取「无需豁免」的那个：
 * full 预设下 pm 轨是原型（`prototype`），其余轨是 `subagent-driven-development`；hotfix / tweak 预设下 `direct` 本来就不需要确认。
 */
export function legacyDecisionRecommended(field: string, state: PipelineState): string | undefined {
  switch (field) {
    case 'isolation': return 'in-place'
    case 'branch_status': return 'handled'
    case 'build_mode':
      if (scalarField(state, 'preset') !== 'full') return 'direct'
      return scalarField(state, 'track') === 'pm' ? 'prototype' : 'subagent-driven-development'
    default: return undefined
  }
}

/**
 * 决定字段（build_mode / isolation / direct_override / branch_status）的取值校验，只对快照记着旧执行模型的任务生效：
 * 新任务没有这些决定，`set` 不替它们校验取值。只在取值不合法时才去读任务的计划判断是不是旧任务（常见路径零开销）；
 * 任务的执行模型在创建时冻结、之后不会变，所以锁外读取不存在竞态。读不到状态或计划就如实报错并拒写
 * （这次写入本来也会因同一个原因失败）。返回 false = 已打印原因。
 */
export async function legacyDecisionValueAllowed(
  deps: CliDeps,
  name: string,
  field: FieldName,
  value: string | string[],
): Promise<boolean> {
  const allowed = legacyDecisionEnum(field)
  if (allowed === undefined || Array.isArray(value) || allowed.includes(value)) return true
  try {
    const state = await deps.store.read(resolveChangeDir(deps.cwd, name))
    const plan = effectiveWorkflowForState(deps, state)
    if (plan === null || !isLegacyExecution(plan)) return true
  } catch (error) {
    deps.io.err(`ERROR: ${errMsg(error)}`)
    return false
  }
  deps.io.err(`ERROR: 非法值 '${value}'，允许: ${allowed.join(' ')}`)
  return false
}

export function enumValueAllowed(deps: CliDeps, field: FieldName, value: string | string[]): boolean {
  if (RETIRED_FIELDS.has(field)) {
    deps.io.err(`ERROR: 字段 '${field}' 已删除——评审改用步骤 agents.reviewers`)
    return false
  }
  // 任务级验证轮次上限：只接受 1 到 20 的规范十进制整数；清空不是一种写法（要恢复工作流声明的上限，由用户决定）。
  if (field === 'max_rounds') {
    if (typeof value === 'string' && parseMaxRoundsText(value) !== undefined) return true
    deps.io.err(`ERROR: ${msg(deps, 'field.maxRoundsInvalid', { value: Array.isArray(value) ? value.join(',') : value })}`)
    return false
  }
  if (Array.isArray(value)) return true
  const allowed = field === 'phase' ? deps.flow.manifest.phases : STATIC_ENUMS[field]
  if (!allowed || allowed.includes(value as never)) return true
  deps.io.err(`ERROR: 非法值 '${value}'，允许: ${allowed.join(' ')}`)
  return false
}

export function scalarField(state: PipelineState, field: FieldName): string {
  const value = state.fields[field]
  return Array.isArray(value) ? value.join(',') : (value ?? '')
}

export function scalarValue(value: string | string[] | undefined, fallback: string): string {
  if (value === undefined) return fallback
  return Array.isArray(value) ? value.join(',') : value
}

/** 最终 {track, workflow} 组合是否成立：该工作流存在，且它有这条轨道（平铺工作流只有与工作流同名的一条）。 */
export function trackWorkflowAllowed(deps: CliDeps, track: string, workflow: string): boolean {
  try {
    loadTrack(deps.cwd, workflow === '' ? 'default' : workflow, track)
    return true
  } catch (error) {
    deps.io.err(`ERROR: ${errMsg(error)}`)
    return false
  }
}

export function fieldPatch(
  field: FieldName,
  value: string | string[],
): Partial<Record<FieldName, string | string[]>> {
  const patch: Partial<Record<FieldName, string | string[]>> = {}
  patch[field] = value
  return patch
}
