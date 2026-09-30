/**
 * `tenon test register --auto` 的「扩展 glob」部分（纯函数）：把没有任何套件认领的测试文件并进合适套件的 `files` glob。
 *
 * 认领规则：
 *   · 只看文件名明确是测试的文件（`*.test.*`、`*.spec.*`、`test_*.py`、`*_test.go`/`*_test.py`）；e2e/ 下的辅助文件、
 *     `*.bench.*` 基准脚本不自动认领（基准套件要声明指标，辅助文件不是测试，登记它们只会换来「登记的测试没有被执行」）。
 *   · 候选套件在文件所在目录之上（套件 cwd 是文件路径的前缀）：`e2e/` 下的文件找 playwright / e2e / browser 套件，
 *     其余找 unit / integration / regression 套件；cwd 越具体越优先，其次目录里靠前的。
 *   · 新增的 glob 取「文件的第一级目录 + ** + 文件名模式」（如 `test/**\/*.test.js`），根目录文件取 `*.test.js`；
 *     文件名认不出模式（不该出现，前一步已筛过）就不认领。
 */
import { matchesAnyGlob, suiteFileGlobs, suitesOwningFile, type CatalogSuite, type TestCatalog, type TestKind } from '@tenon/kernel'

const CLAIMABLE_NAME = /(?:\.(?:test|spec)\.[A-Za-z0-9]+$)|(?:^test_[^/]+\.py$)|(?:_test\.(?:go|py)$)/
const BROWSER_KINDS: readonly TestKind[] = ['playwright', 'e2e', 'browser']
const UNIT_KINDS: readonly TestKind[] = ['unit', 'integration', 'regression']

/** 文件名明确是测试脚本（自动认领的候选）。 */
export function isClaimableTestFile(path: string): boolean {
  const name = path.split('/').at(-1) ?? path
  return CLAIMABLE_NAME.test(name) && !/\.bench\./.test(name)
}

function namePattern(name: string): string | undefined {
  const dotted = /^.+\.(test|spec)\.([A-Za-z0-9]+)$/.exec(name)
  if (dotted !== null) return `*.${dotted[1]}.${dotted[2]}`
  if (/^test_.+\.py$/.test(name)) return 'test_*.py'
  const suffixed = /^.+_test\.(go|py)$/.exec(name)
  return suffixed === null ? undefined : `*_test.${suffixed[1]}`
}

function relativeTo(suite: CatalogSuite, path: string): string | undefined {
  if (suite.cwd === '.') return path
  return path.startsWith(`${suite.cwd}/`) ? path.slice(suite.cwd.length + 1) : undefined
}

function candidates(catalog: TestCatalog, path: string): readonly CatalogSuite[] {
  const kinds = /(^|\/)e2e\//.test(path) ? BROWSER_KINDS : UNIT_KINDS
  return catalog.suites
    .map((suite, index) => ({ suite, index }))
    .filter(({ suite }) => kinds.includes(suite.kind) && relativeTo(suite, path) !== undefined)
    .sort((left, right) => right.suite.cwd.length - left.suite.cwd.length || left.index - right.index)
    .map(({ suite }) => suite)
}

export interface OrphanClaim {
  readonly path: string
  readonly suite: string
  /** 加进该套件 files 的 glob（相对套件 cwd）。 */
  readonly glob: string
}

export interface OrphanClaims {
  readonly catalog: TestCatalog
  readonly claims: readonly OrphanClaim[]
  /** 认领不了的文件：没有合适的套件、或文件名认不出模式。 */
  readonly unresolved: readonly string[]
}

/** 对没有套件认领的测试文件逐个找套件并扩展 files glob；没有任何改动时 catalog 原样返回。 */
export function claimOrphans(catalog: TestCatalog, orphans: readonly string[]): OrphanClaims {
  let current = catalog
  const claims: OrphanClaim[] = []
  const unresolved: string[] = []
  for (const path of [...new Set(orphans)].sort()) {
    const owners = suitesOwningFile(current, path)
    if (owners.length > 0) {
      // 原本就有人认领的不管；原先没人认领、被前面某次扩展的 glob 顺带认领的，记在同一条扩展名下（也要登记）。
      if (suitesOwningFile(catalog, path).length > 0) continue
      const via = claims.find((claim) => owners.includes(claim.suite))
      if (via !== undefined) claims.push({ path, suite: via.suite, glob: via.glob })
      continue
    }
    const suite = candidates(current, path)[0]
    const rel = suite === undefined ? undefined : relativeTo(suite, path)
    const pattern = rel === undefined ? undefined : namePattern(rel.split('/').at(-1) ?? rel)
    if (suite === undefined || rel === undefined || pattern === undefined) {
      unresolved.push(path)
      continue
    }
    const parts = rel.split('/')
    const glob = parts.length === 1 ? pattern : `${parts[0]}/**/${pattern}`
    const widened: CatalogSuite = { ...suite, files: [...suite.files, glob] }
    if (!matchesAnyGlob(path, suiteFileGlobs(widened))) {
      unresolved.push(path)
      continue
    }
    current = { ...current, suites: current.suites.map((item) => (item.id === suite.id ? widened : item)) }
    claims.push({ path, suite: suite.id, glob })
  }
  return { catalog: current, claims, unresolved }
}
