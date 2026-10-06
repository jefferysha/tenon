/**
 * `tenon verify --ci` 读的 git 事实：HEAD、浅克隆探测、基线引用解析、PR 范围的改动路径、
 * `refs/notes/tenon` 上的证据 note、候选不一致时的线索文件。全部只读；任何一步失败返回 undefined / 空，
 * 由调用方决定是失败关闭还是降级成提示（这里不吞错成「一切正常」）。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { EVIDENCE_NOTES_REF, decodeEvidenceNote, isWorkspaceCandidatePath, type AnchorEvidence } from '@tenon/kernel'

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

/** 某时刻之后提交改动过的候选范围文件（候选不一致时的线索；提交时间可伪造，只作提示）。 */
export async function candidateFilesTouchedSince(cwd: string, sinceIso: string, limit = 5): Promise<readonly string[]> {
  const out = await git(cwd, ['log', `--since=${sinceIso}`, '--name-only', '--format=', '--no-renames', 'HEAD'])
  if (out === undefined) return []
  const seen = new Set<string>()
  for (const line of out.split('\n')) {
    const path = line.trim()
    if (path !== '' && isWorkspaceCandidatePath(path)) seen.add(path)
    if (seen.size >= limit) break
  }
  return [...seen]
}
