/**
 * 交付步与完结时下发的提交动作要问 git 的事实。提交命令（`git add -A -- <paths…>`、可选的
 * `git rm --cached -q --ignore-unmatch -- <untrack…>`、`git commit`）必须一次成功，所以 paths 里
 * 只能出现 git 接受的路径：
 *
 *   · `openspec archive` 搬走的原目录如果从来没被 git 跟踪过，搬走之后这条 pathspec 什么也匹配
 *     不到，`git add` 以 `fatal: pathspec … did not match any files`（exit 128）整条失败；只有被
 *     跟踪过的原目录才需要、也才能出现在 paths 里（`-A` 据索引项把删除一起暂存）。
 *   · 状态目录自己的 `.gitignore`（`.pipeline/`、`.tenon/`、`openspec/`）首次生成后常处于未跟踪
 *     状态，不一起提交收尾后 `git status` 就不干净；但它们只在存在、且没有被上层规则忽略时才能
 *     `git add`（被忽略的路径 `git add` 会 exit 1）。
 *   · 旧版本已经提交进 git 的终端心跳（`openspec/changes/**\/.pipeline-terminal-activity.*`）不会因为
 *     后来加的忽略规则而取消跟踪：已跟踪且已被忽略的那些列进 `untrack`，由 `git rm --cached` 移出索引。
 *   · 整个工作区的提交（交付步的 `commit`、非治理工作流的收尾）用 `.` 加 exclude pathspec 挡住仓库根
 *     的本机门禁标记；判「还有没有要提交的」用同一组 pathspec，否则只剩标记时 `git commit` 以
 *     「nothing to commit」失败。
 *
 * 不是 git 仓（或 git 跑不起来）时返回 null：调用方据此不发提交动作，不把「不知道」当成「可以提交」。
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { GATE_MARKERS } from '@tenon/kernel'

export interface GitFinishProbe {
  /** `openspec/changes/<c>` 之下有没有已跟踪的文件。 */
  readonly changeDirTracked: boolean
  /** 工作区（含未跟踪、不含被忽略的、不含仓库根的本机门禁标记）有没有待提交的改动。 */
  readonly workspaceDirty: boolean
  /**
   * 同上，再去掉 change 目录本身：交付物（代码、文档、主规格、测试记录、.gitignore）有没有待提交的。
   * change 目录每次 hook 都会追加历史，拿它判「还要不要提交」会让提交动作永远发不完；它随交付
   * 提交一起入库，之后的改动由完结的 finish-change 负责。
   */
  readonly deliverablesDirty: boolean
  /**
   * 同 workspaceDirty，只去掉 hook 在 change 目录里追加的台账（历史、交互、技能调用与确认）：交付步
   * 收尾时还有没入库的东西（包括 `set pr_url` 写下的状态文件）。这些台账在每次技能调用与用户回复时
   * 都会追加，拿它们判定会让每次续轮都多一次提交；它们随下一次提交入库。
   */
  readonly stepDirty: boolean
  /** 这个 change 的首次交付提交（`feat(<c>): deliver`）已在当前分支的历史里。 */
  readonly delivered: boolean
  /** 存在且未被忽略、可以一起 `git add` 的状态目录 `.gitignore`。 */
  readonly housekeeping: readonly string[]
  /** 已跟踪、但按当前忽略规则应被忽略的终端心跳文件。 */
  readonly untrack: readonly string[]
}

export const FINISH_HOUSEKEEPING_PATHS: readonly string[] = [
  '.pipeline/.gitignore',
  '.tenon/.gitignore',
  'openspec/.gitignore',
]

/**
 * 仓库根上只属于本机的文件：三个门禁标记（`.pipeline-pending-*`），以及旧版本留下的活跃指针与
 * 交互授权（session activate 会删掉它们，但升级前的仓库里可能还在）。项目根 `.gitignore` 不归
 * Tenon 改写，所以它们靠提交命令里的 exclude pathspec 挡在提交之外。
 */
export const LOCAL_ROOT_FILES: readonly string[] = [
  ...GATE_MARKERS,
  '.pipeline-active',
  '.pipeline-interaction-authority',
]

