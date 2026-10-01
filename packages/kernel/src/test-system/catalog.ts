/**
 * 项目测试目录的解析、跨条目校验、摘要与规范化写出。
 *
 * 解析不在第一个错误处停：YAML 语法错误之外，全部问题逐条带行号返回，`tenon test catalog validate`
 * 与门禁都据此列出 `catalog.yaml:<行>: …`。
 *
 * 摘要：`catalogDigest` 覆盖整份目录；运行记录绑定的是 `catalogSuitesDigest`——只取本次运行涉及的套件
 * 条目、它们引用的服务与 `profiles_env`，改动无关套件不会让别的记录过期。
 */
import { sha256Hex } from '../sha256.js'
import { decodeCatalogService, decodeCatalogSuite } from './catalog-decode.js'
import { decodeNotApplicable, notApplicableValue } from './catalog-na.js'
import {
  TEST_CATALOG_SCHEMA, type CatalogService, type CatalogSuite, type TestCatalog,
} from './catalog-types.js'
import { canonicalJson } from './canonical.js'
import { repoGlob } from './globs.js'
import { ENV_NAME_RE } from './vocabulary.js'
import { emitYaml, type YamlValue } from './yaml-emit.js'
import { IssueSink, asMap, asSeq, checkKeys, field, formatIssue, str, strList, type DecodeIssue } from './yaml-read.js'
import { YamlSubsetError, parseYamlSubset } from './yaml-subset.js'

export const TEST_CATALOG_FILE_LABEL = 'catalog.yaml'

export type CatalogParseResult =
  | { readonly ok: true; readonly catalog: TestCatalog }
  | { readonly ok: false; readonly issues: readonly DecodeIssue[] }

export function parseTestCatalog(text: string): CatalogParseResult {
  let root
  try {
    root = parseYamlSubset(text)
  } catch (error) {
    if (error instanceof YamlSubsetError) return { ok: false, issues: [{ line: error.line, message: error.message.replace(/^第 \d+ 行：/, '') }] }
    throw error
  }
  const sink = new IssueSink()
  const map = asMap(root, sink, '目录')
  if (map === undefined) return { ok: false, issues: sink.issues }
  checkKeys(map, ['schema', 'profiles_env', 'suites', 'services', 'not_applicable'], sink, '目录')
  const schema = str(field(map, 'schema'), sink, 'schema', map.line)
  if (schema !== undefined && schema !== TEST_CATALOG_SCHEMA) {
    sink.add(field(map, 'schema')?.line ?? map.line, `schema 必须是 ${TEST_CATALOG_SCHEMA}（实际 '${schema}'）`)
  }
  const profilesEnv = strList(field(map, 'profiles_env'), sink, 'profiles_env', { pattern: ENV_NAME_RE, hint: '环境变量名' })
  const suites: CatalogSuite[] = []
  const suiteLines = new Map<string, number>()
  for (const node of asSeq(field(map, 'suites'), sink, 'suites') ?? []) {
    const suite = decodeCatalogSuite(node, sink)
    if (suite === undefined) continue
    if (suiteLines.has(suite.id)) {
      sink.add(node.line, `套件 id '${suite.id}' 重复（首次在第 ${suiteLines.get(suite.id) ?? '?'} 行）`)
      continue
    }
    suiteLines.set(suite.id, node.line)
    suites.push(suite)
  }
  const services: CatalogService[] = []
  const serviceLines = new Map<string, number>()
  for (const node of asSeq(field(map, 'services'), sink, 'services') ?? []) {
    const service = decodeCatalogService(node, sink)
    if (service === undefined) continue
    if (serviceLines.has(service.id)) {
      sink.add(node.line, `服务 id '${service.id}' 重复（首次在第 ${serviceLines.get(service.id) ?? '?'} 行）`)
      continue
    }
    serviceLines.set(service.id, node.line)
    services.push(service)
  }
  for (const suite of suites) {
    for (const service of suite.services) {
      if (!serviceLines.has(service)) sink.add(suiteLines.get(suite.id) ?? map.line, `套件 '${suite.id}' 引用的服务 '${service}' 不存在`)
    }
  }
  const notApplicable = decodeNotApplicable(field(map, 'not_applicable'), sink)
  if (sink.issues.length > 0) return { ok: false, issues: sink.issues }
  return {
    ok: true,
    catalog: {
      schema: TEST_CATALOG_SCHEMA, profiles_env: profilesEnv, suites, services,
      ...(notApplicable.length === 0 ? {} : { not_applicable: notApplicable }),
    },
  }
}

