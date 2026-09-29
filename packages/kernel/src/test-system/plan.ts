/**
 * 任务测试计划 `openspec/changes/<c>/test-plan.yaml`：本任务要跑的目录套件、本任务新增或修改的测试文件、
 * 场景 / 任务条目 → 用例映射，以及策略要求但本任务不适用的豁免。
 *
 * 计划由 CLI 独占写入：写出的字节恒为 `serializeTestPlan` 的规范化形态（列表排序、去重），摘要记进
 * change 目录的台账（plan-ledger.ts）。手改文件 → 字节摘要与台账不符 → `test-plan-tampered`。
 */
import { sha256Hex } from '../sha256.js'
import type { TestCatalog } from './catalog-types.js'
import { parseCaseRef, parseCovers } from './covers.js'
import { isRepoRelativePath } from './globs.js'
import {
  PLAN_SCOPES, SUITE_ID_RE, TEST_KINDS, isPlanScope, isTestKind, type PlanScope, type TestKind,
} from './vocabulary.js'
import { emitYaml } from './yaml-emit.js'
import { IssueSink, asMap, asSeq, checkKeys, field, oneOf, optionalStr, str, strList, type DecodeIssue } from './yaml-read.js'
import { YamlSubsetError, parseYamlSubset, type YamlNode } from './yaml-subset.js'

export const TEST_PLAN_SCHEMA = 'tenon-test-plan/v1'
export const TEST_PLAN_FILE = 'test-plan.yaml'
const CHANGE_RE = /^[A-Za-z0-9_-]{1,128}$/

export interface PlanSuite {
  readonly suite: string
  readonly scope: PlanScope
  /** scope grep 的用例名过滤。 */
  readonly pattern?: string
  /** scope files 的测试文件（仓库相对）。 */
  readonly files?: readonly string[]
}

export interface PlanFile {
  readonly path: string
  readonly suite?: string
  readonly kind?: TestKind
}

export interface PlanCase {
  readonly covers: string
  readonly tests: readonly string[]
}

interface WaiverBase {
  readonly reason: string
  /** 只由 `tenon review acknowledge` 的同一次确认写入；null = 未批准，不解除阻塞。 */
  readonly approved_by: string | null
}

export type PlanWaiver =
  | (WaiverBase & { readonly kind: TestKind; readonly covers?: undefined })
  | (WaiverBase & { readonly covers: string; readonly kind?: undefined })

export interface TestPlan {
  readonly schema: typeof TEST_PLAN_SCHEMA
  readonly change: string
  readonly suites: readonly PlanSuite[]
  readonly files: readonly PlanFile[]
  readonly cases: readonly PlanCase[]
  readonly waivers: readonly PlanWaiver[]
}

export type PlanParseResult =
  | { readonly ok: true; readonly plan: TestPlan }
  | { readonly ok: false; readonly issues: readonly DecodeIssue[] }

export function emptyTestPlan(change: string): TestPlan {
  return { schema: TEST_PLAN_SCHEMA, change, suites: [], files: [], cases: [], waivers: [] }
}

function decodeSuite(node: YamlNode, sink: IssueSink): PlanSuite | undefined {
  const map = asMap(node, sink, '计划套件')
  if (map === undefined) return undefined
  checkKeys(map, ['suite', 'scope', 'pattern', 'files'], sink, '计划套件')
  const suite = str(field(map, 'suite'), sink, '计划套件 suite', map.line, { pattern: SUITE_ID_RE })
  const scope = field(map, 'scope') === undefined
    ? sink.add(map.line, `计划套件 '${suite ?? '?'}' 缺 scope`)
    : oneOf(field(map, 'scope'), sink, `计划套件 '${suite ?? '?'}' 的 scope`, isPlanScope, PLAN_SCOPES)
  const pattern = optionalStr(field(map, 'pattern'), sink, `计划套件 '${suite ?? '?'}' 的 pattern`, { maxBytes: 500 })
  const filesNode = field(map, 'files')
  const files = filesNode === undefined ? undefined : strList(filesNode, sink, `计划套件 '${suite ?? '?'}' 的 files`)
  if (suite === undefined || scope === undefined) return undefined
  if (scope === 'grep' && pattern === undefined) return sink.add(map.line, `计划套件 '${suite}' 的 scope grep 需要 pattern`)
  if (scope !== 'grep' && pattern !== undefined) return sink.add(map.line, `计划套件 '${suite}' 只有 scope grep 才写 pattern`)
  if (scope === 'files' && (files === undefined || files.length === 0)) return sink.add(map.line, `计划套件 '${suite}' 的 scope files 需要非空 files`)
  if (scope !== 'files' && files !== undefined) return sink.add(map.line, `计划套件 '${suite}' 只有 scope files 才写 files`)
  for (const path of files ?? []) {
    if (!isRepoRelativePath(path) || path === '.') return sink.add(map.line, `计划套件 '${suite}' 的文件 '${path}' 必须是仓库内相对路径`)
  }
  return { suite, scope, ...(pattern === undefined ? {} : { pattern }), ...(files === undefined ? {} : { files }) }
}

