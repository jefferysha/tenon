/**
 * `tenon test catalog add|set` 的字段装配：把命令行选项叠到「已有条目 / runner 推荐调用 / 测试方向模板」上，得到完整的
 * 套件或服务条目。值域与组合合法性不在这里重复判断——写盘前整份目录会重新解析，报错带 catalog.yaml:<行>。
 */
import {
  CATALOG_DEFAULT_TIMEOUT_S, COVERAGE_FORMATS, EXIT_CODE_KINDS, REPORT_FORMATS, SERVICE_DEFAULT_READY_TIMEOUT_S,
  TEST_KINDS, TEST_RUNNERS, isCoverageFormat, isReportFormat, isTestKind, isTestRunner, kindForDirection,
  type BenchmarkMetricSpec, type CatalogService, type CatalogServiceReady, type CatalogSuite, type ReportFormat,
  type TestDirectionDef, type TestKind, type TestRunner,
} from '@tenon/kernel'
import { RUNNER_PRESETS, inferRunner } from '../test-system/runner-presets.js'

export interface SuiteOptions {
  readonly kind?: string
  readonly runner?: string
  readonly command?: string
  readonly label?: string
  readonly cwd?: string
  readonly timeout?: string
  readonly fileGlob?: readonly string[]
  readonly coverGlob?: readonly string[]
  readonly selectFiles?: string
  readonly selectGrep?: string
  readonly reportFormat?: string
  readonly reportPath?: string
  readonly coverageFormat?: string
  readonly coveragePath?: string
  readonly artifact?: readonly string[]
  readonly env?: readonly string[]
  readonly uses?: readonly string[]
  readonly retries?: string
  readonly parallel?: boolean
  readonly tag?: readonly string[]
  readonly browser?: readonly string[]
  readonly runs?: string
  readonly warmup?: string
  readonly metric?: readonly string[]
  readonly from?: string
}

export interface ServiceOptions {
  readonly start?: string
  readonly cwd?: string
  readonly readyUrl?: string
  readonly readyPort?: string
  readonly readyLog?: string
  readonly readyTimeout?: string
  readonly stop?: string
  readonly env?: readonly string[]
}

function integer(value: string | undefined, name: string): number | undefined | string {
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : `${name} 必须是非负整数（收到 '${value}'）`
}

/** `--metric name=p95_ms,better=lower,max_regression_pct=10,max=250,unit=ms` */
export function parseMetric(text: string): BenchmarkMetricSpec | string {
  const fields = new Map<string, string>()
  for (const part of text.split(',')) {
    const at = part.indexOf('=')
    if (at <= 0) return `--metric '${text}' 每一段都要写成 key=value`
    fields.set(part.slice(0, at).trim(), part.slice(at + 1).trim())
  }
  const allowed = new Set(['name', 'unit', 'better', 'max_regression_pct', 'max', 'min'])
  for (const key of fields.keys()) if (!allowed.has(key)) return `--metric 不认识的键 '${key}'（可用：${[...allowed].join('/')}）`
  const name = fields.get('name')
  if (name === undefined) return `--metric '${text}' 缺 name=`
  const better = fields.get('better') ?? 'lower'
  if (better !== 'lower' && better !== 'higher') return `--metric '${name}' 的 better 只能是 lower 或 higher`
  const num = (key: string): number | undefined | string => {
    const raw = fields.get(key)
    if (raw === undefined) return undefined
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : `--metric '${name}' 的 ${key} 不是数字`
  }
  const regression = num('max_regression_pct')
  const max = num('max')
  const min = num('min')
  for (const value of [regression, max, min]) if (typeof value === 'string') return value
  const unit = fields.get('unit')
  return {
    name, better,
    ...(unit === undefined ? {} : { unit }),
    ...(typeof regression === 'number' ? { max_regression_pct: regression } : {}),
    ...(typeof max === 'number' ? { max } : {}),
    ...(typeof min === 'number' ? { min } : {}),
  }
}

