/**
 * 测试体系单测与下游（CLI / server / kernel）集成测试共用的夹具：合法的套件运行、记录草稿、串好链的记录
 * （纯数据），以及给「主题与测试无关」的流程用例一次性满足步骤测试策略的豁免播种（写盘）。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { RecordActor } from '../users/user.js'
import type { EffectiveWorkflowPlan } from '../workflow/effective-plan-types.js'
import { loadDeltaScenarios, loadTaskItems } from './load.js'
import { testSystemPaths } from './paths.js'
import { readTestPlanState, writeTestPlan } from './plan-ledger.js'
import { emptyTestPlan, type PlanWaiver } from './plan.js'
import { policyRequiredKinds } from './policy.js'
import { recordV2Digest } from './record-chain.js'
import type {
  CaseResultV2, SuiteRunV2, TestRunRecordV2, TestRunRecordV2Draft,
} from './record-v2-types.js'
import type { TestKind } from './vocabulary.js'

export const EMPTY_TEST_CATALOG = 'schema: tenon-test-catalog/v1\nsuites: []\n'

/**
 * 夹具：让一个步骤的 test_policy 在「主题与测试无关」的流程用例里直接满足——没有目录就写一份空目录，
 * 计划里为策略要求的每个种类（含覆盖率门槛对应的 coverage）和每个 delta spec 场景写入已批准豁免。
 * 专门测测试门禁的用例不要用它。步骤没有策略时什么都不做。
 */
export async function seedApprovedTestPolicyWaivers(input: {
  readonly repoRoot: string
  readonly changeDir: string
  readonly changeName: string
  readonly plan: EffectiveWorkflowPlan
  readonly stepId: string
  readonly actor: RecordActor
  readonly recordedAt: string
}): Promise<boolean> {
  const policy = input.plan.workflow.steps.find((step) => step.id === input.stepId)?.test_policy
  if (policy === undefined) return false
  const catalogPath = testSystemPaths(input.repoRoot).catalog
  await mkdir(dirname(catalogPath), { recursive: true })
  await writeFile(catalogPath, EMPTY_TEST_CATALOG, { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error
  })
  const current = await readTestPlanState(input.changeDir, input.changeName)
  const plan = current.state === 'ok' ? current.plan : emptyTestPlan(input.changeName)
  const kinds: TestKind[] = [...policyRequiredKinds(policy), ...(policy.coverage === undefined ? [] : ['coverage' as const])]
  const scenarios = policy.scenarios === 'off' ? [] : await loadDeltaScenarios(input.changeDir)
  const stages = input.plan.workflow.steps.map((step) => ({ id: step.id, label: step.label }))
  const tasks = policy.scenarios === 'off' ? [] : (await loadTaskItems(input.changeDir, stages)).filter((task) => task.required)
  const approved = input.actor.id
  const waivers: PlanWaiver[] = [
    ...plan.waivers,
    ...kinds.map((kind) => ({ kind, reason: '夹具：本用例与测试门禁无关', approved_by: approved })),
    ...[...scenarios, ...tasks].map((item) => ({ covers: item.covers, reason: '夹具：本用例与测试门禁无关', approved_by: approved })),
  ]
  await writeTestPlan(input.changeDir, { ...plan, waivers }, { actor: input.actor, recordedAt: input.recordedAt })
  return true
}

export const FIXTURE_DIGEST = `sha256:${'0'.repeat(64)}`
export const FIXTURE_FINGERPRINT = 'f'.repeat(64)

export function fixtureCase(overrides: Partial<CaseResultV2> & { readonly file: string; readonly name: string }): CaseResultV2 {
  return {
    id: `${overrides.file} › ${overrides.name}`,
    suite_path: [],
    project: null,
    status: 'pass',
    duration_ms: 1,
    attempts: 1,
    artifacts: [],
    ...overrides,
  }
}

export function fixtureSuiteRun(overrides: Partial<SuiteRunV2> & { readonly suite: string }): SuiteRunV2 {
  const cases = overrides.cases ?? [fixtureCase({ file: 'src/a.test.ts', name: 'works' })]
  const count = (status: CaseResultV2['status']): number => cases.filter((item) => item.status === status).length
  return {
    origin: overrides.suite.startsWith('step:') ? 'step' : 'catalog',
    kind: 'unit',
    runner: 'vitest',
    scope: 'full',
    selection: [],
    command: 'npx vitest run',
    cwd: '.',
    exit_code: 0,
    signal: null,
    duration_ms: 10,
    result: 'pass',
    reasons: [],
    totals: {
      cases: cases.length, pass: count('pass'), fail: count('fail'), skip: count('skip'),
      flaky: count('flaky'), known_fail: count('known-fail'),
    },
    cases,
    projects: [],
    coverage: null,
    metrics: [],
    artifacts: [],
    report: { format: 'junit', path: 'test-results/junit.xml', digest: FIXTURE_DIGEST },
    log: { artifact: 'output.log', bytes_total: 0, bytes_kept: 0, truncated: false, digest: FIXTURE_DIGEST },
    ...overrides,
  }
}

