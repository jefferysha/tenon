/**
 * 任务测试计划的纯编辑函数：登记 / 取消登记 / 豁免 / 初稿。每个函数返回新计划（规范化交给序列化）；
 * 涉及磁盘的检查（文件是否存在、目录是否有该套件）在命令层做。
 */
import {
  policyRequiredKinds, suiteCoverGlobs, suiteFileGlobs, matchesAnyGlob, suitesOwningFile, testFileRegistration,
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

/** 同键豁免：原因没变且已批准 → 原样保留；原因变了 → 批准清零（批准的是旧原因）。 */
export function withWaiver(plan: TestPlan, waiver: PlanWaiver): TestPlan {
  const sameKey = (item: PlanWaiver): boolean => (waiver.kind !== undefined ? item.kind === waiver.kind : item.covers === waiver.covers)
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
      || (target.waiverCovers !== undefined && item.covers === target.waiverCovers))),
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
  readonly unmapped: readonly { readonly covers: string; readonly title: string; readonly kind: 'spec' | 'task' }[]
}

function touches(suite: CatalogSuite, changed: readonly string[]): boolean {
  const globs = [...suiteFileGlobs(suite), ...suiteCoverGlobs(suite)]
  return changed.some((path) => matchesAnyGlob(path, globs))
}

/** 计划初稿：只增不减。套件来自「diff 碰到的套件」与「策略要求的种类」，文件来自 diff 里未登记的测试文件。 */
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
  const required = [...new Set(input.policies.flatMap((policy) => policyRequiredKinds(policy)))]
  for (const kind of required) {
    const have = plan.suites.some((item) => input.catalog.suites.find((suite) => suite.id === item.suite)?.kind === kind)
    if (have) continue
    const candidates = input.catalog.suites.filter((suite) => suite.kind === kind)
    if (candidates.length === 0) missingKinds.push(kind)
    for (const suite of candidates) add(suite, 'full')
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
  const unmapped = [
    ...input.scenarios.filter((item) => !mapped.has(item.covers)).map((item) => ({ covers: item.covers, title: `${item.capability} · ${item.title}`, kind: 'spec' as const })),
    ...input.tasks.filter((item) => !mapped.has(item.covers)).map((item) => ({ covers: item.covers, title: item.text, kind: 'task' as const })),
  ]
  return { plan, addedSuites, addedFiles: files.map((file) => file.path), orphans: registration.orphans, missingKinds, unmapped }
}

export function ownersOf(catalog: TestCatalog, path: string): readonly string[] {
  return suitesOwningFile(catalog, path)
}
