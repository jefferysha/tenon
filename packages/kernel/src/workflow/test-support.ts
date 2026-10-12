/**
 * workflow handler 单测共享基座（G2 P1）——guard-handlers.test.ts 与 action-handlers.test.ts
 * 曾各持一份的全字段 fixture 收拢为单一来源。零 vitest 依赖（同 packages/cli/src/test-support.ts
 * 先例），tsc 正常编译、不进任何运行时路径。
 */
import { FIELD_ORDER, LIST_FIELDS, type FieldName, type InitOptions } from '../types.js'
import { compileDefaultWorkflow, compileWorkflow } from './compile.js'
import { DEFAULT_WORKFLOW_SOURCE, DESIGN_SYSTEM_WORKFLOW_SOURCE } from './default-workflow.generated.js'
import { compileEffectiveWorkflowPlan, effectiveWorkflowPlanBinding, workflowPlanSnapshot } from './effective-plan.js'
import type { EffectiveWorkflowPlan } from './effective-plan-types.js'
import type { WorkflowIR } from './ir.js'
import { parseWorkflow } from './parse.js'
import type { StepDef, StepTransition, TrackBranchDef, WorkflowDef, WorkflowDocumentContractV1 } from './types.js'

const LIST_FIELD_SET: ReadonlySet<string> = new Set<string>(LIST_FIELDS)

/** 全字段初始化，over 覆盖。基底对齐真实 PipelineState 形状（flow/flow.test.ts 同款口径）：
 *  列表字段（LIST_FIELDS）→ []、标量字段 → ''——scalar guard 若误读列表字段会在 fixture 上
 *  立刻炸出（guard-handlers.ts 的数组读值 fail-loud），而不是被 '' 掩过。 */
export function allFields(
  over: Partial<Record<FieldName, string | string[]>> = {},
): Record<FieldName, string | string[]> {
  const fields = {} as Record<FieldName, string | string[]>
  for (const k of FIELD_ORDER) fields[k] = LIST_FIELD_SET.has(k) ? [] : ''
  return { ...fields, ...over }
}

/**
 * 技能全部来自 manifest 叠加的 default 定义（step 自己不声明技能）：manifest-overlay 机制的单测
 * 用它做夹具——该机制仍服务冻结的老快照。
 */
export function legacyDefaultWorkflow(): WorkflowDef {
  const def = parseWorkflow(DEFAULT_WORKFLOW_SOURCE)
  // 分支化之前 default 只有一条 pipeline：spec 的 plan artifact 带 PM 豁免谓词。用 frontend 分支（含其文档契约）还原它。
  const branch = def.tracks?.frontend
  const frontend = branch?.steps ?? def.steps
  return {
    ...def,
    tracks: undefined,
    ...(branch?.documentContract === undefined ? {} : { documentContract: branch.documentContract }),
    steps: frontend.map((step) => ({
      ...step,
      skills: [],
      ...(step.id === 'spec' && step.artifacts !== undefined
        ? { artifacts: step.artifacts.map((artifact) => artifact.field === 'plan' ? { ...artifact, requiredWhen: { kind: 'track-not-in' as const, values: ['pm'] } } : artifact) }
        : {}),
    })),
  }
}

/** 没有技能、字段、守卫的最小步骤；只带出边，供分支夹具拼装。 */
function bareStep(id: string, transitions: readonly StepTransition[] = [], over: Partial<StepDef> = {}): StepDef {
  return { id, label: id, gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions, ...over }
}

/**
 * 已退役的内建 `simple`（change → verify → done / escalated）的原定义：平铺 step-graph 工作流，
 * 带 `scope-expanded` 放弃边与两个终态，供终态 / 放弃 / 隐式完成相关单测当夹具。
 */
export function simpleWorkflow(): WorkflowDef {
  const escalate: StepTransition = { event: 'scope-expanded', to: 'escalated', actions: [{ type: 'archive-run' }] }
  return {
    name: 'simple',
    steps: [
      bareStep('change', [{ event: 'change-complete', to: 'verify' }, escalate], { label: 'Change' }),
      bareStep('verify', [
        { event: 'verify-pass', to: 'done', actions: [{ type: 'mark-verification-passed' }, { type: 'archive-run' }] },
        { event: 'verify-fail', to: 'change', actions: [{ type: 'mark-verification-failed' }] },
        escalate,
      ], { label: 'Verify', skills: [{ id: 'verification-before-completion' }] }),
      bareStep('done', [], { label: 'Done' }),
      bareStep('escalated', [], { label: 'Escalated' }),
    ],
  }
}

