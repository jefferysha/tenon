/**
 * In-place build baseline —— content-addressed workspace snapshot.
 *
 * A Git commit is an excellent immutable verification target when a build runs in a branch or
 * worktree.  It is not a truthful target for `isolation=in-place`: the build may deliberately
 * leave its implementation uncommitted, so HEAD can stay unchanged while the source drifts.
 * This module supplies the other durable target kind: a deterministic SHA-256 manifest of the
 * implementation workspace.
 *
 * Scope is intentionally source/configuration oriented.  We exclude Git internals, dependencies,
 * OpenSpec/pipeline control state and documentation/evidence.  Verification outputs are excluded
 * only where a test catalog (or a frozen workflow) declares them (`options.declaredOutputs`):
 * an undeclared `coverage/` or `test-results/` directory at any depth is part of the candidate, so
 * nothing can hide under a conventional-looking name.  Including declared outputs would make a
 * successful verifier invalidate the target it is trying to attest.  All remaining files,
 * directories, modes, and symlink targets are represented without following symlinks.
 *
 * Two values come out of one traversal (`fingerprintWorkspaceTwins`).  The full one records raw permission
 * bits and counts host-local files; it is the 0.3.0 value, byte for byte, and what reviewer verdicts and
 * build revisions bind.  The portable one is what test records bind: it leaves out untracked host-local
 * files and records modes the way git does (`portableModeOf`), so a runner on another platform reproduces
 * it from the same committed content.
 */
import { createHash, type Hash } from 'node:crypto'
import type { Stats } from 'node:fs'
import { lstat, readdir, readFile, readlink } from 'node:fs/promises'
import { join, sep } from 'node:path'
import {
  HOST_LOCAL_DIRS, HOST_LOCAL_FILES, SKIP_NOTHING, hasHostLocalFiles, hostLocalTracking, skipUntrackedHostLocal,
  type HostLocalSkip,
} from './host-local.js'
import { isProcessLocalFdPath } from './process-local-fd-path.js'

export { HOST_LOCAL_DIRS, HOST_LOCAL_FILES, hasHostLocalFiles, isHostLocalPath, trackedHostLocalPaths } from './host-local.js'

export const WORKSPACE_BASELINE_PREFIX = 'workspace:sha256:'

const EXCLUDED_TOP_LEVEL = new Set([
  '.git',
  '.pipeline',
  // Per-user selection, authority, test records and local artifacts; never part of a candidate.
  '.tenon',
  '.agents',
  '.codex',
  '.impeccable',
  '.superpowers',
  '.worktrees',
  'openspec',
  'docs',
  '.turbo',
  '.playwright-mcp',
  '.playwright-tmp',
  '.sandcastle-build',
  'e2e-runs',
])

// Dependency and interpreter cache directories can occur below a workspace package, not only at
// the project root (for example packages/dashboard-app/node_modules/.vite/vitest/results.json).
// They are never source, and no catalog declares them.
const EXCLUDED_ANY_SEGMENT = new Set([
  'node_modules',
  '.pytest_cache',
  '__pycache__',
])

/**
 * The directory names a declared test output must live under.  A declaration can only hide files
 * inside such a directory, never source: the catalog and workflow validators enforce this, so a
 * suite cannot exclude `src/` from the candidate by "declaring" it as an artifact.
 */
export const TEST_OUTPUT_DIR_SEGMENTS = ['test-results', 'playwright-report', 'coverage'] as const

/**
 * Directory names the pre-declaration fingerprint excluded at any depth.  Kept only as the scope of
 * code-size metrics (`isWorkspaceCandidatePath`), which count source lines and have no evidence role.
 */
const METRIC_EXCLUDED_ANY_SEGMENT = new Set([
  ...EXCLUDED_ANY_SEGMENT,
  ...TEST_OUTPUT_DIR_SEGMENTS,
  '.cache',
])