function decodeFile(node: YamlNode, sink: IssueSink): PlanFile | undefined {
  const map = asMap(node, sink, '计划文件')
  if (map === undefined) return undefined
  checkKeys(map, ['path', 'suite', 'kind'], sink, '计划文件')
  const path = str(field(map, 'path'), sink, '计划文件 path', map.line)
  const suite = optionalStr(field(map, 'suite'), sink, '计划文件 suite', { pattern: SUITE_ID_RE })
  const kind = oneOf(field(map, 'kind'), sink, '计划文件 kind', isTestKind, TEST_KINDS)
  if (path === undefined) return undefined
  if (!isRepoRelativePath(path) || path === '.') return sink.add(map.line, `计划文件 '${path}' 必须是仓库内相对路径（不是 glob）`)
  if ((field(map, 'suite') !== undefined && suite === undefined) || (field(map, 'kind') !== undefined && kind === undefined)) return undefined
  return { path, ...(suite === undefined ? {} : { suite }), ...(kind === undefined ? {} : { kind }) }
}

function decodeCase(node: YamlNode, sink: IssueSink): PlanCase | undefined {
  const map = asMap(node, sink, '追溯映射')
  if (map === undefined) return undefined
  checkKeys(map, ['covers', 'tests'], sink, '追溯映射')
  const covers = str(field(map, 'covers'), sink, '追溯映射 covers', map.line)
  const tests = strList(field(map, 'tests'), sink, `追溯映射 '${covers ?? '?'}' 的 tests`)
  if (covers === undefined) return undefined
  if (parseCovers(covers) === undefined) return sink.add(map.line, `covers '${covers}' 非法（spec:<capability>/<Scenario 标题> 或 task:<编号>）`)
  if (tests.length === 0) return sink.add(map.line, `追溯映射 '${covers}' 至少需要一个用例`)
  for (const test of tests) {
    if (parseCaseRef(test) === undefined) return sink.add(map.line, `用例引用 '${test}' 非法（<文件> › <用例名>）`)
  }
  return { covers, tests }
}

function decodeWaiver(node: YamlNode, sink: IssueSink): PlanWaiver | undefined {
  const map = asMap(node, sink, '豁免')
  if (map === undefined) return undefined
  checkKeys(map, ['kind', 'covers', 'reason', 'approved_by'], sink, '豁免')
  const kind = oneOf(field(map, 'kind'), sink, '豁免 kind', isTestKind, TEST_KINDS)
  const covers = optionalStr(field(map, 'covers'), sink, '豁免 covers')
  const reason = str(field(map, 'reason'), sink, '豁免 reason', map.line, { maxBytes: 1000 })
  const approvedNode = field(map, 'approved_by')
  const approvedValue = approvedNode?.kind === 'scalar' ? approvedNode.value : undefined
  if (approvedNode !== undefined && approvedValue !== null && (typeof approvedValue !== 'string' || approvedValue === '')) {
    return sink.add(approvedNode.line, '豁免 approved_by 必须是 null 或批准人')
  }
  const approved = typeof approvedValue === 'string' ? approvedValue : null
  if (reason === undefined) return undefined
  if ((kind === undefined) === (covers === undefined)) return sink.add(map.line, '豁免必须恰好写 kind 或 covers 之一')
  if (covers !== undefined && parseCovers(covers) === undefined) return sink.add(map.line, `豁免 covers '${covers}' 非法`)
  return kind !== undefined
    ? { kind, reason, approved_by: approved }
    : { covers: covers ?? '', reason, approved_by: approved }
}

function decodeList<T>(node: YamlNode | undefined, sink: IssueSink, what: string, decode: (node: YamlNode, sink: IssueSink) => T | undefined): T[] {
  return (asSeq(node, sink, what) ?? []).map((item) => decode(item, sink)).filter((item): item is T => item !== undefined)
}

