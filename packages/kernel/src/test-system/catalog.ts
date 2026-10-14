/**
 * 项目测试目录的解析、跨条目校验、摘要与规范化写出。
 *
 * 解析不在第一个错误处停：YAML 语法错误之外，全部问题逐条带行号返回，`tenon test catalog validate`
 * 与门禁都据此列出 `catalog.yaml:<行>: …`。
 *
 * 摘要：`catalogDigest` 覆盖整份目录；运行记录绑定的是 `catalogSuitesDigest`——只取本次运行涉及的套件
 * 条目、它们引用的服务与机器画像口径（`profile`、`profiles_env`），改动无关套件不会让别的记录过期。
 * 声明了档位定义（`levels`）时两种摘要都带上它：改了档位定义，已有运行随之过期。
 */
import { sha256Hex } from '../sha256.js'
import { decodeCatalogService, decodeCatalogSuite } from './catalog-decode.js'
import { decodeNotApplicable, notApplicableValue } from './catalog-na.js'
import {
  TEST_CATALOG_SCHEMA, type CatalogService, type CatalogSuite, type TestCatalog,
} from './catalog-types.js'
import { canonicalJson } from './canonical.js'
import { repoGlob } from './globs.js'
import { decodeCatalogLevels, levelsValue } from './levels-codec.js'
import { MACHINE_PROFILE_MODES, isMachineProfileMode, type MachineProfileMode } from './machine-profile.js'
import { ENV_NAME_RE } from './vocabulary.js'
import { emitYaml, type YamlValue } from './yaml-emit.js'
import { IssueSink, asMap, asSeq, checkKeys, field, formatIssue, oneOf, str, strList, type DecodeIssue } from './yaml-read.js'
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
  checkKeys(map, ['schema', 'profile', 'profiles_env', 'suites', 'services', 'not_applicable', 'levels'], sink, '目录')
  const schema = str(field(map, 'schema'), sink, 'schema', map.line)
  if (schema !== undefined && schema !== TEST_CATALOG_SCHEMA) {
    sink.add(field(map, 'schema')?.line ?? map.line, `schema 必须是 ${TEST_CATALOG_SCHEMA}（实际 '${schema}'）`)
  }
  const profileMode = oneOf<MachineProfileMode>(field(map, 'profile'), sink, 'profile', isMachineProfileMode, MACHINE_PROFILE_MODES)
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
  const levels = decodeCatalogLevels(field(map, 'levels'), sink)
  if (sink.issues.length > 0) return { ok: false, issues: sink.issues }
  return {
    ok: true,
    catalog: {
      schema: TEST_CATALOG_SCHEMA,
      ...(profileMode === 'coarse' ? { profile: profileMode } : {}),
      profiles_env: profilesEnv, suites, services,
      ...(notApplicable.length === 0 ? {} : { not_applicable: notApplicable }),
      ...(levels === undefined ? {} : { levels }),
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
  // 细口径不进摘要：没有声明 profile 的旧目录，摘要与引入 profile 之前逐字相同。
  // 档位定义同理只在声明时进摘要：改了它，已绑定的运行随之过期；没写 levels 的目录摘要不变。
  return digestOf({
    ...(catalog.profile === 'coarse' ? { profile: 'coarse' } : {}),
    profiles_env: catalog.profiles_env, suites, services,
    ...(catalog.levels === undefined ? {} : { levels: catalog.levels }),
  })
}

/** 按 UTF-16 码元比较（与 Array.prototype.sort 的缺省口径一致，不受区域设置影响）；摘要排序都用它。 */
function byCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** 套件里会被执行的文字（整份摘要与单条摘要共用）：命令、工作目录、按文件 / 按名字运行的模板、声明的环境变量名（排序）。 */
function suiteExecFields(suite: CatalogSuite): {
  readonly cwd: string
  readonly command: string
  readonly select_files: string | null
  readonly select_grep: string | null
  readonly env: readonly string[]
} {
  return {
    cwd: suite.cwd, command: suite.command,
    select_files: suite.select?.files ?? null, select_grep: suite.select?.grep ?? null,
    env: [...suite.env].sort(),
  }
}

/**
 * 目录里「会被 Tenon 执行的文字」的摘要：套件的命令、选择模板、工作目录、声明的环境变量与依赖服务，
 * 服务的启动命令、工作目录、就绪探测与停止方式。用户在本机首次执行前确认的就是这份摘要（R6）：
 * 改标签、标签页、covers、报告路径不会让信任失效，改任何一条要执行的命令一定会。
 */
export function catalogExecDigest(catalog: TestCatalog): string {
  return digestOf({
    suites: [...catalog.suites].sort((left, right) => byCodeUnit(left.id, right.id)).map((suite) => ({
      id: suite.id, ...suiteExecFields(suite), services: [...suite.services].sort(),
    })),
    services: [...catalog.services].sort((left, right) => byCodeUnit(left.id, right.id)).map((service) => ({
      id: service.id, ...serviceExecFields(service),
    })),
  })
}

/**
 * 任务冻结工作流里步骤内联测试（旧的 `tests[]`）的可执行摘要：id + 命令 + 工作目录。它们来自项目的工作流定义，
 * 和测试目录一样是仓库带来的、会被执行的文字，同样需要用户在本机首次执行前确认（R6）。
 */
export function stepTestsExecDigest(tests: readonly { readonly id: string; readonly command: string; readonly cwd: string }[]): string {
  const rows = tests.map((test) => ({ id: test.id, command: test.command, cwd: test.cwd }))
    .sort((left, right) => byCodeUnit(left.id + '\u0000' + left.command, right.id + '\u0000' + right.command))
  return digestOf({ step_tests: rows })
}

/**
 * 逐条信任用的「一条可执行命令」：`digest` 是这条命令的摘要，`line` 是确认信任时给用户看的一行。
 * 用户级信任存储（trust-store.ts）按 (仓库, digest) 记，所以只有新增或改动的命令要重新确认。
 */
export interface ExecEntry {
  readonly digest: string
  readonly line: string
}

/**
 * 确认的那一行不能被命令文字改写：控制字符（回车、退格、转义…）、格式字符（双向控制、零宽）与行分隔符
 * 转成可见的 \uXXXX，否则一个 `\r` 或 RLO 就能让终端上显示的命令和实际执行的不同。
 */
function visibleLine(value: string): string {
  const named: Readonly<Record<string, string>> = { '\n': '\\n', '\r': '\\r', '\t': '\\t' }
  return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (char) =>
    named[char] ?? `\\u${(char.codePointAt(0) ?? 0).toString(16).padStart(4, '0')}`)
}

