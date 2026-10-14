/**
 * 阶段运行集（M2，纯函数）：策略 × 目录 × 任务计划 × 本任务改动 → 本阶段要跑的套件与范围。
 * `evaluate-v2`（门禁）与 `tenon test run --stage`（实际运行）共用，所以「要求跑的」和「实际跑的」不会对不上。
 *
 * 档位策略（带 `level`）：
 *   · changed：required ∪ touched 类里被改动碰到的套件，按改动范围（scope changed）；required 类的套件原因是 run，touched 类是 if-registered。
 *   · full：required 类的全部套件全量（run）；touched 类里被碰到的套件全量（if-registered）。
 *   · plan：不运行套件，只看 missingClasses。
 *   · 计划里显式登记的套件（`register --suite`）追加为 run，范围照计划（full 档一律全量），压过档位推出的范围。
 *   · 读不到改动列表（changedFiles 为 undefined）：只有显式登记的套件，加上 full 档的 required 类套件。
 * 旧策略（无 `level`）：计划套件按 `policyRunReason` 过滤；`files: registered` 时再追加认领文件所属、种类在 run ∪ run_if_registered 的套件。
 */
import { shellQuote, testNotice, type TestNotice } from './blockers.js'
import { suiteCoverGlobs, suiteFileGlobs } from './catalog.js'
import type { CatalogSuite, TestCatalog } from './catalog-types.js'
import { changedRepoPaths, claimChangedTestFiles } from './claim.js'
import { matchesAnyGlob } from './globs.js'
import type { TestPlan } from './plan.js'
import { policyRunReason } from './policy.js'
import type { ResolvedLevel } from './levels.js'
import { hasTestSourceExtension } from './test-paths.js'
import { looksLikeTestFile, testClassOf, type PlanScope, type TestClass } from './vocabulary.js'
import type { StepTestPolicyIR } from '../workflow/ir.js'

export interface StageRunItem {
  readonly suite: CatalogSuite
  readonly scope: PlanScope
  readonly reason: 'run' | 'if-registered'
  readonly pattern?: string
  readonly files?: readonly string[]
}

export interface StageRunSet {
  /** 按目录顺序、按 id 去重。 */
  readonly items: readonly StageRunItem[]
  /** 仅档位策略：required 类在目录里没有任何套件，且没有已批准的项目级不适用声明。 */
  readonly missingClasses: readonly TestClass[]
}

/** 「被改动碰到」：改动文件（与认领同一口径归一、去控制目录）匹配套件 `files` 或 `covers` 的任一 glob。 */
export function touches(suite: CatalogSuite, changed: readonly string[]): boolean {
  const globs = [...suiteFileGlobs(suite), ...suiteCoverGlobs(suite)]
  return changedRepoPaths(changed).some((path) => matchesAnyGlob(path, globs))
}

function missingClassesOf(level: ResolvedLevel, catalog: TestCatalog): TestClass[] {
  return level.required.filter((cls) =>
    !catalog.suites.some((suite) => testClassOf(suite.kind) === cls)
    && !(catalog.not_applicable ?? []).some((entry) => entry.approved_by !== null && testClassOf(entry.kind) === cls))
}

function planned(plan: TestPlan | undefined, catalog: TestCatalog): ReadonlyMap<string, StageRunItem> {
  const out = new Map<string, StageRunItem>()
  for (const entry of plan?.suites ?? []) {
    const suite = catalog.suites.find((item) => item.id === entry.suite)
    if (suite === undefined) continue
    out.set(suite.id, {
      suite, scope: entry.scope, reason: 'run',
      ...(entry.pattern === undefined ? {} : { pattern: entry.pattern }),
      ...(entry.files === undefined ? {} : { files: entry.files }),
    })
  }
  return out
}

/** 档位自己推出的运行项（不含计划里显式登记的）。 */
function derivedByLevel(level: ResolvedLevel, catalog: TestCatalog, changed: readonly string[] | undefined): ReadonlyMap<string, StageRunItem> {
  const out = new Map<string, StageRunItem>()
  const full = level.name === 'full'
  for (const suite of catalog.suites) {
    const cls = testClassOf(suite.kind)
    const required = level.required.includes(cls)
    if (!required && !level.touched.includes(cls)) continue
    const hit = changed !== undefined && touches(suite, changed)
    // full 档的必需类不看改动；其余都要被碰到才跑（读不到改动列表时碰没碰到无从判断，不猜）。
    if (!(full && required) && !hit) continue
    out.set(suite.id, { suite, scope: full ? 'full' : 'changed', reason: required ? 'run' : 'if-registered' })
  }
  return out
}

