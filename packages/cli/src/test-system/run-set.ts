/**
 * 运行集规划（纯函数）：命令行参数 × 任务计划 × 当前阶段策略 → 要跑的套件与范围。
 *   --stage        阶段运行集 = 策略 run（必跑）与 run_if_registered（计划登记了才跑）里种类对应的计划套件；
 *                  策略要求全量时一律 full，否则用计划里各套件登记的范围。没有任何选择参数时缺省就是 --stage。
 *   --suite <id>   点名的套件（计划里有就沿用它的范围，没有就 full）
 *   --kind <k>     计划里该种类的套件（没有计划时取目录里该种类的全部套件）
 *   --all          计划里的全部套件（没有计划时取目录里的全部套件），全量
 *   --changed      把上面选出的套件范围改成 changed
 * 结果按目录里的套件顺序、按 id 去重。
 */
import {
  TEST_KINDS, isTestKind, type CatalogSuite, type PlanScope, type StepTestPolicyIR, type TestCatalog, type TestPlan,
} from '@tenon/kernel'
import type { RunItem } from './exec-types.js'

export interface RunFlags {
  readonly suites: readonly string[]
  readonly kinds: readonly string[]
  readonly stage: boolean
  readonly all: boolean
  readonly changed: boolean
}

export interface RunSetInput {
  readonly catalog: TestCatalog
  readonly plan: TestPlan | undefined
  readonly policy: StepTestPolicyIR | undefined
  readonly flags: RunFlags
  readonly stepId: string
  readonly change: string
}

export type RunSetResult = { readonly items: readonly RunItem[] } | { readonly error: string }

function planned(plan: TestPlan | undefined, catalog: TestCatalog): ReadonlyArray<{ readonly suite: CatalogSuite; readonly scope: PlanScope; readonly pattern?: string; readonly files?: readonly string[] }> {
  if (plan === undefined) return catalog.suites.map((suite) => ({ suite, scope: 'full' as const }))
  return plan.suites.flatMap((entry) => {
    const suite = catalog.suites.find((item) => item.id === entry.suite)
    return suite === undefined ? [] : [{ suite, scope: entry.scope, ...(entry.pattern === undefined ? {} : { pattern: entry.pattern }), ...(entry.files === undefined ? {} : { files: entry.files }) }]
  })
}

export function planRunSet(input: RunSetInput): RunSetResult {
  const { catalog, plan, policy, flags } = input
  const chosen = new Map<string, RunItem>()
  const put = (suite: CatalogSuite, scope: PlanScope, why: RunItem['why'], extra?: { pattern?: string; files?: readonly string[] }): void => {
    if (chosen.has(suite.id)) return
    chosen.set(suite.id, {
      suite, scope: flags.changed ? 'changed' : scope, why,
      ...(!flags.changed && extra?.pattern !== undefined ? { pattern: extra.pattern } : {}),
      ...(!flags.changed && extra?.files !== undefined ? { files: extra.files } : {}),
    })
  }
  const explicit = flags.suites.length > 0 || flags.kinds.length > 0 || flags.all
  for (const id of flags.suites) {
    const suite = catalog.suites.find((item) => item.id === id)
    if (suite === undefined) return { error: `目录里没有套件 '${id}'（可选：${catalog.suites.map((item) => item.id).join(', ') || '无'}）` }
    const entry = plan?.suites.find((item) => item.suite === id)
    put(suite, entry?.scope ?? 'full', 'explicit', entry)
  }
  for (const kind of flags.kinds) {
    if (!isTestKind(kind)) return { error: `--kind '${kind}' 不合法（可选：${TEST_KINDS.join('/')}）` }
    const matches = planned(plan, catalog).filter((entry) => entry.suite.kind === kind)
    if (matches.length === 0) return { error: `${plan === undefined ? '目录' : '任务计划'}里没有 ${kind} 种类的套件` }
    for (const entry of matches) put(entry.suite, entry.scope, 'explicit', entry)
  }
  if (flags.all) {
    const everything = planned(plan, catalog)
    if (everything.length === 0) return { error: '没有可运行的套件（任务计划为空）；tenon test plan <change> --seed' }
    for (const entry of everything) put(entry.suite, 'full', 'explicit')
  }
  if (flags.stage || !explicit) {
    if (policy === undefined) return { error: `步骤 ${input.stepId} 没有 test_policy，没有阶段运行集；用 --suite / --kind / --all 指定要跑的套件` }
    if (plan === undefined) return { error: `阶段运行集来自任务测试计划，${input.change} 还没有可用的计划；执行 tenon test plan ${input.change} --seed` }
    for (const entry of planned(plan, catalog)) {
      const why = policy.run.includes(entry.suite.kind) ? 'run' : policy.run_if_registered.includes(entry.suite.kind) ? 'if-registered' : undefined
      if (why !== undefined) put(entry.suite, policy.scope === 'full' ? 'full' : entry.scope, why, policy.scope === 'full' ? undefined : entry)
    }
    // 策略没有必须运行的种类（run 为空）时，阶段运行集为空是正常的，交给调用方如实说明；有必须运行的种类却没有套件才是缺登记。
    if (chosen.size === 0 && policy.run.length > 0) {
      return { error: `步骤 ${input.stepId} 的策略要求运行 ${[...policy.run, ...policy.run_if_registered].join('/')}，但任务计划里没有这些种类的套件；tenon test register ${input.change} --suite <id>` }
    }
  }
  const order = new Map(catalog.suites.map((suite, index) => [suite.id, index]))
  return { items: [...chosen.values()].sort((left, right) => (order.get(left.suite.id) ?? 0) - (order.get(right.suite.id) ?? 0)) }
}
