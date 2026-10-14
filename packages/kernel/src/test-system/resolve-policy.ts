/**
 * 步骤的有效测试策略（M1）：档位（`test: plan|changed|full`）或旧 `test_policy` → 同一种 `StepTestPolicyIR`。
 *
 * 一个接缝两个适配器：旧策略原样返回；档位按目录 `levels`（没写用内建缺省）现算，所以改档位定义不改工作流指纹。
 * 档位派生的策略带 `level`，kinds / run / run_if_registered 恒为空——运行集与必需类由 `stageRunSet` 按档位算。
 * 求值、`tenon test run --stage`、agent 提示、server DTO 都经这里读策略，不再各自读 `step.test_policy`。
 */
import type { StepIR, StepTestPolicyIR } from '../workflow/ir.js'
import type { TestCatalog } from './catalog-types.js'
import { resolveLevel, type ResolvedLevel } from './levels.js'

/** 档位 → IR 的映射：plan 恒 required；scope 只有 full 档记 full（plan 档也记 changed，它不跑套件）；files 恒 any（改动列表由档位另行读取）。 */
function levelPolicy(level: ResolvedLevel): StepTestPolicyIR {
  return {
    plan: 'required',
    kinds: [],
    run: [],
    run_if_registered: [],
    scope: level.name === 'full' ? 'full' : 'changed',
    files: 'any',
    scenarios: level.scenarios,
    ...(level.coverage === undefined ? {} : { coverage: level.coverage }),
    ...(level.flaky === undefined ? {} : { flaky: level.flaky }),
    benchmark: { require_baseline: level.require_baseline },
    browsers: [],
    level,
  }
}

/**
 * 档位或旧策略 → 有效策略；`none`、未声明 → undefined。目录为 undefined（缺失或无效）时档位用内建缺省。
 * 同一步既有档位又有旧策略（编译会拒，这里是纵深防线）时旧策略优先：冻结的旧任务按冻结的策略走。
 */
export function resolveStepTestPolicy(
  step: Pick<StepIR, 'test' | 'test_policy'>,
  catalog: TestCatalog | undefined,
): StepTestPolicyIR | undefined {
  if (step.test_policy !== undefined) return step.test_policy
  if (step.test === undefined || step.test === 'none') return undefined
  return levelPolicy(resolveLevel(step.test, catalog))
}

/** 本步有没有策略（档位非 none，或旧 `test_policy`）；不含旧 `tests[]`。 */
export function stepHasTestPolicy(step: Pick<StepIR, 'test' | 'test_policy'>): boolean {
  return step.test_policy !== undefined || (step.test !== undefined && step.test !== 'none')
}

/** 求值要读本任务改动列表的策略：旧 `files: registered`，或会按改动碰到的套件决定运行集 / 认领文件的档位（changed、full）。 */
export function policyChecksChangedFiles(policy: Pick<StepTestPolicyIR, 'files' | 'level'>): boolean {
  return policy.files === 'registered' || (policy.level !== undefined && policy.level.name !== 'plan')
}

/** 策略会在本阶段运行套件：旧策略的 run / run_if_registered 非空，或档位 changed / full。完整性检查据此决定要不要读 diff。 */
export function policyRunsSuites(policy: Pick<StepTestPolicyIR, 'run' | 'run_if_registered' | 'level'>): boolean {
  return policy.run.length > 0 || policy.run_if_registered.length > 0 || (policy.level !== undefined && policy.level.name !== 'plan')
}

/** 没有任何要求的中性策略：步骤没有测试声明、却要用「运行器」执行套件（显式 --suite / --kind / --all）时的占位。 */
export const INERT_TEST_POLICY: StepTestPolicyIR = Object.freeze({
  plan: 'optional',
  kinds: Object.freeze([]),
  run: Object.freeze([]),
  run_if_registered: Object.freeze([]),
  scope: 'changed',
  files: 'any',
  scenarios: 'off',
  benchmark: Object.freeze({ require_baseline: false }),
  browsers: Object.freeze([]),
})
