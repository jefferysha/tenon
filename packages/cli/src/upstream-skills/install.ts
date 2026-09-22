import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  parseSkillProvenanceRegistry,
  parseUpstreamSkillLock,
  parseUpstreamSkillSources,
  serializeUpstreamSkillLock,
  UpstreamSkillError,
  type UpstreamSkillFailureReason,
  type UpstreamSkillLock,
  type UpstreamSkillLockEntry,
  type UpstreamSkillRunReport,
  type UpstreamSkillRunResult,
  type UpstreamSkillSource,
} from '@tenon/kernel'
import type { SetupEnv } from '../commands/setup.js'
import { copyTree, measureTree, readSkillFrontmatter, skillModelInvocable, treeHash } from './content.js'
import { checkoutUpstreamPaths, resolveDefaultBranchHead, treeEntryModes, type UpstreamCheckout } from './fetch.js'
import { detectUpstreamLicense, hasSkillLicenseFile, type LicenseEvidence } from './license.js'

export interface UpstreamSkillLimits { readonly skillBytes: number; readonly totalBytes: number; readonly deadlineMs: number }
export interface UpstreamSkillInstallInput {
  readonly env: Pick<SetupEnv, 'runCommand'>
  /** Host plugin root, or a development checkout. */
  readonly pluginRoot: string
  /** Active managed release payload root when it is valid; the only source of previous content. */
  readonly previousRoot: string | null
  readonly host: 'codex' | 'claude' | 'dev'
  /** Clone scratch directory (`RuntimePaths.stagingRoot`). */
  readonly workRoot: string
  readonly now: () => string
  readonly log: (line: string) => void
  readonly limits?: Partial<UpstreamSkillLimits>
}
export interface UpstreamSkillInstallResult { readonly report: UpstreamSkillRunReport; readonly lockWritten: boolean }

const DEFAULT_LIMITS: UpstreamSkillLimits = { skillBytes: 64 * 1024 * 1024, totalBytes: 256 * 1024 * 1024, deadlineMs: 20 * 60_000 }
const STAGING_PREFIX = '.tenon-skills-staging-'
const ROOT_EXCLUDES: ReadonlySet<string> = new Set(['.git', '.github'])
const NESTED_EXCLUDES: ReadonlySet<string> = new Set(['.git'])

interface Failure { readonly reason: UpstreamSkillFailureReason; readonly detail?: string }

interface Run {
  readonly input: UpstreamSkillInstallInput
  readonly at: string
  readonly limits: UpstreamSkillLimits
  readonly skillsRoot: string
  readonly staging: string
  readonly previous: ReadonlyMap<string, UpstreamSkillLockEntry>
  readonly entries: Map<string, UpstreamSkillLockEntry>
  readonly results: Map<string, UpstreamSkillRunResult>
  readonly failures: Map<string, Failure>
  readonly staged: Set<string>
  totalBytes: number
}

