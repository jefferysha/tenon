/**
 * 测试体系视图的测试工厂（非 *.test.*，不被收集）：构造 server 契约形状的响应，供解码器、客户端与组件测试共用。
 * 全部是「线上形状」的纯数据，可直接 JSON.stringify 当 fetch 响应体。
 */
import type {
  PolicyReport, RecordDetail, RecordListResponse, SuiteBaselinesResponse, SuiteRun, SuiteVerdict,
  TestCatalogResponse, TestPlanBrief, TestPlanView, TestTotals,
} from './testSystemTypes'

export const FIXTURE_ROOT = '/repo'
export const FIXTURE_CHANGE = 'add-login'
export const FIXTURE_USER = 'tester-at-tenon.test'
export const FIXTURE_RUN = '20260929T110000Z-abc123'
export const FIXTURE_PROFILE = 'darwin-arm64-m3max-node22-1a2b3c4d'

export function totals(over: Partial<TestTotals> = {}): TestTotals {
  return { cases: 10, pass: 10, fail: 0, skip: 0, flaky: 0, knownFail: 0, ...over }
}

export function catalogResponse(): TestCatalogResponse {
  return {
    catalog: {
      state: 'ok',
      suites: [
        {
          id: 'web-unit', label: '前端单测', kind: 'unit', runner: 'vitest',
          command: 'npx vitest run --reporter=junit --outputFile=test-results/web-unit.xml', cwd: 'packages/dashboard-app',
          timeoutS: 900, report: { format: 'junit', path: 'test-results/web-unit.xml' },
          coverage: { format: 'istanbul-summary', path: 'coverage/coverage-summary.json' },
          services: [], retries: 0, parallel: false, tags: ['web'], browsers: [],
        },
        {
          id: 'web-e2e', label: '浏览器 e2e', kind: 'playwright', runner: 'playwright',
          command: 'npx playwright test --reporter=json,html', cwd: '.', timeoutS: 900,
          report: { format: 'playwright-json', path: 'test-results/results.json' },
          services: ['web-dev'], retries: 2, parallel: false, tags: [], browsers: ['chromium', 'webkit'],
        },
        {
          id: 'api-bench', label: '接口基准', kind: 'benchmark', runner: 'custom',
          command: 'node bench/run.mjs --json test-results/bench.json', cwd: '.', timeoutS: 900,
          report: { format: 'benchmark-json', path: 'test-results/bench.json' },
          services: [], retries: 0, parallel: false, tags: [], browsers: [],
          benchmark: {
            runs: 5, warmup: 1,
            metrics: [
              { name: 'p95_ms', unit: 'ms', better: 'lower', maxRegressionPct: 10, max: 250 },
              { name: 'rps', unit: 'req/s', better: 'higher', maxRegressionPct: 5 },
            ],
          },
        },
        {
          id: 'types', kind: 'typecheck', runner: 'tsc', command: 'npx tsc --noEmit', cwd: '.', timeoutS: 900,
          report: { format: 'exit-code' }, services: [], retries: 0, parallel: false, tags: [], browsers: [],
        },
      ],
      services: [{
        id: 'web-dev', start: 'npm run dev -- --port 5178', cwd: 'packages/dashboard-app',
        ready: { kind: 'url', value: 'http://127.0.0.1:5178/', timeoutS: 60 }, stop: 'SIGTERM',
      }],
    },
    knownFailures: {
      state: 'ok',
      entries: [
        { suite: 'web-e2e', test: 'e2e/login.spec.ts › 慢速网络', reason: '环境限速', link: 'https://example.test/issues/1', expires: '2999-12-31', addedBy: 'a@x.io', expired: false },
        { suite: 'web-unit', test: 'src/a.test.ts › 旧用例', reason: '上游缺陷', expires: '2000-01-01', addedBy: 'a@x.io', expired: true },
      ],
    },
    latest: [
      { suite: 'web-e2e', runId: FIXTURE_RUN, change: FIXTURE_CHANGE, user: FIXTURE_USER, finishedAt: '2026-09-29T11:00:00Z', result: 'fail', totals: totals({ cases: 48, pass: 45, fail: 2, flaky: 1 }) },
      { suite: 'web-unit', runId: '20260929T100000Z-abc122', change: FIXTURE_CHANGE, user: FIXTURE_USER, finishedAt: '2026-09-29T10:00:00Z', result: 'pass', totals: totals({ cases: 120, pass: 120 }) },
    ],
  }
}

export function baselinesResponse(suite = 'api-bench'): SuiteBaselinesResponse {
  const metric = (median: number): SuiteBaselinesResponse['baselines'][number]['metrics'] => ({
    p95_ms: { median, p95: median + 3, mad: 1, samples: 5, better: 'lower', unit: 'ms' },
    rps: { median: 900, p95: 950, mad: 12, samples: 5, better: 'higher', unit: 'req/s' },
  })
  return {
    suite,
    baselines: [{
      profile: FIXTURE_PROFILE, profileLabel: 'darwin-arm64-m3max-node22',
      updatedAt: '2026-09-20T00:00:00Z', metrics: metric(12),
      source: { change: FIXTURE_CHANGE, runId: FIXTURE_RUN, commit: 'abc1234' },
      history: [
        { updatedAt: '2026-09-10T00:00:00Z', metrics: metric(14) },
        { updatedAt: '2026-09-01T00:00:00Z', metrics: metric(13) },
      ],
    }],
    corrupt: [],
  }
}

