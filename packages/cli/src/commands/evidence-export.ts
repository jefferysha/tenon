/**
 * `tenon evidence export <change> --format agent-trace|otel|git-notes|trailer`
 * 把任务的证据导出成别的工具读得懂的形状。四种格式都是已提交内容的纯函数（kernel `evidence-export/`）；
 * 默认只打印；`--apply` 才写仓库（git-notes 写 note、trailer amend HEAD），且只对这两种格式有意义。
 * exit：0 成功；1 用法 / 环境错误；2 记录链断了或为空（不为坏链背书）。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  EVIDENCE_NOTES_REF, buildAgentTrace, buildOtelTrace, decodeEvidenceNote, evidenceNoteEntry, isContributorType, isTenonUser,
  mergeEvidenceNote, serializeEvidenceNote, stateStorageExistsSync, trailerArguments, trailerLines, type ContributorType, type EvidenceBundle,
} from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'
import { msg } from '../i18n/messages.js'
import { isValidChangeName, resolveChangeDir } from '../paths.js'
import { amendHeadWithTrailers, hasGitIdentity, hasStagedChanges, readCommitNote, resolveCommit, writeCommitNote } from './evidence-git.js'
import { gatherEvidence } from './evidence-gather.js'

export const EVIDENCE_FORMATS = ['agent-trace', 'otel', 'git-notes', 'trailer'] as const
export type EvidenceFormat = (typeof EVIDENCE_FORMATS)[number]

export interface EvidenceExportOpts {
  readonly format?: string
  readonly out?: string
  readonly commit?: string
  readonly user?: string
  readonly apply?: boolean
  readonly anchor?: boolean
  readonly contributor?: string
  readonly model?: string
}

function isEvidenceFormat(value: string): value is EvidenceFormat {
  return (EVIDENCE_FORMATS as readonly string[]).includes(value)
}

function usageProblem(opts: EvidenceExportOpts): string | undefined {
  if (opts.format === undefined || !isEvidenceFormat(opts.format)) {
    return `--format 必填，取 ${EVIDENCE_FORMATS.join(' | ')}（收到 '${opts.format ?? ''}'）`
  }
  if (opts.apply === true && opts.format !== 'git-notes' && opts.format !== 'trailer') {
    return `--apply 只对 git-notes（写 note）和 trailer（amend HEAD）有意义，${opts.format} 只能打印或 --out`
  }
  if (opts.anchor === true && opts.format !== 'git-notes') return '--anchor 只用于 --format git-notes'
  if ((opts.contributor !== undefined || opts.model !== undefined) && opts.format !== 'agent-trace') {
    return '--contributor / --model 只用于 --format agent-trace'
  }
  if (opts.contributor !== undefined && !isContributorType(opts.contributor)) {
    return `--contributor 只支持 human | ai | mixed | unknown（收到 '${opts.contributor}'）`
  }
  return undefined
}

/** 缺 git 身份时 notes / amend 会失败：用 Tenon 声明的用户身份兜底；两者都没有就明说。 */
async function committerEnv(deps: CliDeps): Promise<{ env?: NodeJS.ProcessEnv } | string> {
  if (await hasGitIdentity(deps.cwd)) return {}
  const user = deps.user()
  if (!isTenonUser(user)) return 'git 没有 committer 身份，Tenon 也没有用户身份；先 git config user.email / user.name，或 tenon user set'
  return { env: { GIT_COMMITTER_NAME: user.name, GIT_COMMITTER_EMAIL: user.id, GIT_AUTHOR_NAME: user.name, GIT_AUTHOR_EMAIL: user.id } }
}

async function emit(deps: CliDeps, out: string | undefined, text: string): Promise<boolean> {
  if (out === undefined) {
    deps.io.out(text.replace(/\n$/u, ''))
    return true
  }
  try {
    const target = resolve(deps.cwd, out)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, text, 'utf8')
    return true
  } catch (error) {
    deps.io.err(`ERROR: 写输出文件失败：${errMsg(error)}`)
    return false
  }
}