function readOptional(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function bundledSkillIds(pluginRoot: string): ReadonlySet<string> {
  const registry = parseSkillProvenanceRegistry(readFileSync(join(pluginRoot, 'templates', 'skill-sources.yaml'), 'utf8'))
  return new Set(registry.skills.flatMap((entry) => [entry.token, entry.contentSkill ?? entry.token]))
}

function readPreviousLock(input: UpstreamSkillInstallInput): UpstreamSkillLock | null {
  if (input.previousRoot === null) return null
  const text = readOptional(join(input.previousRoot, 'skills', 'skills.lock.json'))
  if (text === null) return null
  try {
    return parseUpstreamSkillLock(text)
  } catch {
    input.log('[skills] 旧锁文件无效，全部重新获取')
    return null
  }
}

function previousFor(run: Run, source: UpstreamSkillSource): UpstreamSkillLockEntry | undefined {
  const entry = run.previous.get(source.id)
  return entry?.repo === source.repo && entry.path === source.path ? entry : undefined
}

/** Keeps a verified copy of `entry`: in place when the plugin root already matches, else staged from the previous root. */
async function keepVerified(run: Run, entry: UpstreamSkillLockEntry): Promise<boolean> {
  if (await treeHash(entry.id, join(run.skillsRoot, entry.id)) === entry.treeSha256) return true
  const previousRoot = run.input.previousRoot
  if (previousRoot === null || previousRoot === run.input.pluginRoot) return false
  const previousDir = join(previousRoot, 'skills', entry.id)
  if (await treeHash(entry.id, previousDir) !== entry.treeSha256) return false
  copyTree(previousDir, join(run.staging, entry.id))
  run.staged.add(entry.id)
  return true
}

function unchanged(run: Run, entry: UpstreamSkillLockEntry): void {
  run.entries.set(entry.id, entry)
  run.results.set(entry.id, { id: entry.id, outcome: 'unchanged' })
}

function validate(run: Run, source: UpstreamSkillSource, checkout: UpstreamCheckout): Failure | LicenseEvidence {
  const modes = treeEntryModes(run.input.env, checkout.dir, source.path)
  if (modes === null) return { reason: 'invalid-content', detail: 'git ls-tree failed' }
  const tree = source.path === '.' ? modes.filter((entry) => !entry.path.startsWith('.github/')) : modes
  if (tree.length === 0) return { reason: 'removed', detail: `${source.path} missing at ${checkout.commit.slice(0, 7)}` }
  const link = tree.find((entry) => entry.mode === '120000' || entry.mode === '160000')
  if (link !== undefined) return { reason: 'invalid-content', detail: `${link.mode === '120000' ? 'symlink' : 'submodule'} ${link.path}` }
  const skillDir = source.path === '.' ? checkout.dir : join(checkout.dir, source.path)
  const name = readSkillFrontmatter(join(skillDir, 'SKILL.md'))?.get('name')
  if (name === undefined || name === '') return { reason: 'invalid-content', detail: 'SKILL.md or its name is missing' }
  if (name !== source.id) return { reason: 'renamed', detail: `upstream name ${name}` }
  const measured = measureTree(skillDir, source.path === '.' ? ROOT_EXCLUDES : NESTED_EXCLUDES)
  if ('error' in measured) return { reason: 'invalid-content', detail: measured.error }
  if (measured.bytes > run.limits.skillBytes || run.totalBytes + measured.bytes > run.limits.totalBytes) {
    return { reason: 'too-large', detail: `${measured.bytes} bytes` }
  }
  const license = detectUpstreamLicense(checkout.dir, source.path)
  if (license === null) return { reason: 'license-missing' }
  if (license.license !== source.licenseExpected) {
    return { reason: 'license-mismatch', detail: `expected ${source.licenseExpected}, found ${license.license}` }
  }
  run.totalBytes += measured.bytes
  return license
}

async function installFromCheckout(run: Run, source: UpstreamSkillSource, checkout: UpstreamCheckout): Promise<void> {
  const verdict = validate(run, source, checkout)
  if ('reason' in verdict) {
    run.failures.set(source.id, verdict)
    return
  }
  const skillDir = source.path === '.' ? checkout.dir : join(checkout.dir, source.path)
  const staged = join(run.staging, source.id)
  copyTree(skillDir, staged, source.path === '.' ? ROOT_EXCLUDES : NESTED_EXCLUDES)
  if (verdict.source === 'repo-file' && verdict.file !== undefined && !hasSkillLicenseFile(staged)) {
    copyFileSync(verdict.file, join(staged, basename(verdict.file)))
  }
  const hash = await treeHash(source.id, staged)
  if (hash === null) {
    run.failures.set(source.id, { reason: 'invalid-content', detail: 'staged content is not hashable' })
    return
  }
  const previous = previousFor(run, source)
  if (previous?.treeSha256 === hash) {
    if (await treeHash(source.id, join(run.skillsRoot, source.id)) === hash) rmSync(staged, { recursive: true, force: true })
    else run.staged.add(source.id)
    unchanged(run, previous)
    return
  }
  run.staged.add(source.id)
  run.entries.set(source.id, {
    id: source.id, repo: source.repo, path: source.path, commit: checkout.commit, treeSha256: hash,
    license: verdict.license, fetchedAt: run.at, previousCommit: previous?.commit ?? null,
    // Recorded from the bytes that are actually being installed, which is the only moment the
    // repository ever holds them: skills/<id> is gitignored, so no later repo-only check can.
    modelInvocable: skillModelInvocable(join(staged, 'SKILL.md')),
  })
  run.results.set(source.id, { id: source.id, outcome: 'updated' })
  run.input.log(`[skills] 更新 ${source.id} ${checkout.commit.slice(0, 7)}`)
}

async function installRepository(run: Run, repo: string, sources: readonly UpstreamSkillSource[], workDir: string, started: number): Promise<void> {
  const failAll = (items: readonly UpstreamSkillSource[], detail: string): void => {
    for (const source of items) run.failures.set(source.id, { reason: 'unreachable', detail })
  }
  if (Date.now() - started >= run.limits.deadlineMs) return failAll(sources, 'deadline')
  run.input.log(`[skills] 获取 ${repo} …`)
  const head = resolveDefaultBranchHead(run.input.env, repo)
  if (!head.ok) return failAll(sources, head.detail)
  const pending: UpstreamSkillSource[] = []
  for (const source of sources) {
    const previous = previousFor(run, source)
    if (previous?.commit === head.commit && await keepVerified(run, previous)) unchanged(run, previous)
    else pending.push(source)
  }
  if (pending.length === 0) return
  const checkout = checkoutUpstreamPaths(run.input.env, repo, pending.map((source) => source.path), workDir)
  if (!checkout.ok) return failAll(pending, checkout.detail)
  for (const source of pending) await installFromCheckout(run, source, checkout.checkout)
}

async function settleFailures(run: Run, sources: readonly UpstreamSkillSource[]): Promise<void> {
  for (const source of sources) {
    const failure = run.failures.get(source.id)
    if (failure === undefined) continue
    const id = source.id
    const previous = previousFor(run, source)
    const kept = previous !== undefined && await keepVerified(run, previous)
    run.results.set(id, { id, outcome: kept ? 'kept' : 'missing', ...failure })
    if (kept) run.entries.set(id, previous)
    run.input.log(`[skills] 失败 ${id} ${failure.reason}（${kept ? `保留 ${previous.commit.slice(0, 7)}` : '未安装'}）`)
  }
}

function applyStaged(run: Run, bundled: ReadonlySet<string>, managed: ReadonlySet<string>): void {
  mkdirSync(run.skillsRoot, { recursive: true })
  for (const id of run.staged) {
    const target = join(run.skillsRoot, id)
    if (existsSync(target) || isLink(target)) renameSync(target, join(run.staging, `.old-${id}`))
    renameSync(join(run.staging, id), target)
  }
  for (const item of readdirSync(run.skillsRoot, { withFileTypes: true })) {
    if (!item.isDirectory() && !item.isSymbolicLink()) continue
    if (bundled.has(item.name) || run.entries.has(item.name)) continue
    // A development checkout may hold unregistered work in progress; only upstream-managed ids are removed there.
    if (run.input.host === 'dev' && !managed.has(item.name)) continue
    rmSync(join(run.skillsRoot, item.name), { recursive: true, force: true })
  }
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

function writeLock(run: Run, previousLock: UpstreamSkillLock | null, runId: string): boolean {
  const skills = [...run.entries.values()]
  const lockPath = join(run.skillsRoot, 'skills.lock.json')
  const existing = readOptional(lockPath)
  if (skills.length === 0 && previousLock === null && existing === null) return false
  const sameAsPrevious = previousLock !== null
    && serializeUpstreamSkillLock({ ...previousLock, skills }) === serializeUpstreamSkillLock(previousLock)
  const text = serializeUpstreamSkillLock({ version: 2, updatedAt: sameAsPrevious ? previousLock.updatedAt : run.at, skills })
  if (existing === text) return false
  const tmp = `${lockPath}.tmp-${runId}`
  writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o644 })
  renameSync(tmp, lockPath)
  return true
}

