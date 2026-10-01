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
import { createHash } from 'node:crypto'
import type { Stats } from 'node:fs'
import { lstat, readdir, readFile, readlink } from 'node:fs/promises'
import { join, sep } from 'node:path'
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
 * A directory that only wraps excluded host configuration (`.claude/` holding just `agents/`) is not
 * implementation either: Tenon creates it when it first generates a host agent file, and that must not
 * move the candidate the earlier test records are bound to.
 */
function isExcludedHostConfigShell(relativePath: string, names: readonly string[], exclusions: Exclusions): boolean {
  return EXCLUDED_RELATIVE_ROOTS.some((root) => root.startsWith(`${relativePath}/`))
    && names.every((name) => isExcluded(`${relativePath}/${name}`, exclusions))
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

/**
 * Whether a repository-relative path (forward slashes) counts as source for code metrics.
 * `tenon test code-size` counts only these paths, so workflow control state (openspec/, .tenon/,
 * .pipeline/), documentation and caches (including the conventional test-output directories, declared
 * or not) never inflate the code metrics.  This is a metric scope, not evidence: the candidate
 * fingerprint uses the stricter `fingerprintWorkspace` rules.
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
async function holdsOnlyExcluded(root: string, relativePath: string, exclusions: Exclusions): Promise<boolean> {
  for (const name of await readdir(join(root, ...relativePath.split('/')))) {
    const child = `${relativePath}/${name}`
    if (isExcluded(child, exclusions)) continue
    if (!exclusions.ancestors.has(child)) return false
    if (!(await lstat(join(root, ...child.split('/')))).isDirectory()) return false
    if (!(await holdsOnlyExcluded(root, child, exclusions))) return false
  }
  return true
}

async function fingerprintEntry(
  root: string,
  relativePath: string,
  hash: ReturnType<typeof createHash>,
  exclusions: Exclusions,
): Promise<void> {
  if (isExcluded(relativePath, exclusions)) return
  const absolutePath = join(root, ...relativePath.split('/'))
  const before = await lstat(absolutePath)

  if (before.isDirectory()) {
    const names = sortNames(await readdir(absolutePath))
    if (isExcludedHostConfigShell(relativePath, names, exclusions)) return
    // A directory that only wraps declared outputs (`test-results/` holding just the report) appears when
    // the first run writes them; it must not move the candidate the run is bound to.
    if (exclusions.ancestors.has(relativePath) && await holdsOnlyExcluded(root, relativePath, exclusions)) return
    writeRecord(hash, 'D', relativePath, modeOf(before))
    for (const name of names) await fingerprintEntry(root, `${relativePath}/${name}`, hash, exclusions)
    return
  }

  if (before.isFile()) {
    writeRecord(hash, 'F', relativePath, `${modeOf(before)}:${before.size}`)
    hash.update(await readFile(absolutePath))
    const after = await lstat(absolutePath)
    if (!after.isFile() || !sameFileIdentity(before, after)) {
      throw new Error(`workspace baseline capture raced with a file change: ${relativePath}`)
    }
    return
  }

  if (before.isSymbolicLink()) {
    writeRecord(hash, 'L', relativePath, `${modeOf(before)}:${await readlink(absolutePath)}`)
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

/**
 * Produce a content-addressed target for a project root.  Transient workflow material is excluded
 * by policy above and declared test outputs by `options.declaredOutputs`, so the same implementation
 * tree yields the same value before and after its verification evidence is written.  Production
 * callers go through `candidateFingerprint`, which derives the declarations from the project.
 */
export async function fingerprintWorkspace(root: string, options?: FingerprintOptions): Promise<string> {
  const rootStat = await statRoot(root)
  if (!rootStat.isDirectory()) throw new Error(`workspace root is not a directory: ${root}`)

  const exclusions = exclusionsOf(options)
  const hash = createHash('sha256')
  writeRecord(hash, 'D', '.', modeOf(rootStat))
  const names = sortNames(await readdir(root))
  for (const name of names) await fingerprintEntry(root, name, hash, exclusions)
  return `${WORKSPACE_BASELINE_PREFIX}${hash.digest('hex')}`
}

export function isWorkspaceBaseline(value: string): boolean {
  return new RegExp(`^${WORKSPACE_BASELINE_PREFIX}[a-f0-9]{64}$`).test(value)
}
