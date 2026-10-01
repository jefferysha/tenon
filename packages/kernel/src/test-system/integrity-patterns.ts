/**
 * 测试完整性的逐行启发式：从 `git diff -U0` 的新增 / 删除行里数「声明的用例」「跳过标记」「断言」，
 * 以及路径分类与覆盖率门槛的抽取。全部是文本模式，不解析语法：它们给人看一个信号，不是证明；
 * 误报（把用例改个名、换个断言库）靠人读 `tenon test integrity` 的明细消解。
 */
import { looksLikeTestFile } from './vocabulary.js'

export type IntegrityPathKind = 'test' | 'snapshot' | 'baseline' | 'known-failures' | 'coverage-config' | 'workflow'

/** 声明了一个用例的行（含被跳过的：跳过与否由 SKIP 另数）。 */
const DECLARE: readonly RegExp[] = [
  /^\s*(?:it|test|specify)(?:\.[A-Za-z]+)*\s*[(`]/,
  /^\s*(?:xit|xtest|fit|ftest)\s*\(/,
  /^\s*(?:async\s+)?def\s+test\w*\s*\(/,
  /^func\s+(?:\([^)]*\)\s*)?(?:Test|Benchmark|Fuzz|Example)\w*\s*\(/,
  /^\s*@(?:Test|ParameterizedTest|RepeatedTest|TestFactory)\b/,
  /^\s*#\[(?:tokio::|async_std::)?test\b/,
  /^\s*\[(?:Fact|Theory|Test|TestCase)\b/,
  /^\s*(?:it|specify|scenario|example)\s+(?:do\b|['"])/,
]

/** 把用例变成不执行：`.skip` / `xit` / `todo` / pytest 与 unittest 标记 / `t.Skip` / `@Ignore` / `#[ignore]` 等。 */
const SKIP: readonly RegExp[] = [
  /\b(?:it|test|describe|context|suite|specify)\.(?:skip|todo|fixme|skipIf)\b/,
  /\b(?:xit|xtest|xdescribe|xcontext|xspecify)\s*\(/,
  /@pytest\.mark\.(?:skip|skipif|xfail)\b/,
  /\bpytest\.(?:skip|xfail)\s*\(/,
  /@unittest\.(?:skip|skipIf|skipUnless|expectedFailure)\b/,
  /\bself\.skipTest\s*\(/,
  /\bt\.Skip(?:f|Now)?\s*\(/,
  /@(?:Ignore|Disabled)\b/,
  /#\[ignore\b/,
  /^\s*(?:skip|pending)\s*(?:['"(]|$)/,
  /\[(?:Ignore|Fact\s*\(\s*Skip|Theory\s*\(\s*Skip)/,
]

/** 一次断言：每行最多算一次。 */
const ASSERT: readonly RegExp[] = [
  /\bexpect\s*(?:\(|\.(?:soft|poll|assertions|hasAssertions)\b)/,
  /\bassert(?:\.[A-Za-z]+)?\s*\(/,
  /\bassert[A-Z_]\w*\s*\(/,
  /\bassert_\w+\s*\(/,
  /^\s*assert\s+\S/,
  /\bself\.assert\w+\s*\(/,
  /\.should\b/,
  /\bt\.(?:is|not|deepEqual|true|false|truthy|falsy|throws|notThrows|regex|like)\s*\(/,
  /\bpytest\.raises\s*\(/,
  /\brequire\.\w+\s*\(/,
  /\bt\.(?:Error|Errorf|Fatal|Fatalf|Fail|FailNow)\s*\(/,
  /\bassert(?:_eq|_ne|_matches)?!\s*\(/,
  /\bAssert\.\w+\s*\(/,
  /\bassertThat\s*\(/,
]

function count(lines: readonly string[], patterns: readonly RegExp[]): number {
  let total = 0
  for (const line of lines) if (patterns.some((pattern) => pattern.test(line))) total++
  return total
}

export const declaredTests = (lines: readonly string[]): number => count(lines, DECLARE)
export const skipMarkers = (lines: readonly string[]): number => count(lines, SKIP)
export const assertions = (lines: readonly string[]): number => count(lines, ASSERT)

const SNAPSHOT_PATH: readonly RegExp[] = [
  /(?:^|\/)__snapshots__\//,
  /(?:^|\/)__image_snapshots__\//,
  /-snapshots\//,
  /\.snap(?:\.[A-Za-z0-9]+)?$/,
]

const COVERAGE_CONFIG_BASENAME =
  /^(?:(?:jest|vitest|vite|nyc|c8)\.config\.[cm]?[jt]s|vitest\.workspace\.[cm]?[jt]s|\.nycrc(?:\.json|\.ya?ml)?|\.c8rc(?:\.json)?|\.coveragerc|pyproject\.toml|setup\.cfg|tox\.ini|pytest\.ini|package\.json|\.?codecov\.ya?ml)$/

export const KNOWN_FAILURES_PATH = '.tenon/tests/known-failures.yaml'
const BASELINE_PREFIX = '.tenon/tests/baselines/'
const WORKFLOW_FILE = /^\.pipeline\/workflows\/[^/]+\.ya?ml$/

/** 路径的完整性角色；不相关的文件返回 undefined（不读 diff）。`owned` = 有目录套件认领这个文件。 */
export function integrityPathKind(path: string, owned: boolean): IntegrityPathKind | undefined {
  if (SNAPSHOT_PATH.some((pattern) => pattern.test(path))) return 'snapshot'
  if (path === KNOWN_FAILURES_PATH) return 'known-failures'
  if (path.startsWith(BASELINE_PREFIX)) return 'baseline'
  if (WORKFLOW_FILE.test(path)) return 'workflow'
  if (owned || looksLikeTestFile(path)) return 'test'
  const base = path.slice(path.lastIndexOf('/') + 1)
  return COVERAGE_CONFIG_BASENAME.test(base) ? 'coverage-config' : undefined
}

/**
 * 覆盖率门槛：行里 `<键> <分隔> <数字>`，键是 lines / branches / functions / statements / fail_under / threshold / target。
 * 同一个键的数值变小（或整个键消失）算降低。工作流的 `coverage: { lines: 80 }`、jest 的 `coverageThreshold`、
 * coverage.py 的 `fail_under = 90`、`--cov-fail-under=90` 都落在这个形状里。
 */
const THRESHOLD = /\b(lines|branches|functions|statements|fail[_-]?under|threshold|target)\b\W{0,6}(\d+(?:\.\d+)?)/gi

export function thresholdsOf(lines: readonly string[]): ReadonlyMap<string, number> {
  const out = new Map<string, number>()
  for (const line of lines) {
    for (const match of line.matchAll(THRESHOLD)) {
      const key = (match[1] ?? '').toLowerCase().replace(/[_-]/g, '')
      const value = Number(match[2])
      if (!Number.isFinite(value)) continue
      const known = out.get(key)
      out.set(key, known === undefined ? value : Math.max(known, value))
    }
  }
  return out
}

export interface ThresholdDrop {
  readonly key: string
  readonly before: number
  /** undefined = 新内容里没有这个键（门槛被删）。 */
  readonly after: number | undefined
}

/** 删除的行里有、新增的行里更小或缺席的门槛。 */
export function thresholdDrops(removed: readonly string[], added: readonly string[]): readonly ThresholdDrop[] {
  const before = thresholdsOf(removed)
  const after = thresholdsOf(added)
  const out: ThresholdDrop[] = []
  for (const [key, value] of before) {
    const next = after.get(key)
    if (next === undefined || next < value) out.push({ key, before: value, after: next })
  }
  return out
}

/** known-failures.yaml 里一行 `test: <文件> › <用例名>` 的引用；其它行返回 undefined。 */
export function knownFailureRefOf(line: string): string | undefined {
  const match = /^\s*(?:-\s+)?test:\s*(.*?)\s*$/.exec(line)
  if (match === null) return undefined
  const raw = match[1] ?? ''
  const quoted = /^(["'])(.*)\1$/.exec(raw)
  const ref = (quoted === null ? raw : quoted[2] ?? '').trim()
  return ref === '' ? undefined : ref
}
