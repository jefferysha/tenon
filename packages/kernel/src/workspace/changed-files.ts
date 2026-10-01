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
 * 读不出来（不是 git 仓库、git 跑不起来、超时、起点定不出来）一律抛 ChangedFilesUnavailableError，
 * 调用方据此阻塞（fail closed），绝不当作「没有改动」。
 *
 * 批量读取：`createChangedFilesSession` 把同一个仓库的 git 调用合并成一次会话——相同参数的命令只跑一次
 * （repo 探针与 HEAD 合成一次 rev-parse，未跟踪文件表、merge-base、每个起点的 diff 各一次），创建时间落在
 * 最近一段历史里的多个任务共用一次 `rev-list --timestamp`。一个仓库有 N 个任务时，逐任务读取要 6N 个 git 子进程，
 * 会话只要 O(项目) 个。任何一次 git 超时都会让会话里后续未缓存的命令直接以同一原因失败，而不是每个任务再等一遍超时。
 *
 * 未跟踪文件上限：单个仓库只读前 UNTRACKED_FILE_LIMIT 个未跟踪路径，超出部分不再检查；这在结果里显式带出
 * `untrackedTruncated`，调用方据此给出提示，而不是悄悄截断。
 */
import { execFile } from 'node:child_process'
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { readFileDiffs, type FileDiffsResult } from './file-diffs.js'

export type { FileDiffEntry, FileDiffsResult } from './file-diffs.js'

const run = promisify(execFile)
export const CHANGED_FILES_GIT_TIMEOUT_MS = 20_000
const MAX_BUFFER = 64 * 1024 * 1024
const MAX_UNTRACKED_BYTES = 1024 * 1024
/** 一个仓库读多少个未跟踪路径；超出即被截断并在结果里标出。 */
export const UNTRACKED_FILE_LIMIT = 20_000
/** 一次 `rev-list --timestamp` 覆盖的最近提交数；更早的创建时间退回逐个 `rev-list -1 --before`。 */
const HISTORY_WINDOW = 2_000
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

function usableBase(value: string): string | undefined {
  const base = value.trim()
  return base === '' || base === 'null' || base.startsWith('-') ? undefined : base
}

function usableTime(value: string): string | undefined {
  return Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined
}

function nulList(stdout: string): string[] {
  return stdout.split('\0').filter((entry) => entry !== '')
}

/** 一次 git 调用的结果：失败时仍带上已输出的 stdout（合并的 rev-parse 靠它区分「不是仓库」与「还没有提交」）。 */
type GitOutcome =
  | { readonly ok: true; readonly stdout: string }
  | { readonly ok: false; readonly stdout: string; readonly timedOut: boolean }

export interface ChangedFilesSessionOptions {
  /** 单个 git 命令的超时（毫秒）；默认 20 秒。dashboard 快照会传更短的值，避免一个卡住的仓库拖住整份快照。 */
  readonly timeoutMs?: number
  /** 读多少个未跟踪路径；默认 UNTRACKED_FILE_LIMIT。 */
  readonly untrackedLimit?: number
  /** @internal 测试缝：替换真实的 git 子进程（数调用次数、模拟超时）；语义同 execFile 的 promisify 版本。 */
  readonly runGit?: (
    args: readonly string[],
    options: { readonly cwd: string; readonly timeout: number; readonly maxBuffer: number },
  ) => Promise<{ readonly stdout: string }>
}

export interface ChangedFilesResult {
  /** 排序去重后的仓库相对路径。 */
  readonly files: readonly string[]
  /** 未跟踪文件超过上限时存在：只读了前 `limit` 个，`found` 是 git 实际列出的个数。 */
  readonly untrackedTruncated?: { readonly found: number; readonly limit: number }
}

export type PathChangeStatus = 'added' | 'modified' | 'deleted'

export interface PathChange {
  readonly path: string
  readonly status: PathChangeStatus
}

export interface ChangedFilesSession {
  resolveStart(input: ChangeStartInput): Promise<string>
  changedFiles(input: ChangeStartInput): Promise<ChangedFilesResult>
  changedLines(input: ChangeStartInput): Promise<ReadonlyMap<string, ReadonlySet<number>>>
  /** 只看给定 pathspec 的改动（含删除）；见 pathChangesSinceChangeStart。 */
  pathChanges(input: ChangeStartInput, pathspecs: readonly string[]): Promise<readonly PathChange[]>
  /** 起点提交（或空树）时该路径的文件内容；起点不存在该文件返回 undefined。 */
  fileAtStart(input: ChangeStartInput, path: string): Promise<string | undefined>
  /** 满足 `accept` 的文件（含删除）相对起点的改动行；测试完整性读它。 */
  fileDiffs(input: ChangeStartInput, accept: (path: string) => boolean, limit: number): Promise<FileDiffsResult>
}