/** Fetches every `skills/sources.yaml` entry into `<pluginRoot>/skills/<id>` and writes `skills/skills.lock.json`. */
export async function installUpstreamSkills(input: UpstreamSkillInstallInput): Promise<UpstreamSkillInstallResult> {
  const at = input.now()
  const sourcesText = readOptional(join(input.pluginRoot, 'skills', 'sources.yaml'))
  if (sourcesText === null) return { report: { version: 1, at, host: input.host, results: [] }, lockWritten: false }
  const sources = parseUpstreamSkillSources(sourcesText)
  const bundled = bundledSkillIds(input.pluginRoot)
  const collision = sources.skills.find((source) => bundled.has(source.id))
  if (collision !== undefined) {
    throw new UpstreamSkillError('invalid-skill-sources', `skills/sources.yaml: 技能 '${collision.id}' 与 Tenon 自带技能同名`)
  }
  const previousLock = readPreviousLock(input)
  for (const name of readdirSync(input.pluginRoot)) {
    if (name.startsWith(STAGING_PREFIX)) rmSync(join(input.pluginRoot, name), { recursive: true, force: true })
  }
  const runId = randomUUID()
  const staging = join(input.pluginRoot, `${STAGING_PREFIX}${runId}`)
  const clones = join(input.workRoot, `upstream-${runId}`)
  mkdirSync(staging, { recursive: true })
  const run: Run = {
    input, at, limits: { ...DEFAULT_LIMITS, ...input.limits }, skillsRoot: join(input.pluginRoot, 'skills'), staging,
    previous: new Map((previousLock?.skills ?? []).map((entry) => [entry.id, entry])),
    entries: new Map(), results: new Map(), failures: new Map(), staged: new Set(), totalBytes: 0,
  }
  try {
    const byRepo = new Map<string, UpstreamSkillSource[]>()
    for (const source of sources.skills) byRepo.set(source.repo, [...(byRepo.get(source.repo) ?? []), source])
    mkdirSync(clones, { recursive: true })
    const started = Date.now()
    let index = 0
    for (const [repo, items] of byRepo) await installRepository(run, repo, items, join(clones, String(index++)), started)
    await settleFailures(run, sources.skills)
    const managed = new Set([...sources.skills.map((source) => source.id), ...run.previous.keys()])
    applyStaged(run, bundled, managed)
    const lockWritten = writeLock(run, previousLock, runId)
    const results = sources.skills.flatMap((source) => run.results.get(source.id) ?? [])
    return { report: { version: 1, at, host: input.host, results }, lockWritten }
  } finally {
    rmSync(staging, { recursive: true, force: true })
    rmSync(clones, { recursive: true, force: true })
  }
}
