/**
 * 项目测试目录文件 `.tenon/tests/catalog.yaml` 的读—改—写。人可以直接改这份文件；`tenon test catalog|discover`、
 * `tenon init` 的自动识别和评审确认里对「不适用」声明的批准都经这里：同目录持锁 + 临时文件原子替换，
 * 读—改—写在同一把锁内，并发的写者不会互相覆盖；落盘前整份解析回读，写坏的目录进不了盘。
 */
import { mkdir, readFile } from 'node:fs/promises'
import { atomicReplaceFile } from '../state/atomic-publish.js'
import { withLock } from '../state/lock.js'
import { TEST_CATALOG_SCHEMA, type TestCatalog } from './catalog-types.js'
import { formatCatalogIssues, parseTestCatalog, serializeTestCatalog } from './catalog.js'
import { testSystemPaths } from './paths.js'

export type CatalogFile =
  | { readonly state: 'missing' }
  | { readonly state: 'invalid'; readonly issues: readonly string[] }
  | { readonly state: 'ok'; readonly catalog: TestCatalog }

export function emptyCatalog(): TestCatalog {
  return { schema: TEST_CATALOG_SCHEMA, profiles_env: [], suites: [], services: [] }
}

export async function readCatalogFile(repoRoot: string): Promise<CatalogFile> {
  let text: string
  try {
    text = await readFile(testSystemPaths(repoRoot).catalog, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing' }
    throw error
  }
  const parsed = parseTestCatalog(text)
  return parsed.ok ? { state: 'ok', catalog: parsed.catalog } : { state: 'invalid', issues: formatCatalogIssues(parsed.issues) }
}

export type UpdateOutcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string }

/**
 * 目录的读—改—写。目录不存在时从空目录起步；已存在但无效时拒绝（不覆盖人写坏的文件，先 validate 修好）。
 * mutate 返回新目录（原样返回入参表示没有改动，不落盘），或返回 string 拒绝；写出前再整份解析一遍，写坏的目录进不了盘。
 *
 * `observe` 在同一把锁内、读目录之前运行，它的结果作为 mutate 的第二个参数：写者要依据「写之前看到的目录状态」做判断
 * （例如目录相对任务起点有没有改动）时，观察与写在同一个临界区里，两者之间不会插进另一个 Tenon 写者；人手直接改文件
 * 不受这把锁约束，所以写者应在 mutate 里（同步、紧贴写盘）再核对一次文件摘要，不符就返回 string 拒绝。
 */
export async function updateCatalog<T, Seen = undefined>(
  repoRoot: string,
  mutate: (current: TestCatalog, seen: Seen) => { readonly catalog: TestCatalog; readonly value: T } | string,
  observe?: () => Promise<Seen>,
): Promise<UpdateOutcome<T>> {
  const paths = testSystemPaths(repoRoot)
  await mkdir(paths.root, { recursive: true })
  return withLock(paths.root, async () => {
    const seen = observe === undefined ? undefined as Seen : await observe()
    const current = await readCatalogFile(repoRoot)
    if (current.state === 'invalid') return { ok: false, message: `catalog.yaml 无效，先修好再改：${current.issues.slice(0, 3).join('；')}` }
    const base = current.state === 'ok' ? current.catalog : emptyCatalog()
    const result = mutate(base, seen)
    if (typeof result === 'string') return { ok: false, message: result }
    // 原样返回入参 = 没有改动：不重写文件（重写会把人手写的注释和排版规范化掉）。
    if (result.catalog === base) return { ok: true, value: result.value }
    const text = serializeTestCatalog(result.catalog)
    const check = parseTestCatalog(text)
    if (!check.ok) return { ok: false, message: `改动后的目录不合法：${formatCatalogIssues(check.issues).slice(0, 3).join('；')}` }
    await atomicReplaceFile(paths.catalog, text)
    return { ok: true, value: result.value }
  })
}