export interface FingerprintOptions {
  /**
   * Repository-relative files or directories (forward slashes) that a test catalog or a frozen
   * workflow declares as outputs of a test run.  Only these are excluded; see `candidateFingerprint`.
   */
  readonly declaredOutputs?: readonly string[]
}

interface Exclusions {
  readonly declared: readonly string[]
  /** Every proper ancestor directory of a declared output: candidates for the empty-shell rule. */
  readonly ancestors: ReadonlySet<string>
}

function normalizeDeclared(value: string): string | undefined {
  const parts = value.split('/').filter((part) => part !== '' && part !== '.')
  if (parts.length === 0 || parts.includes('..') || value.startsWith('/') || value.includes('\\')) return undefined
  return parts.join('/')
}

function exclusionsOf(options: FingerprintOptions | undefined): Exclusions {
  const declared = [...new Set((options?.declaredOutputs ?? []).flatMap((value) => normalizeDeclared(value) ?? []))].sort()
  const ancestors = new Set<string>()
  for (const path of declared) {
    const parts = path.split('/')
    for (let end = 1; end < parts.length; end++) ancestors.add(parts.slice(0, end).join('/'))
  }
  return { declared, ancestors }
}

const EXCLUDED_BASENAMES = new Set([
  '.DS_Store',
  '.pipeline-active',
  '.pipeline-interaction-authority',
  '.pipeline-pending-confirm',
  '.pipeline-pending-interaction',
  '.pipeline-pending-review',
])

/**
 * `.claude/agents` holds host subagent definitions, which include the task-scoped `tenon-<name>.md`
 * files Tenon generates and prunes while other tasks are in flight; like `.codex/` and `.agents/` it is
 * host configuration, not implementation.
 */
const EXCLUDED_RELATIVE_ROOTS = ['.github/hooks', '.claude/agents'] as const
/** Root-level ownership manifest: Tenon rewrites it whenever it generates or prunes host agent files. */
const EXCLUDED_ROOT_FILES = new Set(['.pipeline-owned.json'])

/**
 * A directory that only wraps excluded host configuration (`.claude/` holding just `agents/`) is not
 * implementation either: Tenon creates it when it first generates a host agent file, and that must not
 * move the candidate the earlier test records are bound to.  For the portable fingerprint the untracked
 * host-local paths count as excluded host configuration too (`.claude/` holding `agents/` and
 * `settings.local.json`).
 */
function isExcludedHostConfigShell(relativePath: string, names: readonly string[], exclusions: Exclusions, skip: HostLocalSkip): boolean {
  const roots: readonly string[] = [...EXCLUDED_RELATIVE_ROOTS, ...HOST_LOCAL_FILES, ...HOST_LOCAL_DIRS]
  return roots.some((root) => root.startsWith(`${relativePath}/`))
    && names.every((name) => isExcludedFor(`${relativePath}/${name}`, exclusions, skip))
}
const EXCLUDED_ROOT_ARTIFACTS = [
  /^dashboard-progress-custom-spec\.png$/,
  /^dashboard-acceptance-.*\.png$/,
  /^workbench-.*\.png$/,
] as const

function sortNames(names: string[]): string[] {
  return names.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
}

function modeOf(stat: { mode: number }): string {
  return (stat.mode & 0o777).toString(8)
}

function sameFileIdentity(
  before: { size: number; mode: number; mtimeMs: number; ino: number },
  after: { size: number; mode: number; mtimeMs: number; ino: number },
): boolean {
  return before.size === after.size
    && before.mode === after.mode
    && before.mtimeMs === after.mtimeMs
    && before.ino === after.ino
}

function isDeclaredOutput(relativePath: string, exclusions: Exclusions): boolean {
  return exclusions.declared.some((path) => relativePath === path || relativePath.startsWith(`${path}/`))
}

