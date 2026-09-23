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
 * OpenSpec/pipeline control state, documentation/evidence, and common test caches.  Those paths
 * are either mutable workflow metadata or verification outputs; including them would make a
 * successful verifier invalidate the target it is trying to attest.  All remaining files,
 * directories, modes, and symlink targets are represented without following symlinks.
 */
import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, readlink } from 'node:fs/promises'
import { join } from 'node:path'

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

// Dependency and verifier cache directories can occur below a workspace package, not only at
// the project root (for example packages/dashboard-app/node_modules/.vite/vitest/results.json).
// Excluding by every path segment keeps verification from invalidating its own frozen target.
const EXCLUDED_ANY_SEGMENT = new Set([
  'node_modules',
  'coverage',
  'test-results',
  'playwright-report',
  '.cache',
  '.pytest_cache',
  '__pycache__',
])

/**
 * The excluded segments a declared test output may live under. Declared outputs must sit here so
 * producing them never changes the candidate that binds the run record.
 */
export const TEST_OUTPUT_DIR_SEGMENTS = ['test-results', 'playwright-report', 'coverage'] as const

const EXCLUDED_BASENAMES = new Set([
  '.DS_Store',
  '.pipeline-active',
  '.pipeline-interaction-authority',
  '.pipeline-pending-confirm',
  '.pipeline-pending-interaction',
  '.pipeline-pending-review',
])

const EXCLUDED_RELATIVE_ROOTS = ['.github/hooks'] as const
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

function isExcluded(relativePath: string): boolean {
  const parts = relativePath.split('/')
  return EXCLUDED_TOP_LEVEL.has(parts[0] ?? '')
    || parts.some((part) => EXCLUDED_ANY_SEGMENT.has(part))
    || EXCLUDED_BASENAMES.has(parts.at(-1) ?? '')
    || EXCLUDED_RELATIVE_ROOTS.some((root) => relativePath === root || relativePath.startsWith(`${root}/`))
    || (!relativePath.includes('/') && EXCLUDED_ROOT_ARTIFACTS.some((pattern) => pattern.test(relativePath)))
}

/**
 * Whether a repository-relative path (forward slashes) belongs to the implementation candidate.
 * `tenon test code-size` counts only these paths, so workflow control state (openspec/, .tenon/,
 * .pipeline/), documentation and caches never inflate the code metrics.
 */
export function isWorkspaceCandidatePath(relativePath: string): boolean {
  return !isExcluded(relativePath)
}

function writeRecord(hash: ReturnType<typeof createHash>, kind: 'D' | 'F' | 'L', relativePath: string, details = ''): void {
  hash.update(kind)
  hash.update('\0')
  hash.update(relativePath)
  hash.update('\0')
  hash.update(details)
  hash.update('\0')
}

async function fingerprintEntry(
  root: string,
  relativePath: string,
  hash: ReturnType<typeof createHash>,
): Promise<void> {
  if (isExcluded(relativePath)) return
  const absolutePath = join(root, ...relativePath.split('/'))
  const before = await lstat(absolutePath)

  if (before.isDirectory()) {
    writeRecord(hash, 'D', relativePath, modeOf(before))
    const names = sortNames(await readdir(absolutePath))
    for (const name of names) await fingerprintEntry(root, `${relativePath}/${name}`, hash)
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
 * Produce a content-addressed target for a project root.  The caller supplies only the root;
 * transient workflow material is excluded by policy above, so the same implementation tree
 * yields the same value before and after its verification evidence is written.
 */
export async function fingerprintWorkspace(root: string): Promise<string> {
  const rootStat = await lstat(root)
  if (!rootStat.isDirectory()) throw new Error(`workspace root is not a directory: ${root}`)

  const hash = createHash('sha256')
  writeRecord(hash, 'D', '.', modeOf(rootStat))
  const names = sortNames(await readdir(root))
  for (const name of names) await fingerprintEntry(root, name, hash)
  return `${WORKSPACE_BASELINE_PREFIX}${hash.digest('hex')}`
}

export function isWorkspaceBaseline(value: string): boolean {
  return new RegExp(`^${WORKSPACE_BASELINE_PREFIX}[a-f0-9]{64}$`).test(value)
}
