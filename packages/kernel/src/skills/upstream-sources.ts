import { parseFlowBody, stripFlowComment } from './flow-yaml.js'

/**
 * 上游技能的三份机器数据：来源清单 `skills/sources.yaml`、锁文件 `skills/skills.lock.json`
 * 与最近一次获取报告 `<stateRoot>/skills/last-update.json`，以及 doctor 与 Dashboard 共用的视图。
 * 这里只处理文本；git、文件系统与网络都在 CLI / server。
 */

export type UpstreamSkillLicense = 'MIT' | 'Apache-2.0'
export const UPSTREAM_SKILL_LICENSES: readonly UpstreamSkillLicense[] = ['MIT', 'Apache-2.0']

export interface UpstreamSkillSource {
  readonly id: string
  readonly repo: string
  readonly path: string
  readonly ref: 'default-branch'
  readonly licenseExpected: UpstreamSkillLicense
}
export interface UpstreamSkillSources { readonly version: 1; readonly skills: readonly UpstreamSkillSource[] }

export type UpstreamSkillErrorCategory = 'invalid-skill-sources' | 'invalid-skill-lock'
export class UpstreamSkillError extends Error {
  override readonly name = 'UpstreamSkillError'
  constructor(readonly category: UpstreamSkillErrorCategory, message: string) {
    super(message)
    this.name = 'UpstreamSkillError'
  }
}

export interface UpstreamSkillLockEntry {
  readonly id: string
  readonly repo: string
  readonly path: string
  readonly commit: string
  readonly treeSha256: `sha256:${string}`
  readonly license: UpstreamSkillLicense
  readonly fetchedAt: string
  readonly previousCommit: string | null
}
export interface UpstreamSkillLock {
  readonly version: 1
  readonly updatedAt: string
  readonly skills: readonly UpstreamSkillLockEntry[]
}

export type UpstreamSkillFailureReason =
  | 'unreachable' | 'removed' | 'renamed' | 'invalid-content' | 'too-large' | 'license-missing' | 'license-mismatch'
export interface UpstreamSkillRunResult {
  readonly id: string
  readonly outcome: 'updated' | 'unchanged' | 'kept' | 'missing'
  readonly reason?: UpstreamSkillFailureReason
  readonly detail?: string
}
export interface UpstreamSkillRunReport {
  readonly version: 1
  readonly at: string
  readonly host: 'codex' | 'claude' | 'dev'
  readonly results: readonly UpstreamSkillRunResult[]
}

export type UpstreamSkillRowStatus = 'changed' | 'unchanged' | 'failed' | 'bundled'
export interface UpstreamSkillViewRow {
  readonly id: string
  readonly origin: 'tenon' | 'upstream'
  readonly status: UpstreamSkillRowStatus
  readonly repo?: string
  readonly path?: string
  readonly commit?: string
  readonly previousCommit?: string | null
  readonly license?: UpstreamSkillLicense
  readonly fetchedAt?: string
  readonly reason?: UpstreamSkillFailureReason
  readonly detail?: string
  readonly sourceUrl?: string
  readonly commitUrl?: string
  readonly compareUrl?: string
}
export interface UpstreamSkillView {
  readonly updatedAt: string | null
  readonly lastRunAt: string | null
  readonly rows: readonly UpstreamSkillViewRow[]
}

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/
const PATH_SEGMENT = /^[A-Za-z0-9._-]+$/
const COMMIT = /^[0-9a-f]{40}$/
const TREE_SHA256 = /^sha256:[0-9a-f]{64}$/
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/
const SOURCE_FIELDS: ReadonlySet<string> = new Set(['repo', 'path', 'ref', 'license_expected'])
const LOCK_KEYS = ['version', 'updated_at', 'skills'] as const
const LOCK_ENTRY_KEYS = ['id', 'repo', 'path', 'commit', 'tree_sha256', 'license', 'fetched_at', 'previous_commit'] as const
const REPORT_KEYS = ['version', 'at', 'host', 'results'] as const
const RESULT_KEYS: ReadonlySet<string> = new Set(['id', 'outcome', 'reason', 'detail'])
const FAILURE_REASONS: ReadonlySet<string> = new Set<UpstreamSkillFailureReason>([
  'unreachable', 'removed', 'renamed', 'invalid-content', 'too-large', 'license-missing', 'license-mismatch',
])

function isLicense(value: unknown): value is UpstreamSkillLicense {
  return value === 'MIT' || value === 'Apache-2.0'
}

function isRepo(value: unknown): value is string {
  if (typeof value !== 'string' || !REPO.test(value) || value.endsWith('.git')) return false
  const name = value.slice(value.indexOf('/') + 1)
  return name !== '.' && name !== '..'
}

