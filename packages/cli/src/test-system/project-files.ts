/**
 * 项目共享的测试配置文件（进 git）：目录 `.tenon/tests/catalog.yaml` 与已知失败清单 `known-failures.yaml`。
 * 写入统一规范化（serialize），落盘前先解析回读校验；同目录持锁 + 临时文件原子替换，两个并发的 `tenon test catalog`
 * / `known` 命令不会互相覆盖（读—改—写在同一把锁内）。
 */
import { mkdir, readFile } from 'node:fs/promises'
import {
  atomicReplaceFile, parseKnownFailures, serializeKnownFailures, testSystemPaths, withLock,
  type KnownFailure,
} from '@tenon/kernel'
import type { UpdateOutcome } from '@tenon/kernel'

// 目录文件的读—改—写在 kernel（评审确认批准「不适用」声明时同样要写目录）；CLI 这里只是原有的导入位置。
export { emptyCatalog, readCatalogFile, updateCatalog } from '@tenon/kernel'
export type { CatalogFile, UpdateOutcome } from '@tenon/kernel'

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
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
