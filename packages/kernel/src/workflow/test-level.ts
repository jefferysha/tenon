/**
 * 步骤测试档位（工作流 YAML 键 `test:`）：四选一。编译后的步骤只记档位名，档位的具体含义
 * （必需类、阈值）在求值时读项目测试目录的 `levels`，所以改档位定义不改工作流指纹。
 */
export const TEST_LEVELS = ['none', 'plan', 'changed', 'full'] as const
export type TestLevel = (typeof TEST_LEVELS)[number]

const LEVELS: ReadonlySet<string> = new Set(TEST_LEVELS)

export function isTestLevel(value: unknown): value is TestLevel {
  return typeof value === 'string' && LEVELS.has(value)
}

/**
 * 本步有没有测试要求：档位不是 `none`、或有旧 `test_policy`、或有旧 `tests[]`。
 * 只关心「有无测试要求」的调用方用它；要具体策略的走 `resolveStepTestPolicy`。
 * 参数是 `Pick<StepIR, 'test' | 'test_policy' | 'tests'>` 的结构化超类型（任何 StepIR 都能传），
 * 这样本模块不必反向导入 ir.ts（ir.ts 已导入 TestLevel）。
 */
export function stepDeclaresTests(step: {
  readonly test?: TestLevel
  readonly test_policy?: object
  readonly tests?: readonly object[]
}): boolean {
  if (step.test !== undefined && step.test !== 'none') return true
  if (step.test_policy !== undefined) return true
  return step.tests !== undefined && step.tests.length > 0
}