function isExcluded(relativePath: string, exclusions: Exclusions, anySegment: ReadonlySet<string> = EXCLUDED_ANY_SEGMENT): boolean {
  const parts = relativePath.split('/')
  return EXCLUDED_TOP_LEVEL.has(parts[0] ?? '')
    || parts.some((part) => anySegment.has(part))
    || EXCLUDED_BASENAMES.has(parts.at(-1) ?? '')
    || EXCLUDED_RELATIVE_ROOTS.some((root) => relativePath === root || relativePath.startsWith(`${root}/`))
    || (!relativePath.includes('/') && EXCLUDED_ROOT_ARTIFACTS.some((pattern) => pattern.test(relativePath)))
    || EXCLUDED_ROOT_FILES.has(relativePath)
    || isDeclaredOutput(relativePath, exclusions)
}

const NO_EXCLUSIONS: Exclusions = { declared: [], ancestors: new Set() }

/** The common exclusions plus whatever this fingerprint's `skip` leaves out (the full fingerprint skips nothing). */
function isExcludedFor(relativePath: string, exclusions: Exclusions, skip: HostLocalSkip): boolean {
  return isExcluded(relativePath, exclusions) || skip(relativePath)
}

/**
 * Whether a repository-relative path (forward slashes) counts as source for code metrics.
 * `tenon test code-size` counts only these paths, so workflow control state (openspec/, .tenon/,
 * .pipeline/), documentation and caches (including the conventional test-output directories, declared
 * or not) never inflate the code metrics.  The paths come from git diffs, so a host-local path that shows
 * up there is tracked and counts.  This is a metric scope, not evidence: the candidate fingerprint uses the
 * stricter `fingerprintWorkspace` rules.
 */
export function isWorkspaceCandidatePath(relativePath: string): boolean {
  return !isExcluded(relativePath, NO_EXCLUSIONS, METRIC_EXCLUDED_ANY_SEGMENT)
}

function recordText(kind: 'D' | 'F' | 'L', relativePath: string, details: string): string {
  return `${kind}\0${relativePath}\0${details}\0`
}

/** True when everything below `relativePath` is excluded, so the directory itself carries no candidate content. */
async function holdsOnlyExcluded(root: string, relativePath: string, exclusions: Exclusions, skip: HostLocalSkip): Promise<boolean> {
  for (const name of await readdir(join(root, ...relativePath.split('/')))) {
    const child = `${relativePath}/${name}`
    if (isExcludedFor(child, exclusions, skip)) continue
    if (!exclusions.ancestors.has(child)) return false
    if (!(await lstat(join(root, ...child.split('/')))).isDirectory()) return false
    if (!(await holdsOnlyExcluded(root, child, exclusions, skip))) return false
  }
  return true
}

/**
 * The mode token the portable fingerprint records, following git's mode model instead of the file system's.
 * Git stores no directory modes, no symlink modes and, for a regular file, only the owner's executable bit
 * (100644 or 100755).  Every other permission bit comes from the machine that wrote the checkout and differs
 * for the same committed content: a symlink is 0755 on macOS and always 0777 on Linux, and directories and
 * files follow the umask (0775/0664 under umask 002).  Recording them would make a Linux runner unable to
 * reproduce a fingerprint taken on a Mac.
 *
 * The constants that stand in for the modes git does not store are the values a umask-022 checkout produces
 * on macOS, so for an ordinary tree the portable fingerprint equals the full one, and a reader that only
 * knows the full fingerprint (0.3.0 and earlier) still finds the record fresh.
 */
export function portableModeOf(kind: 'D' | 'F' | 'L', mode: number): string {
  if (kind === 'F') return (mode & 0o100) !== 0 ? '755' : '644'
  return '755'
}

/** One of the two fingerprints being computed.  Both are fed by the same traversal, so each file is read once. */
interface Sink {
  readonly id: 'full' | 'portable'
  readonly skip: HostLocalSkip
  /** Record git's mode model (`portableModeOf`) instead of the raw permission bits. */
  readonly gitModes: boolean
}

