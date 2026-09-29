/**
 * 测试体系的闭集词表：种类、runner、报告格式、覆盖率格式、范围，以及它们之间的合法组合。
 * 目录校验、计划校验、工作流策略编译与判定共用这一份，避免多处白名单漂移。
 */

export const TEST_KINDS = [
  'unit', 'integration', 'regression', 'e2e', 'playwright', 'browser', 'benchmark', 'typecheck', 'lint',
  'coverage', 'a11y', 'visual', 'contract', 'smoke', 'code-size', 'design-system', 'custom',
] as const
export type TestKind = (typeof TEST_KINDS)[number]

export const TEST_RUNNERS = [
  'vitest', 'jest', 'mocha', 'node-test', 'pytest', 'go', 'cargo', 'playwright', 'cypress', 'vitest-bench',
  'hyperfine', 'k6', 'lighthouse', 'tsc', 'eslint', 'custom',
] as const
export type TestRunner = (typeof TEST_RUNNERS)[number]

export const REPORT_FORMATS = [
  'junit', 'playwright-json', 'vitest-json', 'jest-json', 'go-json', 'tap', 'benchmark-json', 'k6-summary',
  'lighthouse-json', 'exit-code',
] as const
export type ReportFormat = (typeof REPORT_FORMATS)[number]

export const COVERAGE_FORMATS = ['istanbul-summary', 'lcov', 'cobertura'] as const
export type CoverageFormat = (typeof COVERAGE_FORMATS)[number]

/** 计划里一个套件的运行范围。`changed` 按目录 covers/files 与 diff 选文件。 */
export const PLAN_SCOPES = ['full', 'changed', 'files', 'grep'] as const
export type PlanScope = (typeof PLAN_SCOPES)[number]

/** 运行记录里的范围：计划范围之外还有旧步骤测试的 `known`（只跑已知失败清单）。 */
export const RUN_SCOPES = [...PLAN_SCOPES, 'known'] as const
export type RunScope = (typeof RUN_SCOPES)[number]

/** 策略要求的最小范围：full 只认全量运行，changed 认任何范围。 */
export const POLICY_SCOPES = ['changed', 'full'] as const
export type PolicyScope = (typeof POLICY_SCOPES)[number]

export const SERVICE_STOP_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGKILL'] as const
export type ServiceStopSignal = (typeof SERVICE_STOP_SIGNALS)[number]

export const COVERAGE_METRICS = ['lines', 'branches', 'functions', 'statements', 'changed_lines'] as const
export type CoverageMetric = (typeof COVERAGE_METRICS)[number]

/** 目录套件与服务 id。旧步骤测试编译出的内联套件带 `step:` 前缀，天然不与目录 id 冲突。 */
export const SUITE_ID_RE = /^[a-z0-9-]{1,48}$/
export const INLINE_SUITE_PREFIX = 'step:'
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
export const TAG_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/
/** Playwright project 名可以带空格（如 `Mobile Chrome`）。 */
export const BROWSER_PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/
export const METRIC_NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/

/** 只有这些种类可以不产出报告、只看退出码；其余种类必须有可解析的报告（0 用例、伪通过都能被识破）。 */
export const EXIT_CODE_KINDS: ReadonlySet<TestKind> = new Set<TestKind>(['typecheck', 'lint', 'code-size', 'custom'])

const BENCHMARK_FORMATS: ReadonlySet<ReportFormat> = new Set<ReportFormat>(['benchmark-json', 'k6-summary', 'lighthouse-json'])
const CASE_FORMATS: ReadonlySet<ReportFormat> = new Set<ReportFormat>([
  'junit', 'playwright-json', 'vitest-json', 'jest-json', 'go-json', 'tap',
])

/** runner 能产出的报告格式；首项是默认格式（目录里省略 `report.format` 时取它）。 */
export const RUNNER_FORMATS: Readonly<Record<TestRunner, readonly ReportFormat[]>> = {
  vitest: ['junit', 'vitest-json'],
  jest: ['junit', 'jest-json'],
  mocha: ['junit', 'tap'],
  'node-test': ['tap', 'junit'],
  pytest: ['junit'],
  go: ['go-json', 'junit'],
  cargo: ['junit'],
  playwright: ['playwright-json', 'junit'],
  cypress: ['junit'],
  'vitest-bench': ['benchmark-json'],
  hyperfine: ['benchmark-json'],
  k6: ['k6-summary'],
  lighthouse: ['lighthouse-json'],
  tsc: ['exit-code'],
  eslint: ['exit-code', 'junit'],
  custom: [...REPORT_FORMATS],
}