/** expectedChange 给出时，计划里的 change 必须与之相同（防止把别的任务的计划拷过来）。 */
export function parseTestPlan(text: string, expectedChange?: string): PlanParseResult {
  let root
  try {
    root = parseYamlSubset(text)
  } catch (error) {
    if (error instanceof YamlSubsetError) return { ok: false, issues: [{ line: error.line, message: error.message.replace(/^第 \d+ 行：/, '') }] }
    throw error
  }
  const sink = new IssueSink()
  const map = asMap(root, sink, '测试计划')
  if (map === undefined) return { ok: false, issues: sink.issues }
  checkKeys(map, ['schema', 'change', 'suites', 'files', 'cases', 'waivers'], sink, '测试计划')
  const schema = str(field(map, 'schema'), sink, 'schema', map.line)
  if (schema !== undefined && schema !== TEST_PLAN_SCHEMA) sink.add(map.line, `schema 必须是 ${TEST_PLAN_SCHEMA}`)
  const change = str(field(map, 'change'), sink, 'change', map.line, { pattern: CHANGE_RE })
  if (change !== undefined && expectedChange !== undefined && change !== expectedChange) {
    sink.add(field(map, 'change')?.line ?? map.line, `计划属于任务 '${change}'，不是 '${expectedChange}'`)
  }
  const plan: TestPlan = {
    schema: TEST_PLAN_SCHEMA,
    change: change ?? '',
    suites: decodeList(field(map, 'suites'), sink, 'suites', decodeSuite),
    files: decodeList(field(map, 'files'), sink, 'files', decodeFile),
    cases: decodeList(field(map, 'cases'), sink, 'cases', decodeCase),
    waivers: decodeList(field(map, 'waivers'), sink, 'waivers', decodeWaiver),
  }
  for (const [what, keys] of [
    ['套件', plan.suites.map((item) => item.suite)],
    ['文件', plan.files.map((item) => item.path)],
    ['追溯映射', plan.cases.map((item) => item.covers)],
    ['豁免', plan.waivers.map(waiverKey)],
  ] as const) {
    const seen = new Set<string>()
    for (const key of keys) {
      if (seen.has(key)) sink.add(map.line, `计划里的${what} '${key}' 重复`)
      seen.add(key)
    }
  }
  if (sink.issues.length > 0) return { ok: false, issues: sink.issues }
  return { ok: true, plan }
}

export function waiverKey(waiver: PlanWaiver): string {
  return waiver.kind !== undefined ? `kind:${waiver.kind}` : `covers:${waiver.covers}`
}

function byKey<T>(items: readonly T[], key: (item: T) => string): T[] {
  const map = new Map<string, T>()
  for (const item of items) map.set(key(item), item)
  return [...map.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).map(([, item]) => item)
}

/** 规范形态：各列表按主键排序、同键后写者胜，用例引用去重排序。 */
export function normalizeTestPlan(plan: TestPlan): TestPlan {
  return {
    schema: TEST_PLAN_SCHEMA,
    change: plan.change,
    suites: byKey(plan.suites, (item) => item.suite).map((item) => (
      item.files === undefined ? item : { ...item, files: [...new Set(item.files)].sort() })),
    files: byKey(plan.files, (item) => item.path),
    cases: byKey(plan.cases, (item) => item.covers).map((item) => ({ covers: item.covers, tests: [...new Set(item.tests)].sort() })),
    waivers: byKey(plan.waivers, waiverKey),
  }
}

export function serializeTestPlan(plan: TestPlan): string {
  const normal = normalizeTestPlan(plan)
  return emitYaml({
    schema: normal.schema,
    change: normal.change,
    suites: normal.suites.map((item) => ({ suite: item.suite, scope: item.scope, pattern: item.pattern, files: item.files })),
    files: normal.files.map((item) => ({ path: item.path, suite: item.suite, kind: item.kind })),
    cases: normal.cases.map((item) => ({ covers: item.covers, tests: item.tests })),
    waivers: normal.waivers.map((item) => ({
      kind: item.kind, covers: item.covers, reason: item.reason, approved_by: item.approved_by,
    })),
  })
}

export function testPlanBytesDigest(bytes: string): string {
  return `sha256:${sha256Hex(bytes)}`
}

/** 计划摘要 = 规范化字节的 sha256；CLI 写入的文件字节摘要与此相等。 */
export function testPlanDigest(plan: TestPlan): string {
  return testPlanBytesDigest(serializeTestPlan(plan))
}

export interface PlanCatalogProblem {
  readonly subject: string
  readonly message: string
}

/** 计划与当前目录的一致性：登记的套件还在、文件指向的套件还在、文件声明的种类与套件一致。 */
export function planCatalogProblems(plan: TestPlan, catalog: TestCatalog): readonly PlanCatalogProblem[] {
  const suites = new Map(catalog.suites.map((suite) => [suite.id, suite]))
  const problems: PlanCatalogProblem[] = []
  for (const item of plan.suites) {
    if (!suites.has(item.suite)) problems.push({ subject: item.suite, message: `计划登记的套件 '${item.suite}' 不在目录中` })
  }
  for (const file of plan.files) {
    if (file.suite === undefined) continue
    const suite = suites.get(file.suite)
    if (suite === undefined) {
      problems.push({ subject: file.suite, message: `测试文件 '${file.path}' 指向的套件 '${file.suite}' 不在目录中` })
    } else if (file.kind !== undefined && file.kind !== suite.kind) {
      problems.push({ subject: file.path, message: `测试文件 '${file.path}' 声明种类 ${file.kind}，但套件 '${suite.id}' 是 ${suite.kind}` })
    }
  }
  return problems
}
