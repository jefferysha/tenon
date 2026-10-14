/**
 * 必需测试种类 / 类的检查（从 evaluate-v2 拆出）。
 *   · 旧策略：策略要求的每个种类，计划里要有该种类的套件（regression 可由全量跑的 unit 套件顶上），或有已批准的豁免，
 *     或目录里有已批准的项目级「不适用」声明；豁免 / 声明未批准时给 waiver-unapproved，由评审确认一并批准；都没有才是 test-kind-missing。
 *   · 档位策略：required 类在目录里没有套件（stageRunSet 的 missingClasses），同样靠计划里该类的已批准种类豁免（豁免的 kind 等于类名）
 *     或项目级不适用声明（按类归类）放行。档位策略不要求计划里登记该类的套件——计划由 `tenon step run` 自动生成。
 */
import { shellQuote, testBlocker } from './blockers.js'
import { catalogSuite } from './catalog.js'
import { catalogNotApplicable } from './catalog-na.js'
import type { TestCatalog } from './catalog-types.js'
import type { Collector, TestPolicyEvaluationInput } from './evaluate-types.js'
import type { TestPlan } from './plan.js'
import { planKindsSatisfy, policyRequiredKinds } from './policy.js'
import { testClassOf, type TestClass, type TestKind } from './vocabulary.js'

/** 计划里登记的目录套件的种类（目录里已不存在的套件另由 planCatalogProblems 报）。 */
function plannedKinds(plan: TestPlan, catalog: TestCatalog): readonly TestKind[] {
  return plan.suites.flatMap((item) => catalogSuite(catalog, item.suite)?.kind ?? [])
}

function kindWaiver(plan: TestPlan, kind: TestKind): { readonly approved: boolean } | undefined {
  const waiver = plan.waivers.find((item) => item.kind === kind)
  return waiver === undefined ? undefined : { approved: waiver.approved_by !== null }
}

const NOT_APPLICABLE_HELP = '只有这个任务不适用用 tenon test waive，整个项目都不适用就在目录里声明 not_applicable'

function legacyKinds(input: TestPolicyEvaluationInput, catalog: TestCatalog, plan: TestPlan, reviewFix: string, out: Collector): void {
  const kinds = plannedKinds(plan, catalog)
  for (const kind of policyRequiredKinds(input.policy)) {
    if (planKindsSatisfy(input.policy, kinds, kind)) continue
    const waiver = kindWaiver(plan, kind)
    if (waiver?.approved === true) continue
    const projectWide = catalogNotApplicable(catalog, kind)
    if (projectWide !== undefined && projectWide.approved_by !== null) continue
    if (waiver !== undefined) {
      out.blockers.push(testBlocker('waiver-unapproved', `测试种类 ${kind} 的豁免尚未经评审批准`, { fix: reviewFix, subject: kind }))
      continue
    }
    if (projectWide !== undefined) {
      out.blockers.push(testBlocker('waiver-unapproved', `测试种类 ${kind} 在 catalog.yaml 里声明了「本项目不适用」，但尚未经评审批准`, { fix: reviewFix, subject: kind }))
      continue
    }
    const candidate = catalog.suites.find((suite) => suite.kind === kind)
    out.blockers.push(testBlocker('test-kind-missing', `本阶段要求 ${kind} 测试，计划里既没有该种类的套件也没有已批准的豁免${candidate === undefined ? `（目录里也没有这类套件；${NOT_APPLICABLE_HELP}）` : ''}`, {
      fix: candidate === undefined
        ? `tenon test catalog not-applicable ${kind} --reason ${shellQuote('<本项目为什么不适用>')}`
        : `tenon test register ${input.change} --suite ${shellQuote(candidate.id)}`,
      subject: kind,
    }))
  }
}

/** 目录里该类的项目级不适用声明（旧种类名按类归类）；`missingClasses` 只含没有已批准声明的类，所以这里找到的都是未批准的。 */
function classNotApplicable(catalog: TestCatalog, cls: TestClass): { readonly kind: TestKind } | undefined {
  return (catalog.not_applicable ?? []).find((entry) => testClassOf(entry.kind) === cls)
}

function levelClasses(
  input: TestPolicyEvaluationInput, catalog: TestCatalog, plan: TestPlan, missing: readonly TestClass[], reviewFix: string, out: Collector,
): void {
  const level = input.policy.level?.name ?? 'changed'
  for (const cls of missing) {
    const waiver = kindWaiver(plan, cls)
    if (waiver?.approved === true) continue
    if (waiver !== undefined) {
      out.blockers.push(testBlocker('waiver-unapproved', `测试种类 ${cls} 的豁免尚未经评审批准`, { fix: reviewFix, subject: cls }))
      continue
    }
    const projectWide = classNotApplicable(catalog, cls)
    if (projectWide !== undefined) {
      out.blockers.push(testBlocker('waiver-unapproved', `测试种类 ${projectWide.kind} 在 catalog.yaml 里声明了「本项目不适用」，但尚未经评审批准`, { fix: reviewFix, subject: projectWide.kind }))
      continue
    }
    out.blockers.push(testBlocker('test-kind-missing', `本阶段（档位 ${level}）要求 ${cls} 类测试，目录里没有这类套件，也没有已批准的豁免（补套件用 tenon test catalog add；${NOT_APPLICABLE_HELP}）`, {
      fix: `tenon test catalog not-applicable ${cls} --reason ${shellQuote('<本项目为什么不适用>')}`,
      subject: cls,
    }))
  }
}

/**
 * `missingClasses` 来自 stageRunSet（档位策略）；旧策略传空数组，走种类逻辑。目录不可用时整体跳过（目录无效另有阻塞）。
 */
export function checkKinds(
  input: TestPolicyEvaluationInput, plan: TestPlan, missingClasses: readonly TestClass[], reviewFix: string, out: Collector,
): void {
  if (input.catalog.state !== 'ok') return
  if (input.policy.level === undefined) legacyKinds(input, input.catalog.catalog, plan, reviewFix, out)
  else levelClasses(input, input.catalog.catalog, plan, missingClasses, reviewFix, out)
}