interface HistoryWindow {
  readonly entries: readonly { readonly sha: string; readonly ts: number }[]
  /** true = 历史比窗口长，窗口里找不到不能断定「没有更早的提交」。 */
  readonly truncated: boolean
}

interface UntrackedList {
  readonly files: readonly string[]
  readonly found: number
}

/**
 * 同一个仓库的一组读取共用的会话：相同参数的 git 命令只跑一次，所有结果按起点复用。
 * 会话很短命（一次 CLI 调用，或 dashboard 对一个项目的一次扫描），不做跨会话缓存——工作区随时会变。
 */
export function createChangedFilesSession(repoRoot: string, options: ChangedFilesSessionOptions = {}): ChangedFilesSession {
  const timeoutMs = options.timeoutMs ?? CHANGED_FILES_GIT_TIMEOUT_MS
  const untrackedLimit = options.untrackedLimit ?? UNTRACKED_FILE_LIMIT
  const runGit = options.runGit
  const commands = new Map<string, Promise<GitOutcome>>()
  let abandoned = false
  const timeoutReason = (what: string): string => `git ${what} 超时（超过 ${Math.max(1, Math.round(timeoutMs / 1000))} 秒）`

  async function execute(args: readonly string[]): Promise<GitOutcome> {
    if (abandoned) return { ok: false, stdout: '', timedOut: true }
    try {
      const options = { cwd: repoRoot, timeout: timeoutMs, maxBuffer: MAX_BUFFER }
      const { stdout } = await (runGit ?? ((argv, opts) => run('git', [...argv], opts)))(args, options)
      return { ok: true, stdout }
    } catch (error) {
      const failure = error as { readonly killed?: unknown; readonly signal?: unknown; readonly code?: unknown; readonly stdout?: unknown }
      const timedOut = failure.killed === true && failure.signal === 'SIGTERM' && failure.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
      if (timedOut) abandoned = true
      return { ok: false, stdout: typeof failure.stdout === 'string' ? failure.stdout : '', timedOut }
    }
  }

  function git(args: readonly string[]): Promise<GitOutcome> {
    const key = args.join('\0')
    const known = commands.get(key)
    if (known !== undefined) return known
    const pending = execute(args)
    commands.set(key, pending)
    return pending
  }

  /** stdout；命令失败返回 undefined（调用方按各自口径处理），超时则抛错——绝不把超时当成「没有结果」。 */
  async function gitText(args: readonly string[]): Promise<string | undefined> {
    const outcome = await git(args)
    if (outcome.ok) return outcome.stdout
    if (outcome.timedOut) throw new ChangedFilesUnavailableError(timeoutReason(args[0] ?? ''))
    return undefined
  }

  let repo: Promise<{ readonly head: string | undefined }> | undefined
  function repository(): Promise<{ readonly head: string | undefined }> {
    repo ??= (async () => {
      // 一个进程同时回答「是不是 git 仓库」与「HEAD 是谁」：仓库外 stdout 为空，还没有提交时只有 `true`。
      const outcome = await git(['rev-parse', '--is-inside-work-tree', '--verify', '-q', 'HEAD'])
      if (!outcome.ok && outcome.timedOut) throw new ChangedFilesUnavailableError(timeoutReason('rev-parse'))
      const [inside, head] = outcome.stdout.split('\n').map((line) => line.trim())
      if (inside !== 'true') throw new ChangedFilesUnavailableError('当前目录不是 git 仓库')
      return { head: outcome.ok && head !== undefined && head !== '' ? head : undefined }
    })()
    return repo
  }

  let history: Promise<HistoryWindow | undefined> | undefined
  function historyWindow(): Promise<HistoryWindow | undefined> {
    history ??= (async () => {
      const out = await gitText(['rev-list', '--timestamp', `--max-count=${HISTORY_WINDOW}`, 'HEAD'])
      if (out === undefined) return undefined
      const entries: { sha: string; ts: number }[] = []
      for (const line of out.split('\n')) {
        const [ts, sha] = line.trim().split(' ')
        if (ts === undefined || sha === undefined || !/^\d+$/.test(ts)) continue
        entries.push({ sha, ts: Number(ts) })
      }
      return { entries, truncated: entries.length >= HISTORY_WINDOW }
    })()
    return history
  }

  /**
   * 创建时刻之前的最后一个提交，即 `rev-list -1 --before=<时刻> HEAD`：git 按提交时间优先的遍历顺序输出，
   * 跳过晚于该时刻的提交；所以在同一份遍历顺序里取第一个不晚于该时刻的提交，与逐个调用的结果一致，
   * 而一个仓库的所有任务只需要一次 `rev-list --timestamp`。窗口之外的更早时刻才退回逐个调用。
   */
  async function lastCommitBefore(sinceIso: string): Promise<string> {
    const seconds = Math.floor(Date.parse(sinceIso) / 1000)
    const window = await historyWindow()
    if (window !== undefined) {
      const hit = window.entries.find((entry) => entry.ts <= seconds)
      if (hit !== undefined) return hit.sha
      if (!window.truncated) return EMPTY_TREE
    }
    const before = (await gitText(['rev-list', '-1', `--before=${sinceIso}`, 'HEAD']))?.trim()
    return before === undefined || before === '' ? EMPTY_TREE : before
  }

  async function computeStart(input: ChangeStartInput): Promise<string> {
    const { head } = await repository()
    if (head === undefined) return EMPTY_TREE
    const base = usableBase(input.baseBranch)
    if (base !== undefined) {
      const mergeBase = (await gitText(['merge-base', 'HEAD', base]))?.trim()
      if (mergeBase !== undefined && mergeBase !== '' && mergeBase !== head) return mergeBase
    }
    const since = usableTime(input.createdAt)
    if (since === undefined) {
      if (base !== undefined) {
        const mergeBase = (await gitText(['merge-base', 'HEAD', base]))?.trim()
        if (mergeBase !== undefined && mergeBase !== '') return mergeBase
      }
      throw new ChangedFilesUnavailableError('任务没有可用的创建时间与基线分支，定不出起点')
    }
    return lastCommitBefore(since)
  }

  const starts = new Map<string, Promise<string>>()
  function resolveStart(input: ChangeStartInput): Promise<string> {
    const key = `${input.baseBranch}\0${input.createdAt}`
    let pending = starts.get(key)
    if (pending === undefined) {
      pending = computeStart(input)
      starts.set(key, pending)
    }
    return pending
  }

  let untracked: Promise<UntrackedList> | undefined
  function untrackedFiles(): Promise<UntrackedList> {
    untracked ??= (async () => {
      const out = await gitText(['ls-files', '--others', '--exclude-standard', '-z'])
      if (out === undefined) throw new ChangedFilesUnavailableError('git ls-files 失败')
      const all = nulList(out)
      return { files: all.length > untrackedLimit ? all.slice(0, untrackedLimit) : all, found: all.length }
    })()
    return untracked
  }

  const results = new Map<string, Promise<ChangedFilesResult>>()
  async function computeChangedFiles(start: string): Promise<ChangedFilesResult> {
    const tracked = await gitText(['diff', '--name-only', '--diff-filter=ACMR', '--no-renames', '-z', start])
    if (tracked === undefined) throw new ChangedFilesUnavailableError('git diff 失败')
    const others = await untrackedFiles()
    return {
      files: [...new Set([...nulList(tracked), ...others.files])].sort(),
      ...(others.found > untrackedLimit ? { untrackedTruncated: { found: others.found, limit: untrackedLimit } } : {}),
    }
  }

  const pathResults = new Map<string, Promise<readonly PathChange[]>>()
  async function computePathChanges(start: string, pathspecs: readonly string[]): Promise<readonly PathChange[]> {
    const tracked = await gitText(['diff', '--name-status', '--no-renames', '-z', start, '--', ...pathspecs])
    if (tracked === undefined) throw new ChangedFilesUnavailableError('git diff 失败')
    const out = new Map<string, PathChangeStatus>()
    const tokens = nulList(tracked)
    for (let index = 0; index + 1 < tokens.length; index += 2) {
      const letter = tokens[index]?.[0]
      const path = tokens[index + 1]
      if (path === undefined) continue
      out.set(path, letter === 'D' ? 'deleted' : letter === 'A' ? 'added' : 'modified')
    }
    const untracked = await gitText(['ls-files', '--others', '--exclude-standard', '-z', '--', ...pathspecs])
    if (untracked === undefined) throw new ChangedFilesUnavailableError('git ls-files 失败')
    for (const path of nulList(untracked)) if (!out.has(path)) out.set(path, 'added')
    return [...out].map(([path, status]) => ({ path, status })).sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  }

  return {
    resolveStart,
    async fileDiffs(input, accept, limit) {
      const port = { gitText, untracked: async () => (await untrackedFiles()).files, fail: (what: string) => new ChangedFilesUnavailableError(what) }
      return readFileDiffs(port, repoRoot, await resolveStart(input), accept, limit)
    },
    async pathChanges(input, pathspecs) {
      const start = await resolveStart(input)
      const key = `${start}\0${pathspecs.join('\0')}`
      let pending = pathResults.get(key)
      if (pending === undefined) {
        pending = computePathChanges(start, pathspecs)
        pathResults.set(key, pending)
      }
      return pending
    },
    async fileAtStart(input, path) {
      return gitText(['show', `${await resolveStart(input)}:${path}`])
    },
    async changedFiles(input) {
      const start = await resolveStart(input)
      let pending = results.get(start)
      if (pending === undefined) {
        pending = computeChangedFiles(start)
        results.set(start, pending)
      }
      return pending
    },
    async changedLines(input) {
      const start = await resolveStart(input)
      const diff = await gitText(['diff', '-U0', '--no-color', '--no-renames', '--diff-filter=ACMR', start])
      if (diff === undefined) throw new ChangedFilesUnavailableError('git diff 失败')
      const out = new Map(parseAddedLines(diff))
      // 覆盖率只需要未跟踪文件的行数；超过上限被截断的部分不在这里报（changedFiles 的结果已带出截断信息）。
      for (const path of (await untrackedFiles()).files) {
        const lines = await lineCount(join(repoRoot, path))
        if (lines > 0) out.set(path, new Set(Array.from({ length: lines }, (_, index) => index + 1)))
      }
      return out
    },
  }
}