async function exportNote(deps: CliDeps, input: {
  readonly commit: string
  readonly entry: ReturnType<typeof evidenceNoteEntry>
  readonly opts: EvidenceExportOpts
}): Promise<number> {
  const existingText = await readCommitNote(deps.cwd, input.commit)
  const existing = existingText === undefined ? undefined : decodeEvidenceNote(existingText)
  if (existingText !== undefined && existing === undefined) {
    deps.io.err(`ERROR: 提交 ${input.commit.slice(0, 12)} 上已有 ${EVIDENCE_NOTES_REF} 的 note，但不是 Tenon 证据 note，不覆盖`)
    return 1
  }
  const body = serializeEvidenceNote(mergeEvidenceNote(existing, input.entry))
  if (input.opts.apply !== true) {
    if (!await emit(deps, input.opts.out, body)) return 1
    deps.io.err(`[EVIDENCE] 未写入。加 --apply 写入 ${EVIDENCE_NOTES_REF}（提交 ${input.commit.slice(0, 12)}）${input.entry.anchor === undefined ? '' : '，note 带链头锚点'}`)
    return 0
  }
  const who = await committerEnv(deps)
  if (typeof who === 'string') {
    deps.io.err(`ERROR: ${who}`)
    return 1
  }
  const written = await writeCommitNote(deps.cwd, input.commit, body, who.env)
  if (written.code !== 0) {
    deps.io.err(`ERROR: git notes 写入失败：${written.stderr.trim()}`)
    return 1
  }
  deps.io.out(`[EVIDENCE] 已写入 ${EVIDENCE_NOTES_REF}：提交 ${input.commit.slice(0, 12)}，任务 ${input.entry.change}，链头 ${input.entry.chain.head}${input.entry.anchor === undefined ? '' : '（已锚定）'}`)
  deps.io.out(`[EVIDENCE] 让 CI 看到它：git push origin ${EVIDENCE_NOTES_REF}`)
  return 0
}

async function exportTrailer(deps: CliDeps, bundle: EvidenceBundle, commit: string, head: string | undefined, opts: EvidenceExportOpts): Promise<number> {
  const text = `${trailerLines(bundle).join('\n')}\n`
  if (opts.apply !== true) {
    if (!await emit(deps, opts.out, text)) return 1
    deps.io.err('[EVIDENCE] 未修改提交。加 --apply 把它们 amend 进 HEAD（会换 HEAD 的 sha；已写在旧 sha 上的 note 要在 amend 之后再写）')
    return 0
  }
  if (head !== commit) {
    deps.io.err('ERROR: --apply 只改 HEAD 提交；--commit 不是 HEAD')
    return 1
  }
  if (await hasStagedChanges(deps.cwd)) {
    deps.io.err('ERROR: 有已暂存的改动，amend 会把它们并进 HEAD；先提交或取消暂存')
    return 1
  }
  const who = await committerEnv(deps)
  if (typeof who === 'string') {
    deps.io.err(`ERROR: ${who}`)
    return 1
  }
  const amended = await amendHeadWithTrailers(deps.cwd, trailerArguments(bundle), who.env)
  if (!amended.ok) {
    deps.io.err(`ERROR: ${amended.message}`)
    return 1
  }
  deps.io.out(`[EVIDENCE] 已把尾注 amend 进 HEAD：${commit.slice(0, 12)} → ${amended.commit.slice(0, 12)}`)
  return 0
}

export async function cmdEvidenceExport(deps: CliDeps, change: string, opts: EvidenceExportOpts): Promise<number> {
  const problem = usageProblem(opts)
  if (problem !== undefined) {
    deps.io.err(`ERROR: ${problem}`)
    return 1
  }
  const format = opts.format as EvidenceFormat
  if (!isValidChangeName(change)) {
    deps.io.err(`ERROR: ${msg(deps, 'change.nameInvalid', { name: change })}`)
    return 1
  }
  const dir = resolveChangeDir(deps.cwd, change)
  if (!stateStorageExistsSync(dir)) {
    deps.io.err(`ERROR: ${msg(deps, 'change.notFound', { name: change })}`)
    return 1
  }
  const commit = await resolveCommit(deps.cwd, opts.commit ?? 'HEAD')
  if (commit === undefined) {
    deps.io.err(`ERROR: 解析不出提交 '${opts.commit ?? 'HEAD'}'（不是 git 仓库，或还没有提交）`)
    return 1
  }
  const gathered = await gatherEvidence(deps, { change, dir, commit, user: opts.user, withFiles: format === 'agent-trace' })
  if (!gathered.ok) {
    deps.io.err(`ERROR: ${gathered.message}`)
    return gathered.code
  }
  const { bundle } = gathered
  if (format === 'agent-trace') {
    const contributor: ContributorType = opts.contributor === undefined || !isContributorType(opts.contributor) ? 'unknown' : opts.contributor
    const record = buildAgentTrace(bundle, { contributor, ...(opts.model === undefined ? {} : { model: opts.model }) })
    return (await emit(deps, opts.out, `${JSON.stringify(record, null, 2)}\n`)) ? 0 : 1
  }
  if (format === 'otel') return (await emit(deps, opts.out, `${JSON.stringify(buildOtelTrace(bundle), null, 2)}\n`)) ? 0 : 1
  if (format === 'git-notes') {
    return exportNote(deps, { commit, entry: evidenceNoteEntry(bundle, { anchor: opts.anchor === true }), opts })
  }
  const head = await resolveCommit(deps.cwd, 'HEAD')
  return exportTrailer(deps, bundle, commit, head, opts)
}
