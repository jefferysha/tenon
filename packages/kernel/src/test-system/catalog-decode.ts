/**
 * 目录里单个套件与服务的解码：闭集键、值域、种类 × runner × 报告格式组合、路径留在仓库内且落在
 * 测试输出目录下。跨条目的校验（id 唯一、服务引用存在）在 catalog.ts。
 */
import { TEST_OUTPUT_DIR_SEGMENTS } from '../workspace/fingerprint.js'
import {
  CATALOG_DEFAULT_TIMEOUT_S, SERVICE_DEFAULT_READY_TIMEOUT_S, type BenchmarkMetricSpec, type BenchmarkSpec,
  type CatalogCoverage, type CatalogReport, type CatalogSelect, type CatalogService, type CatalogServiceReady,
  type CatalogSuite,
} from './catalog-types.js'
import { isRepoRelativeGlob, isRepoRelativePath } from './globs.js'
import {
  BROWSER_PROJECT_RE, COVERAGE_FORMATS, ENV_NAME_RE, METRIC_NAME_RE, REPORT_FORMATS, SERVICE_STOP_SIGNALS,
  SUITE_ID_RE, TAG_RE, TEST_KINDS, TEST_RUNNERS, defaultReportFormat, isCoverageFormat, isReportFormat,
  isServiceStopSignal, isTestKind, isTestRunner, kindFormatProblem, kindRunnerProblem,
} from './vocabulary.js'
import {
  asMap, asSeq, bool, checkKeys, field, int, num, oneOf, optionalStr, str, strList, type IssueSink,
} from './yaml-read.js'
import type { YamlMap, YamlNode } from './yaml-subset.js'

const SUITE_KEYS = [
  'id', 'label', 'kind', 'runner', 'command', 'cwd', 'timeout_s', 'files', 'covers', 'select', 'report',
  'coverage', 'artifacts', 'env', 'services', 'retries', 'parallel', 'tags', 'browsers', 'benchmark',
] as const
const SERVICE_KEYS = ['id', 'start', 'cwd', 'ready', 'stop', 'env'] as const
const COMMAND_RULE = { maxBytes: 2000 } as const

function outputPath(node: YamlNode | undefined, sink: IssueSink, what: string, line: number): string | undefined {
  const value = str(node, sink, what, line)
  if (value === undefined) return undefined
  const at = node?.line ?? line
  if (!isRepoRelativePath(value) || value === '.') return sink.add(at, `${what} '${value}' 必须是仓库内相对路径（不含 ..）`)
  if (!value.split('/').some((segment) => (TEST_OUTPUT_DIR_SEGMENTS as readonly string[]).includes(segment))) {
    return sink.add(at, `${what} '${value}' 必须位于 ${TEST_OUTPUT_DIR_SEGMENTS.join('/、')}/ 目录下（否则产出它会让候选版本失效）`)
  }
  return value
}

function outputList(node: YamlNode | undefined, sink: IssueSink, what: string): string[] {
  const out: string[] = []
  for (const item of asSeq(node, sink, what) ?? []) {
    const path = outputPath(item, sink, `${what} 的一项`, item.line)
    if (path === undefined) continue
    if (out.includes(path)) sink.add(item.line, `${what} 重复列出 '${path}'`)
    else out.push(path)
  }
  return out
}

function globList(node: YamlNode | undefined, sink: IssueSink, what: string): string[] {
  const globs = strList(node, sink, what)
  for (const glob of globs) {
    if (!isRepoRelativeGlob(glob)) sink.add(node?.line ?? 1, `${what} '${glob}' 必须是仓库内相对 glob（不含 ..）`)
  }
  return globs.filter(isRepoRelativeGlob)
}

function decodeSelect(node: YamlNode | undefined, sink: IssueSink, id: string): CatalogSelect | undefined {
  if (node === undefined) return undefined
  const map = asMap(node, sink, `套件 '${id}' 的 select`)
  if (map === undefined) return undefined
  checkKeys(map, ['files', 'grep'], sink, `套件 '${id}' 的 select`)
  const files = optionalStr(field(map, 'files'), sink, `套件 '${id}' 的 select.files`, COMMAND_RULE)
  const grep = optionalStr(field(map, 'grep'), sink, `套件 '${id}' 的 select.grep`, COMMAND_RULE)
  if (files !== undefined && !files.includes('{files}')) sink.add(map.line, `套件 '${id}' 的 select.files 必须含 {files} 占位符`)
  if (grep !== undefined && !grep.includes('{pattern}')) sink.add(map.line, `套件 '${id}' 的 select.grep 必须含 {pattern} 占位符`)
  if (files === undefined && grep === undefined) return sink.add(map.line, `套件 '${id}' 的 select 至少需要 files 或 grep`)
  return { ...(files === undefined ? {} : { files }), ...(grep === undefined ? {} : { grep }) }
}

