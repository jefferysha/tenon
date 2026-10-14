/**
 * `tenon test register --auto` 的「认领孤儿」部分（纯函数）：把本任务改动里没有任何套件认领的测试文件，
 * 以**精确路径**追加进合适套件的 `files`。认领一个文件不会顺带认领别的文件——不生成 `<目录>/**` 一类的通配，
 * 套件原有的 glob 一个字符都不动。
 *
 * 规则：
 *   · 候选文件来自本任务的改动列表（`changedTestCandidates`）：先去掉控制目录，再要求名字像测试且是源码扩展名
 *     （与求值用的 `looksLikeTestFile` 同一口径）。
 *   · 候选套件在文件所在目录之上（套件 cwd 是文件路径的前缀）：`e2e/` 下的文件找 playwright / e2e / browser 套件，
 *     `*.bench.*` 基准脚本找 benchmark 套件，其余找 unit / integration / regression 套件；cwd 越具体越优先，其次目录里靠前的。
 *   · 追加的路径相对套件 cwd；这一项含 glob 元字符（`* ? [ ] { } !` 与反斜杠）时一律不认领、进 unresolved：
 *     它写进 `files` 就是通配符，会顺带认领别的文件。其余路径追加后，该套件的 glob 还必须真的认领这个文件，否则同样进 unresolved。
 */
import {
  looksLikeTestFile, matchesAnyGlob, suiteFileGlobs, suitesOwningFile, withoutControlPaths,
  type CatalogSuite, type TestCatalog, type TestKind,
} from '@tenon/kernel'

const BROWSER_KINDS: readonly TestKind[] = ['playwright', 'e2e', 'browser']
const UNIT_KINDS: readonly TestKind[] = ['unit', 'integration', 'regression']
const BENCHMARK_KINDS: readonly TestKind[] = ['benchmark']
/** 带这些字符的名字写进 `files` 就是通配符而不是精确路径：`a*b.test.ts` 会顺带认领 `a-x-b.test.ts`。 */
const GLOB_METACHARACTER = /[*?[\]{}!\\]/u

/** 本任务改动里像测试的源码文件（去掉控制目录），排序、去重。 */
export function changedTestCandidates(changedFiles: readonly string[]): readonly string[] {
  return [...new Set(withoutControlPaths(changedFiles).filter(looksLikeTestFile))].sort()
}

function relativeTo(suite: CatalogSuite, path: string): string | undefined {
  if (suite.cwd === '.') return path
  return path.startsWith(`${suite.cwd}/`) ? path.slice(suite.cwd.length + 1) : undefined
}

function kindsFor(path: string): readonly TestKind[] {
  if (/(^|\/)e2e\//.test(path)) return BROWSER_KINDS
  return /\.bench\.[^/]+$/.test(path) ? BENCHMARK_KINDS : UNIT_KINDS
}

function candidates(catalog: TestCatalog, path: string): readonly CatalogSuite[] {
  const kinds = kindsFor(path)
  return catalog.suites
    .map((suite, index) => ({ suite, index }))
    .filter(({ suite }) => kinds.includes(suite.kind) && relativeTo(suite, path) !== undefined)
    .sort((left, right) => right.suite.cwd.length - left.suite.cwd.length || left.index - right.index)
    .map(({ suite }) => suite)
}

export interface OrphanClaim {
  /** 仓库相对路径。 */
  readonly path: string
  readonly suite: string
  /** 追加进该套件 `files` 的那一项：该文件的精确路径，相对套件 cwd。 */
  readonly file: string
}

export interface OrphanClaims {
  readonly catalog: TestCatalog
  readonly claims: readonly OrphanClaim[]
  /** 认领不了的文件：没有合适的套件、文件名含 glob 元字符、或精确路径追加后套件仍认不出它。 */
  readonly unresolved: readonly string[]
}

/** 对没有套件认领的测试文件逐个找套件并追加精确路径；没有任何改动时 catalog 原样返回。 */
export function claimOrphans(catalog: TestCatalog, orphans: readonly string[]): OrphanClaims {
  let current = catalog
  const claims: OrphanClaim[] = []
  const unresolved: string[] = []
  for (const path of [...new Set(orphans)].sort()) {
    if (suitesOwningFile(current, path).length > 0) continue
    const suite = candidates(current, path)[0]
    const file = suite === undefined ? undefined : relativeTo(suite, path)
    if (suite === undefined || file === undefined || GLOB_METACHARACTER.test(file)) {
      unresolved.push(path)
      continue
    }
    const widened: CatalogSuite = { ...suite, files: [...suite.files, file] }
    if (!matchesAnyGlob(path, suiteFileGlobs(widened))) {
      unresolved.push(path)
      continue
    }
    current = { ...current, suites: current.suites.map((item) => (item.id === suite.id ? widened : item)) }
    claims.push({ path, suite: suite.id, file })
  }
  return { catalog: current, claims, unresolved }
}