let sequence = 0

export function fixtureRunId(index = ++sequence): string {
  const hex = index.toString(16).padStart(6, '0').slice(-6)
  return `20260929T${String(100000 + (index % 800000)).slice(-6)}Z-${hex}`
}

export function fixtureRecordDraft(overrides: Partial<TestRunRecordV2Draft> = {}): TestRunRecordV2Draft {
  const index = ++sequence
  return {
    schema: 'tenon-test-run-v2',
    run_id: fixtureRunId(index),
    change: 'demo',
    workflow_run_id: 'run-1',
    workflow: 'default',
    track: 'backend',
    step: 'build',
    bindings: {
      candidate: null,
      workflow_fingerprint: FIXTURE_FINGERPRINT,
      catalog_digest: null,
      plan_digest: null,
      policy_digest: null,
    },
    machine_profile: 'darwin-arm64-m3max-node22-1a2b3c4d',
    machine_label: 'darwin-arm64-m3max-node22',
    services: [],
    suites: [fixtureSuiteRun({ suite: 'web-unit' })],
    result: 'pass',
    actor: { id: 'tester@tenon.test', name: 'Tester', trust: 'declared' },
    host: { kind: 'terminal', sandbox: null },
    git_head: null,
    started_at: `2026-09-29T10:00:${String(index % 60).padStart(2, '0')}.000Z`,
    finished_at: `2026-09-29T10:${String(Math.floor(index / 60) % 60).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.500Z`,
    duration_ms: 500,
    ...overrides,
  }
}

/** 按给定顺序串成一条完好的链（第一条为链首）。 */
export function fixtureChain(drafts: readonly TestRunRecordV2Draft[]): TestRunRecordV2[] {
  const out: TestRunRecordV2[] = []
  for (const draft of drafts) {
    const base = { ...draft, prev_digest: out.at(-1)?.digest ?? null }
    out.push({ ...base, digest: recordV2Digest(base) })
  }
  return out
}

/** 设计文档 §2 的目录样例（报告与产物落在测试输出目录下）。 */
export const DESIGN_CATALOG = `schema: tenon-test-catalog/v1
profiles_env: [CI]
suites:
  - id: web-unit
    label: 前端单测
    kind: unit
    runner: vitest
    command: npx vitest run --reporter=junit --outputFile=test-results/web-unit.xml
    cwd: packages/dashboard-app
    timeout_s: 900
    files: ["src/**/*.test.{ts,tsx}"]
    covers: ["src/**/*.{ts,tsx}"]
    select:
      files: "npx vitest run {files} --reporter=junit --outputFile=test-results/web-unit.xml"
      grep:  "npx vitest run -t {pattern} --reporter=junit --outputFile=test-results/web-unit.xml"
    report: { format: junit, path: test-results/web-unit.xml }
    coverage: { format: istanbul-summary, path: coverage/coverage-summary.json }
    artifacts: [test-results, coverage]
    env: [NODE_OPTIONS]
    services: [web-dev]
    retries: 0
    parallel: false
    tags: [web]
  - id: web-e2e
    label: 浏览器 e2e
    kind: playwright
    runner: playwright
    command: npx playwright test --reporter=json,html
    files: ["e2e/**/*.spec.ts"]
    report: { format: playwright-json, path: test-results/results.json }
    artifacts: [playwright-report, test-results]
    browsers: [chromium, webkit]
    services: [web-dev]
    retries: 2
  - id: api-bench
    label: 接口基准
    kind: benchmark
    runner: custom
    command: node bench/run.mjs --json test-results/bench.json
    report: { format: benchmark-json, path: test-results/bench.json }
    benchmark:
      runs: 5
      warmup: 1
      metrics:
        - { name: p95_ms, unit: ms, better: lower, max_regression_pct: 10, max: 250 }
        - { name: rps, unit: req/s, better: higher, max_regression_pct: 5 }
  - id: types
    kind: typecheck
    runner: tsc
    command: npx tsc --noEmit
services:
  - id: web-dev
    start: npm run dev -- --port 5178
    cwd: packages/dashboard-app
    ready: { url: "http://127.0.0.1:5178/", timeout_s: 60 }
    stop: SIGTERM
`
