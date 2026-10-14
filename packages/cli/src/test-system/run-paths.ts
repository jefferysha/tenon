/**
 * 运行记录里的路径改写（M6）：记录入库、会被别的机器读到，里面的字符串（失败堆栈、期望 / 实际值、原因说明、命令……）
 * 不该带本机的仓库根或用户主目录。算摘要、写盘之前对每个套件运行调用 `relativizeRunStrings`：
 *   · 仓库根（逻辑路径、真实路径，以及 macOS 上 /var ↔ /private/var 这类互为真实路径的写法，含 `file://` 前缀）→ 仓库相对路径；
 *   · 用户主目录 → `~`。
 * 只做路径前缀替换：不读文件、不执行内容；只改字符串的值（键不改）；返回新对象，原对象不动——判定和本机日志用的还是原始数据。
 */
import { realpath } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export interface PathRoots {
  /** 仓库根的各种写法（逻辑路径与 realpath），去重、长的在前。 */
  readonly repo: readonly string[]
  /** 用户主目录；取不到时 undefined（不改写主目录）。 */
  readonly home: string | undefined
}

/** 路径里会出现的字符：前缀的前一个字符是它们之一，说明命中的是更长路径的中间一段（`/mnt<repo>/`、`prefix<repo>/`），不是前缀。 */
const PATH_CHARS = String.raw`\p{L}\p{N}_.~%+@/-`
const PATH_CHARS_NO_DOT = String.raw`\p{L}\p{N}_~%+@/-`

function trimmedRoot(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/u, '') : path
}

/** 只认真正的目录路径：相对路径、空串与文件系统根（`/`）都不能当前缀，否则会把无关文本整片改写。 */
function usableRoot(path: string): boolean {
  return isAbsolute(path) && dirname(path) !== path
}

/** macOS 的 /var、/tmp、/etc 是 /private 下同名目录的软链：以真实路径建根时，补上另一种写法。 */
async function withoutPrivateAlias(root: string): Promise<string | undefined> {
  if (!root.startsWith('/private/')) return undefined
  const alias = root.slice('/private'.length)
  const real = await realpath(alias).then(trimmedRoot, () => undefined)
  return real === root ? alias : undefined
}

export async function pathRootsFor(repoRoot: string, home: string | undefined): Promise<PathRoots> {
  const logical = trimmedRoot(resolve(repoRoot))
  const found = new Set<string>([logical])
  const real = await realpath(logical).then(trimmedRoot, () => undefined)
  if (real !== undefined) found.add(real)
  for (const root of [...found]) {
    const alias = await withoutPrivateAlias(root)
    if (alias !== undefined) found.add(alias)
  }
  const homeRoot = home === undefined || home === '' || !isAbsolute(home) ? undefined : trimmedRoot(resolve(home))
  return {
    repo: [...found].sort((left, right) => right.length - left.length),
    home: homeRoot !== undefined && usableRoot(homeRoot) ? homeRoot : undefined,
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/gu, String.raw`\$&`)
}

/** 目录的各种写法：原样路径、`file://` 加原样路径，以及 `file://` URL 的百分号编码写法（空格、中文）。 */
function forms(root: string): string[] {
  return [root, `file://${root}`, pathToFileURL(root).href]
}

/**
 * 把「前缀 + 斜杠」改写成 `withSlash`，恰好等于前缀（后面不是路径字符）的出现改写成 `bare`。
 * 前缀前后只要还连着路径字符就不改：`<repo>-other/`、`<repo>.bak/`、`/mnt<repo>/` 都是别的路径。
 */
function prefixRewriter(roots: readonly string[], withSlash: string, bare: string): ((text: string) => string) | undefined {
  const usable = roots.map(trimmedRoot).filter(usableRoot)
  if (usable.length === 0) return undefined
  const alternatives = [...new Set(usable.flatMap(forms))]
    .sort((left, right) => right.length - left.length)
    .map(escapeRegExp)
  const pattern = new RegExp(
    `(?<![${PATH_CHARS}])(?:${alternatives.join('|')})(/|(?![${PATH_CHARS_NO_DOT}])(?!\\.[${PATH_CHARS}]))`,
    'gu',
  )
  return (text) => text.replace(pattern, (_match: string, tail: string) => (tail === '/' ? withSlash : bare))
}

function walk(value: unknown, rewrite: (text: string) => string): unknown {
  if (typeof value === 'string') return rewrite(value)
  if (Array.isArray(value)) return value.map((item: unknown) => walk(item, rewrite))
  if (typeof value === 'object' && value !== null) {
    const prototype: unknown = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return value
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item, rewrite)]))
  }
  return value
}

/** 深拷贝 `value`，其中字符串里的仓库根前缀改写成仓库相对路径、主目录前缀改写成 `~`。 */
export function relativizeRunStrings<T>(value: T, roots: PathRoots): T {
  const repo = prefixRewriter(roots.repo, '', '.')
  const home = roots.home === undefined ? undefined : prefixRewriter([roots.home], '~/', '~')
  const rewrite = (text: string): string => {
    const relative = repo === undefined ? text : repo(text)
    return home === undefined ? relative : home(relative)
  }
  return walk(value, rewrite) as T
}