/** `git add -A -- <这些>` = 整个工作区，去掉仓库根的本机文件（exclude 不要求匹配到文件）。 */
export const WORKSPACE_COMMIT_PATHS: readonly string[] = [
  '.',
  ...LOCAL_ROOT_FILES.map((name) => `:(exclude)${name}`),
]

const TERMINAL_ACTIVITY_PREFIX = '.pipeline-terminal-activity.'

/** hook 往 change 目录追加的历史（技能调用、用户回复）。 */
/**
 * hook 与会话在 change 目录里只追加的台账。真机第六轮：交付步收尾后用户回复「继续」，续轮本身就改了
 * 后三个文件，next 又要求一次同名的「update deliverables」提交。
 */
const HOOK_APPENDED_LEDGERS: readonly string[] = [
  '.pipeline-history.jsonl',
  '.pipeline-interactions.jsonl',
  '.pipeline-skill-confirmations.jsonl',
  '.pipeline-skill-invocations.jsonl',
]

/** 交付步的首次提交标题；之后的补交另有标题（statusStepFinish.deliveryCommit）。 */
export function firstDeliveryMessage(change: string): string {
  return `feat(${change}): deliver`
}

interface GitOutcome {
  readonly code: number | null
  readonly stdout: string
}

function git(cwd: string, args: readonly string[]): Promise<GitOutcome> {
  return new Promise((resolve) => {
    execFile('git', [...args], { cwd, timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error === null) {
        resolve({ code: 0, stdout: String(stdout) })
        return
      }
      const code = (error as NodeJS.ErrnoException).code
      resolve({ code: typeof code === 'number' ? code : null, stdout: String(stdout) })
    })
  })
}

function nulList(stdout: string): readonly string[] {
  return stdout.split('\0').filter((entry) => entry !== '')
}

export async function probeGitFinish(cwd: string, change: string): Promise<GitFinishProbe | null> {
  const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree'])
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') return null
  // 判「脏」与提交用同一组 pathspec：只剩门禁标记时说干净，否则发出去的 `git commit` 会以
  // 「nothing to commit」失败。
  const statusOf = (paths: readonly string[]): Promise<GitOutcome> =>
    git(cwd, ['status', '--porcelain', '-z', '--untracked-files=normal', '--', ...paths])
  const [tracked, status, deliverables, step, ignoredTracked, subjects] = await Promise.all([
    git(cwd, ['ls-files', '-z', '--', `openspec/changes/${change}`]),
    statusOf(WORKSPACE_COMMIT_PATHS),
    statusOf([...WORKSPACE_COMMIT_PATHS, `:(exclude)openspec/changes/${change}`]),
    statusOf([...WORKSPACE_COMMIT_PATHS, ...HOOK_APPENDED_LEDGERS.map((file) => `:(exclude)openspec/changes/${change}/${file}`)]),
    git(cwd, ['ls-files', '-z', '-c', '-i', '--exclude-standard', '--', 'openspec/changes']),
    // 还没有任何提交时 git log 以 128 退出：按「还没交付过」处理。
    git(cwd, ['log', '--format=%s', '--fixed-strings', `--grep=${firstDeliveryMessage(change)}`]),
  ])
  if (tracked.code !== 0 || status.code !== 0 || deliverables.code !== 0 || step.code !== 0) return null
  const housekeeping: string[] = []
  for (const path of FINISH_HOUSEKEEPING_PATHS) {
    if (!existsSync(join(cwd, path))) continue
    // check-ignore：0 = 被忽略，1 = 没被忽略；其余（128）按判定不了处理，不列。
    if ((await git(cwd, ['check-ignore', '-q', '--', path])).code === 1) housekeeping.push(path)
  }
  const untrack = ignoredTracked.code === 0
    ? nulList(ignoredTracked.stdout).filter((path) => basename(path).startsWith(TERMINAL_ACTIVITY_PREFIX))
    : []
  return {
    changeDirTracked: tracked.stdout !== '',
    workspaceDirty: status.stdout !== '',
    deliverablesDirty: deliverables.stdout !== '',
    stepDirty: step.stdout !== '',
    delivered: subjects.code === 0 && subjects.stdout.split('\n').includes(firstDeliveryMessage(change)),
    housekeeping,
    untrack,
  }
}
