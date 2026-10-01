/**
 * 一个步骤的有效测试要求：`test_policy`（编译后的 IR）+ 旧 `tests[]` 编译出的内联套件。
 *
 * 旧步骤测试项编译为「内联套件 + 该步骤必须运行（required 时）」：套件 id 为 `step:<test-id>`，
 * 种类取来源测试方向（未知方向归 custom），执行与判定仍走 v1 记录与既有判定，行为不变。
 * 两者可以并存：有策略时，内联套件的状态并入策略判定一起出阻塞；没有策略时一切照旧。
 */
import { sha256Hex } from '../sha256.js'
import type { StepIR, StepTestIR, StepTestPolicyIR } from '../workflow/ir.js'
import { canonicalJson } from './canonical.js'
import { INLINE_SUITE_PREFIX, kindForDirection, type TestKind } from './vocabulary.js'

export interface InlineSuite {
  /** `step:<test-id>` */
  readonly id: string
  readonly testId: string
  readonly kind: TestKind
  readonly label?: string
  readonly required: boolean
  readonly command: string
  readonly cwd: string
}

export interface StepTestRequirements {
  readonly stepId: string
  readonly policy?: StepTestPolicyIR
  readonly inline: readonly InlineSuite[]
}

export function inlineSuiteId(testId: string): string {
  return `${INLINE_SUITE_PREFIX}${testId}`
}

export function inlineSuiteFromTest(test: StepTestIR): InlineSuite {
  return {
    id: inlineSuiteId(test.id),
    testId: test.id,
    kind: kindForDirection(test.direction),
    ...(test.label === undefined ? {} : { label: test.label }),
    required: test.required,
    command: test.command,
    cwd: test.cwd,
  }
}

export function stepTestRequirements(step: Pick<StepIR, 'id' | 'tests' | 'test_policy'>): StepTestRequirements {
  return {
    stepId: step.id,
    ...(step.test_policy === undefined ? {} : { policy: step.test_policy }),
    inline: (step.tests ?? []).map(inlineSuiteFromTest),
  }
}

/** 策略摘要：运行记录绑定它，策略改一个字，本阶段已有的运行即过期。 */
export function testPolicyDigest(policy: StepTestPolicyIR): string {
  return `sha256:${sha256Hex(canonicalJson(policy))}`
}

/** 策略要求的种类（登记 ∪ 必跑），保序去重。 */
export function policyRequiredKinds(policy: StepTestPolicyIR): readonly TestKind[] {
  return [...new Set([...policy.kinds, ...policy.run])]
}

/**
 * 回归就是「全量跑单测」，不需要单独的套件：策略的 `run` 要求 regression 且 `scope: full` 时，
 * unit 套件（全量运行）满足它，运行集里也带上 unit 套件。scope 是 changed 时不成立——只跑改动范围的单测不是回归。
 */
function unitServesRegression(policy: Pick<StepTestPolicyIR, 'run' | 'scope'>, suiteKind: TestKind): boolean {
  return suiteKind === 'unit' && policy.scope === 'full' && policy.run.includes('regression')
}

/** 一个计划里的套件在本阶段为什么要跑：必跑 / 有则跑；策略不涉及它的种类时 undefined。 */
export function policyRunReason(
  policy: Pick<StepTestPolicyIR, 'run' | 'run_if_registered' | 'scope'>,
  suiteKind: TestKind,
): 'run' | 'if-registered' | undefined {
  if (policy.run.includes(suiteKind) || unitServesRegression(policy, suiteKind)) return 'run'
  return policy.run_if_registered.includes(suiteKind) ? 'if-registered' : undefined
}

/**
 * 计划里种类为 `suiteKinds` 的套件能否满足策略要求的 `required` 种类：同种类，或 regression 由 unit 套件顶上
 * （只在 `kinds` 里要求登记时有 unit 套件即可；`run` 里要求运行 regression 时另外要求 scope: full，见 unitServesRegression）。
 */
export function planKindsSatisfy(
  policy: Pick<StepTestPolicyIR, 'run' | 'scope'>,
  suiteKinds: readonly TestKind[],
  required: TestKind,
): boolean {
  if (suiteKinds.includes(required)) return true
  if (required !== 'regression' || !suiteKinds.includes('unit')) return false
  return !policy.run.includes('regression') || policy.scope === 'full'
}
