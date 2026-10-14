/**
 * 本步在文档方面「负责什么」——决定 `next` 里 `validate-spec`（负责 delta spec）、`apply-spec`（负责应用规格）
 * 和测试配置提示的「计划步」。
 *
 * 契约模式（升级前创建的任务）从契约记录读：本步登记的文档里有 delta-spec / applied-spec / plan。
 * 观察模式（新任务）没有契约，改由 YAML 推出（设计 §9），且只对走 OpenSpec 的分支成立：
 *   · 负责 delta spec = 本步有指向 `openspec/changes/{change}/specs/` 的必须产出；
 *   · 负责应用规格   = 本步的离开条件含 `spec-migration-applied`；
 *   · 计划步         = 本步测试策略的 `plan` 为 required。
 */
import { resolveStepTestPolicy, stepRequiredOutputs, type EffectiveWorkflowPlan, type PipelineState, type StepIR } from '@tenon/kernel'
import { str } from '../render.js'
import { leaveGuards } from './exitGuards.js'
import type { StepDocumentsView } from './statusStepParts.js'
import { PLAN_DOCUMENT_KINDS } from './statusStepTestConfig.js'

/** 观察模式里 delta spec 的位置（`{change}` 未渲染，与 YAML 里的写法逐字相同）。 */
const DELTA_SPEC_PREFIX = 'openspec/changes/{change}/specs/'

export interface StepOwnership {
  readonly ownsDeltaSpec: boolean
  readonly ownsAppliedSpec: boolean
  readonly planning: boolean
}

export function stepOwnership(
  plan: EffectiveWorkflowPlan,
  step: StepIR,
  state: PipelineState,
  documents: StepDocumentsView,
): StepOwnership {
  if (documents.mode !== 'observed') {
    return {
      ownsDeltaSpec: documents.records.some((doc) => doc.kind === 'delta-spec'),
      ownsAppliedSpec: documents.records.some((doc) => doc.kind === 'applied-spec'),
      planning: documents.records.some((doc) => PLAN_DOCUMENT_KINDS.has(doc.kind)),
    }
  }
  if (!plan.capabilities.documents.governed) return { ownsDeltaSpec: false, ownsAppliedSpec: false, planning: false }
  return {
    ownsDeltaSpec: stepRequiredOutputs(plan, step.id, str(state.fields.track)).some((pattern) => pattern.startsWith(DELTA_SPEC_PREFIX)),
    ownsAppliedSpec: leaveGuards(plan, step, state).some((guard) => guard.type === 'spec-migration-applied'),
    // 档位（`test: plan|changed|full`）派生的策略恒要求测试计划，旧 `test_policy` 看自己的 plan；档位的 plan 不依赖目录，所以传 undefined。
    planning: resolveStepTestPolicy(step, undefined)?.plan === 'required',
  }
}
