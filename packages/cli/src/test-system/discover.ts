/**
 * `tenon test discover`：扫描项目里的测试工具与脚本，给出建议的目录套件（含推荐的 reporter 参数，让每个套件都
 * 产出可解析的报告）。只读、纯建议——是否写进 catalog.yaml 由调用方决定，已存在的套件 id 永远不覆盖。
 *
 * 识别范围：仓库根与向下 3 层内带 package.json / 各工具配置的目录；工具有 vitest、jest、mocha、node:test、
 * Playwright、tsc、eslint、pytest、go。基准脚本与 cargo / cypress 这类无法凭配置推出指标或报告路径的工具只给提示。
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { discoverJsTools } from './discover-js.js'
import { discoverOtherLanguages } from './discover-other.js'
import type { DiscoveredSuite, ProjectDir } from './discover-support.js'

export type { DiscoveredSuite } from './discover-support.js'

export interface DiscoveryResult {
  readonly suites: readonly DiscoveredSuite[]
  readonly notes: readonly string[]
}

const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', 'test-results', 'playwright-report', '.tenon', 'openspec',
  '.pipeline', '.next', '.turbo', 'target', 'vendor', 'venv', '.venv', '__pycache__', '.cache', 'out', '.claude',
])
const MAX_DEPTH = 3
const MAX_DIRS = 4000

async function listProjectDirs(repoRoot: string): Promise<ProjectDir[]> {
  const out: ProjectDir[] = []
  let visited = 0
  const walk = async (rel: string, depth: number): Promise<void> => {
    if (visited++ > MAX_DIRS) return
    const abs = rel === '.' ? repoRoot : join(repoRoot, rel)
    let entries
    try {
      entries = await readdir(abs, { withFileTypes: true })
    } catch {
      return
    }
    out.push({ rel, abs, names: new Set(entries.filter((entry) => entry.isFile() || entry.isDirectory()).map((entry) => entry.name)) })
    if (depth >= MAX_DEPTH) return
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
      await walk(rel === '.' ? entry.name : `${rel}/${entry.name}`, depth + 1)
    }
  }
  await walk('.', 0)
  return out
}

export async function discoverTests(repoRoot: string): Promise<DiscoveryResult> {
  const suites: DiscoveredSuite[] = []
  const notes: string[] = []
  const taken = new Set<string>()
  const add = (found: DiscoveredSuite): void => {
    let id = found.suite.id
    for (let n = 2; taken.has(id); n++) id = `${found.suite.id.slice(0, 44)}-${n}`
    taken.add(id)
    suites.push({ ...found, suite: id === found.suite.id ? found.suite : { ...found.suite, id } })
  }
  for (const dir of await listProjectDirs(repoRoot)) {
    for (const found of await discoverJsTools(dir, notes)) add(found)
    for (const found of await discoverOtherLanguages(dir, notes)) add(found)
  }
  if (suites.length === 0) notes.push('没有识别到测试工具；用 tenon test catalog add 手工登记套件')
  return { suites, notes }
}
