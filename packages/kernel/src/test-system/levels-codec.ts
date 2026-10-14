/**
 * 目录顶层键 `levels` 的解码（闭集键、值域、行号报错）与规范化写出。
 * 档名、键、测试类、覆盖率范围各自闭集校验；问题逐条进 sink，一次列全。
 */
import { LEVEL_NAMES, type CatalogLevels, type LevelName, type LevelThresholds } from './levels.js'
import { COVERAGE_METRICS, TEST_CLASSES, isTestClass, type CoverageMetric, type TestClass } from './vocabulary.js'
import type { YamlValue } from './yaml-emit.js'
import { IssueSink, asMap, asSeq, bool, checkKeys, field, int, num, oneOf } from './yaml-read.js'
import type { YamlNode } from './yaml-subset.js'

type Tier = NonNullable<CatalogLevels[LevelName]>
type MutableTier = { -readonly [K in keyof Tier]: Tier[K] }
type MutableCoverage = { -readonly [K in CoverageMetric]?: number }

const SCENARIO_MODES = ['off', 'required', 'passing'] as const
const TIER_KEYS = ['required', 'touched', 'scenarios', 'coverage', 'flaky', 'require_baseline'] as const
/** plan 档不跑套件，只看必需类与场景映射。 */
const PLAN_KEYS = ['required', 'scenarios'] as const

function isScenarioMode(value: unknown): value is LevelThresholds['scenarios'] {
  return (SCENARIO_MODES as readonly unknown[]).includes(value)
}

function classList(node: YamlNode | undefined, sink: IssueSink, what: string): TestClass[] | undefined {
  const items = asSeq(node, sink, what)
  if (items === undefined) return undefined
  const out: TestClass[] = []
  for (const item of items) {
    const value = oneOf(item, sink, `${what} 的一项`, isTestClass, TEST_CLASSES)
    if (value === undefined) continue
    if (out.includes(value)) sink.add(item.line, `${what} 重复列出 '${value}'`)
    else out.push(value)
  }
  return out
}

function decodeCoverage(node: YamlNode | undefined, sink: IssueSink, what: string): Tier['coverage'] {
  const map = asMap(node, sink, what)
  if (map === undefined) return undefined
  checkKeys(map, COVERAGE_METRICS, sink, what)
  if (map.entries.length === 0) return sink.add(map.line, `${what} 至少声明 ${COVERAGE_METRICS.join('/')} 之一`)
  const out: MutableCoverage = {}
  for (const metric of COVERAGE_METRICS) {
    const value = num(field(map, metric), sink, `${what}.${metric}`, 0, 100)
    if (value !== undefined) out[metric] = value
  }
  return Object.keys(out).length === 0 ? undefined : out
}

function decodeFlaky(node: YamlNode | undefined, sink: IssueSink, what: string): Tier['flaky'] {
  const map = asMap(node, sink, what)
  if (map === undefined) return undefined
  checkKeys(map, ['max', 'fail_on_new'], sink, what)
  const maxNode = field(map, 'max')
  const max = maxNode === undefined ? sink.add(map.line, `${what}.max 缺失`) : int(maxNode, sink, `${what}.max`, 0, 1000)
  const failOnNew = bool(field(map, 'fail_on_new'), sink, `${what}.fail_on_new`) ?? false
  return max === undefined ? undefined : { max, fail_on_new: failOnNew }
}

function decodeTier(name: LevelName, node: YamlNode, sink: IssueSink): Tier | undefined {
  const what = `levels.${name}`
  const map = asMap(node, sink, what)
  if (map === undefined) return undefined
  checkKeys(map, name === 'plan' ? PLAN_KEYS : TIER_KEYS, sink, what)
  const tier: MutableTier = {}
  const declared = (key: string): YamlNode | undefined => field(map, key)
  if (declared('required') !== undefined) {
    const required = classList(declared('required'), sink, `${what}.required`)
    if (required !== undefined) tier.required = required
  }
  if (name !== 'plan' && declared('touched') !== undefined) {
    const touched = classList(declared('touched'), sink, `${what}.touched`)
    if (touched !== undefined) tier.touched = touched
  }
  if (declared('scenarios') !== undefined) {
    const scenarios = oneOf(declared('scenarios'), sink, `${what}.scenarios`, isScenarioMode, SCENARIO_MODES)
    if (scenarios !== undefined) tier.scenarios = scenarios
  }
  if (name !== 'plan' && declared('coverage') !== undefined) {
    const coverage = decodeCoverage(declared('coverage'), sink, `${what}.coverage`)
    if (coverage !== undefined) tier.coverage = coverage
  }
  if (name !== 'plan' && declared('flaky') !== undefined) {
    const flaky = decodeFlaky(declared('flaky'), sink, `${what}.flaky`)
    if (flaky !== undefined) tier.flaky = flaky
  }
  if (name !== 'plan' && declared('require_baseline') !== undefined) {
    const requireBaseline = bool(declared('require_baseline'), sink, `${what}.require_baseline`)
    if (requireBaseline !== undefined) tier.require_baseline = requireBaseline
  }
  return tier
}

/**
 * 解码 `levels`。没写、写成空映射、或所有档位都是空映射时返回 undefined（与没写完全一致，目录摘要不变）。
 * 问题逐条进 sink；只要有问题，调用方就不会采用返回值。
 */
export function decodeCatalogLevels(node: YamlNode | undefined, sink: IssueSink): CatalogLevels | undefined {
  if (node === undefined) return undefined
  const map = asMap(node, sink, 'levels')
  if (map === undefined) return undefined
  checkKeys(map, LEVEL_NAMES, sink, 'levels')
  const out: { -readonly [K in LevelName]?: Tier } = {}
  for (const name of LEVEL_NAMES) {
    const tierNode = field(map, name)
    if (tierNode === undefined) continue
    const tier = decodeTier(name, tierNode, sink)
    if (tier !== undefined && Object.keys(tier).length > 0) out[name] = tier
  }
  return Object.keys(out).length === 0 ? undefined : out
}

function tierValue(tier: Tier): YamlValue {
  const coverage = tier.coverage
  const flaky = tier.flaky
  return {
    required: tier.required === undefined ? undefined : [...tier.required],
    touched: tier.touched === undefined ? undefined : [...tier.touched],
    scenarios: tier.scenarios,
    coverage: coverage === undefined ? undefined : Object.fromEntries(COVERAGE_METRICS.map((metric) => [metric, coverage[metric]])),
    flaky: flaky === undefined ? undefined : { max: flaky.max, fail_on_new: flaky.fail_on_new },
    require_baseline: tier.require_baseline,
  }
}

/** 写出用：没有任何档位定义时 undefined（该键整体省略）；档与键按固定顺序。 */
export function levelsValue(levels: CatalogLevels | undefined): YamlValue | undefined {
  if (levels === undefined) return undefined
  const out: { [name: string]: YamlValue } = {}
  for (const name of LEVEL_NAMES) {
    const tier = levels[name]
    if (tier !== undefined && Object.keys(tier).length > 0) out[name] = tierValue(tier)
  }
  return Object.keys(out).length === 0 ? undefined : out
}
