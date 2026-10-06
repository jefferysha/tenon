/**
 * `tenon verify --ci` 读的 git 事实：HEAD、浅克隆探测、基线引用解析、PR 范围的改动路径、
 * `refs/notes/tenon` 上的证据 note、候选不一致时的线索文件。全部只读；任何一步失败返回 undefined / 空，
 * 由调用方决定是失败关闭还是降级成提示（这里不吞错成「一切正常」）。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  EVIDENCE_NOTES_REF, HOST_LOCAL_DIRS, HOST_LOCAL_FILES, decodeEvidenceNote, isHostLocalPath, isWorkspaceCandidatePath,
  trackedHostLocalPaths, type AnchorEvidence,
} from '@tenon/kernel'

const run = promisify(execFile)
const GIT_TIMEOUT_MS = 30_000
const MAX_BUFFER = 64 * 1024 * 1024
/** 只在最近这么多个提交里找锚点 note。 */
export const NOTE_SCAN_COMMITS = 1000
const MAX_NOTES_READ = 200

export async function git(cwd: string, args: readonly string[]): Promise<string | undefined> {
  try {
    const { stdout } = await run('git', [...args], { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER })
    return stdout
  } catch {
    return undefined
  }
}

export async function headCommit(cwd: string): Promise<string | null> {
  const out = (await git(cwd, ['rev-parse', '--verify', '-q', 'HEAD']))?.trim()
  return out !== undefined && /^[0-9a-f]{40}$/u.test(out) ? out : null
}

export async function isShallow(cwd: string): Promise<boolean> {
  return (await git(cwd, ['rev-parse', '--is-shallow-repository']))?.trim() === 'true'
}

async function resolves(cwd: string, ref: string): Promise<boolean> {
  return (await git(cwd, ['rev-parse', '--verify', '-q', `${ref}^{commit}`])) !== undefined
}

/** CI 检出里通常只有 `origin/<分支>`，没有本地分支：状态里的 base_branch 解析不到时退回 origin/ 前缀。 */
export async function resolveBaseRef(cwd: string, base: string): Promise<string> {
  if (base === '' || base === 'null' || base.startsWith('-')) return base
  if (await resolves(cwd, base)) return base
  return (await resolves(cwd, `origin/${base}`)) ? `origin/${base}` : base
}

/** `--since <ref>` 的基点：merge-base(ref, HEAD)；ref 本身解析不到时试 origin/<ref>。 */
export async function mergeBaseWith(cwd: string, ref: string): Promise<string | undefined> {
  if (ref === '' || ref.startsWith('-')) return undefined
  const resolved = await resolves(cwd, ref) ? ref : (await resolves(cwd, `origin/${ref}`)) ? `origin/${ref}` : undefined
  if (resolved === undefined) return undefined
  const base = (await git(cwd, ['merge-base', resolved, 'HEAD']))?.trim()
  return base === undefined || base === '' ? undefined : base
}

/** 基点到 HEAD 之间提交改动的路径（含删除与重命名的两端）；读不出返回 undefined。 */
export async function rangeChangedPaths(cwd: string, base: string): Promise<readonly string[] | undefined> {
  const out = await git(cwd, ['diff', '--name-only', '--no-renames', '-z', base, 'HEAD'])
  return out === undefined ? undefined : out.split('\0').filter((path) => path !== '')
}

/**
 * `refs/notes/tenon` 上最近 NOTE_SCAN_COMMITS 个提交的证据 note 条目，新的提交在前。
 * ref 不存在（CI 默认不检出 notes）= 空。解码失败的 note 整体忽略。
 */
export async function readEvidenceNotes(cwd: string): Promise<readonly AnchorEvidence[]> {
  const listing = await git(cwd, ['notes', `--ref=${EVIDENCE_NOTES_REF}`, 'list'])
  if (listing === undefined || listing.trim() === '') return []
  const noteOf = new Map<string, string>()
  for (const line of listing.split('\n')) {
    const [blob, commit] = line.trim().split(/\s+/u)
    if (blob !== undefined && commit !== undefined && /^[0-9a-f]{40}$/u.test(blob) && /^[0-9a-f]{40}$/u.test(commit)) noteOf.set(commit, blob)
  }
  const revisions = await git(cwd, ['rev-list', `--max-count=${NOTE_SCAN_COMMITS}`, 'HEAD'])
  if (revisions === undefined) return []
  const out: AnchorEvidence[] = []
  let read = 0
  for (const commit of revisions.split('\n').map((line) => line.trim()).filter((line) => line !== '')) {
    const blob = noteOf.get(commit)
    if (blob === undefined) continue
    if (read++ >= MAX_NOTES_READ) break
    const body = await git(cwd, ['cat-file', 'blob', blob])
    const note = body === undefined ? undefined : decodeEvidenceNote(body)
    if (note === undefined) continue
    for (const entry of note.changes) out.push({ commit, entry })
  }
  return out
}

export interface CandidateClues {
  /** 记录之后的第一个提交（缩写）：测试跑完后工作区通常就提交在这个提交里；找不到时 undefined。 */
  readonly followedBy: string | undefined
  /** 这个提交之后又改过的候选范围路径，最多 `limit` 个。 */
  readonly changedLater: readonly string[]
  readonly changedLaterMore: number
  /** 本次检出里候选范围内被 gitignore 或未跟踪的路径（例如构建产物），最多 `limit` 个。 */
  readonly extraHere: readonly string[]
  readonly extraHereMore: number
  /** 本次检出里 git 跟踪着的宿主本地清单上的路径：它们计入候选（改了就动候选），和作者本机没提交时不一样。 */
  readonly trackedHostLocal: readonly string[]
  readonly trackedHostLocalMore: number
}