function reportExtension(format: ReportFormat): string {
  return format === 'junit' ? 'xml' : format === 'tap' ? 'tap' : 'json'
}

/** 测试方向模板里是「裸调用」（`npx playwright test` 之类）就换成 runner 的推荐调用，自定义命令原样保留。 */
function fromDirection(direction: TestDirectionDef, runnerOption: TestRunner | undefined): Partial<CatalogSuite> {
  const runner = runnerOption ?? inferRunner(direction.command)
  const preset = RUNNER_PRESETS[runner]
  const bare = preset?.bare.some((pattern) => pattern.test(direction.command.trim())) === true
  return {
    kind: kindForDirection(direction.id),
    runner,
    label: direction.label,
    command: bare && preset !== undefined ? preset.command : direction.command,
    cwd: direction.cwd ?? '.',
    timeout_s: direction.timeout_s ?? preset?.timeout_s ?? CATALOG_DEFAULT_TIMEOUT_S,
    ...(bare && preset !== undefined
      ? { select: preset.select, report: preset.report, artifacts: preset.artifacts }
      : {}),
  }
}

export function buildSuite(
  id: string,
  base: CatalogSuite | undefined,
  opts: SuiteOptions,
  direction: TestDirectionDef | undefined,
): CatalogSuite | string {
  if (opts.runner !== undefined && !isTestRunner(opts.runner)) return `--runner '${opts.runner}' 不在闭集内（可选：${TEST_RUNNERS.join('/')}）`
  const seed: Partial<CatalogSuite> = base ?? (direction === undefined ? {} : fromDirection(direction, opts.runner as TestRunner | undefined))
  const kindText = opts.kind ?? seed.kind
  if (kindText === undefined) return `add 需要 --kind（可选：${TEST_KINDS.join('/')}）或 --from <测试方向>`
  if (!isTestKind(kindText)) return `--kind '${kindText}' 不在闭集内（可选：${TEST_KINDS.join('/')}）`
  const kind: TestKind = kindText
  const command = opts.command ?? seed.command
  if (command === undefined) return 'add 需要 --command'
  const runner: TestRunner = seed.runner !== undefined && opts.runner === undefined ? seed.runner : (opts.runner as TestRunner | undefined) ?? inferRunner(command)
  const preset = RUNNER_PRESETS[runner]
  const timeout = integer(opts.timeout, '--timeout')
  const retries = integer(opts.retries, '--retries')
  const runs = integer(opts.runs, '--runs')
  const warmup = integer(opts.warmup, '--warmup')
  for (const value of [timeout, retries, runs, warmup]) if (typeof value === 'string') return value
  const formatText = opts.reportFormat ?? seed.report?.format ?? (EXIT_CODE_KINDS.has(kind) && preset === undefined ? 'exit-code' : preset?.report.format)
  if (formatText === undefined) return '这个套件需要报告：加 --report-format 与 --report-path（只有 typecheck/lint/code-size/custom 可以只看退出码）'
  if (!isReportFormat(formatText)) return `--report-format '${formatText}' 不在闭集内（可选：${REPORT_FORMATS.join('/')}）`
  const reportFormat: ReportFormat = formatText
  const reportPath = opts.reportPath ?? (opts.reportFormat === undefined ? seed.report?.path ?? preset?.report.path : `test-results/${id}.${reportExtension(reportFormat)}`)
  const metrics: BenchmarkMetricSpec[] = []
  for (const text of opts.metric ?? []) {
    const parsed = parseMetric(text)
    if (typeof parsed === 'string') return parsed
    metrics.push(parsed)
  }
  const benchmark = kind === 'benchmark'
    ? {
        runs: typeof runs === 'number' ? runs : seed.benchmark?.runs ?? 1,
        warmup: typeof warmup === 'number' ? warmup : seed.benchmark?.warmup ?? 0,
        metrics: metrics.length > 0 ? metrics : seed.benchmark?.metrics ?? [],
      }
    : undefined
  const select = opts.selectFiles !== undefined || opts.selectGrep !== undefined
    ? { ...(seed.select?.files === undefined ? {} : { files: seed.select.files }), ...(seed.select?.grep === undefined ? {} : { grep: seed.select.grep }),
        ...(opts.selectFiles === undefined ? {} : { files: opts.selectFiles }), ...(opts.selectGrep === undefined ? {} : { grep: opts.selectGrep }) }
    : seed.select
  const coverageFormat = opts.coverageFormat ?? seed.coverage?.format
  const coveragePath = opts.coveragePath ?? seed.coverage?.path
  if (coverageFormat !== undefined && !isCoverageFormat(coverageFormat)) return `--coverage-format '${coverageFormat}' 不在闭集内（可选：${COVERAGE_FORMATS.join('/')}）`
  if ((coverageFormat === undefined) !== (coveragePath === undefined)) return '--coverage-format 与 --coverage-path 要一起给'
  return {
    id,
    ...((opts.label ?? seed.label) === undefined ? {} : { label: opts.label ?? seed.label }),
    kind, runner, command,
    cwd: opts.cwd ?? seed.cwd ?? '.',
    timeout_s: typeof timeout === 'number' ? timeout : seed.timeout_s ?? CATALOG_DEFAULT_TIMEOUT_S,
    files: opts.fileGlob ?? seed.files ?? [],
    covers: opts.coverGlob ?? seed.covers ?? [],
    ...(select === undefined ? {} : { select }),
    report: reportPath === undefined ? { format: reportFormat } : { format: reportFormat, path: reportPath },
    ...(coverageFormat === undefined || coveragePath === undefined || !isCoverageFormat(coverageFormat) ? {} : { coverage: { format: coverageFormat, path: coveragePath } }),
    artifacts: opts.artifact ?? seed.artifacts ?? [],
    env: opts.env ?? seed.env ?? [],
    services: opts.uses ?? seed.services ?? [],
    retries: typeof retries === 'number' ? retries : seed.retries ?? 0,
    parallel: opts.parallel ?? seed.parallel ?? false,
    tags: opts.tag ?? seed.tags ?? [],
    browsers: opts.browser ?? seed.browsers ?? [],
    ...(benchmark === undefined ? {} : { benchmark }),
  }
}