/** 任务起点的提交（或空树）。定不出来抛 ChangedFilesUnavailableError。 */
export function resolveChangeStart(repoRoot: string, input: ChangeStartInput): Promise<string> {
  return createChangedFilesSession(repoRoot).resolveStart(input)
}

export async function changedFilesSinceChangeStart(repoRoot: string, input: ChangeStartInput): Promise<readonly string[]> {
  return (await createChangedFilesSession(repoRoot).changedFiles(input)).files
}

/**
 * 只看给定 pathspec 的「自任务起点以来的改动」，含删除（changedFilesSinceChangeStart 只列新增 / 修改）。
 * 受保护的测试配置（目录、基线、已知失败清单、工作流）用它：删掉一个已知失败或一份基线同样是需要人看的改动。
 * pathspec 限定了 git 的工作量，所以比全量 diff 便宜得多；读不出照样抛 ChangedFilesUnavailableError。
 * 批量读取时用 `createChangedFilesSession().pathChanges`，与改动文件共用同一次起点解析与 git 结果缓存。
 */
export function pathChangesSinceChangeStart(
  repoRoot: string,
  input: ChangeStartInput,
  pathspecs: readonly string[],
): Promise<readonly PathChange[]> {
  return createChangedFilesSession(repoRoot).pathChanges(input, pathspecs)
}

/** 起点提交（或空树）时该路径的文件内容；起点不存在该文件返回 undefined。 */
export function fileAtChangeStart(repoRoot: string, input: ChangeStartInput, path: string): Promise<string | undefined> {
  return createChangedFilesSession(repoRoot).fileAtStart(input, path)
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

/** 与 changedFilesForState 同一份口径，另带「未跟踪文件被截断」的显式标记（测试策略据此给出提示）。 */
export async function changedFilesResultForState(repoRoot: string, state: { readonly fields: StateFields }): Promise<ChangedFilesResult> {
  return createChangedFilesSession(repoRoot).changedFiles(changeStartOfFields(state.fields))
}

/** 自任务起点以来新增 / 修改的行（changed_lines 覆盖率用）；未跟踪文件的每一行都算新增。 */
export function changedLinesSinceChangeStart(
  repoRoot: string,
  input: ChangeStartInput,
): Promise<ReadonlyMap<string, ReadonlySet<number>>> {
  return createChangedFilesSession(repoRoot).changedLines(input)
}
