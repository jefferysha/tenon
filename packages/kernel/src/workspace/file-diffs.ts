/**
 * `git diff -U0` 输出的逐文件解析与读取：每个文件相对任务起点的新增行与删除行。测试完整性读它；
 * 起点解析、版本库调用与缓存仍在 changed-files.ts 的会话里（通过 `FileDiffPort` 交进来）。
 *
 * 解析用状态机而不是逐行猜：每个文件段以 `diff --git` 开头，文件头（`---` / `+++`）只出现在第一个 `@@` 之前，
 * 之后全是内容行——内容里恰好以 `++ ` 或 `-- ` 开头的行不会被当成文件头。二进制文件没有内容行，
 * 解析结果里没有它（调用方按「改了却看不到行」处理）。
 */
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface FileLineDiff {
  readonly added: readonly string[]
  readonly removed: readonly string[]
}

function headerPath(raw: string): string | undefined {
  // 含空格的路径 git 会在末尾补一个制表符；`/dev/null` 表示这一侧不存在。
  const text = raw.replace(/\t.*$/, '')
  if (text === '/dev/null') return undefined
  return text.startsWith('a/') || text.startsWith('b/') ? text.slice(2) : text
}

export function parseFileLineDiffs(diff: string): ReadonlyMap<string, FileLineDiff> {
  const out = new Map<string, { added: string[]; removed: string[] }>()
  let oldPath: string | undefined
  let newPath: string | undefined
  let current: { added: string[]; removed: string[] } | undefined
  let inHunk = false
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      oldPath = undefined
      newPath = undefined
      current = undefined
      inHunk = false
      continue
    }
    if (!inHunk) {
      if (line.startsWith('--- ')) oldPath = headerPath(line.slice(4))
      else if (line.startsWith('+++ ')) newPath = headerPath(line.slice(4))
      else if (line.startsWith('@@')) {
        inHunk = true
        const path = newPath ?? oldPath
        if (path !== undefined) {
          current = out.get(path) ?? { added: [], removed: [] }
          out.set(path, current)
        }
      }
      continue
    }
    if (line.startsWith('@@') || line.startsWith('\\') || current === undefined) continue
    if (line.startsWith('+')) current.added.push(line.slice(1))
    else if (line.startsWith('-')) current.removed.push(line.slice(1))
  }
  return out
}

export interface FileDiffEntry {
  readonly path: string
  readonly status: 'added' | 'modified' | 'deleted'
  /** 起点之后新增 / 删除的行；未跟踪文件整份算新增，二进制文件两边都空。 */
  readonly added: readonly string[]
  readonly removed: readonly string[]
}

export interface FileDiffsResult {
  readonly files: readonly FileDiffEntry[]
  /** 满足条件的文件超过 `limit`：只读了前 `limit` 个，`found` 是实际个数。 */
  readonly truncated?: { readonly found: number; readonly limit: number }
}

/** 会话交给本模块的读取口：版本库命令（失败返回 undefined、超时抛错）与未跟踪文件表。 */
export interface FileDiffPort {
  gitText(args: readonly string[]): Promise<string | undefined>
  untracked(): Promise<readonly string[]>
  fail(what: string): Error
}

/** 一次 `-U0` diff 带多少个路径；更多的分批，避开命令行长度上限。 */
const DIFF_CHUNK = 100
const MAX_UNTRACKED_BYTES = 1024 * 1024

function nulTokens(stdout: string): string[] {
  return stdout.split('\0').filter((entry) => entry !== '')
}

/** 未跟踪文件的内容行（超过 1 MiB、非普通文件、读不出的当作没有行）。 */
async function untrackedLines(path: string): Promise<readonly string[]> {
  try {
    const entry = await lstat(path)
    if (!entry.isFile() || entry.size > MAX_UNTRACKED_BYTES) return []
    const text = await readFile(path, 'utf8')
    if (text === '') return []
    return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n')
  } catch {
    return []
  }
}

/**
 * 满足 `accept` 的文件（含删除）自 `start` 以来的改动行。先用 `--name-status` 与未跟踪表圈定文件，
 * 再对圈中的已跟踪文件分批读一次 `-U0` diff；圈中文件超过 `limit` 的部分不读，结果里带出截断信息。
 */
export async function readFileDiffs(
  port: FileDiffPort,
  repoRoot: string,
  start: string,
  accept: (path: string) => boolean,
  limit: number,
): Promise<FileDiffsResult> {
  const named = await port.gitText(['diff', '--name-status', '--no-renames', '-z', start])
  if (named === undefined) throw port.fail('git diff 失败')
  const statuses = new Map<string, FileDiffEntry['status']>()
  const tokens = nulTokens(named)
  for (let index = 0; index + 1 < tokens.length; index += 2) {
    const letter = tokens[index]?.[0]
    const path = tokens[index + 1]
    if (path !== undefined) statuses.set(path, letter === 'D' ? 'deleted' : letter === 'A' ? 'added' : 'modified')
  }
  const candidates = [
    ...[...statuses].filter(([path]) => accept(path)).map(([path, status]) => ({ path, status })),
    ...(await port.untracked()).filter((path) => !statuses.has(path) && accept(path)).map((path) => ({ path, status: 'added' as const })),
  ].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  const picked = candidates.slice(0, limit)
  const tracked = picked.filter((entry) => statuses.has(entry.path)).map((entry) => entry.path)
  const lines = new Map<string, FileLineDiff>()
  for (let from = 0; from < tracked.length; from += DIFF_CHUNK) {
    const text = await port.gitText([
      '-c', 'core.quotePath=false', 'diff', '-U0', '--no-color', '--no-ext-diff', '--no-renames', start, '--', ...tracked.slice(from, from + DIFF_CHUNK),
    ])
    if (text === undefined) throw port.fail('git diff 失败')
    for (const [path, diff] of parseFileLineDiffs(text)) lines.set(path, diff)
  }
  const files: FileDiffEntry[] = []
  for (const entry of picked) {
    const diff = lines.get(entry.path)
    files.push(statuses.has(entry.path)
      ? { ...entry, added: diff?.added ?? [], removed: diff?.removed ?? [] }
      : { ...entry, added: await untrackedLines(join(repoRoot, ...entry.path.split('/'))), removed: [] })
  }
  return { files, ...(candidates.length > limit ? { truncated: { found: candidates.length, limit } } : {}) }
}
