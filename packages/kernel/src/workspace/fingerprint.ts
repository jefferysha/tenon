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
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import type { Stats } from 'node:fs'
import { lstat, readdir, readFile, readlink } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { promisify } from 'node:util'
import { isProcessLocalFdPath } from './process-local-fd-path.js'

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
 * Host-local files: per-machine configuration of the coding-agent hosts that is never committed (the hosts
 * create it git-ignored, or tell the user to ignore it).  They are not implementation, but they differ
 * between the author's workspace and any clone, so a fingerprint that counted them could never be
 * reproduced from the committed files.  The list is explicit on purpose; nothing else is excluded by name
 * pattern, and every entry is a path from the project root:
 *
 *   · `.claude/settings.local.json` — Claude Code's personal project settings (permission allow-lists, hook
 *     logging); Claude Code rewrites it whenever the user answers a permission prompt.
 *   · `CLAUDE.local.md` — Claude Code's personal, uncommitted project memory next to `CLAUDE.md`.
 *   · `.claude/worktrees/` — checkouts of this project that Claude Code creates for its sub-agents; every
 *     file in them is a copy of source that already counts at its real path.
 *
 * `.claude/settings.json`, `.claude/commands/`, `.claude/skills/`, `.mcp.json` and `CLAUDE.md` are shared,
 * committed configuration and stay part of the candidate.  Codex needs no entry: `.codex/` and `.agents/`
 * are excluded as a whole.
 *
 * The exclusion is only for files git does not track.  A host-local path that is tracked (committed or
 * staged) is part of the repository, so the portable fingerprint counts it: otherwise a pull request could
 * commit code under one of these paths, point a test at it, and change it later without moving the candidate.
 */
export const HOST_LOCAL_FILES = ['.claude/settings.local.json', 'CLAUDE.local.md'] as const
export const HOST_LOCAL_DIRS = ['.claude/worktrees'] as const

/** Whether a path is on the host-local list (by name only; whether git tracks it is a separate question, see `trackedHostLocalPaths`). */
export function isHostLocalPath(relativePath: string): boolean {
  return (HOST_LOCAL_FILES as readonly string[]).includes(relativePath)
    || HOST_LOCAL_DIRS.some((dir) => relativePath === dir || relativePath.startsWith(`${dir}/`))
}

/** True when the project has at least one host-local path, i.e. when the two fingerprints below can differ. */
export async function hasHostLocalFiles(root: string): Promise<boolean> {
  for (const path of [...HOST_LOCAL_FILES, ...HOST_LOCAL_DIRS]) {
    try {
      await lstat(join(root, ...path.split('/')))
      return true
    } catch {
      // absent
    }
  }
  return false
}

const runGit = promisify(execFile)
const GIT_TIMEOUT_MS = 30_000
const GIT_MAX_BUFFER = 64 * 1024 * 1024

/**
 * The files under the host-local list that git tracks (committed or staged), as paths from the project root.
 * A directory that is not a git repository tracks nothing.  Any other failure (git missing, a corrupt index,
 * a timeout) is `undefined`: the caller must then count every host-local path, because "unknown" must never
 * widen what the fingerprint leaves out.
 */
export async function trackedHostLocalPaths(root: string): Promise<ReadonlySet<string> | undefined> {
  try {
    const { stdout } = await runGit('git', ['ls-files', '-z', '--cached', '--', ...HOST_LOCAL_FILES, ...HOST_LOCAL_DIRS], {
      cwd: root, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    })
    return new Set(stdout.split('\0').filter((path) => path !== ''))
  } catch (error) {
    const stderr = typeof error === 'object' && error !== null ? Reflect.get(error, 'stderr') : undefined
    return typeof stderr === 'string' && /not a git repository/iu.test(stderr) ? new Set() : undefined
  }
}

/** Which paths a fingerprint leaves out in addition to the common exclusions. */
type HostLocalSkip = (relativePath: string) => boolean

/** The full fingerprint counts every host-local path. */
const SKIP_NOTHING: HostLocalSkip = () => false