/** 限定种类的 runner；未列出的 runner 接受除 `playwright` / `browser` 之外的任何种类。 */
const RUNNER_KINDS: Partial<Readonly<Record<TestRunner, readonly TestKind[]>>> = {
  playwright: ['playwright', 'e2e', 'a11y', 'visual', 'smoke', 'regression', 'contract', 'custom'],
  cypress: ['browser', 'e2e', 'a11y', 'visual', 'smoke', 'regression', 'custom'],
  'vitest-bench': ['benchmark'],
  hyperfine: ['benchmark'],
  k6: ['benchmark'],
  lighthouse: ['benchmark', 'a11y'],
  tsc: ['typecheck', 'custom'],
  eslint: ['lint', 'a11y', 'custom'],
}

function member<T extends string>(values: readonly T[]): (value: unknown) => value is T {
  const set: ReadonlySet<string> = new Set<string>(values)
  return (value: unknown): value is T => typeof value === 'string' && set.has(value)
}

export const isTestKind = member(TEST_KINDS)
export const isTestRunner = member(TEST_RUNNERS)
export const isReportFormat = member(REPORT_FORMATS)
export const isCoverageFormat = member(COVERAGE_FORMATS)
export const isPlanScope = member(PLAN_SCOPES)
export const isRunScope = member(RUN_SCOPES)
export const isPolicyScope = member(POLICY_SCOPES)
export const isServiceStopSignal = member(SERVICE_STOP_SIGNALS)

export function defaultReportFormat(runner: TestRunner): ReportFormat {
  return RUNNER_FORMATS[runner][0] ?? 'exit-code'
}

/** 种类 × runner：`playwright` 种类专属 Playwright runner，`browser` 种类恰好是非 Playwright 的浏览器脚本。 */
export function kindRunnerProblem(kind: TestKind, runner: TestRunner): string | undefined {
  const allowed = RUNNER_KINDS[runner]
  if (allowed !== undefined && !allowed.includes(kind)) {
    return `runner '${runner}' 不能承载种类 '${kind}'（可选：${allowed.join('/')}）`
  }
  if (kind === 'playwright' && runner !== 'playwright') return "种类 'playwright' 必须用 runner 'playwright'"
  if (kind === 'browser' && runner === 'playwright') return "Playwright 脚本的种类是 'playwright'，'browser' 只用于 Cypress、WebdriverIO 等"
  return undefined
}

/** 种类 × 报告格式 × runner。exit-code 只给不产用例的种类；基准种类只认基准格式。 */
export function kindFormatProblem(kind: TestKind, runner: TestRunner, format: ReportFormat): string | undefined {
  if (!RUNNER_FORMATS[runner].includes(format)) {
    return `runner '${runner}' 不产出报告格式 '${format}'（可选：${RUNNER_FORMATS[runner].join('/')}）`
  }
  if (format === 'exit-code' && !EXIT_CODE_KINDS.has(kind)) {
    return `种类 '${kind}' 必须有可解析的报告；只有 ${[...EXIT_CODE_KINDS].join('/')} 可以用 exit-code`
  }
  if (kind === 'benchmark' && !BENCHMARK_FORMATS.has(format)) {
    return `基准套件的报告格式必须是 ${[...BENCHMARK_FORMATS].join('/')}`
  }
  if (format === 'lighthouse-json' && kind !== 'benchmark' && kind !== 'a11y') {
    return "报告格式 'lighthouse-json' 只用于 benchmark 或 a11y 种类"
  }
  if ((format === 'benchmark-json' || format === 'k6-summary') && kind !== 'benchmark') {
    return `报告格式 '${format}' 只用于 benchmark 种类`
  }
  return undefined
}

/** 报告格式是否产出用例级结果（0 用例、已登记用例未执行等判定只对这些格式成立）。 */
export function isCaseReportFormat(format: ReportFormat): boolean {
  return CASE_FORMATS.has(format)
}

/** 看起来像测试脚本、却没有任何目录套件认领的文件（孤儿）判定用的模式。 */
export const TEST_FILE_LIKE_PATTERNS: readonly RegExp[] = [
  /(?:^|\/)[^/]+\.test\.[^/]+$/,
  /(?:^|\/)[^/]+\.spec\.[^/]+$/,
  /(?:^|\/)test_[^/]+\.py$/,
  /(?:^|\/)[^/]+_test\.go$/,
  /(?:^|\/)[^/]+\.bench\.[^/]+$/,
  /(?:^|\/)e2e\//,
]

export function looksLikeTestFile(path: string): boolean {
  return TEST_FILE_LIKE_PATTERNS.some((pattern) => pattern.test(path))
}

/** 旧测试方向 id → 种类；方向是创作模板，未知方向归 custom。 */
export function kindForDirection(direction: string): TestKind {
  return isTestKind(direction) ? direction : 'custom'
}