export function buildService(id: string, base: CatalogService | undefined, opts: ServiceOptions): CatalogService | string {
  const start = opts.start ?? base?.start
  if (start === undefined) return '服务需要 --start'
  const timeout = integer(opts.readyTimeout, '--ready-timeout')
  const port = integer(opts.readyPort, '--ready-port')
  for (const value of [timeout, port]) if (typeof value === 'string') return value
  const declared = [opts.readyUrl, opts.readyPort, opts.readyLog].filter((value) => value !== undefined)
  if (declared.length > 1) return '--ready-url / --ready-port / --ready-log 只能选一个'
  const seconds = typeof timeout === 'number' ? timeout : base?.ready.timeout_s ?? SERVICE_DEFAULT_READY_TIMEOUT_S
  let ready: CatalogServiceReady | undefined = base === undefined ? undefined : { ...base.ready, timeout_s: seconds }
  if (opts.readyUrl !== undefined) ready = { url: opts.readyUrl, timeout_s: seconds }
  else if (typeof port === 'number') ready = { port, timeout_s: seconds }
  else if (opts.readyLog !== undefined) ready = { log: opts.readyLog, timeout_s: seconds }
  if (ready === undefined) return '服务需要就绪探测：--ready-url / --ready-port / --ready-log 三选一'
  const stop = opts.stop ?? base?.stop ?? 'SIGTERM'
  if (stop !== 'SIGTERM' && stop !== 'SIGINT' && stop !== 'SIGKILL') return `--stop 只能是 SIGTERM / SIGINT / SIGKILL`
  return { id, start, cwd: opts.cwd ?? base?.cwd ?? '.', ready, stop, env: opts.env ?? base?.env ?? [] }
}