function levelRunSet(level: ResolvedLevel, input: StageInput): StageRunSet {
  const missingClasses = missingClassesOf(level, input.catalog)
  if (level.name === 'plan') return { items: [], missingClasses }
  const merged = new Map(derivedByLevel(level, input.catalog, input.changedFiles))
  for (const [id, item] of planned(input.plan, input.catalog)) {
    merged.set(id, level.name === 'full' ? { suite: item.suite, scope: 'full', reason: 'run' } : item)
  }
  return { items: input.catalog.suites.flatMap((suite) => merged.get(suite.id) ?? []), missingClasses }
}

function legacyRunSet(input: StageInput): StageRunSet {
  const { policy, catalog } = input
  const merged = new Map<string, StageRunItem>()
  for (const [id, item] of planned(input.plan, catalog)) {
    const reason = policyRunReason(policy, item.suite.kind)
    if (reason === undefined) continue
    merged.set(id, policy.scope === 'full'
      ? { suite: item.suite, scope: 'full', reason }
      : { ...item, reason })
  }
  if (policy.files === 'registered' && input.changedFiles !== undefined) {
    for (const id of claimChangedTestFiles(input.changedFiles, catalog).claimed.keys()) {
      const suite = catalog.suites.find((item) => item.id === id)
      const reason = suite === undefined ? undefined : policyRunReason(policy, suite.kind)
      if (suite === undefined || reason === undefined || merged.has(id)) continue
      merged.set(id, { suite, scope: policy.scope === 'full' ? 'full' : 'changed', reason })
    }
  }
  return { items: catalog.suites.flatMap((suite) => merged.get(suite.id) ?? []), missingClasses: [] }
}

interface StageInput {
  readonly policy: StepTestPolicyIR
  readonly catalog: TestCatalog
  readonly plan: TestPlan | undefined
  /** undefined = 读不到改动列表（调用方另出 files-diff-unavailable）。 */
  readonly changedFiles: readonly string[] | undefined
}

export function stageRunSet(input: StageInput): StageRunSet {
  const level = input.policy.level
  return level === undefined ? legacyRunSet(input) : levelRunSet(level, input)
}

/** 本任务改了源码文件：归一后在控制目录之外、扩展名是源码扩展名、命名又不像测试文件（改测试文件由套件的 files 认领，不属于「只改源码」）。 */
function changedSourceFiles(changed: readonly string[]): boolean {
  return changedRepoPaths(changed).some((path) => hasTestSourceExtension(path) && !looksLikeTestFile(path))
}

/**
 * 档位策略（changed / full）下，required 或 touched 类里没写 covers、因此没进运行集的套件 id（按目录顺序）。
 * 只在本任务改了源码文件时返回非空：控制目录之外（withoutControlPaths）、hasTestSourceExtension 为真、looksLikeTestFile 为假。
 * 旧策略（policy.level === undefined）、plan 档、changedFiles === undefined 一律返回 []。
 */
export function suitesWithoutCovers(input: {
  readonly policy: StepTestPolicyIR
  readonly catalog: TestCatalog
  readonly changedFiles: readonly string[] | undefined
  readonly runSet: StageRunSet
}): readonly string[] {
  const level = input.policy.level
  if (level === undefined || level.name === 'plan' || input.changedFiles === undefined) return []
  if (!changedSourceFiles(input.changedFiles)) return []
  const running = new Set(input.runSet.items.map((item) => item.suite.id))
  return input.catalog.suites
    .filter((suite) => {
      const cls = testClassOf(suite.kind)
      return (level.required.includes(cls) || level.touched.includes(cls)) && suite.covers.length === 0 && !running.has(suite.id)
    })
    .map((suite) => suite.id)
}

/** `suites-without-covers` 提示；求值（evaluate-v2）与 `tenon test run --stage` 都由它生成，文案只有这一份。没有要提示的套件时返回 undefined。 */
export function suitesWithoutCoversNotice(input: Parameters<typeof suitesWithoutCovers>[0]): TestNotice | undefined {
  const ids = suitesWithoutCovers(input)
  const first = ids[0]
  if (first === undefined) return undefined
  return testNotice(
    'suites-without-covers',
    `套件 ${ids.join('、')} 没写 covers：只改源码碰不到它们，本步没有运行；需要源码改动触发时，在 .tenon/tests/catalog.yaml 给它们写上 covers`,
    { fix: `tenon test catalog set ${shellQuote(first)} --cover-glob "<glob>"` },
  )
}