export function planView(): TestPlanView {
  return {
    state: 'ok',
    suites: [{ suite: 'web-unit', kind: 'unit', scope: 'changed' }, { suite: 'web-e2e', kind: 'playwright', scope: 'grep', pattern: '@login' }],
    files: [{ path: 'e2e/login.spec.ts', suite: 'web-e2e', kind: 'playwright' }],
    cases: [{ covers: 'spec:auth/登录成功跳转首页', tests: ['e2e/login.spec.ts › 登录成功跳转首页'] }],
    waivers: [{ kind: 'benchmark', reason: '纯文案改动', approvedBy: null }],
  }
}

export function planBrief(): TestPlanBrief {
  return {
    state: 'ok',
    suites: [{ suite: 'web-unit', kind: 'unit', scope: 'changed' }, { suite: 'web-e2e', kind: 'playwright', scope: 'full' }],
    waivers: [{ kind: 'benchmark', approved: false }],
    files: 1,
    cases: 1,
  }
}

export function verdict(over: Partial<SuiteVerdict> & { suite: string }): SuiteVerdict {
  return { origin: 'catalog', kind: 'unit', reason: 'run', state: 'passed', ...over }
}

/** verify 步：单测通过（含 flaky 与覆盖率）、e2e 因代码变化过期、基准退化、缺 a11y，且有未登记文件与场景追溯。 */
export function verifyReport(over: Partial<PolicyReport> = {}): PolicyReport {
  return {
    stepId: 'verify',
    pass: false,
    chain: 'intact',
    policy: {
      plan: 'required', kinds: ['unit', 'playwright', 'a11y'], run: ['unit', 'playwright', 'benchmark'], runIfRegistered: [],
      scope: 'full', files: 'registered', scenarios: 'passing', coverage: { lines: 80, changedLines: 90 },
      flaky: { max: 2, failOnNew: true }, requireBaseline: false, browsers: ['chromium'],
    },
    blockers: [
      { code: 'test-stale', blocking: true, message: '套件 浏览器 e2e（web-e2e）的运行已过期：代码已变化', fix: 'tenon test run add-login --suite web-e2e', subject: 'web-e2e' },
      { code: 'benchmark-regression', blocking: true, message: '套件 接口基准：p95_ms 退化 18%', fix: 'tenon test run add-login --suite api-bench', subject: 'api-bench' },
      { code: 'test-kind-missing', blocking: true, message: '本阶段要求 a11y 测试', fix: "tenon test waive add-login --kind a11y --reason '<不适用的原因>'", subject: 'a11y' },
      { code: 'test-file-unregistered', blocking: true, message: '测试文件 e2e/new.spec.ts 没有登记', fix: 'tenon test register add-login --file e2e/new.spec.ts --suite web-e2e', subject: 'e2e/new.spec.ts' },
      { code: 'flaky-over-limit', blocking: true, message: 'flaky 用例 3 个，超过上限 2', fix: 'tenon test run add-login --stage' },
    ],
    notices: [{ code: 'known-failure-fixed', message: '已知失败 src/a.test.ts › 旧用例 已通过', fix: "tenon test known rm --suite web-unit --test 'src/a.test.ts › 旧用例'", subject: 'src/a.test.ts › 旧用例' }],
    suites: [
      verdict({ suite: 'web-unit', label: '前端单测', kind: 'unit', runId: '20260929T100000Z-abc122', finishedAt: '2026-09-29T10:00:00Z', totals: totals({ cases: 120, pass: 118, flaky: 2 }), flaky: ['src/a.test.ts › slow'], coverage: { lines: 91.2, branches: 74, changedLines: 88 } }),
      verdict({ suite: 'web-e2e', label: '浏览器 e2e', kind: 'playwright', state: 'stale', staleBecause: ['candidate', 'plan'], runId: FIXTURE_RUN, finishedAt: '2026-09-29T11:00:00Z' }),
      verdict({
        suite: 'api-bench', label: '接口基准', kind: 'benchmark', state: 'failed', runId: '20260929T105000Z-abc124', finishedAt: '2026-09-29T10:50:00Z',
        totals: totals({ cases: 0, pass: 0 }),
        benchmark: [
          { name: 'p95_ms', unit: 'ms', better: 'lower', median: 14.2, p95: 17, baseline: 12, deltaPct: 18.3, failed: true, baselineMissing: false, noisy: false, details: ['退化 18.3% > 10%'] },
          { name: 'rps', unit: 'req/s', better: 'higher', median: 905, p95: 940, baseline: 900, deltaPct: -0.6, failed: false, baselineMissing: false, noisy: false, details: [] },
        ],
      }),
    ],
    trace: [
      { covers: 'spec:auth/登录成功跳转首页', kind: 'spec', title: 'auth · 登录成功跳转首页', state: 'failing', tests: [{ ref: 'e2e/login.spec.ts › 登录成功跳转首页', status: 'fail', suite: 'web-e2e', runId: FIXTURE_RUN }] },
      { covers: 'spec:auth/退出登录', kind: 'spec', title: 'auth · 退出登录', state: 'uncovered', tests: [] },
      { covers: 'task:2.3', kind: 'task', title: '2.3 密码为空时禁用提交', state: 'passing', tests: [{ ref: 'Login.test.tsx › 密码为空时禁用提交', status: 'pass', suite: 'web-unit', runId: '20260929T100000Z-abc122' }] },
    ],
    files: { checked: true, unregistered: [{ path: 'e2e/new.spec.ts', suites: ['web-e2e'] }], orphans: ['scripts/tmp.test.mjs'] },
    ...over,
  }
}

