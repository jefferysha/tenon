/**
 * 验证轮次上限的取值、解析与解析顺序（叶子模块：没有任何运行时依赖，workflow 解析、序列化与 Dashboard
 * 解码都可以直接引用，不会把文件系统相关的模块带进来）。
 *
 * 上限的来源有三层，后者覆盖前者：内置默认值（2）→ 工作流步骤声明的 `max_rounds` →
 * 任务字段 `max_rounds`（`tenon set <change> max_rounds <N>`，只有用户能决定调高）。
 */

/** 没声明 max_rounds 的受约束步骤（自定义工作流、升级前已冻结的计划）按这个值处理。 */
export const DEFAULT_MAX_ROUNDS = 2
export const MAX_ROUNDS_MIN = 1
export const MAX_ROUNDS_MAX = 20

/** 工作流层给出的上限来源；任务字段覆盖时来源是 `task`。 */
export type PlanMaxRoundsSource = 'workflow' | 'default'
export type MaxRoundsSource = PlanMaxRoundsSource | 'task'

export interface PlanMaxRounds {
  readonly max: number
  readonly source: PlanMaxRoundsSource
}

export interface ResolvedMaxRounds {
  readonly max: number
  readonly source: MaxRoundsSource
}

/** 1 到 20 的整数。 */
export function isValidMaxRounds(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MAX_ROUNDS_MIN && value <= MAX_ROUNDS_MAX
}

/** 规范十进制文本（`3`，不接受 `03`、` 3`、`3.0`）→ 数值；不合法返回 undefined。 */
export function parseMaxRoundsText(raw: string): number | undefined {
  return /^(?:[1-9]|1\d|20)$/.test(raw) ? Number(raw) : undefined
}

/**
 * 步骤自己的上限：声明了取声明值（`workflow`），没声明按内置默认值（`default`）。
 * 只对受约束的步骤（评审门且有回退边）有意义，调用方先判 `isRoundsLimited`。
 */
export function effectiveMaxRounds(step: { readonly maxRounds?: number }): PlanMaxRounds {
  return step.maxRounds === undefined
    ? { max: DEFAULT_MAX_ROUNDS, source: 'default' }
    : { max: step.maxRounds, source: 'workflow' }
}

/**
 * 任务字段覆盖工作流上限：合法的 1–20 整数文本生效（来源 `task`）；空串、越界或手改出来的脏值一律忽略，
 * 不让它悄悄放宽或收紧上限。
 */
export function resolveMaxRounds(planMax: PlanMaxRounds, taskField: string | undefined): ResolvedMaxRounds {
  const override = taskField === undefined ? undefined : parseMaxRoundsText(taskField)
  return override === undefined ? planMax : { max: override, source: 'task' }
}