/** The mode token one sink records for an entry. */
function recordedMode(sink: Sink, kind: 'D' | 'F' | 'L', stat: { mode: number }): string {
  return sink.gitModes ? portableModeOf(kind, stat.mode) : modeOf(stat)
}

/**
 * The two SHA-256 streams.  They share one hash state for as long as every record is identical for both, which
 * is the whole traversal of an ordinary tree, so hashing the contents is paid once.  The first record only one of
 * them takes (or that they record differently) splits the state in two with `Hash.copy()`; after that each is
 * fed on its own.  The bytes each stream sees are exactly what two separate traversals would have fed it.
 */
class FingerprintStreams {
  private shared: Hash | undefined = createHash('sha256')
  private split: { readonly full: Hash; readonly portable: Hash } | undefined

  update(data: string | Buffer, target: 'both' | 'full' | 'portable'): void {
    if (this.shared !== undefined && target === 'both') {
      this.shared.update(data)
      return
    }
    const { full, portable } = this.diverge()
    if (target !== 'portable') full.update(data)
    if (target !== 'full') portable.update(data)
  }

  private diverge(): { readonly full: Hash; readonly portable: Hash } {
    if (this.split === undefined) {
      const full = this.shared ?? createHash('sha256')
      this.split = { full, portable: full.copy() }
      this.shared = undefined
    }
    return this.split
  }

  digests(): WorkspaceFingerprints {
    const hex = (hash: Hash): string => `${WORKSPACE_BASELINE_PREFIX}${hash.digest('hex')}`
    if (this.split === undefined) {
      const value = hex(this.shared ?? createHash('sha256'))
      return { full: value, portable: value }
    }
    return { full: hex(this.split.full), portable: hex(this.split.portable) }
  }
}

/** Feed an entry's record to every live sink; `text` is what that sink records for it. */
function emit(streams: FingerprintStreams, live: readonly Sink[], text: (sink: Sink) => string): void {
  const records = live.map((sink) => ({ id: sink.id, text: text(sink) }))
  const [first, second] = records
  if (first === undefined) return
  if (second === undefined) streams.update(first.text, first.id)
  else if (first.text === second.text) streams.update(first.text, 'both')
  else for (const record of records) streams.update(record.text, record.id)
}

async function fingerprintEntry(
  root: string,
  relativePath: string,
  sinks: readonly Sink[],
  exclusions: Exclusions,
  streams: FingerprintStreams,
): Promise<void> {
  const live = sinks.filter((sink) => !isExcludedFor(relativePath, exclusions, sink.skip))
  if (live.length === 0) return
  const absolutePath = join(root, ...relativePath.split('/'))
  const before = await lstat(absolutePath)

  if (before.isDirectory()) {
    const names = sortNames(await readdir(absolutePath))
    const keep: Sink[] = []
    for (const sink of live) {
      if (isExcludedHostConfigShell(relativePath, names, exclusions, sink.skip)) continue
      // A directory that only wraps declared outputs (`test-results/` holding just the report) appears when
      // the first run writes them; it must not move the candidate the run is bound to.
      if (exclusions.ancestors.has(relativePath) && await holdsOnlyExcluded(root, relativePath, exclusions, sink.skip)) continue
      keep.push(sink)
    }
    if (keep.length === 0) return
    emit(streams, keep, (sink) => recordText('D', relativePath, recordedMode(sink, 'D', before)))
    for (const name of names) await fingerprintEntry(root, `${relativePath}/${name}`, keep, exclusions, streams)
    return
  }

  if (before.isFile()) {
    const content = await readFile(absolutePath)
    emit(streams, live, (sink) => recordText('F', relativePath, `${recordedMode(sink, 'F', before)}:${before.size}`))
    // The content is the same bytes for every sink that holds the file.
    streams.update(content, live.length === 2 ? 'both' : (live[0]?.id ?? 'both'))
    const after = await lstat(absolutePath)
    if (!after.isFile() || !sameFileIdentity(before, after)) {
      throw new Error(`workspace baseline capture raced with a file change: ${relativePath}`)
    }
    return
  }

  if (before.isSymbolicLink()) {
    const target = await readlink(absolutePath)
    emit(streams, live, (sink) => recordText('L', relativePath, `${recordedMode(sink, 'L', before)}:${target}`))
    return
  }

  throw new Error(`workspace baseline does not support non-file entry: ${relativePath}`)
}