export function suiteRun(over: Partial<SuiteRun> = {}): SuiteRun {
  return {
    suite: 'web-e2e', origin: 'catalog', kind: 'playwright', runner: 'playwright', scope: 'full',
    command: 'npx playwright test --reporter=json,html', cwd: '.', exitCode: 1, signal: null, durationMs: 83_400,
    result: 'fail', reasons: [{ code: 'test-failed', detail: '2 failed' }],
    totals: totals({ cases: 48, pass: 45, fail: 2, flaky: 1 }),
    cases: [
      {
        file: 'e2e/login.spec.ts', line: 12, name: '登录成功跳转首页', suitePath: ['登录'], project: 'chromium', status: 'fail',
        durationMs: 2100, attempts: 3,
        failure: { message: 'expected /home', stack: 'Error: expected /home\n    at login.spec.ts:12:5', expected: '/home', actual: '/login' },
        artifacts: ['test-results/login/fail.png', 'test-results/login/trace.zip', 'test-results/login/video.webm'],
      },
      { file: 'e2e/cart.spec.ts', line: 30, name: '结算', suitePath: [], project: 'webkit', status: 'fail', durationMs: 900, attempts: 1, failure: { message: 'timeout 5000ms' }, artifacts: [] },
      { file: 'e2e/nav.spec.ts', name: '菜单', suitePath: [], project: 'chromium', status: 'flaky', durationMs: 700, attempts: 2, artifacts: [] },
    ],
    casesTruncated: false,
    projects: ['chromium', 'webkit'],
    coverage: { lines: 78.5, branches: 70, changedLines: 92 },
    metrics: [{ name: 'p95_ms', unit: 'ms', better: 'lower', median: 14.2, p95: 17, mad: 0.8, samples: 5 }],
    artifacts: [
      { path: 'test-results/login/fail.png', bytes: 20_480, media: 'image', entry: false, present: true },
      { path: 'test-results/login/trace.zip', bytes: 1_048_576, media: 'trace', entry: false, present: true },
      { path: 'test-results/login/video.webm', bytes: 524_288, media: 'video', entry: false, present: true },
      { path: 'playwright-report/index.html', bytes: 4096, media: 'html', entry: true, present: true },
      { path: 'test-results/gone.png', bytes: 100, media: 'image', entry: false, present: false },
    ],
    artifactsTruncated: false,
    log: { artifact: 'suite-web-e2e.log', bytesTotal: 9000, bytesKept: 9000, truncated: false, present: true },
    ...over,
  }
}

export function recordDetail(over: Partial<RecordDetail> = {}): RecordDetail {
  return {
    user: FIXTURE_USER, trusted: true, runId: FIXTURE_RUN, change: FIXTURE_CHANGE, step: 'verify', workflow: 'default',
    track: 'frontend', result: 'fail', startedAt: '2026-09-29T10:58:30Z', finishedAt: '2026-09-29T11:00:00Z', durationMs: 90_000,
    machineProfile: FIXTURE_PROFILE, machineLabel: 'darwin-arm64-m3max-node22',
    artifactsDir: ['.tenon', 'users', FIXTURE_USER, 'local', 'artifacts', FIXTURE_CHANGE, FIXTURE_RUN].join('/'),
    actor: { id: 'tester@tenon.test', name: 'Tester' },
    services: [{ id: 'web-dev', readyMs: 2310, exit: 'stopped', log: 'services/web-dev.log', logPresent: true, leaked: 0 }],
    suites: [suiteRun()],
    ...over,
  }
}

export function recordList(): RecordListResponse {
  return {
    users: [{ user: FIXTURE_USER, chain: 'intact' }],
    runs: [{
      user: FIXTURE_USER, trusted: true, runId: FIXTURE_RUN, step: 'verify', result: 'fail',
      startedAt: '2026-09-29T10:58:30Z', finishedAt: '2026-09-29T11:00:00Z', durationMs: 90_000,
      machineLabel: 'darwin-arm64-m3max-node22', actor: { id: 'tester@tenon.test', name: 'Tester' },
      suites: [{ suite: 'web-e2e', kind: 'playwright', scope: 'full', result: 'fail', totals: totals({ cases: 48, pass: 45, fail: 2, flaky: 1 }), coverage: { lines: 78.5 } }],
    }],
  }
}
