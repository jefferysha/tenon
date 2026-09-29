/**
 * 「自任务起点以来改动的文件」：全量登记强制（test_policy.files: registered）与 changed 范围选择读它，
 * CLI 与 server 快照共用同一份口径。
 *
 * 起点（任务开始时代码所在的提交）：
 *   1. 任务分支与基线分支分叉时，取 merge-base(HEAD, base_branch)——分支上的所有提交与工作区改动都算；
 *   2. 直接在基线分支上做（HEAD 就是 merge-base，或没有基线分支）时，取任务创建时刻之前的最后一个提交；
 *   3. 仓库在任务创建前没有任何提交，取空树——当前所有文件都算新增。
 * 改动文件 = 起点提交与工作区的差异中新增 / 修改 / 重命名后的路径（含暂存与未暂存），加上未忽略的未跟踪文件。
 *
 * 读不出来（不是 git 仓库、git 跑不起来、起点定不出来）一律抛 ChangedFilesUnavailableError，
 * 调用方据此阻塞（fail closed），绝不当作「没有改动」。
 */
import { execFile } from 'node:child_process'
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const GIT_TIMEOUT_MS = 20_000
const MAX_BUFFER = 64 * 1024 * 1024
const MAX_UNTRACKED_BYTES = 1024 * 1024
const MAX_UNTRACKED_FILES = 20_000
/** git 的空树对象 id：与它比较等于「所有文件都是新增」。 */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

export interface ChangeStartInput {
  /** state 的 base_branch 字段；空串或 'null' 表示未记录。 */
  readonly baseBranch: string
  /** state 的 created_at（ISO 时间）；缺失时只能依赖基线分支。 */
  readonly createdAt: string
}

export class ChangedFilesUnavailableError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'ChangedFilesUnavailableError'
  }
}

async function git(repoRoot: string, args: readonly string[]): Promise<string | undefined> {
  try {
    return (await run('git', [...args], { cwd: repoRoot, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER })).stdout
  } catch {
    return undefined
  }
}

function usableBase(value: string): string | undefined {
  const base = value.trim()
  return base === '' || base === 'null' || base.startsWith('-') ? undefined : base
}

function usableTime(value: string): string | undefined {
  return Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined
}

/** 任务起点的提交（或空树）。定不出来抛 ChangedFilesUnavailableError。 */
export async function resolveChangeStart(repoRoot: string, input: ChangeStartInput): Promise<string> {
  const inside = await git(repoRoot, ['rev-parse', '--is-inside-work-tree'])
  if (inside?.trim() !== 'true') throw new ChangedFilesUnavailableError('当前目录不是 git 仓库')
  const head = (await git(repoRoot, ['rev-parse', '--verify', '-q', 'HEAD']))?.trim()
  if (head === undefined || head === '') return EMPTY_TREE
  const base = usableBase(input.baseBranch)
  if (base !== undefined) {
    const mergeBase = (await git(repoRoot, ['merge-base', 'HEAD', base]))?.trim()
    if (mergeBase !== undefined && mergeBase !== '' && mergeBase !== head) return mergeBase
  }
  const since = usableTime(input.createdAt)
  if (since === undefined) {
    if (base !== undefined) {
      const mergeBase = (await git(repoRoot, ['merge-base', 'HEAD', base]))?.trim()
      if (mergeBase !== undefined && mergeBase !== '') return mergeBase
    }
    throw new ChangedFilesUnavailableError('任务没有可用的创建时间与基线分支，定不出起点')
  }
  const before = (await git(repoRoot, ['rev-list', '-1', `--before=${since}`, 'HEAD']))?.trim()
  return before === undefined || before === '' ? EMPTY_TREE : before
}

function nulList(stdout: string): string[] {
  return stdout.split('\0').filter((entry) => entry !== '')
}

async function untrackedFiles(repoRoot: string): Promise<string[]> {
  const out = await git(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z'])
  if (out === undefined) throw new ChangedFilesUnavailableError('git ls-files 失败')
  return nulList(out).slice(0, MAX_UNTRACKED_FILES)
}

export async function changedFilesSinceChangeStart(repoRoot: string, input: ChangeStartInput): Promise<readonly string[]> {
  const start = await resolveChangeStart(repoRoot, input)
  const tracked = await git(repoRoot, ['diff', '--name-only', '--diff-filter=ACMR', '--no-renames', '-z', start])
  if (tracked === undefined) throw new ChangedFilesUnavailableError('git diff 失败')
  return [...new Set([...nulList(tracked), ...await untrackedFiles(repoRoot)])].sort()
}

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/

/** unified=0 的 diff 文本 → 仓库相对路径 → 新增 / 修改的行号。 */
export function parseAddedLines(diff: string): ReadonlyMap<string, ReadonlySet<number>> {
  const out = new Map<string, Set<number>>()
  let current: Set<number> | undefined
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const path = line.slice(4).trim()
      if (path === '/dev/null') { current = undefined; continue }
      const relative = path.startsWith('b/') ? path.slice(2) : path
      current = out.get(relative) ?? new Set<number>()
      out.set(relative, current)
      continue
    }
    const hunk = HUNK.exec(line)
    if (hunk === null || current === undefined) continue
    const first = Number(hunk[1])
    const count = hunk[2] === undefined ? 1 : Number(hunk[2])
    for (let offset = 0; offset < count; offset++) current.add(first + offset)
  }
  return out
}

async function lineCount(path: string): Promise<number> {
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

type StateFields = { readonly base_branch?: string | readonly string[]; readonly created_at?: string | readonly string[] }

function scalar(value: string | readonly string[] | undefined): string {
  return value === undefined ? '' : typeof value === 'string' ? value : value.join(',')
}

/** 任务起点的输入取自 state 的 base_branch 与 created_at（CLI 与 server 快照共用）。 */
export function changeStartOfFields(fields: StateFields): ChangeStartInput {
  return { baseBranch: scalar(fields.base_branch), createdAt: scalar(fields.created_at) }
}

export function changedFilesForState(repoRoot: string, state: { readonly fields: StateFields }): Promise<readonly string[]> {
  return changedFilesSinceChangeStart(repoRoot, changeStartOfFields(state.fields))
}

/** 自任务起点以来新增 / 修改的行（changed_lines 覆盖率用）；未跟踪文件的每一行都算新增。 */
export async function changedLinesSinceChangeStart(
  repoRoot: string,
  input: ChangeStartInput,
): Promise<ReadonlyMap<string, ReadonlySet<number>>> {
  const start = await resolveChangeStart(repoRoot, input)
  const diff = await git(repoRoot, ['diff', '-U0', '--no-color', '--no-renames', '--diff-filter=ACMR', start])
  if (diff === undefined) throw new ChangedFilesUnavailableError('git diff 失败')
  const out = new Map(parseAddedLines(diff))
  for (const path of await untrackedFiles(repoRoot)) {
    const lines = await lineCount(join(repoRoot, path))
    if (lines > 0) out.set(path, new Set(Array.from({ length: lines }, (_, index) => index + 1)))
  }
  return out
}