function isSkillPath(value: unknown): value is string {
  if (value === '.') return true
  return typeof value === 'string'
    && value.split('/').every((segment) => segment !== '.' && segment !== '..' && PATH_SEGMENT.test(segment))
}

function isIsoUtc(value: unknown): value is string {
  return typeof value === 'string' && ISO_UTC.test(value) && !Number.isNaN(Date.parse(value))
}

function isTreeSha256(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && TREE_SHA256.test(value)
}

function isOutcome(value: unknown): value is UpstreamSkillRunResult['outcome'] {
  return value === 'updated' || value === 'unchanged' || value === 'kept' || value === 'missing'
}

function isHost(value: unknown): value is UpstreamSkillRunReport['host'] {
  return value === 'codex' || value === 'claude' || value === 'dev'
}

function isFailureReason(value: unknown): value is UpstreamSkillFailureReason {
  return typeof value === 'string' && FAILURE_REASONS.has(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function parseJson(text: string, fail: (message: string) => UpstreamSkillError): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw fail(`JSON 无效：${error instanceof Error ? error.message : String(error)}`)
  }
}

function byId(left: { readonly id: string }, right: { readonly id: string }): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

function sourcesError(message: string): UpstreamSkillError {
  return new UpstreamSkillError('invalid-skill-sources', `skills/sources.yaml: ${message}`)
}

function parseSourceLine(line: string, lineNo: number): UpstreamSkillSource {
  const match = /^\s+([^\s:{}]+):\s*\{(.*)\}\s*$/.exec(line)
  if (match === null) throw sourcesError(`第 ${lineNo} 行不是 'id: { ... }' 形态`)
  const id = match[1] ?? ''
  if (!ID.test(id)) throw sourcesError(`第 ${lineNo} 行技能 id '${id}' 不合法`)
  const fields = parseFlowBody(match[2] ?? '', (message) => sourcesError(`技能 '${id}' ${message}`))
  for (const key of fields.keys()) {
    if (!SOURCE_FIELDS.has(key)) throw sourcesError(`技能 '${id}' 含未知字段 '${key}'`)
  }
  const repo = fields.get('repo')
  if (!isRepo(repo)) throw sourcesError(`技能 '${id}' repo '${repo ?? ''}' 不是 owner/name`)
  const path = fields.get('path')
  if (!isSkillPath(path)) throw sourcesError(`技能 '${id}' path '${path ?? ''}' 不是仓库内相对路径`)
  const ref = fields.get('ref')
  if (ref !== 'default-branch') throw sourcesError(`技能 '${id}' ref '${ref ?? ''}' 只能是 default-branch`)
  const license = fields.get('license_expected')
  if (!isLicense(license)) throw sourcesError(`技能 '${id}' license_expected '${license ?? ''}' 只能是 MIT 或 Apache-2.0`)
  return { id, repo, path, ref, licenseExpected: license }
}

/** 严格解析来源清单；任何偏离都抛 `invalid-skill-sources`。与 bundled token 的撞名由调用方检查。 */
export function parseUpstreamSkillSources(text: string): UpstreamSkillSources {
  let version: string | undefined
  let seenSkills = false
  let inSkills = false
  const skills: UpstreamSkillSource[] = []
  const seen = new Set<string>()
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const lineNo = i + 1
    const line = stripFlowComment(lines[i] ?? '')
    if (line.trim() === '') continue
    if (!/^\s/.test(line)) {
      inSkills = false
      const versionMatch = /^version:\s*(.*?)\s*$/.exec(line)
      if (versionMatch !== null) {
        if (version !== undefined) throw sourcesError(`第 ${lineNo} 行重复声明 version`)
        version = versionMatch[1] ?? ''
        continue
      }
      if (/^skills:\s*$/.test(line)) {
        if (seenSkills) throw sourcesError(`第 ${lineNo} 行重复声明 skills`)
        seenSkills = true
        inSkills = true
        continue
      }
      throw sourcesError(`第 ${lineNo} 行含未知顶层字段`)
    }
    if (!inSkills) throw sourcesError(`第 ${lineNo} 行位于 skills 块外`)
    const source = parseSourceLine(line, lineNo)
    if (seen.has(source.id)) throw sourcesError(`技能 '${source.id}' 重复声明`)
    seen.add(source.id)
    skills.push(source)
  }
  if (version !== '1') throw sourcesError(`version '${version ?? ''}' 不受支持（需要 1）`)
  if (!seenSkills) throw sourcesError('缺少 skills: 块')
  return { version: 1, skills }
}

function lockError(message: string): UpstreamSkillError {
  return new UpstreamSkillError('invalid-skill-lock', `skills/skills.lock.json: ${message}`)
}