function cwdNote(cwd: string): string {
  return cwd === '.' ? '' : `  [cwd=${cwd}]`
}

/** 服务里会被执行的文字（整份摘要与单条摘要共用）：启动命令、工作目录、就绪探测、停止方式、声明的环境变量名（排序）。 */
function serviceExecFields(service: CatalogService): Pick<CatalogService, 'start' | 'cwd' | 'ready' | 'stop'> & { readonly env: readonly string[] } {
  return { start: service.start, cwd: service.cwd, ready: service.ready, stop: service.stop, env: [...service.env].sort() }
}

function suiteExecEntry(catalog: TestCatalog, suite: CatalogSuite): ExecEntry {
  const used = suite.services.map((id) => catalog.services.find((service) => service.id === id) ?? { id, missing: true })
  // 服务按内容排序、不带 id：改服务的 id 不算改了命令，顺序也不影响摘要。
  const services = used.map((service) => ('missing' in service ? service : serviceExecFields(service)))
    .sort((left, right) => byCodeUnit(canonicalJson(left), canonicalJson(right)))
  const digest = digestOf({ kind: 'suite', ...suiteExecFields(suite), services })
  const parts = [
    `套件 ${suite.id}（${suite.kind}）  $ ${suite.command}${cwdNote(suite.cwd)}`,
    ...(suite.select?.files === undefined ? [] : [`按文件运行  $ ${suite.select.files}`]),
    ...(suite.select?.grep === undefined ? [] : [`按用例名运行  $ ${suite.select.grep}`]),
    ...used.map((service) => ('missing' in service ? `服务 ${service.id}（目录里没有定义）` : `服务 ${service.id}  $ ${service.start}${cwdNote(service.cwd)}`)),
  ]
  return { digest, line: visibleLine(parts.join('；')) }
}

