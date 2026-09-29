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