/**
 * The root's own stat.  A server that pins its project root through an open directory descriptor reads
 * it as `/proc/self/fd/<n>` (Linux) or `/dev/fd/<n>`.  On Linux the leaf of that path is a symlink, so a
 * plain `lstat` reports the link instead of the directory and the capture used to fail with "workspace
 * root is not a directory" — the Dashboard then read every test record as bound to an unknown candidate.
 * A trailing `/.` traverses such an alias to the opened directory (path.join would normalize it away).
 * Only a process-local descriptor alias gets this; a real symlinked root is still refused, and children
 * are joined under the alias unchanged, so the value equals the one taken through the real path.
 */
async function statRoot(root: string): Promise<Stats> {
  const direct = await lstat(root)
  if (!direct.isSymbolicLink() || !isProcessLocalFdPath(root)) return direct
  return lstat(`${root}${sep}.`)
}

export interface WorkspaceFingerprints {
  /**
   * The value Tenon 0.3.0 and earlier bound into every record and review, byte for byte: host-local files
   * counted, raw permission bits recorded.  It depends on the machine (symlink modes, umask).
   */
  readonly full: string
  /**
   * What a clean checkout of the committed files reproduces on any machine: the host-local paths git does not
   * track are left out, and modes follow git's model (`portableModeOf`).  Test records bind this one.
   */
  readonly portable: string
}

/**
 * Both fingerprints of a project root from one traversal, so each file is read once.  They are equal for an
 * ordinary tree (no untracked host-local path, directories 755, files 644/755, no symlink on Linux).
 * Transient workflow material is excluded by policy above and declared test outputs by
 * `options.declaredOutputs`, so the same implementation tree yields the same values before and after its
 * verification evidence is written.  Production callers go through `candidateFingerprint`, which derives
 * the declarations from the project.
 */
export async function fingerprintWorkspaceTwins(root: string, options?: FingerprintOptions): Promise<WorkspaceFingerprints> {
  const rootStat = await statRoot(root)
  if (!rootStat.isDirectory()) throw new Error(`workspace root is not a directory: ${root}`)

  const exclusions = exclusionsOf(options)
  const full: Sink = { id: 'full', skip: SKIP_NOTHING, gitModes: false }
  // The portable fingerprint leaves out the host-local paths git does not track.  When git cannot say what it tracks
  // (or there is no host-local path to ask about) nothing is left out.
  const tracking = await hasHostLocalFiles(root) ? await hostLocalTracking(root) : undefined
  const portable: Sink = {
    id: 'portable', gitModes: true,
    skip: tracking === undefined ? SKIP_NOTHING : skipUntrackedHostLocal(tracking.tracked, tracking.caseInsensitive),
  }
  const sinks = [full, portable]
  const streams = new FingerprintStreams()
  emit(streams, sinks, (sink) => recordText('D', '.', recordedMode(sink, 'D', rootStat)))
  const names = sortNames(await readdir(root))
  for (const name of names) await fingerprintEntry(root, name, sinks, exclusions, streams)
  return streams.digests()
}

/** The fingerprint that counts host-local files (`WorkspaceFingerprints.full`). */
export async function fingerprintWorkspace(root: string, options?: FingerprintOptions): Promise<string> {
  return (await fingerprintWorkspaceTwins(root, options)).full
}

export function isWorkspaceBaseline(value: string): boolean {
  return new RegExp(`^${WORKSPACE_BASELINE_PREFIX}[a-f0-9]{64}$`).test(value)
}
