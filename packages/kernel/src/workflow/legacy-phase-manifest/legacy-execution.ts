/**
 * 旧 phase-manifest 执行适配器——只服务快照里记着 `executionModel: 'phase-manifest'` 的在途任务。
 *
 * 旧引擎的规则（事件边表 flow/transition-table.ts、事件策略 flow/default-event-policy.ts、相位出口表
 * flow/guard.ts 的 EXIT_RULES）由这条适配器驱动；新任务一律走 step-graph。其中 DEFAULT_EVENT_POLICY 与
 * `taskCount` 同时被 step-graph 引用，仍留在 flow/ 原处，没有移进本目录。execution-seam.ts 里选旧适配器的
 * 那一支和本目录同生共死。
 */
import type { PipelineState } from '../../types.js'
import { DEFAULT_EVENT_POLICY, evaluateDefaultEventPreconditions, normalizeDefaultGuardFields } from '../../flow/default-event-policy.js'
import type { EventName } from '../../flow/transition-table.js'
import type { EdgeGuardBlocker, ExecutionAdapter } from '../execution-seam-types.js'
import type { CompiledGuardConfig, GuardInput } from '../ir.js'
import { buildStepGuardInput, type StepGuardContext } from '../stepGuard.js'
import { fieldStr } from '../transition-field-scalar.js'
import { phaseExitGuardContext, unfinishedTaskItems } from './phase-exit-context.js'
import { planDefaultTransition } from './transition-plan-default.js'

/** 事件表里每条事件适用的 guard；事件表之外的事件不是 phase-manifest 工作流该有的。 */
function defaultEventGuards(event: string): readonly CompiledGuardConfig[] {
  if (!Object.hasOwn(DEFAULT_EVENT_POLICY, event)) {
    throw new Error(`phase-manifest workflow 声明了未知 default event '${event}'`)
  }
  return DEFAULT_EVENT_POLICY[event as EventName].guards
}

/** 与 step-graph 共用基础设施能力，但保留旧的 fstr 字段口径（数组 join、缺省空串）。 */
function buildDefaultGuardInput(state: PipelineState, ctx: StepGuardContext): GuardInput {
  return {
    ...buildStepGuardInput(state, ctx),
    fields: normalizeDefaultGuardFields(state.fields),
    track: fieldStr(state.fields.track),
    currentStep: ctx.currentStep ?? fieldStr(state.fields.phase),
  }
}

export const legacyPhaseManifestExecution: ExecutionAdapter = {
  kind: 'legacy-phase-manifest',

  planTransition: ({ state, plan, command, flow, clock }) =>
    planDefaultTransition(state, command, flow, clock, plan),

  readiness: ({ state, context }) => ({
    guardInput: buildDefaultGuardInput(state, context),
    exitsOf: (step) => step.transitions,
    guardsOf: (_step, transition) => defaultEventGuards(transition.event),
  }),

  async exitReport({ plan, state, stepId, changeDir, fileContext, guardCheck }) {
    // 相位出口规则表是「离开本相位」的条件，由出口报告只加给前进边。
    const exitContext = await phaseExitGuardContext(fileContext, changeDir)
    const exit = guardCheck(state, { ...exitContext, coverageProfile: plan.capabilities.track.coverageProfile })
    return {
      phaseExit: {
        failures: exit.failures,
        openTasks: unfinishedTaskItems(exitContext, fileContext?.changeDirRel, stepId),
      },
      async edgeGuards({ event }, context): Promise<readonly EdgeGuardBlocker[]> {
        const result = await evaluateDefaultEventPreconditions(event as EventName, state, context, { stopOnFirstFailure: false })
        if (result === null) return []
        return [
          ...result.lines.map((line) => ({ source: 'guard' as const, code: 'guard-failed', message: line })),
          ...(result.blockers ?? []).map((item) => ({
            source: 'revision' as const, code: item.code, message: `${item.reason}；${item.remediation}`,
          })),
        ]
      },
    }
  },
}
