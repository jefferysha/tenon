/**
 * 门禁只有两种：review（人复核）与 auto（本阶段声明的输出齐全即放行）。`gate: null` 与缺省是 auto 的别名。
 *
 * 编译时把 null 归一成 'auto'，所以新编译的 IR 里不再出现 null。旧的冻结计划照旧带 null 的 IR 与它当时
 * 编进边里的守卫——那份字节就是它们记录的行为（没有输出守卫），读回时不重编译、不改写；隐式完结边也只认
 * IR 里的 gate 值，所以旧计划的完结边同样不会凭空多出守卫。
 *
 * auto 编译成前进出边上的 nonempty-output（展开为逐输出 field-nonempty / output-present），与显式守卫同一条
 * 评估链；退回边（verify-fail、requirements-changed、自定义回边）不挂：修问题的路必须一直开着。
 * 已冻结的旧 auto 计划把守卫挂在每条出边上，这是它们记录的行为，同样不改。
 */
import { compileGuards } from './compile-guards.js'
import type { CompiledGuardConfig, StepIR } from './ir.js'
import type { FieldRef, GateKind } from './types.js'

/**
 * 引擎自己写的输出不进检查：build_sha 由 Build→Verify 出边上的 freeze-build-sha 冻结（手填即伪造 barrier），
 * archived 由完结边自己的 archive-run 写入——离开本阶段之前它们不可能已经在，要求它们是死锁，不是检查。
 * 其余输出（含 pr_url 这类要人填的）照检。
 */
const ENGINE_WRITTEN_OUTPUTS: ReadonlySet<string> = new Set(['build_sha', 'archived'])

/** 这个输出是否由引擎写入（不在 auto 门禁的检查范围内）；Dashboard 的门禁进度同口径。 */
export function isEngineWrittenOutput(field: string): boolean {
  return ENGINE_WRITTEN_OUTPUTS.has(field)
}

export function normalizeGate(gate: GateKind): 'review' | 'auto' {
  return gate === 'review' ? 'review' : 'auto'
}

/** auto 门禁在一条出边上要求的守卫：本阶段声明的（引擎之外写入的）输出全部有值。 */
export function autoGateGuards(stepId: string, outputs: readonly FieldRef[]): CompiledGuardConfig[] {
  const checked = outputs.filter((output) => !isEngineWrittenOutput(output.field))
  return compileGuards([{ type: 'nonempty-output' }], `steps.${stepId}.gate(auto)`, checked)
}

/** 在同一份步骤序（顶层或某条轨道分支）里，给 auto 步骤的前进出边挂上输出齐全守卫。 */
export function withAutoGateGuards(
  steps: readonly StepIR[],
  isForward: (stepIds: readonly string[], from: string, to: string, event: string) => boolean,
): StepIR[] {
  const ids = steps.map((step) => step.id)
  return steps.map((step) => {
    if (step.gate !== 'auto') return step
    const guards = autoGateGuards(step.id, step.outputs)
    if (guards.length === 0) return step
    return {
      ...step,
      transitions: step.transitions.map((transition) => isForward(ids, step.id, transition.to, transition.event)
        ? { ...transition, guards: [...guards, ...transition.guards] }
        : transition),
    }
  })
}
