/**
 * `tenon test code-size [--base <ref>] [--json]` —— 代码规模的确定性探针，内建 `code-size` 测试方向背后的命令。
 * 只读 git：与 base 的 merge-base 做 numstat，再数未跟踪文件的行数。输出一行 JSON，供指标判定读取。
 *
 * 只统计源代码：路径范围与工作区候选指纹同一份定义（isWorkspaceCandidatePath：排除 openspec/、
 * .tenon/、.pipeline/、docs/、依赖与测试缓存等），再排除 Markdown 文档。Tenon 自己写下的状态、
 * 文档与证据因此不会被算成代码改动。
 */
import { execFile } from 'node:child_process'
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { isWorkspaceCandidatePath } from '@tenon/kernel'
import type { CliDeps } from '../deps.js'

const run = promisify(execFile)
const MAX_UNTRACKED_FILES = 5000
const MAX_UNTRACKED_BYTES = 1024 * 1024

export interface CodeSizeMetrics {
  readonly files_changed: number
  readonly lines_added: number
  readonly lines_deleted: number
  readonly largest_added_lines: number
}

const DOCUMENT_EXTENSION = /\.(?:md|mdx|markdown)$/iu

/** 仓库相对路径是否计入代码规模。 */
export function isCodePath(path: string): boolean {
  return isWorkspaceCandidatePath(path) && !DOCUMENT_EXTENSION.test(path)
}

async function git(cwd: string, args: readonly string[]): Promise<string | undefined> {
  try {
    return (await run('git', [...args], { cwd, maxBuffer: 32 * 1024 * 1024 })).stdout
  } catch {
    return undefined
  }
}

async function countLines(path: string): Promise<number> {
  try {
    const entry = await lstat(path)
    if (!entry.isFile() || entry.size > MAX_UNTRACKED_BYTES) return 0
    const text = await readFile(path, 'utf8')
    if (text === '') return 0
    return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length
  } catch {
    return 0
  }
}

export async function collectCodeSize(cwd: string, base: string): Promise<CodeSizeMetrics | undefined> {
  const mergeBase = (await git(cwd, ['merge-base', 'HEAD', base]))?.trim()
  if (mergeBase === undefined || mergeBase === '') return undefined
  // -z：路径不加引号、不转义；--no-renames：每条记录恰好一个路径，按路径过滤才可靠。
  const numstat = await git(cwd, ['diff', '--numstat', '--no-renames', '-z', mergeBase])
  if (numstat === undefined) return undefined
  let filesChanged = 0
  let linesAdded = 0
  let linesDeleted = 0
  let largest = 0
  for (const record of numstat.split('\0')) {
    if (record.trim() === '') continue
    const [added, deleted, ...rest] = record.split('\t')
    if (!isCodePath(rest.join('\t'))) continue
    const plus = Number(added)
    const minus = Number(deleted)
    filesChanged += 1
    if (Number.isFinite(plus)) {
      linesAdded += plus
      largest = Math.max(largest, plus)
    }
    if (Number.isFinite(minus)) linesDeleted += minus
  }
  const untracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']) ?? '')
    .split('\0').filter((path) => path !== '' && isCodePath(path)).slice(0, MAX_UNTRACKED_FILES)
  for (const path of untracked) {
    const lines = await countLines(join(cwd, path))
    filesChanged += 1
    linesAdded += lines
    largest = Math.max(largest, lines)
  }
  return {
    files_changed: filesChanged,
    lines_added: linesAdded,
    lines_deleted: linesDeleted,
    largest_added_lines: largest,
  }
}

export async function cmdTestCodeSize(
  deps: CliDeps,
  opts: { readonly base?: string; readonly json?: boolean } = {},
): Promise<number> {
  const base = opts.base ?? deps.env?.('TENON_BASE_BRANCH') ?? 'HEAD'
  const metrics = await collectCodeSize(deps.cwd, base === '' ? 'HEAD' : base)
  if (metrics === undefined) {
    deps.io.err(`ERROR: 无法读取 git 规模信息（base=${base}）`)
    return 1
  }
  deps.io.out(JSON.stringify(metrics))
  return 0
}