async function isAncestorOfHead(cwd: string, commit: string): Promise<boolean> {
  return (await git(cwd, ['merge-base', '--is-ancestor', commit, 'HEAD'])) !== undefined
}

function lines(out: string | undefined): readonly string[] {
  return (out ?? '').split('\n').map((line) => line.trim()).filter((line) => line !== '')
}

/**
 * 记录之后的第一个提交：优先用记录里的 `git_head`（测试运行时的 HEAD）——它之后沿 HEAD 的第一父链上的第一个提交；
 * `git_head` 缺失、解析不到或不在 HEAD 的历史里（变基、浅克隆）时，退回「完成时间之后的第一个提交」（提交时间可伪造，只作线索）。
 */
async function commitAfterRecord(cwd: string, gitHead: string | null, finishedAt: string): Promise<string | undefined> {
  if (gitHead !== null && /^[0-9a-f]{40}$/u.test(gitHead) && await resolves(cwd, gitHead) && await isAncestorOfHead(cwd, gitHead)) {
    // 第一父链上 gitHead..HEAD 的最后一行就是紧接着它的那个提交；空 = 测试就是在 HEAD 上跑的，没有「之后的提交」，不去猜。
    return lines(await git(cwd, ['rev-list', '--first-parent', `${gitHead}..HEAD`])).at(-1)
  }
  if (!Number.isFinite(Date.parse(finishedAt))) return undefined
  return lines(await git(cwd, ['rev-list', '--first-parent', '--reverse', `--since=${finishedAt}`, 'HEAD'])).find((line) => /^[0-9a-f]{40}$/u.test(line))
}

function underAny(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(`${root}/`) || (path.endsWith('/') && root.startsWith(path)))
}

/** `git status` 里未跟踪（`??`）与被忽略（`!!`）的条目路径；折叠的目录是一个以 `/` 结尾的条目。读不出返回空。 */
async function untrackedAndIgnored(cwd: string, pathspec: readonly string[], untracked: 'normal' | 'all'): Promise<readonly string[]> {
  const args = ['status', '--porcelain=v1', '-z', '--ignored=traditional', `--untracked-files=${untracked}`]
  const out = await git(cwd, pathspec.length === 0 ? args : [...args, '--', ...pathspec])
  return (out ?? '').split('\0').filter((entry) => /^(\?\?|!!) /u.test(entry)).map((entry) => entry.slice(3)).filter((path) => path !== '')
}

/** 折叠的目录里装着宿主本地清单上的路径（`.claude/` 装着 settings.local.json）：要展开，不然清单路径会连同整个目录被算成「多出来的文件」。 */
function holdsHostLocalPath(dir: string): boolean {
  return [...HOST_LOCAL_FILES, ...HOST_LOCAL_DIRS].some((path) => path.startsWith(dir))
}

/** 本次检出里候选范围内被 gitignore 或未跟踪的路径（目录以 `/` 结尾）；读不出返回空。 */
async function candidateExtrasHere(cwd: string, declared: readonly string[]): Promise<readonly string[]> {
  const entries: string[] = []
  for (const path of await untrackedAndIgnored(cwd, [], 'normal')) {
    if (path.endsWith('/') && holdsHostLocalPath(path)) entries.push(...await untrackedAndIgnored(cwd, [path], 'all'))
    else entries.push(path)
  }
  const paths: string[] = []
  for (const path of entries) {
    const bare = path.replace(/\/$/u, '')
    // 宿主本地清单上没被跟踪的路径不进可移植指纹，所以不算「多出来的文件」。
    if (bare === '' || !isWorkspaceCandidatePath(bare) || isHostLocalPath(bare) || underAny(path, declared)) continue
    paths.push(path)
  }
  return [...new Set(paths)].sort()
}

/**
 * 候选不一致时的线索。记录只绑了一个指纹，CI 看不到作者当时的工作区，所以说不出「差在哪个文件」；
 * 能确定的有两件：测试之后的提交里又改过哪些候选文件，和本次检出里多出了哪些被忽略 / 未跟踪的候选文件。
 * 交付提交本身不算「之后又改过」：它只是把测试时的工作区提交了。
 */
export async function candidateClues(cwd: string, input: {
  readonly gitHead: string | null
  readonly finishedAt: string
  /** 项目声明的测试产物路径（不算多出来的文件）。 */
  readonly declared: readonly string[]
}, limit = 5): Promise<CandidateClues> {
  const followedBy = await commitAfterRecord(cwd, input.gitHead, input.finishedAt)
  let later: readonly string[] = []
  if (followedBy !== undefined) {
    const out = await git(cwd, ['diff', '--name-only', '--no-renames', '-z', followedBy, 'HEAD'])
    later = (out?.split('\0') ?? []).filter((path) => path !== '' && isWorkspaceCandidatePath(path)).sort()
  }
  const extras = await candidateExtrasHere(cwd, input.declared)
  const tracked = [...(await trackedHostLocalPaths(cwd)) ?? []].sort()
  return {
    followedBy: followedBy?.slice(0, 7),
    changedLater: later.slice(0, limit), changedLaterMore: Math.max(0, later.length - limit),
    extraHere: extras.slice(0, limit), extraHereMore: Math.max(0, extras.length - limit),
    trackedHostLocal: tracked.slice(0, limit), trackedHostLocalMore: Math.max(0, tracked.length - limit),
  }
}