/**
 * 目录里每个套件一条可执行命令（套件的 `command`、`cwd`、`select.files` / `select.grep`、排序后的 `env`，
 * 加上它用到的服务的启动命令）。`suiteIds` 给出时只取这些套件（本次要执行的），按目录顺序、去重，目录里没有的 id 忽略。
 * 没有任何套件用到的服务不会被执行，也就没有条目。
 */
export function catalogExecEntries(catalog: TestCatalog, suiteIds?: readonly string[]): readonly ExecEntry[] {
  const wanted = suiteIds === undefined ? undefined : new Set(suiteIds)
  return catalog.suites.filter((suite) => wanted === undefined || wanted.has(suite.id)).map((suite) => suiteExecEntry(catalog, suite))
}

/** 步骤内联测试（旧的 `tests[]`）逐条的可执行摘要：按 `command` 与 `cwd` 计算，换步骤或测试 id 不算改了命令。 */
export function stepTestExecEntries(
  tests: readonly { readonly step: string; readonly id: string; readonly command: string; readonly cwd: string }[],
): readonly ExecEntry[] {
  return tests.map((test) => ({
    digest: digestOf({ kind: 'step-test', command: test.command, cwd: test.cwd }),
    line: visibleLine(`步骤 ${test.step} 的测试 ${test.id}  $ ${test.command}${cwdNote(test.cwd)}`),
  }))
}

/** 套件拥有的测试文件 glob，换算成仓库相对。 */
export function suiteFileGlobs(suite: CatalogSuite): readonly string[] {
  return suite.files.map((glob) => repoGlob(suite.cwd, glob))
}

export function suiteCoverGlobs(suite: CatalogSuite): readonly string[] {
  return suite.covers.map((glob) => repoGlob(suite.cwd, glob))
}

export function suiteValue(suite: CatalogSuite): YamlValue {
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

export function serviceValue(service: CatalogService): YamlValue {
  return {
    id: service.id,
    start: service.start,
    cwd: service.cwd === '.' ? undefined : service.cwd,
    ready: { ...service.ready },
    stop: service.stop,
    env: service.env.length === 0 ? undefined : service.env,
  }
}

/** 目录的顶层键 → 要写出的值（键序即写出顺序，省略等于默认值的键）。整份写出与按节点写回（catalog-patch.ts）共用这一份。 */
export function catalogValue(catalog: TestCatalog): { readonly [key: string]: YamlValue | undefined } {
  return {
    schema: catalog.schema,
    profile: catalog.profile === 'coarse' ? 'coarse' : undefined,
    profiles_env: catalog.profiles_env.length === 0 ? undefined : catalog.profiles_env,
    suites: catalog.suites.map(suiteValue),
    services: catalog.services.length === 0 ? undefined : catalog.services.map(serviceValue),
    not_applicable: notApplicableValue(catalog.not_applicable),
    levels: levelsValue(catalog.levels),
  }
}

/**
 * 规范化整份写出（新建目录用：`discover --write`、没有目录时的第一次写入）：保留条目顺序，
 * 省略等于默认值的键，注释不保留。parseTestCatalog(serializeTestCatalog(c)) 深等于 c。
 * 已有目录文件的改动走 `patchCatalogText`，只替换变化的节点。
 */
export function serializeTestCatalog(catalog: TestCatalog): string {
  return emitYaml(catalogValue(catalog))
}
