/**
 * 任务测试计划的纯编辑函数：登记 / 取消登记 / 豁免 / 初稿。每个函数返回新计划（规范化交给序列化）；
 * 涉及磁盘的检查（文件是否存在、目录是否有该套件）在命令层做。
 */
import {
  catalogNotApplicable, planKindsSatisfy, policyRequiredKinds, suiteCoverGlobs, suiteFileGlobs, matchesAnyGlob,
  suitesOwningFile, testFileRegistration, waiverKey,
  type CatalogSuite, type OpenSpecScenario, type PlanCase, type PlanFile, type PlanScope, type PlanSuite, type PlanWaiver,
  type StepTestPolicyIR, type TaskItem, type TestCatalog, type TestKind, type TestPlan,
} from '@tenon/kernel'

export function withSuite(plan: TestPlan, item: PlanSuite): TestPlan {
  return { ...plan, suites: [...plan.suites.filter((existing) => existing.suite !== item.suite), item] }
}

export function withFiles(plan: TestPlan, files: readonly PlanFile[]): TestPlan {
  const paths = new Set(files.map((file) => file.path))
  return { ...plan, files: [...plan.files.filter((existing) => !paths.has(existing.path)), ...files] }
}

export function withCase(plan: TestPlan, covers: string, tests: readonly string[]): TestPlan {
  const existing = plan.cases.find((item) => item.covers === covers)
  const merged: PlanCase = { covers, tests: [...new Set([...(existing?.tests ?? []), ...tests])] }
  return { ...plan, cases: [...plan.cases.filter((item) => item.covers !== covers), merged] }
}

/** 同键豁免（kind / covers / test 各自一键，同名互不相干）：原因没变且已批准 → 原样保留；原因变了 → 批准清零（批准的是旧原因）。 */
export function withWaiver(plan: TestPlan, waiver: PlanWaiver): TestPlan {
  const sameKey = (item: PlanWaiver): boolean => waiverKey(item) === waiverKey(waiver)
  const existing = plan.waivers.find(sameKey)
  if (existing !== undefined && existing.reason === waiver.reason) return plan
  return { ...plan, waivers: [...plan.waivers.filter((item) => !sameKey(item)), waiver] }
}

export interface RemovalTarget {
  readonly suite?: string
  readonly file?: string
  readonly covers?: string
  readonly test?: string
  readonly waiverKind?: TestKind
  readonly waiverCovers?: string
  /** 步骤测试豁免（`test:<id>`）的测试 id。 */
  readonly waiverTest?: string
}

export interface Removal {
  readonly plan: TestPlan
  readonly removed: number
}

function weight(plan: TestPlan): number {
  return plan.suites.length + plan.files.length + plan.cases.reduce((sum, item) => sum + item.tests.length, 0) + plan.waivers.length
}

export function withoutTarget(plan: TestPlan, target: RemovalTarget): Removal {
  const next: TestPlan = {
    ...plan,
    suites: target.suite === undefined ? plan.suites : plan.suites.filter((item) => item.suite !== target.suite),
    files: target.file === undefined ? plan.files : plan.files.filter((item) => item.path !== target.file),
    cases: target.covers === undefined
      ? plan.cases
      : plan.cases.flatMap((item) => {
          if (item.covers !== target.covers) return [item]
          if (target.test === undefined) return []
          const tests = item.tests.filter((test) => test !== target.test)
          return tests.length === 0 ? [] : [{ covers: item.covers, tests }]
        }),
    waivers: plan.waivers.filter((item) => !(
      (target.waiverKind !== undefined && item.kind === target.waiverKind)
      || (target.waiverCovers !== undefined && item.covers === target.waiverCovers)
      || (target.waiverTest !== undefined && item.test === target.waiverTest))),
  }
  return { plan: next, removed: weight(plan) - weight(next) }
}

export interface SeedInput {
  readonly catalog: TestCatalog
  readonly plan: TestPlan
  /** undefined = 宿主没给 diff：只按策略种类补套件，不补文件。 */
  readonly changedFiles: readonly string[] | undefined
  readonly policies: readonly StepTestPolicyIR[]
  readonly scenarios: readonly OpenSpecScenario[]
  readonly tasks: readonly TaskItem[]
}

export interface SeedResult {
  readonly plan: TestPlan
  readonly addedSuites: readonly string[]
  readonly addedFiles: readonly string[]
  readonly orphans: readonly string[]
  readonly missingKinds: readonly TestKind[]
  /** 还没有映射用例的场景 / 任务；required = 要求映射（场景、实现阶段小节的任务），其余可选、不挡。 */
  readonly unmapped: readonly UnmappedItem[]
}

