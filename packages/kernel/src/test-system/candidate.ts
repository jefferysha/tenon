/**
 * 候选代码指纹的生产口径：`fingerprintWorkspace` 只忽略「声明的」测试产物路径，这里负责从项目里找出这些声明。
 *
 *   · 测试目录（`.tenon/tests/catalog.yaml`）：每个套件的 `report.path`、`coverage.path`（istanbul 摘要旁的
 *     `coverage-final.json` 一并算）与 `artifacts[]`，都相对套件 `cwd`；
 *   · 任务冻结的工作流（未归档任务的 `.pipeline-workflow-plan.json`）：步骤内联测试（`tests[]`）的 `outputs[].path`，
 *     它们是仓库相对路径。
 *
 * 目录读不出（不存在、无效）就没有目录声明：产出报告的目录会计入候选，宁可让记录多过期一次，
 * 也不因为一份读不了的目录而放宽指纹。CLI、server 与 build revision 捕获共用这一个函数，口径唯一。
 */
import { lstat, readFile, readdir } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { WORKFLOW_PLAN_SNAPSHOT_FILE } from '../state/workflow-plan-snapshot.js'
import { fingerprintWorkspace } from '../workspace/fingerprint.js'
import type { TestCatalog } from './catalog-types.js'
import { loadCatalogInput } from './load.js'

const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024
const MAX_CHANGE_DIRS = 512

/** 套件 cwd 下的相对路径 → 仓库相对路径；越出仓库或非法的一律丢弃（声明不能借 `..` 把别处排除出候选）。 */
function repoPath(cwd: string, path: string): string | undefined {
  const joined = posix.normalize(posix.join(cwd === '' ? '.' : cwd, path))
  if (joined === '.' || joined === '..' || joined.startsWith('../') || posix.isAbsolute(joined)) return undefined
  return joined
}

export function catalogDeclaredOutputs(catalog: TestCatalog): readonly string[] {
  const out = new Set<string>()
  const add = (cwd: string, path: string | undefined): void => {
    if (path === undefined) return
    const resolved = repoPath(cwd, path)
    if (resolved !== undefined) out.add(resolved)
  }
  for (const suite of catalog.suites) {
    add(suite.cwd, suite.report.path)
    if (suite.coverage !== undefined) {
      add(suite.cwd, suite.coverage.path)
      if (suite.coverage.format === 'istanbul-summary') add(suite.cwd, posix.join(posix.dirname(suite.coverage.path), 'coverage-final.json'))
    }
    for (const artifact of suite.artifacts) add(suite.cwd, artifact)
  }
  return [...out].sort()
}

function inlineOutputsOfSnapshot(text: string): readonly string[] {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return []
  }
  const steps = ((value as { plan?: { workflow?: { steps?: unknown } } } | null)?.plan?.workflow?.steps)
  if (!Array.isArray(steps)) return []
  const out: string[] = []
  for (const step of steps as Array<{ tests?: unknown }>) {
    if (!Array.isArray(step?.tests)) continue
    for (const test of step.tests as Array<{ outputs?: unknown }>) {
      if (!Array.isArray(test?.outputs)) continue
      for (const output of test.outputs as Array<{ path?: unknown }>) {
        if (typeof output?.path === 'string') {
          const resolved = repoPath('.', output.path)
          if (resolved !== undefined) out.push(resolved)
        }
      }
    }
  }
  return out
}

const snapshotCache = new Map<string, { readonly stamp: string; readonly outputs: readonly string[] }>()

/** 未归档任务冻结工作流里内联测试声明的输出。按文件大小 + 修改时间缓存，指纹每次调用不重复解析。 */
export async function inlineTestDeclaredOutputs(repoRoot: string): Promise<readonly string[]> {
  const changesDir = join(repoRoot, 'openspec', 'changes')
  let names: string[]
  try {
    names = (await readdir(changesDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name !== 'archive')
      .map((entry) => entry.name)
      .sort()
      .slice(0, MAX_CHANGE_DIRS)
  } catch {
    return []
  }
  const out = new Set<string>()
  for (const name of names) {
    const path = join(changesDir, name, WORKFLOW_PLAN_SNAPSHOT_FILE)
    let info
    try {
      info = await lstat(path)
    } catch {
      continue
    }
    if (!info.isFile() || info.size > MAX_SNAPSHOT_BYTES) continue
    const stamp = `${info.size}:${info.mtimeMs}`
    let cached = snapshotCache.get(path)
    if (cached?.stamp !== stamp) {
      try {
        cached = { stamp, outputs: inlineOutputsOfSnapshot(await readFile(path, 'utf8')) }
      } catch {
        continue
      }
      snapshotCache.set(path, cached)
    }
    for (const output of cached.outputs) out.add(output)
  }
  return [...out].sort()
}

/** 项目里全部「声明的」测试产物路径（目录 ∪ 冻结工作流的内联测试输出）。 */
export async function declaredTestOutputs(repoRoot: string): Promise<readonly string[]> {
  const catalog = await loadCatalogInput(repoRoot)
  const fromCatalog = catalog.state === 'ok' ? catalogDeclaredOutputs(catalog.catalog) : []
  return [...new Set([...fromCatalog, ...await inlineTestDeclaredOutputs(repoRoot)])].sort()
}

/** 候选代码指纹（生产口径）：只忽略项目声明的测试产物路径。 */
export async function candidateFingerprint(repoRoot: string): Promise<string> {
  return fingerprintWorkspace(repoRoot, { declaredOutputs: await declaredTestOutputs(repoRoot) })
}
