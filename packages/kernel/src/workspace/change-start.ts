/**
 * 任务起点的候选与取舍规则；跑 git 的会话在 changed-files.ts，这里只定「哪些提交是候选、取哪一个」。
 *
 * 候选（互相独立，哪个都可能缺）：
 *   1. start_sha：建任务时记下的 HEAD，是当前 HEAD 的祖先、且提交者时间不晚于任务 created_at + 60 秒时入选——用户切了分支、
 *      历史被改写后它可能不再是祖先，那就不入选；真实的 start_sha 是建任务时的 HEAD，提交时间必然不晚于建任务时刻，而它的伴随文件
 *      不在 wire 摘要里（created_at 在），被改写成建任务之后的提交会因时间校验被丢弃；读不到提交时间、created_at 不可用同样丢弃。
 *      丢弃只会让起点前移、改动范围变宽（删掉伴随文件读作没有 start_sha，效果相同）；
 *   2. merge-base(HEAD, base_branch 的上游跟踪分支)：上游存在时入选，别人合并后拉进来的提交落在它之前；
 *   3. merge-base(HEAD, base_branch)：不等于 HEAD 时入选——任务分支与基线分支分叉时就是分叉点。
 * 候选互为祖先取后代；分不出先后（不成链）取二者的共同祖先，只允许多算、不允许漏算。
 * 起点只由 Tenon 记下的 HEAD 与本地引用决定，不读提交信息与作者，改提交信息藏不住改动。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const HEAD_READ_TIMEOUT_MS = 20_000
/** git 的空树对象 id：与它比较等于「所有文件都是新增」。 */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

/** 合法的 git 提交 id：SHA-1（40 位）或 SHA-256（64 位）小写十六进制；start_sha 只接受它，不接受分支名、缩写或带选项的串。 */
const COMMIT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/

export function isGitCommitId(value: string): boolean {
  return COMMIT_ID.test(value)
}

export function usableSha(value: string | undefined): string | undefined {
  return value !== undefined && isGitCommitId(value) ? value : undefined
}

export function usableBase(value: string): string | undefined {
  const base = value.trim()
  return base === '' || base === 'null' || base.startsWith('-') ? undefined : base
}

/** `InitOptions` 里与任务起点有关的三项：建任务的调用方（CLI / Dashboard / triage）传，store.init 原样落盘。 */
export interface InitStartOptions {
  /** 建任务时检出的 HEAD 提交，写入 `start_sha`；必须是合法提交 id（否则 init 拒绝），省略（仓库还没有提交）则该键不出现。 */
  startSha?: string
  /** 覆盖 `base_branch` 的探测（默认读 `.git/HEAD` 的当前分支）；任务建在 worktree 里时是来源分支。 */
  baseBranch?: string
  /** 写入 `isolation` 的预设值；缺省为 `null`（由 build 步骤再填）。 */
  isolation?: 'worktree'
}

/** 仓库当前 HEAD 提交；不是仓库、还没有提交、git 跑不起来都返回 undefined。建任务时记 start_sha 用。 */
export async function readHeadCommit(repoRoot: string): Promise<string | undefined> {
  try {
    const { stdout } = await run('git', ['rev-parse', '--verify', '-q', 'HEAD'], { cwd: repoRoot, timeout: HEAD_READ_TIMEOUT_MS })
    return usableSha(stdout.trim())
  } catch {
    return undefined
  }
}

/** 会话里的 git 执行面：失败的命令 `text` 返回 undefined、`ok` 返回 false；超时由实现抛错，绝不当成「没有结果」。 */
export interface StartGit {
  readonly text: (args: readonly string[]) => Promise<string | undefined>
  readonly ok: (args: readonly string[]) => Promise<boolean>
}

/** 候选依次两两比较：一方是另一方的祖先取后代；不成链取二者的 merge-base，连共同祖先都没有（无关历史）取空树。 */
async function newestOrCommonAncestor(git: StartGit, candidates: readonly string[]): Promise<string> {
  let best = candidates[0] ?? EMPTY_TREE
  for (const next of candidates.slice(1)) {
    if (next === best || await git.ok(['merge-base', '--is-ancestor', next, best])) continue
    if (await git.ok(['merge-base', '--is-ancestor', best, next])) { best = next; continue }
    best = (await git.text(['merge-base', best, next]))?.trim() || EMPTY_TREE
  }
  return best
}

/** 记录的 start_sha 的提交时间允许比 created_at 晚的秒数（机器间 / 提交与建任务之间的时钟误差）。 */
export const START_SHA_CLOCK_SKEW_SECONDS = 60

/**
 * 记录的 start_sha 是否可信：它是建任务时的 HEAD，提交时间必然不晚于建任务时刻（created_at 在受摘要保护的 wire 上，
 * start_sha 的伴随文件不在摘要里，可能被改写）。提交者时间晚于 created_at + 60 秒、读不到提交时间、created_at 不可用都不可信——
 * 不可信只是不把它当候选（起点前移、改动范围变宽），绝不会让改动被漏算。
 */
async function recordedStartIsPlausible(git: StartGit, sha: string, createdAt: string | undefined): Promise<boolean> {
  const created = createdAt === undefined ? Number.NaN : Date.parse(createdAt)
  if (!Number.isFinite(created)) return false
  const committed = (await git.text(['show', '-s', '--format=%ct', sha]))?.trim()
  if (committed === undefined || !/^\d+$/.test(committed)) return false
  return Number(committed) <= Math.floor(created / 1000) + START_SHA_CLOCK_SKEW_SECONDS
}

/** 按上面三条收集候选并取最新的一个；没有任何候选返回 undefined，调用方退回按创建时间推算。 */
export async function startFromCandidates(
  git: StartGit,
  input: { readonly baseBranch: string; readonly startSha?: string; readonly createdAt?: string },
  head: string,
): Promise<string | undefined> {
  const candidates: string[] = []
  const recorded = usableSha(input.startSha)
  if (
    recorded !== undefined
    && await git.ok(['merge-base', '--is-ancestor', recorded, head])
    && await recordedStartIsPlausible(git, recorded, input.createdAt)
  ) candidates.push(recorded)
  const base = usableBase(input.baseBranch)
  if (base !== undefined) {
    const upstream = (await git.text(['rev-parse', '--verify', '--quiet', `${base}@{upstream}`]))?.trim()
    if (upstream) {
      const viaUpstream = (await git.text(['merge-base', 'HEAD', upstream]))?.trim()
      if (viaUpstream) candidates.push(viaUpstream)
    }
    const viaBase = (await git.text(['merge-base', 'HEAD', base]))?.trim()
    if (viaBase && viaBase !== head) candidates.push(viaBase)
  }
  return candidates.length > 0 ? newestOrCommonAncestor(git, candidates) : undefined
}