export interface UnmappedItem {
  readonly covers: string
  readonly title: string
  readonly kind: 'spec' | 'task'
  readonly required: boolean
}

/** 要求映射的排前面，其余（可选）在后；各自保持出现顺序。 */
export function splitUnmapped(items: readonly UnmappedItem[]): { readonly required: readonly UnmappedItem[]; readonly optional: readonly UnmappedItem[] } {
  return { required: items.filter((item) => item.required), optional: items.filter((item) => !item.required) }
}

function touches(suite: CatalogSuite, changed: readonly string[]): boolean {
  const globs = [...suiteFileGlobs(suite), ...suiteCoverGlobs(suite)]
  return changed.some((path) => matchesAnyGlob(path, globs))
}

/** 「有则跑」的种类里，基准是按变更主动选的（性能相关才跑），种子不自动登记；其余目录里有的都登记。 */
const SEED_SKIPPED_OPTIONAL: ReadonlySet<TestKind> = new Set<TestKind>(['benchmark'])

function plannedKinds(plan: TestPlan, catalog: TestCatalog): TestKind[] {
  return plan.suites.flatMap((item) => catalog.suites.find((suite) => suite.id === item.suite)?.kind ?? [])
}

/**
 * 计划初稿：只增不减。套件来自「diff 碰到的套件」、「策略要求的种类」（unit 等）和「策略里 run_if_registered 的种类，
 * 目录里有就登记」——后者让 typecheck / integration / e2e 这类项目有才跑的测试自动进计划，没有的项目不需要豁免。
 * 项目在目录里声明了某种类不适用（not_applicable）时，该种类既不补套件也不算缺。文件来自 diff 里未登记的测试文件。
 */
export function seedPlan(input: SeedInput): SeedResult {
  let plan = input.plan
  const planned = new Set(plan.suites.map((item) => item.suite))
  const addedSuites: string[] = []
  const add = (suite: CatalogSuite, scope: PlanScope): void => {
    if (planned.has(suite.id)) return
    planned.add(suite.id)
    addedSuites.push(suite.id)
    plan = withSuite(plan, { suite: suite.id, scope })
  }
  const changed = input.changedFiles ?? []
  for (const suite of input.catalog.suites) if (touches(suite, changed)) add(suite, 'changed')
  const missingKinds: TestKind[] = []
  for (const policy of input.policies) {
    for (const kind of policyRequiredKinds(policy)) {
      if (planKindsSatisfy(policy, plannedKinds(plan, input.catalog), kind)) continue
      if (catalogNotApplicable(input.catalog, kind) !== undefined) continue
      // regression 没有专门的套件时由 unit 套件全量运行顶上。
      const own = input.catalog.suites.filter((suite) => suite.kind === kind)
      const candidates = own.length > 0 || kind !== 'regression' ? own : input.catalog.suites.filter((suite) => suite.kind === 'unit')
      if (candidates.length === 0 && !missingKinds.includes(kind)) missingKinds.push(kind)
      for (const suite of candidates) add(suite, 'full')
    }
    for (const kind of policy.run_if_registered) {
      if (SEED_SKIPPED_OPTIONAL.has(kind) || catalogNotApplicable(input.catalog, kind) !== undefined) continue
      for (const suite of input.catalog.suites) if (suite.kind === kind) add(suite, 'full')
    }
  }
  const registration = testFileRegistration({ changedFiles: changed, catalog: input.catalog, plan })
  const files: PlanFile[] = registration.unregistered.map((file) => {
    const owner = file.suites.length === 1 ? input.catalog.suites.find((suite) => suite.id === file.suites[0]) : undefined
    return { path: file.path, ...(owner === undefined ? {} : { suite: owner.id, kind: owner.kind }) }
  })
  for (const file of registration.unregistered) {
    for (const id of file.suites) {
      const suite = input.catalog.suites.find((item) => item.id === id)
      if (suite !== undefined && file.suites.length === 1) add(suite, 'changed')
    }
  }
  plan = withFiles(plan, files)
  const mapped = new Set(plan.cases.map((item) => item.covers))
  const unmapped: UnmappedItem[] = [
    ...input.scenarios.filter((item) => !mapped.has(item.covers)).map((item) => ({ covers: item.covers, title: `${item.capability} · ${item.title}`, kind: 'spec' as const, required: true })),
    ...input.tasks.filter((item) => !mapped.has(item.covers) && !item.placeholder).map((item) => ({ covers: item.covers, title: item.text, kind: 'task' as const, required: item.required })),
  ]
  return { plan, addedSuites, addedFiles: files.map((file) => file.path), orphans: registration.orphans, missingKinds, unmapped }
}

export function ownersOf(catalog: TestCatalog, path: string): readonly string[] {
  return suitesOwningFile(catalog, path)
}