function parseLockEntry(raw: unknown, index: number): UpstreamSkillLockEntry {
  const at = `skills[${index}]`
  if (!isRecord(raw) || !hasExactKeys(raw, LOCK_ENTRY_KEYS)) throw lockError(`${at} 字段须为 ${LOCK_ENTRY_KEYS.join(' / ')}`)
  const { id, repo, path, commit, license } = raw
  if (typeof id !== 'string' || !ID.test(id)) throw lockError(`${at}.id 不合法`)
  if (!isRepo(repo)) throw lockError(`${id} repo 不合法`)
  if (!isSkillPath(path)) throw lockError(`${id} path 不合法`)
  if (typeof commit !== 'string' || !COMMIT.test(commit)) throw lockError(`${id} commit 不是 40 位小写十六进制`)
  if (!isTreeSha256(raw.tree_sha256)) throw lockError(`${id} tree_sha256 不是 sha256:<64 hex>`)
  if (!isLicense(license)) throw lockError(`${id} license 只能是 MIT 或 Apache-2.0`)
  if (!isIsoUtc(raw.fetched_at)) throw lockError(`${id} fetched_at 不是 ISO-8601 UTC 时间`)
  const previous = raw.previous_commit
  const previousCommit = previous === null ? null : typeof previous === 'string' && COMMIT.test(previous) ? previous : undefined
  if (previousCommit === undefined) throw lockError(`${id} previous_commit 须为 null 或 40 位十六进制`)
  return { id, repo, path, commit, treeSha256: raw.tree_sha256, license, fetchedAt: raw.fetched_at, previousCommit }
}

/** 严格解析锁文件；给出 `sources` 时每个条目都必须对应一个来源且 repo/path 相同。 */
export function parseUpstreamSkillLock(text: string, sources?: UpstreamSkillSources): UpstreamSkillLock {
  const value = parseJson(text, lockError)
  if (!isRecord(value) || !hasExactKeys(value, LOCK_KEYS)) throw lockError(`顶层字段须为 ${LOCK_KEYS.join(' / ')}`)
  if (value.version !== 1) throw lockError(`version '${String(value.version)}' 不受支持（需要 1）`)
  if (!isIsoUtc(value.updated_at)) throw lockError('updated_at 不是 ISO-8601 UTC 时间')
  if (!Array.isArray(value.skills)) throw lockError('skills 不是数组')
  const byIdSource = sources === undefined ? undefined : new Map(sources.skills.map((source) => [source.id, source]))
  const seen = new Set<string>()
  const skills = value.skills.map((raw: unknown, index: number) => {
    const entry = parseLockEntry(raw, index)
    if (seen.has(entry.id)) throw lockError(`技能 '${entry.id}' 重复`)
    seen.add(entry.id)
    if (byIdSource !== undefined) {
      const source = byIdSource.get(entry.id)
      if (source === undefined) throw lockError(`技能 '${entry.id}' 不在 sources.yaml 中`)
      if (source.repo !== entry.repo || source.path !== entry.path) {
        throw lockError(`技能 '${entry.id}' 的 repo/path 与 sources.yaml 不一致`)
      }
    }
    return entry
  })
  return { version: 1, updatedAt: value.updated_at, skills }
}

/** 条目按 id 排序、键序固定，内容不变时字节不变。 */
export function serializeUpstreamSkillLock(lock: UpstreamSkillLock): string {
  const skills = [...lock.skills].sort(byId).map((entry) => ({
    id: entry.id,
    repo: entry.repo,
    path: entry.path,
    commit: entry.commit,
    tree_sha256: entry.treeSha256,
    license: entry.license,
    fetched_at: entry.fetchedAt,
    previous_commit: entry.previousCommit,
  }))
  return `${JSON.stringify({ version: 1, updated_at: lock.updatedAt, skills }, null, 2)}\n`
}

function reportError(message: string): UpstreamSkillError {
  return new UpstreamSkillError('invalid-skill-lock', `skills/last-update.json: ${message}`)
}

function parseRunResult(raw: unknown, index: number): UpstreamSkillRunResult {
  const at = `results[${index}]`
  if (!isRecord(raw) || Object.keys(raw).some((key) => !RESULT_KEYS.has(key))) throw reportError(`${at} 含未知字段`)
  const { id, outcome, reason, detail } = raw
  if (typeof id !== 'string' || !ID.test(id)) throw reportError(`${at}.id 不合法`)
  if (!isOutcome(outcome)) throw reportError(`${id} outcome 不合法`)
  const failed = outcome === 'kept' || outcome === 'missing'
  if (failed !== isFailureReason(reason) || (!failed && reason !== undefined)) throw reportError(`${id} reason 与 outcome 不符`)
  if (detail !== undefined && (typeof detail !== 'string' || !failed)) throw reportError(`${id} detail 不合法`)
  return {
    id,
    outcome,
    ...(isFailureReason(reason) ? { reason } : {}),
    ...(typeof detail === 'string' ? { detail } : {}),
  }
}