function decodeReport(map: YamlMap, sink: IssueSink, suite: Pick<CatalogSuite, 'id' | 'kind' | 'runner'>): CatalogReport | undefined {
  const node = field(map, 'report')
  const what = `套件 '${suite.id}' 的 report`
  let format = defaultReportFormat(suite.runner)
  let path: string | undefined
  if (node !== undefined) {
    const report = asMap(node, sink, what)
    if (report === undefined) return undefined
    checkKeys(report, ['format', 'path'], sink, what)
    const declared = oneOf(field(report, 'format'), sink, `${what}.format`, isReportFormat, REPORT_FORMATS)
    if (field(report, 'format') !== undefined && declared === undefined) return undefined
    if (declared !== undefined) format = declared
    if (field(report, 'path') !== undefined) path = outputPath(field(report, 'path'), sink, `${what}.path`, report.line)
  }
  const at = node?.line ?? map.line
  const problem = kindFormatProblem(suite.kind, suite.runner, format)
  if (problem !== undefined) return sink.add(at, `套件 '${suite.id}'：${problem}`)
  if (format === 'exit-code') {
    if (path !== undefined) return sink.add(at, `${what}：exit-code 格式没有报告文件，不要写 path`)
    return { format }
  }
  if (path === undefined) return sink.add(at, `${what}.path 缺失（${format} 报告必须声明落盘位置）`)
  return { format, path }
}

function decodeCoverage(node: YamlNode | undefined, sink: IssueSink, id: string): CatalogCoverage | undefined {
  if (node === undefined) return undefined
  const what = `套件 '${id}' 的 coverage`
  const map = asMap(node, sink, what)
  if (map === undefined) return undefined
  checkKeys(map, ['format', 'path'], sink, what)
  const format = field(map, 'format') === undefined
    ? sink.add(map.line, `${what}.format 缺失`)
    : oneOf(field(map, 'format'), sink, `${what}.format`, isCoverageFormat, COVERAGE_FORMATS)
  const path = outputPath(field(map, 'path'), sink, `${what}.path`, map.line)
  return format === undefined || path === undefined ? undefined : { format, path }
}

function decodeMetric(node: YamlNode, sink: IssueSink, id: string): BenchmarkMetricSpec | undefined {
  const what = `套件 '${id}' 的基准指标`
  const map = asMap(node, sink, what)
  if (map === undefined) return undefined
  checkKeys(map, ['name', 'unit', 'better', 'max_regression_pct', 'max', 'min'], sink, what)
  const name = str(field(map, 'name'), sink, `${what}.name`, map.line, { pattern: METRIC_NAME_RE })
  const unit = optionalStr(field(map, 'unit'), sink, `${what}.unit`, { maxBytes: 32 })
  const betterNode = field(map, 'better')
  const better = betterNode === undefined
    ? 'lower'
    : oneOf(betterNode, sink, `${what}.better`, (value): value is 'lower' | 'higher' => value === 'lower' || value === 'higher', ['lower', 'higher'])
  const maxRegression = num(field(map, 'max_regression_pct'), sink, `${what}.max_regression_pct`, 0, 1000)
  const max = num(field(map, 'max'), sink, `${what}.max`)
  const min = num(field(map, 'min'), sink, `${what}.min`)
  if (name === undefined || better === undefined) return undefined
  if (maxRegression === undefined && max === undefined && min === undefined) {
    return sink.add(map.line, `${what} '${name}' 至少需要 max_regression_pct、max 或 min`)
  }
  return {
    name,
    ...(unit === undefined ? {} : { unit }),
    better,
    ...(maxRegression === undefined ? {} : { max_regression_pct: maxRegression }),
    ...(max === undefined ? {} : { max }),
    ...(min === undefined ? {} : { min }),
  }
}