/** The portable fingerprint leaves out the host-local paths git does not track (and the directories holding only those). */
function skipUntrackedHostLocal(tracked: ReadonlySet<string>): HostLocalSkip {
  const holdingTracked = new Set<string>()
  for (const path of tracked) {
    const parts = path.split('/')
    for (let end = 1; end < parts.length; end++) holdingTracked.add(parts.slice(0, end).join('/'))
  }
  return (relativePath) => isHostLocalPath(relativePath) && !tracked.has(relativePath) && !holdingTracked.has(relativePath)
}

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

function writeRecord(hash: ReturnType<typeof createHash>, kind: 'D' | 'F' | 'L', relativePath: string, details = ''): void {
  hash.update(kind)
  hash.update('\0')
  hash.update(relativePath)
  hash.update('\0')
  hash.update(details)
  hash.update('\0')
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

/** One fingerprint being computed.  Both are fed by the same traversal, so each file is read once. */
interface Sink {
  readonly hash: ReturnType<typeof createHash>
  readonly skip: HostLocalSkip
}

async function fingerprintEntry(
  root: string,
  relativePath: string,
  sinks: readonly Sink[],
  exclusions: Exclusions,
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
    for (const sink of keep) writeRecord(sink.hash, 'D', relativePath, modeOf(before))
    for (const name of names) await fingerprintEntry(root, `${relativePath}/${name}`, keep, exclusions)
    return
  }

  if (before.isFile()) {
    const details = `${modeOf(before)}:${before.size}`
    const content = await readFile(absolutePath)
    for (const sink of live) {
      writeRecord(sink.hash, 'F', relativePath, details)
      sink.hash.update(content)
    }
    const after = await lstat(absolutePath)
    if (!after.isFile() || !sameFileIdentity(before, after)) {
      throw new Error(`workspace baseline capture raced with a file change: ${relativePath}`)
    }
    return
  }

  if (before.isSymbolicLink()) {
    const details = `${modeOf(before)}:${await readlink(absolutePath)}`
    for (const sink of live) writeRecord(sink.hash, 'L', relativePath, details)
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
  /** Counts the host-local files: the value Tenon 0.3.0 and earlier bound into every record and review. */
  readonly full: string
  /** Leaves the host-local files out: what a clean checkout of the committed files can reproduce. */
  readonly portable: string
}

/**
 * Both fingerprints of a project root from one traversal.  When the project has no host-local path the two
 * values are equal and the traversal feeds a single hash.  Transient workflow material is excluded by
 * policy above and declared test outputs by `options.declaredOutputs`, so the same implementation tree
 * yields the same values before and after its verification evidence is written.  Production callers go
 * through `candidateFingerprint`, which derives the declarations from the project.
 */
export async function fingerprintWorkspaceTwins(root: string, options?: FingerprintOptions): Promise<WorkspaceFingerprints> {
  const rootStat = await statRoot(root)
  if (!rootStat.isDirectory()) throw new Error(`workspace root is not a directory: ${root}`)

  const exclusions = exclusionsOf(options)
  const full: Sink = { hash: createHash('sha256'), skip: SKIP_NOTHING }
  // The portable fingerprint differs from the full one only when an untracked host-local path exists.  When git cannot
  // say what it tracks, nothing is left out and the two values are equal.
  const tracked = await hasHostLocalFiles(root) ? await trackedHostLocalPaths(root) : undefined
  const portable: Sink | undefined = tracked === undefined ? undefined : { hash: createHash('sha256'), skip: skipUntrackedHostLocal(tracked) }
  const sinks = portable === undefined ? [full] : [full, portable]
  for (const sink of sinks) writeRecord(sink.hash, 'D', '.', modeOf(rootStat))
  const names = sortNames(await readdir(root))
  for (const name of names) await fingerprintEntry(root, name, sinks, exclusions)
  const digest = (sink: Sink): string => `${WORKSPACE_BASELINE_PREFIX}${sink.hash.digest('hex')}`
  const fullValue = digest(full)
  return { full: fullValue, portable: portable === undefined ? fullValue : digest(portable) }
}

/** The fingerprint that counts host-local files (`WorkspaceFingerprints.full`). */
export async function fingerprintWorkspace(root: string, options?: FingerprintOptions): Promise<string> {
  return (await fingerprintWorkspaceTwins(root, options)).full
}

export function isWorkspaceBaseline(value: string): boolean {
  return new RegExp(`^${WORKSPACE_BASELINE_PREFIX}[a-f0-9]{64}$`).test(value)
}