/** 真 default 的 `lite` 换成一条最小的五步分支（`spec: none`，不声明文档契约、不带路由与自动化）：存储校验放宽后的最小实例。 */
export function defaultWithLiteBranch(): WorkflowDef {
  const def = parseWorkflow(DEFAULT_WORKFLOW_SOURCE)
  const escalate: StepTransition = { event: 'scope-expanded', to: 'escalated', actions: [{ type: 'archive-run' }] }
  const lite: TrackBranchDef = {
    label: '轻量',
    spec: 'none',
    steps: [
      bareStep('open', [{ event: 'open-complete', to: 'build' }, escalate]),
      bareStep('build', [{ event: 'build-complete', to: 'verify' }, escalate]),
      bareStep('verify', [
        { event: 'verify-pass', to: 'done', actions: [{ type: 'mark-verification-passed' }, { type: 'archive-run' }] },
        { event: 'verify-fail', to: 'build', actions: [{ type: 'mark-verification-failed' }] },
        escalate,
      ], { gate: 'review' }),
      bareStep('done'),
      bareStep('escalated'),
    ],
  }
  return { ...def, tracks: { ...def.tracks, lite } }
}

/** 单分支工作流 `demo`（分支 id `main`，两步 work → done）；over 覆盖分支自己的键。 */
export function branchWith(over: Partial<TrackBranchDef> = {}): WorkflowDef {
  return {
    name: 'demo',
    steps: [],
    tracks: {
      main: {
        steps: [bareStep('work', [{ event: 'work-complete', to: 'done' }]), bareStep('done')],
        ...over,
      },
    },
  }
}

/** 含一个 proposal 槽（属 `branchWith` 的 work 步）的最小文档契约。 */
export function anyContract(): WorkflowDocumentContractV1 {
  return { version: 'v1', slots: [{ kind: 'proposal', ownerStep: 'work', producers: ['tenon'] }], reads: [] }
}

/**
 * 随插件发布的真 default（`templates/workflows/default.yaml` 的生成物）：轨道 `lite` / `pm` / `frontend` / `backend`，
 * 没有 chat / free，离开条件、动作、路由与自动化设置都写在文件里。测试要「项目里放一份 default」就序列化它。
 */
export function targetDefaultWorkflow(): WorkflowDef {
  return parseWorkflow(DEFAULT_WORKFLOW_SOURCE)
}

/** 编译后的真 default（`targetDefaultWorkflow`）；default 带 phase policy artifact，须走 default 专用编译入口。 */
export function compiledDefault(): WorkflowIR {
  return compileDefaultWorkflow(targetDefaultWorkflow())
}

/** 编译后的 `design-system` 模板：没有 `tracks:` 的平铺工作流。 */
export function compiledDesignSystem(): WorkflowIR {
  return compileWorkflow(parseWorkflow(DESIGN_SYSTEM_WORKFLOW_SOURCE))
}

/**
 * 升级前创建、仍在途的 default 任务：冻结快照记着 phase-manifest（旧引擎）。新建任务一律 step-graph，
 * 要在测试里得到旧引擎的任务，就把这份 `initialWorkflow` 交给 `initChange` / `store.init`。
 */
export function legacyDefaultInitialWorkflow(track: string): NonNullable<InitOptions['initialWorkflow']> {
  const plan = compileEffectiveWorkflowPlan('default', undefined, { track, executionModel: 'phase-manifest' })
  return {
    workflow: 'default',
    phase: 'open',
    ...effectiveWorkflowPlanBinding(plan),
    workflowPlanSnapshot: workflowPlanSnapshot(plan),
    openspecContract: true,
  }
}

/** `compiledDefault` 的别名，供生效计划测试使用。 */
export function defaultIr(): WorkflowIR {
  return compiledDefault()
}

/** 计划里该步的必需技能 id（只来自工作流 YAML 声明）。 */
export function requiredSkillsFor(plan: EffectiveWorkflowPlan, step: string): string[] {
  return [...(plan.capabilities.skills.steps.find((candidate) => candidate.stepId === step)?.requiredSkillIds ?? [])]
}