function decodeBenchmark(node: YamlNode | undefined, sink: IssueSink, id: string): BenchmarkSpec | undefined {
  if (node === undefined) return undefined
  const what = `套件 '${id}' 的 benchmark`
  const map = asMap(node, sink, what)
  if (map === undefined) return undefined
  checkKeys(map, ['runs', 'warmup', 'metrics'], sink, what)
  const runs = int(field(map, 'runs'), sink, `${what}.runs`, 1, 100) ?? 1
  const warmup = int(field(map, 'warmup'), sink, `${what}.warmup`, 0, 100) ?? 0
  const items = asSeq(field(map, 'metrics'), sink, `${what}.metrics`) ?? []
  const metrics = items.map((item) => decodeMetric(item, sink, id)).filter((metric) => metric !== undefined)
  if (items.length === 0) return sink.add(map.line, `${what}.metrics 至少声明一个指标`)
  const names = new Set<string>()
  for (const metric of metrics) {
    if (names.has(metric.name)) sink.add(map.line, `${what} 重复声明指标 '${metric.name}'`)
    names.add(metric.name)
  }
  return { runs, warmup, metrics }
}

/** 一个套件；失败时返回 undefined，问题已进 sink。 */
export function decodeCatalogSuite(node: YamlNode, sink: IssueSink): CatalogSuite | undefined {
  const map = asMap(node, sink, '套件')
  if (map === undefined) return undefined
  const id = str(field(map, 'id'), sink, '套件 id', map.line, { pattern: SUITE_ID_RE, hint: '小写字母、数字与 -，≤48' })
  const name = id ?? `第 ${map.line} 行的套件`
  checkKeys(map, SUITE_KEYS, sink, `套件 '${name}'`)
  const label = optionalStr(field(map, 'label'), sink, `套件 '${name}' 的 label`, { maxBytes: 240 })
  const kind = field(map, 'kind') === undefined
    ? sink.add(map.line, `套件 '${name}' 缺 kind`)
    : oneOf(field(map, 'kind'), sink, `套件 '${name}' 的 kind`, isTestKind, TEST_KINDS)
  const runner = field(map, 'runner') === undefined
    ? sink.add(map.line, `套件 '${name}' 缺 runner`)
    : oneOf(field(map, 'runner'), sink, `套件 '${name}' 的 runner`, isTestRunner, TEST_RUNNERS)
  const command = str(field(map, 'command'), sink, `套件 '${name}' 的 command`, map.line, COMMAND_RULE)
  const cwdNode = field(map, 'cwd')
  const cwd = cwdNode === undefined ? '.' : str(cwdNode, sink, `套件 '${name}' 的 cwd`, map.line)
  if (cwd !== undefined && !isRepoRelativePath(cwd)) sink.add(cwdNode?.line ?? map.line, `套件 '${name}' 的 cwd '${cwd}' 必须是仓库内相对路径`)
  const timeout = int(field(map, 'timeout_s'), sink, `套件 '${name}' 的 timeout_s`, 1, 14400) ?? CATALOG_DEFAULT_TIMEOUT_S
  const files = globList(field(map, 'files'), sink, `套件 '${name}' 的 files`)
  const covers = globList(field(map, 'covers'), sink, `套件 '${name}' 的 covers`)
  const select = decodeSelect(field(map, 'select'), sink, name)
  const coverage = decodeCoverage(field(map, 'coverage'), sink, name)
  const artifacts = outputList(field(map, 'artifacts'), sink, `套件 '${name}' 的 artifacts`)
  const env = strList(field(map, 'env'), sink, `套件 '${name}' 的 env`, { pattern: ENV_NAME_RE, hint: '环境变量名' })
  const services = strList(field(map, 'services'), sink, `套件 '${name}' 的 services`, { pattern: SUITE_ID_RE })
  const retries = int(field(map, 'retries'), sink, `套件 '${name}' 的 retries`, 0, 10) ?? 0
  const parallel = bool(field(map, 'parallel'), sink, `套件 '${name}' 的 parallel`) ?? false
  const tags = strList(field(map, 'tags'), sink, `套件 '${name}' 的 tags`, { pattern: TAG_RE, hint: '小写 token' })
  const browsers = strList(field(map, 'browsers'), sink, `套件 '${name}' 的 browsers`, { pattern: BROWSER_PROJECT_RE })
  const benchmark = decodeBenchmark(field(map, 'benchmark'), sink, name)
  if (id === undefined || kind === undefined || runner === undefined || command === undefined || cwd === undefined) return undefined
  if (!isRepoRelativePath(cwd)) return undefined
  const runnerProblem = kindRunnerProblem(kind, runner)
  if (runnerProblem !== undefined) return sink.add(map.line, `套件 '${id}'：${runnerProblem}`)
  const report = decodeReport(map, sink, { id, kind, runner })
  if (report === undefined) return undefined
  const declaresBenchmark = field(map, 'benchmark') !== undefined
  if (kind === 'benchmark' && !declaresBenchmark) {
    return sink.add(map.line, `基准套件 '${id}' 必须有 benchmark 段（指标、方向与阈值）`)
  }
  if (kind !== 'benchmark' && declaresBenchmark) {
    return sink.add(map.line, `套件 '${id}' 不是 benchmark 种类，不能声明 benchmark 段`)
  }
  if (declaresBenchmark && benchmark === undefined) return undefined
  if (field(map, 'select') !== undefined && select === undefined) return undefined
  if (field(map, 'coverage') !== undefined && coverage === undefined) return undefined
  if (browsers.length > 0 && runner !== 'playwright') {
    return sink.add(map.line, `套件 '${id}' 的 browsers 只用于 Playwright 套件`)
  }
  return {
    id,
    ...(label === undefined ? {} : { label }),
    kind, runner, command, cwd,
    timeout_s: timeout,
    files, covers,
    ...(select === undefined ? {} : { select }),
    report,
    ...(coverage === undefined ? {} : { coverage }),
    artifacts, env, services, retries, parallel, tags, browsers,
    ...(benchmark === undefined ? {} : { benchmark }),
  }
}

