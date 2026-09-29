/**
 * 项目共享的测试配置文件（进 git）：目录 `.tenon/tests/catalog.yaml` 与已知失败清单 `known-failures.yaml`。
 * 写入统一规范化（serialize），落盘前先解析回读校验；同目录持锁 + 临时文件原子替换，两个并发的 `tenon test catalog`
 * / `known` 命令不会互相覆盖（读—改—写在同一把锁内）。
 */
import { mkdir, readFile } from 'node:fs/promises'
import {
  TEST_CATALOG_SCHEMA, atomicReplaceFile, formatCatalogIssues, parseKnownFailures, parseTestCatalog,
  serializeKnownFailures, serializeTestCatalog, testSystemPaths, withLock,
  type KnownFailure, type TestCatalog,
} from '@tenon/kernel'

export type CatalogFile =
  | { readonly state: 'missing' }
  | { readonly state: 'invalid'; readonly issues: readonly string[] }
  | { readonly state: 'ok'; readonly catalog: TestCatalog }

export function emptyCatalog(): TestCatalog {
  return { schema: TEST_CATALOG_SCHEMA, profiles_env: [], suites: [], services: [] }
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export async function readCatalogFile(repoRoot: string): Promise<CatalogFile> {
  const text = await readText(testSystemPaths(repoRoot).catalog)
  if (text === undefined) return { state: 'missing' }
  const parsed = parseTestCatalog(text)
  return parsed.ok ? { state: 'ok', catalog: parsed.catalog } : { state: 'invalid', issues: formatCatalogIssues(parsed.issues) }
}

export type UpdateOutcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string }

/**
 * 目录的读—改—写。目录不存在时从空目录起步；已存在但无效时拒绝（不覆盖人写坏的文件，先 validate 修好）。
 * mutate 返回新目录，或抛 Error(message) / 返回 string 拒绝；写出前再整份解析一遍，写坏的目录进不了盘。
 */
export async function updateCatalog<T>(
  repoRoot: string,
  mutate: (current: TestCatalog) => { readonly catalog: TestCatalog; readonly value: T } | string,
): Promise<UpdateOutcome<T>> {
  const paths = testSystemPaths(repoRoot)
  await mkdir(paths.root, { recursive: true })
  return withLock(paths.root, async () => {
    const current = await readCatalogFile(repoRoot)
    if (current.state === 'invalid') return { ok: false, message: `catalog.yaml 无效，先修好再改：${current.issues.slice(0, 3).join('；')}` }
    const result = mutate(current.state === 'ok' ? current.catalog : emptyCatalog())
    if (typeof result === 'string') return { ok: false, message: result }
    const text = serializeTestCatalog(result.catalog)
    const check = parseTestCatalog(text)
    if (!check.ok) return { ok: false, message: `改动后的目录不合法：${formatCatalogIssues(check.issues).slice(0, 3).join('；')}` }
    await atomicReplaceFile(paths.catalog, text)
    return { ok: true, value: result.value }
  })
}

export type KnownFailuresFile =
  | { readonly state: 'ok'; readonly entries: readonly KnownFailure[] }
  | { readonly state: 'invalid'; readonly issues: readonly string[] }

export async function readKnownFailuresFile(repoRoot: string): Promise<KnownFailuresFile> {
  const text = await readText(testSystemPaths(repoRoot).knownFailures)
  if (text === undefined) return { state: 'ok', entries: [] }
  const parsed = parseKnownFailures(text)
  return parsed.ok
    ? { state: 'ok', entries: parsed.entries }
    : { state: 'invalid', issues: parsed.issues.map((issue) => `known-failures.yaml:${issue.line}: ${issue.message}`) }
}

export async function updateKnownFailures<T>(
  repoRoot: string,
  mutate: (current: readonly KnownFailure[]) => { readonly entries: readonly KnownFailure[]; readonly value: T } | string,
): Promise<UpdateOutcome<T>> {
  const paths = testSystemPaths(repoRoot)
  await mkdir(paths.root, { recursive: true })
  return withLock(paths.root, async () => {
    const current = await readKnownFailuresFile(repoRoot)
    if (current.state === 'invalid') return { ok: false, message: `known-failures.yaml 无效，先修好再改：${current.issues.slice(0, 3).join('；')}` }
    const result = mutate(current.entries)
    if (typeof result === 'string') return { ok: false, message: result }
    await atomicReplaceFile(paths.knownFailures, serializeKnownFailures(result.entries))
    return { ok: true, value: result.value }
  })
}
