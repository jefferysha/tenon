import {
  assertWorkflowAllowed,
  requireTrackForRoot,
  type FieldName,
  type PipelineState,
  type TrackRegistry,
} from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'

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
  'phase', 'created_by', 'assignee', 'archived', 'archived_at', ...REVIEW_GATE_FIELDS,
])

const STATIC_ENUMS: Partial<Record<FieldName, readonly string[]>> = {
  preset: ['full', 'hotfix', 'tweak'],
  phase_status: ['pending', 'in_progress', 'done', 'failed'],
  build_mode: ['direct', 'subagent-driven-development', 'parallel-team', 'prototype'],
  isolation: ['branch', 'worktree', 'in-place'],
  verify_result: REVIEWISH,
  branch_status: REVIEWISH,
  pre_verify_review_result: PRE_VERIFY_REVIEW,
  direct_override: ['true', 'false'],
  archived: ['true', 'false'],
  automation: ['off', 'queued', 'scheduled', 'running', 'merged', 'failed', 'conflict', 'paused'],
}

/** 已退役的字段：槽位还在 canonical 闭集里，但没有任何读者，手填也不再有意义。 */
const RETIRED_FIELDS = new Set<FieldName>(['agent_review_result', 'codex_review_result'])

/** 枚举字段的可选值，供 `status --json` 的 step.fields 直接呈现（`phase` 由 manifest 决定，不在此表）。 */
export const STEP_FIELD_ENUMS: Readonly<Record<string, readonly string[] | undefined>> = STATIC_ENUMS

/**
 * 推荐值：原先写在阶段 skill 的散文里（「默认 direct」「默认 in-place」），现在与枚举同处一地。
 * 持续 / AFK 模式直接取推荐值，人工模式把它排在第一位。
 */
const STATIC_RECOMMENDED: Readonly<Record<string, string>> = {
  preset: 'full',
  build_mode: 'direct',
  isolation: 'in-place',
  pre_verify_review_result: 'pass',
  branch_status: 'handled',
}

export function RECOMMENDED(field: string, state: PipelineState): string | undefined {
  // direct_override 只在 full + direct 这一种组合下才该是 true，别的组合没有推荐值。
  if (field === 'direct_override') {
    return scalarField(state, 'preset') === 'full' && scalarField(state, 'build_mode') === 'direct'
      ? 'true'
      : undefined
  }
  return STATIC_RECOMMENDED[field]
}

export function enumValueAllowed(deps: CliDeps, field: FieldName, value: string | string[]): boolean {
  if (RETIRED_FIELDS.has(field)) {
    deps.io.err(`ERROR: 字段 '${field}' 已删除——评审改用步骤 agents.reviewers`)
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

export function trackWorkflowAllowed(
  deps: CliDeps,
  registry: TrackRegistry,
  track: string,
  workflow: string,
): boolean {
  try {
    assertWorkflowAllowed(requireTrackForRoot(registry, track, deps.cwd, workflow), workflow)
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