function decodeReady(node: YamlNode | undefined, sink: IssueSink, id: string, line: number): CatalogServiceReady | undefined {
  const what = `服务 '${id}' 的 ready`
  const map = asMap(node, sink, what, line)
  if (map === undefined) return undefined
  checkKeys(map, ['url', 'port', 'log', 'timeout_s'], sink, what)
  const timeout = int(field(map, 'timeout_s'), sink, `${what}.timeout_s`, 1, 3600) ?? SERVICE_DEFAULT_READY_TIMEOUT_S
  const probes = ['url', 'port', 'log'].filter((key) => field(map, key) !== undefined)
  if (probes.length !== 1) return sink.add(map.line, `${what} 必须恰好声明 url、port、log 之一`)
  if (field(map, 'url') !== undefined) {
    const url = str(field(map, 'url'), sink, `${what}.url`, map.line, { pattern: /^https?:\/\/\S+$/, hint: 'http(s):// 地址' })
    return url === undefined ? undefined : { url, timeout_s: timeout }
  }
  if (field(map, 'port') !== undefined) {
    const port = int(field(map, 'port'), sink, `${what}.port`, 1, 65535)
    return port === undefined ? undefined : { port, timeout_s: timeout }
  }
  const log = str(field(map, 'log'), sink, `${what}.log`, map.line, { maxBytes: 200 })
  return log === undefined ? undefined : { log, timeout_s: timeout }
}

export function decodeCatalogService(node: YamlNode, sink: IssueSink): CatalogService | undefined {
  const map = asMap(node, sink, '服务')
  if (map === undefined) return undefined
  const id = str(field(map, 'id'), sink, '服务 id', map.line, { pattern: SUITE_ID_RE, hint: '小写字母、数字与 -，≤48' })
  const name = id ?? `第 ${map.line} 行的服务`
  checkKeys(map, SERVICE_KEYS, sink, `服务 '${name}'`)
  const start = str(field(map, 'start'), sink, `服务 '${name}' 的 start`, map.line, COMMAND_RULE)
  const cwdNode = field(map, 'cwd')
  const cwd = cwdNode === undefined ? '.' : str(cwdNode, sink, `服务 '${name}' 的 cwd`, map.line)
  if (cwd !== undefined && !isRepoRelativePath(cwd)) sink.add(cwdNode?.line ?? map.line, `服务 '${name}' 的 cwd '${cwd}' 必须是仓库内相对路径`)
  const ready = decodeReady(field(map, 'ready'), sink, name, map.line)
  const stopNode = field(map, 'stop')
  const stop = stopNode === undefined ? 'SIGTERM' : oneOf(stopNode, sink, `服务 '${name}' 的 stop`, isServiceStopSignal, SERVICE_STOP_SIGNALS)
  const env = strList(field(map, 'env'), sink, `服务 '${name}' 的 env`, { pattern: ENV_NAME_RE, hint: '环境变量名' })
  if (id === undefined || start === undefined || cwd === undefined || ready === undefined || stop === undefined) return undefined
  if (!isRepoRelativePath(cwd)) return undefined
  return { id, start, cwd, ready, stop, env }
}
