/**
 * `tenon evidence export --apply` 对仓库的两种写入：往 `refs/notes/tenon` 写 note、给 HEAD 提交追加尾注（amend）。
 * 只有显式 `--apply` 才会走到这里；任何一步失败都原样报告 git 的错误，不留半成品。
 */
import { spawn } from 'node:child_process'
import { EVIDENCE_NOTES_REF } from '@tenon/kernel'
import { git } from './verify-ci-git.js'

export interface GitResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** 带 stdin 的 git 调用（notes 正文、提交消息走 stdin，避免临时文件和 shell 转义）。 */
export function gitWithInput(cwd: string, args: readonly string[], input: string, env?: NodeJS.ProcessEnv): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn('git', [...args], { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', (error) => resolve({ code: 127, stdout, stderr: `${stderr}${error.message}` }))
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
    child.stdin.on('error', () => undefined)
    child.stdin.end(input)
  })
}

export async function resolveCommit(cwd: string, rev: string): Promise<string | undefined> {
  if (rev === '' || rev.startsWith('-')) return undefined
  const out = (await git(cwd, ['rev-parse', '--verify', '-q', `${rev}^{commit}`]))?.trim()
  return out !== undefined && /^[0-9a-f]{40}$/u.test(out) ? out : undefined
}

/** 提交上现有的 note 正文；没有 note 返回 undefined。 */
export async function readCommitNote(cwd: string, commit: string): Promise<string | undefined> {
  return git(cwd, ['notes', `--ref=${EVIDENCE_NOTES_REF}`, 'show', commit])
}

export async function writeCommitNote(cwd: string, commit: string, body: string, env?: NodeJS.ProcessEnv): Promise<GitResult> {
  return gitWithInput(cwd, ['notes', `--ref=${EVIDENCE_NOTES_REF}`, 'add', '-f', '-F', '-', commit], body, env)
}

/** 缺 git 身份时（CI、新机器）notes 与 amend 都会失败；调用方在这里得到「是否已有身份」。 */
export async function hasGitIdentity(cwd: string): Promise<boolean> {
  return (await git(cwd, ['var', 'GIT_COMMITTER_IDENT'])) !== undefined
}

export async function hasStagedChanges(cwd: string): Promise<boolean> {
  const result = await gitWithInput(cwd, ['diff', '--cached', '--quiet'], '')
  return result.code === 1
}

/**
 * 给 HEAD 提交的消息追加（或替换同名）尾注并 amend。只改消息：作者与树不动；
 * `--cleanup=verbatim` 保证消息里以 `#` 开头的行不被 git 当注释吃掉。返回新的 HEAD。
 */
export async function amendHeadWithTrailers(
  cwd: string, trailerArgs: readonly string[], env?: NodeJS.ProcessEnv,
): Promise<{ readonly ok: true; readonly commit: string } | { readonly ok: false; readonly message: string }> {
  const message = await git(cwd, ['log', '-1', '--format=%B', 'HEAD'])
  if (message === undefined) return { ok: false, message: '读不出 HEAD 提交的消息' }
  const edited = await gitWithInput(cwd, ['interpret-trailers', '--if-exists', 'replace', ...trailerArgs], message.replace(/\n+$/u, '\n'))
  if (edited.code !== 0) return { ok: false, message: `git interpret-trailers 失败：${edited.stderr.trim()}` }
  const amended = await gitWithInput(cwd, ['commit', '--amend', '--allow-empty', '--cleanup=verbatim', '-F', '-'], edited.stdout, env)
  if (amended.code !== 0) return { ok: false, message: `git commit --amend 失败：${(amended.stderr || amended.stdout).trim()}` }
  const head = (await git(cwd, ['rev-parse', 'HEAD']))?.trim()
  return head === undefined ? { ok: false, message: 'amend 之后读不出新的 HEAD' } : { ok: true, commit: head }
}
