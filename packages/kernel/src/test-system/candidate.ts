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
 *
 * 同一次遍历还给出不含宿主本地文件（`.claude/settings.local.json` 等，见 fingerprint.ts）的可移植指纹：测试记录绑它，
 * 干净克隆才复现得出来；评审结论与构建基线仍绑完整指纹（`candidateFingerprint`），它们的口径不变。
 */
import { lstat, readFile, readdir } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { WORKFLOW_PLAN_SNAPSHOT_FILE } from '../state/workflow-plan-snapshot.js'
import { fingerprintWorkspaceTwins, type WorkspaceFingerprints } from '../workspace/fingerprint.js'
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

/**
 * 同一棵树的两个指纹（`WorkspaceFingerprints`）的对照表：完整指纹 → 可移植指纹。完整指纹相同 = 内容相同；可移植指纹还取决于
 * git 是否跟踪宿主本地路径（`git add` 不改内容、只改它），所以每次 `candidateFingerprint` 重算都会刷新对应的表项，
 * 表项最长的陈旧窗口就是宿主缓存候选的时间（Dashboard 的 TTL）。只是缓存，缺了就按需重算。进程内、有界、先进先出。
 */
const TWINS = new Map<string, string>()
const MAX_TWINS = 256

function rememberTwins(twins: WorkspaceFingerprints): void {
  TWINS.delete(twins.full)
  TWINS.set(twins.full, twins.portable)
  if (TWINS.size > MAX_TWINS) {
    const oldest = TWINS.keys().next()
    if (oldest.done !== true) TWINS.delete(oldest.value)
  }
}

async function candidateTwins(repoRoot: string): Promise<WorkspaceFingerprints> {
  const twins = await fingerprintWorkspaceTwins(repoRoot, { declaredOutputs: await declaredTestOutputs(repoRoot) })
  rememberTwins(twins)
  return twins
}

/**
 * 候选代码指纹（生产口径，完整版）：只忽略项目声明的测试产物路径，宿主本地文件照算——评审结论、构建基线冻结的是它，
 * 0.3.0 及更早版本写进测试记录的也是它。测试记录与 `tenon verify --ci` 改用可移植版（`portableCandidate`）。
 */
export async function candidateFingerprint(repoRoot: string): Promise<string> {
  return (await candidateTwins(repoRoot)).full
}

/**
 * 某个完整候选指纹在「去掉宿主本地文件」之后的可移植指纹：干净克隆能复现的那个值，测试记录从 0.3.1 起绑它。
 * 只认本进程算出过的指纹（`candidateFingerprint` 一次遍历同时得到两个）；没有记录时返回 undefined——
 * 调用方拿到的不是本进程算的值（测试里的桩），就只能用完整指纹本身比较。
 */
export function knownPortableCandidate(fullCandidate: string): string | undefined {
  return TWINS.get(fullCandidate)
}

/**
 * 同上，但对照表里没有时重新遍历 `repoRoot` 一次（例如表项被挤掉）；树自那之后变了（完整指纹对不上）就返回 undefined，
 * 不会把另一棵树的指纹冒充成它的。
 */
export async function portableCandidate(repoRoot: string, fullCandidate: string): Promise<string | undefined> {
  const known = TWINS.get(fullCandidate)
  if (known !== undefined) return known
  try {
    const twins = await candidateTwins(repoRoot)
    return twins.full === fullCandidate ? twins.portable : undefined
  } catch {
    return undefined
  }
}
