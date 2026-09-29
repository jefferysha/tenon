/**
 * 集成夹具：测试体系登记类 / 运行类 `next` 动作的「作者」。真实的 `tenon test discover|plan|register|run|report`
 * 是另一批的命令；这里按动作载荷替作者把同样的事经 kernel 的写入口做完（目录文件、计划 CLI 写入口、
 * 哈希链记录追加、追溯矩阵写进验证报告），让运行器能一路走完一个带测试策略的流程。
 *
 * 只造合法数据，不绕过任何判定：门禁读到的目录、计划、记录链和真命令产出的形状一致。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  actorOf, appendTestRunRecordV2, catalogSuite, catalogSuitesDigest, emptyTestPlan, fingerprintWorkspace,
  isTenonUser, parseTestCatalog, readTestPlanState, resolveTenonUser, testPolicyDigest, testSystemPaths,
  userSlug, writeTestPlan,
  type PlanCase, type PlanSuite, type RecordActor, type SuiteRunV2, type TestCatalog, type TestPlan,
} from '@tenon/kernel'
import { fixtureCase, fixtureRecordDraft, fixtureSuiteRun } from '@tenon/kernel/test-system/test-support'
import type { CliDeps } from './deps.js'
import { effectiveWorkflowForState } from './commands/effective-workflow.js'

const FALLBACK_ACTOR: RecordActor = { id: 'tester@tenon.test', name: 'Tester', trust: 'declared' }

/** default 各轨道策略会用到的种类，各一个套件；报告路径都在测试输出目录下。 */
export const FLOW_CATALOG = `schema: tenon-test-catalog/v1
suites:
  - id: unit
    label: 单测
    kind: unit
    runner: vitest
    command: npx vitest run --reporter=junit --outputFile=test-results/unit.xml
    files: ["src/**/*.test.ts"]
    report: { format: junit, path: test-results/unit.xml }
    coverage: { format: istanbul-summary, path: coverage/coverage-summary.json }
    artifacts: [test-results, coverage]
  - id: integration
    label: 集成
    kind: integration
    runner: vitest
    command: npx vitest run --reporter=junit --outputFile=test-results/integration.xml
    files: ["tests/**/*.test.ts"]
    report: { format: junit, path: test-results/integration.xml }
  - id: regression
    label: 回归
    kind: regression
    runner: vitest
    command: npx vitest run --reporter=junit --outputFile=test-results/regression.xml
    report: { format: junit, path: test-results/regression.xml }
  - id: smoke
    label: 冒烟
    kind: smoke
    runner: vitest
    command: npx vitest run --reporter=junit --outputFile=test-results/smoke.xml
    report: { format: junit, path: test-results/smoke.xml }
  - id: types
    label: 类型检查
    kind: typecheck
    runner: tsc
    command: npx tsc --noEmit
    report: { format: exit-code }
`

/** 夹具用例：登记的映射与运行记录用同一个引用，追溯矩阵里能对上。 */
export const FLOW_TEST_REF = 'src/flow.test.ts › runs the flow'

/** 每个变更最近一次写入的运行 id（套件 → run id），验证报告的追溯矩阵引用它们。 */
const lastRuns = new Map<string, Map<string, string>>()

export function flowRunIds(change: string): readonly string[] {
  return [...new Set(lastRuns.get(change)?.values() ?? [])]
}

export interface FlowContext {
  readonly deps: CliDeps
  readonly cwd: string
  readonly change: string
  readonly stepId: string
  readonly recordedAt: string
}

function actorFor(cwd: string): RecordActor {
  const user = resolveTenonUser(cwd, process.env)
  return isTenonUser(user) ? actorOf(user) : FALLBACK_ACTOR
}

async function loadCatalog(cwd: string): Promise<TestCatalog> {
  const parsed = parseTestCatalog(await readFile(testSystemPaths(cwd).catalog, 'utf8'))
  if (!parsed.ok) throw new Error(`flow fixture: 目录无效 ${JSON.stringify(parsed.issues)}`)
  return parsed.catalog
}

async function currentPlan(context: FlowContext): Promise<TestPlan> {
  const changeDir = join(context.cwd, 'openspec', 'changes', context.change)
  const state = await readTestPlanState(changeDir, context.change)
  return state.state === 'ok' ? state.plan : emptyTestPlan(context.change)
}

async function savePlan(context: FlowContext, plan: TestPlan): Promise<void> {
  const changeDir = join(context.cwd, 'openspec', 'changes', context.change)
  await writeTestPlan(changeDir, plan, { actor: actorFor(context.cwd), recordedAt: context.recordedAt })
}

interface ActionItem {
  readonly code: string
  readonly subject: string | null
}

/** test-discover：写一份覆盖 default 各轨道策略种类的目录（人可编辑的配置文件）。 */
async function discover(context: FlowContext): Promise<void> {
  const path = testSystemPaths(context.cwd).catalog
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, FLOW_CATALOG, 'utf8')
}

/** test-plan-seed：写入计划初稿（空计划，映射与套件由后续动作补）。 */
async function seed(context: FlowContext): Promise<void> {
  await savePlan(context, emptyTestPlan(context.change))
}