export function formatCatalogIssues(issues: readonly DecodeIssue[], file = TEST_CATALOG_FILE_LABEL): readonly string[] {
  return issues.map((issue) => formatIssue(file, issue))
}

export function catalogSuite(catalog: TestCatalog, id: string): CatalogSuite | undefined {
  return catalog.suites.find((suite) => suite.id === id)
}

function digestOf(value: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(value))}`
}

export function catalogDigest(catalog: TestCatalog): string {
  return digestOf(catalog)
}

/** 只取给定套件（及其服务）的摘要；目录里不存在的 id 以 null 占位，删除套件同样使摘要变化。 */
export function catalogSuitesDigest(catalog: TestCatalog, suiteIds: readonly string[]): string {
  const ids = [...new Set(suiteIds)].sort()
  const suites = ids.map((id) => catalogSuite(catalog, id) ?? { id, missing: true })
  const serviceIds = new Set(ids.flatMap((id) => catalogSuite(catalog, id)?.services ?? []))
  const services = catalog.services.filter((service) => serviceIds.has(service.id))
  return digestOf({ profiles_env: catalog.profiles_env, suites, services })
}

/** 套件拥有的测试文件 glob，换算成仓库相对。 */
export function suiteFileGlobs(suite: CatalogSuite): readonly string[] {
  return suite.files.map((glob) => repoGlob(suite.cwd, glob))
}

export function suiteCoverGlobs(suite: CatalogSuite): readonly string[] {
  return suite.covers.map((glob) => repoGlob(suite.cwd, glob))
}

function suiteValue(suite: CatalogSuite): YamlValue {
  return {
    id: suite.id,
    label: suite.label,
    kind: suite.kind,
    runner: suite.runner,
    command: suite.command,
    cwd: suite.cwd === '.' ? undefined : suite.cwd,
    timeout_s: suite.timeout_s,
    files: suite.files.length === 0 ? undefined : suite.files,
    covers: suite.covers.length === 0 ? undefined : suite.covers,
    select: suite.select === undefined ? undefined : { files: suite.select.files, grep: suite.select.grep },
    report: { format: suite.report.format, path: suite.report.path },
    coverage: suite.coverage === undefined ? undefined : { format: suite.coverage.format, path: suite.coverage.path },
    artifacts: suite.artifacts.length === 0 ? undefined : suite.artifacts,
    env: suite.env.length === 0 ? undefined : suite.env,
    services: suite.services.length === 0 ? undefined : suite.services,
    retries: suite.retries === 0 ? undefined : suite.retries,
    parallel: suite.parallel ? true : undefined,
    tags: suite.tags.length === 0 ? undefined : suite.tags,
    browsers: suite.browsers.length === 0 ? undefined : suite.browsers,
    benchmark: suite.benchmark === undefined ? undefined : {
      runs: suite.benchmark.runs,
      warmup: suite.benchmark.warmup,
      metrics: suite.benchmark.metrics.map((metric) => ({
        name: metric.name, unit: metric.unit, better: metric.better,
        max_regression_pct: metric.max_regression_pct, max: metric.max, min: metric.min,
      })),
    },
  }
}

function serviceValue(service: CatalogService): YamlValue {
  return {
    id: service.id,
    start: service.start,
    cwd: service.cwd === '.' ? undefined : service.cwd,
    ready: { ...service.ready },
    stop: service.stop,
    env: service.env.length === 0 ? undefined : service.env,
  }
}

/**
 * 规范化写出（`tenon test catalog add|set|rm` 与 `discover --write` 用）：保留条目顺序，
 * 省略等于默认值的键，注释不保留。parseTestCatalog(serializeTestCatalog(c)) 深等于 c。
 */
export function serializeTestCatalog(catalog: TestCatalog): string {
  return emitYaml({
    schema: catalog.schema,
    profiles_env: catalog.profiles_env.length === 0 ? undefined : catalog.profiles_env,
    suites: catalog.suites.map(suiteValue),
    services: catalog.services.length === 0 ? undefined : catalog.services.map(serviceValue),
    not_applicable: notApplicableValue(catalog.not_applicable),
  })
}
