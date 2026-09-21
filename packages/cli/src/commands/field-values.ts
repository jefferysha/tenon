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
