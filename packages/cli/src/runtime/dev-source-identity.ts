import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { PAYLOAD_ENTRIES } from './release-store-codecs.js'
import type { RuntimeDevSource } from './types.js'

/**
 * 托管 release 真正发布的路径集合。安装时的摘要与 hooks/source-drift.sh 必须枚举同一份，
 * 否则 SessionStart 会把没装进去的文件当成漂移；两边由 source-drift-hook.test.ts 交叉验证。
 */
export const DEV_PAYLOAD_PATHSPECS: readonly string[] = PAYLOAD_ENTRIES

const GIT_OID = /^[0-9a-f]{40}$/
const CONTROL = /[\u0000-\u001f\u007f]/u

export type GitRun = (repo: string, args: readonly string[]) => string

/** 在 repo 里跑 git，非零退出会抛（调用方决定怎么降级）。 */
export const realGitRun: GitRun = (repo, args) => execFileSync('git', ['-C', repo, ...args], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  maxBuffer: 64 * 1024 * 1024,
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function byteOrder(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

/** `git hash-object` 对同样字节打印的值：SHA-1("blob <长度>\0" + 字节)。 */
export function gitBlobId(bytes: Uint8Array): string {
  const hash = createHash('sha1')
  hash.update(`blob ${bytes.byteLength}\0`, 'utf8')
  hash.update(bytes)
  return hash.digest('hex')
}

export type SourceRepoVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

function readJson(repo: string, rel: string): unknown {
  try {
    return JSON.parse(readFileSync(join(repo, rel), 'utf8'))
  } catch {
    return null
  }
}

/** 四项判据：缺任何一项都不是 Tenon 源码仓库。 */
export function checkTenonSourceRepo(repo: string): SourceRepoVerdict {
  const pkg = readJson(repo, 'package.json')
  if (!isRecord(pkg) || pkg.name !== 'tenon') {
    return { ok: false, reason: '根 package.json 的 name 不是 tenon' }
  }
  const marketplace = readJson(repo, '.claude-plugin/marketplace.json')
  const first = isRecord(marketplace) && Array.isArray(marketplace.plugins) ? marketplace.plugins[0] : undefined
  if (!isRecord(marketplace) || marketplace.name !== 'tenon' || !isRecord(first) || first.source !== './') {
    return { ok: false, reason: '.claude-plugin/marketplace.json 不是 name=tenon 且 plugins[0].source="./"' }
  }
  if (!existsSync(join(repo, 'skills', 'sources.yaml'))) return { ok: false, reason: '缺少 skills/sources.yaml' }
  if (!existsSync(join(repo, 'runtime', 'tenon-bootstrap.mjs'))) {
    return { ok: false, reason: '缺少 runtime/tenon-bootstrap.mjs' }
  }
  return { ok: true }
}

export type SourceRepoResolution =
  | { readonly ok: true; readonly repo: string }
  | { readonly ok: false; readonly reason: string }

/** 把用户传入的路径解析成仓库根的 realpath，并确认它是 Tenon 源码仓库的 git 工作区根。 */
export function resolveSourceRepo(input: string, git: GitRun = realGitRun): SourceRepoResolution {
  if (input.trim() === '') return { ok: false, reason: '--from-source 需要一个 Tenon 源码仓库路径' }
  let repo: string
  try {
    repo = realpathSync(input)
  } catch {
    return { ok: false, reason: `源码仓库路径不存在或不可读：${input}` }
  }
  if (CONTROL.test(repo)) return { ok: false, reason: '源码仓库路径含控制字符，无法写入 install-channel 标记' }
  const verdict = checkTenonSourceRepo(repo)
  if (!verdict.ok) return { ok: false, reason: `${repo} 不是 Tenon 源码仓库：${verdict.reason}` }
  let top: string
  try {
    top = realpathSync(git(repo, ['rev-parse', '--show-toplevel']).trim())
  } catch {
    return { ok: false, reason: `${repo} 不是 git 工作区（需要 git 记录 commit 与工作区摘要）` }
  }
  if (top !== repo) return { ok: false, reason: `请传仓库根目录 ${top}（收到的是它的子目录 ${repo}）` }
  return { ok: true, repo }
}

/**
 * 安装内容的工作区摘要。口径（hooks/source-drift.sh 逐字一致）：
 * `git ls-files -z --cached --others --exclude-standard -- <PAYLOAD_ENTRIES>` 去重、只留普通文件、按字节序排序，
 * 每行 `<blob40> <path>\n`（blob 取工作区原始字节），整体再取 git blob id。
 * 被忽略的上游技能因 --exclude-standard 自然排除；它们由 skillsIndexDigest 覆盖。
 */
export function computeWorktreeDigest(repo: string, git: GitRun = realGitRun): string {
  const listed = git(repo, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...DEV_PAYLOAD_PATHSPECS])
  const files = [...new Set(listed.split('\0').filter((path) => path !== ''))]
    .filter((path) => isRegularFile(join(repo, path)))
    .sort(byteOrder)
  if (files.length === 0) throw new Error('仓库里没有任何安装内容文件（PAYLOAD_ENTRIES 全空）')
  for (const path of files) {
    if (path.includes('\n')) throw new Error(`路径含换行，无法稳定摘要：${JSON.stringify(path)}`)
  }
  const manifest = files.map((path) => `${gitBlobId(readFileSync(join(repo, path)))} ${path}\n`).join('')
  return gitBlobId(Buffer.from(manifest, 'utf8'))
}

/** 本机拉取索引（skills/skills.lock.json，被 git 忽略）的原始字节摘要；没有索引记为 absent。 */
export function computeSkillsIndexDigest(repo: string): string {
  const file = join(repo, 'skills', 'skills.lock.json')
  return isRegularFile(file) ? gitBlobId(readFileSync(file)) : 'absent'
}

export function computeDevSourceIdentity(repoInput: string, git: GitRun = realGitRun): RuntimeDevSource {
  const repoRealpath = realpathSync(repoInput)
  const verdict = checkTenonSourceRepo(repoRealpath)
  if (!verdict.ok) throw new Error(`${repoRealpath} 不是 Tenon 源码仓库：${verdict.reason}`)
  let commit: string
  try {
    commit = git(repoRealpath, ['rev-parse', 'HEAD']).trim()
  } catch {
    throw new Error(`${repoRealpath} 还没有任何提交；先提交一次再做开发安装`)
  }
  if (!GIT_OID.test(commit)) throw new Error(`${repoRealpath} 的 HEAD 不是合法的 commit：${commit}`)
  const status = git(repoRealpath, ['status', '--porcelain', '--', ...DEV_PAYLOAD_PATHSPECS])
  return {
    kind: 'dev',
    repoRealpath,
    commit,
    dirty: status.trim() !== '',
    worktreeDigest: computeWorktreeDigest(repoRealpath, git),
    skillsIndexDigest: computeSkillsIndexDigest(repoRealpath),
  }
}

export function devSourceEquals(left: RuntimeDevSource, right: RuntimeDevSource): boolean {
  return left.repoRealpath === right.repoRealpath
    && left.commit === right.commit
    && left.dirty === right.dirty
    && left.worktreeDigest === right.worktreeDigest
    && left.skillsIndexDigest === right.skillsIndexDigest
}

/** 漂移原因；commit 与 dirty 只是展示，不在其中。空数组表示已装内容与工作区一致。 */
export function compareDevSource(installed: RuntimeDevSource, live: RuntimeDevSource): readonly string[] {
  const reasons: string[] = []
  if (installed.repoRealpath !== live.repoRealpath) {
    reasons.push(`仓库不同（已装 ${installed.repoRealpath}，当前 ${live.repoRealpath}）`)
  }
  if (installed.worktreeDigest !== live.worktreeDigest) {
    reasons.push(`安装内容已变（已装 ${installed.worktreeDigest.slice(0, 7)}，工作区 ${live.worktreeDigest.slice(0, 7)}）`)
  }
  if (installed.skillsIndexDigest !== live.skillsIndexDigest) {
    reasons.push(`技能索引已变（已装 ${installed.skillsIndexDigest.slice(0, 7)}，当前 ${live.skillsIndexDigest.slice(0, 7)}）`)
  }
  return reasons
}

export function devVersionLabel(version: string, commit: string): string {
  return `${version}+dev.${commit.slice(0, 7)}`
}