/** test-plan-map：缺的种类登记目录里该种类的套件；未覆盖的场景映射到夹具用例。 */
async function map(context: FlowContext, items: readonly ActionItem[]): Promise<void> {
  const catalog = await loadCatalog(context.cwd)
  const plan = await currentPlan(context)
  const suites: PlanSuite[] = [...plan.suites]
  const cases: PlanCase[] = [...plan.cases]
  for (const item of items) {
    if (item.code === 'test-kind-missing' && item.subject !== null) {
      const suite = catalog.suites.find((candidate) => candidate.kind === item.subject)
      if (suite === undefined) throw new Error(`flow fixture: 目录里没有 ${item.subject} 套件`)
      if (!suites.some((entry) => entry.suite === suite.id)) suites.push({ suite: suite.id, scope: 'full' })
    } else if (item.code === 'scenario-uncovered' && item.subject !== null) {
      cases.push({ covers: item.subject, tests: [FLOW_TEST_REF] })
    } else {
      throw new Error(`flow fixture: test-plan-map 给了处理不了的项 ${JSON.stringify(item)}`)
    }
  }
  await savePlan(context, { ...plan, suites, cases })
}

/**
 * 为这些套件追加一条 v2 记录（哈希链、五项绑定都按当前状态取值）。默认每个套件一个通过的用例；
 * `overrides` 按套件覆盖运行结果（造失败用例、flaky、覆盖率不足）。
 */
export async function appendFlowRecord(
  context: FlowContext,
  suiteIds: readonly string[],
  overrides: (suite: string) => Partial<SuiteRunV2> = () => ({}),
): Promise<string> {
  const changeDir = join(context.cwd, 'openspec', 'changes', context.change)
  const state = await context.deps.store.read(changeDir)
  const plan = effectiveWorkflowForState(context.deps, state)
  const policy = plan?.workflow.steps.find((step) => step.id === context.stepId)?.test_policy
  if (plan === null || policy === undefined) throw new Error(`flow fixture: 步骤 ${context.stepId} 没有测试策略`)
  const catalog = await loadCatalog(context.cwd)
  const planState = await readTestPlanState(changeDir, context.change)
  if (planState.state !== 'ok') throw new Error('flow fixture: run-tests 时计划必须已登记')
  const suites = suiteIds.map((id) => {
    const entry = catalogSuite(catalog, id)
    if (entry === undefined) throw new Error(`flow fixture: 目录里没有套件 ${id}`)
    return fixtureSuiteRun({
      suite: id,
      kind: entry.kind,
      runner: entry.runner,
      scope: 'full',
      command: entry.command,
      cases: [fixtureCase({ file: 'src/flow.test.ts', name: 'runs the flow' })],
      report: entry.report.format === 'exit-code'
        ? { format: 'exit-code', path: null, digest: null }
        : { format: entry.report.format, path: entry.report.path ?? null, digest: `sha256:${'0'.repeat(64)}` },
      coverage: entry.coverage === undefined ? null : { lines: 92, branches: 85, changed_lines: 95 },
      ...overrides(id),
    })
  })
  const slug = userSlug(actorFor(context.cwd).id)
  const candidate = await fingerprintWorkspace(context.cwd)
  const written = await appendTestRunRecordV2(context.cwd, slug, fixtureRecordDraft({
    change: context.change,
    workflow_run_id: state.runMetadata?.runId ?? '',
    workflow: plan.id,
    track: String(state.fields.track),
    step: context.stepId,
    suites,
    bindings: {
      candidate,
      workflow_fingerprint: plan.workflowFingerprint,
      catalog_digest: catalogSuitesDigest(catalog, suiteIds),
      plan_digest: planState.digest,
      policy_digest: testPolicyDigest(policy),
    },
    actor: actorFor(context.cwd),
  }))
  const runs = lastRuns.get(context.change) ?? new Map<string, string>()
  for (const id of suiteIds) runs.set(id, written.record.run_id)
  lastRuns.set(context.change, runs)
  return written.record.run_id
}

/** test-report：追溯矩阵写进验证报告（引用各套件最新运行）。 */
async function report(context: FlowContext, path: string): Promise<void> {
  const absolute = join(context.cwd, path)
  const body = existsSync(absolute) ? await readFile(absolute, 'utf8') : ''
  const rows = [...(lastRuns.get(context.change)?.entries() ?? [])].map(([suite, run]) => `| ${suite} | ${run} | pass |`)
  await writeFile(absolute, `${body.trimEnd()}\n\n## 测试追溯\n\n| 套件 | 运行 | 结果 |\n| --- | --- | --- |\n${rows.join('\n')}\n`, 'utf8')
}

/** 处理一条测试体系动作；不是这类动作返回 false。 */
export async function performFlowAction(
  context: FlowContext,
  action: { readonly action: string; readonly [key: string]: unknown },
): Promise<boolean> {
  switch (action.action) {
    case 'test-discover':
      await discover(context)
      return true
    case 'test-plan-seed':
      await seed(context)
      return true
    case 'test-plan-map':
      await map(context, action.items as readonly ActionItem[])
      return true
    case 'run-tests':
      await appendFlowRecord(context, (action.suites as readonly ActionItem[]).flatMap((item) => item.subject === null ? [] : [item.subject]))
      return true
    case 'test-report':
      await report(context, String(action.path))
      return true
    default:
      return false
  }
}