export function parseUpstreamSkillRunReport(text: string): UpstreamSkillRunReport {
  const value = parseJson(text, reportError)
  if (!isRecord(value) || !hasExactKeys(value, REPORT_KEYS)) throw reportError(`顶层字段须为 ${REPORT_KEYS.join(' / ')}`)
  if (value.version !== 1) throw reportError(`version '${String(value.version)}' 不受支持（需要 1）`)
  if (!isIsoUtc(value.at)) throw reportError('at 不是 ISO-8601 UTC 时间')
  if (!isHost(value.host)) throw reportError('host 不合法')
  if (!Array.isArray(value.results)) throw reportError('results 不是数组')
  const seen = new Set<string>()
  const results = value.results.map((raw: unknown, index: number) => {
    const result = parseRunResult(raw, index)
    if (seen.has(result.id)) throw reportError(`技能 '${result.id}' 重复`)
    seen.add(result.id)
    return result
  })
  return { version: 1, at: value.at, host: value.host, results }
}

export function serializeUpstreamSkillRunReport(report: UpstreamSkillRunReport): string {
  const results = report.results.map((result) => ({
    id: result.id,
    outcome: result.outcome,
    ...(result.reason === undefined ? {} : { reason: result.reason }),
    ...(result.detail === undefined ? {} : { detail: result.detail }),
  }))
  return `${JSON.stringify({ version: 1, at: report.at, host: report.host, results }, null, 2)}\n`
}

function treeUrl(repo: string, commit: string, path: string): string {
  return path === '.' ? `https://github.com/${repo}/tree/${commit}` : `https://github.com/${repo}/tree/${commit}/${path}`
}

/**
 * bundled 行在前，来源行按 sources.yaml 顺序。锁里没有的来源，或最近一次运行不早于锁更新
 * 且该来源 kept/missing 的，记为 failed；其余按 `fetchedAt === updatedAt` 区分 changed / unchanged。
 */
export function buildUpstreamSkillView(input: {
  readonly bundledIds: readonly string[]
  readonly sources: UpstreamSkillSources | null
  readonly lock: UpstreamSkillLock | null
  readonly lastRun: UpstreamSkillRunReport | null
}): UpstreamSkillView {
  const { lock, lastRun } = input
  const locked = new Map((lock?.skills ?? []).map((entry) => [entry.id, entry]))
  const failures = new Map((lastRun?.results ?? [])
    .filter((result) => result.outcome === 'kept' || result.outcome === 'missing')
    .map((result) => [result.id, result]))
  const lastRunCurrent = lastRun !== null && (lock === null || Date.parse(lastRun.at) >= Date.parse(lock.updatedAt))
  const rows: UpstreamSkillViewRow[] = input.bundledIds.map((id) => ({ id, origin: 'tenon', status: 'bundled' }))
  for (const source of input.sources?.skills ?? []) {
    const entry = locked.get(source.id)
    const failure = entry === undefined || lastRunCurrent ? failures.get(source.id) : undefined
    const failureFields = {
      ...(failure?.reason === undefined ? {} : { reason: failure.reason }),
      ...(failure?.detail === undefined ? {} : { detail: failure.detail }),
    }
    if (entry === undefined) {
      rows.push({ id: source.id, origin: 'upstream', status: 'failed', repo: source.repo, path: source.path, ...failureFields })
      continue
    }
    const status: UpstreamSkillRowStatus = failure !== undefined
      ? 'failed'
      : entry.fetchedAt === lock?.updatedAt ? 'changed' : 'unchanged'
    rows.push({
      id: source.id,
      origin: 'upstream',
      status,
      repo: source.repo,
      path: source.path,
      commit: entry.commit,
      previousCommit: entry.previousCommit,
      license: entry.license,
      fetchedAt: entry.fetchedAt,
      ...failureFields,
      sourceUrl: treeUrl(source.repo, entry.commit, source.path),
      commitUrl: `https://github.com/${source.repo}/commit/${entry.commit}`,
      ...(entry.previousCommit === null
        ? {}
        : { compareUrl: `https://github.com/${source.repo}/compare/${entry.previousCommit}...${entry.commit}` }),
    })
  }
  return { updatedAt: lock?.updatedAt ?? null, lastRunAt: lastRun?.at ?? null, rows }
}
