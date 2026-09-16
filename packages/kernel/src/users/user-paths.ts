/**
 * Per-user project layout `<repo>/.tenon/users/<slug>/`. Tracked records sit beside `local/`, which the
 * nested `.tenon/.gitignore` keeps out of git; Tenon never edits the project's root `.gitignore`.
 * Siblings add their own path fields to `UserProjectPaths` instead of building parallel helpers.
 */
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const TENON_PROJECT_DIR = '.tenon'
export const TENON_PROJECT_GITIGNORE = 'users/*/local/\n'

export interface UserProjectPaths {
  readonly userRoot: string
  readonly testsDir: string
  readonly baselinesDir: string
  /** Task deletions: a shared fact, committed together with the removal. */
  readonly audit: string
  readonly localDir: string
  readonly activeChange: string
  readonly authority: string
  readonly archived: string
  /** 归档 / 取消归档: a personal preference, never synced. */
  readonly localAudit: string
  /** Staging for atomic 删除: the Change directory is renamed here, then removed. */
  readonly deletingDir: string
  readonly artifactsDir: string
}

/** Slugs come from `userSlug`: `[a-z0-9._-]` and always `-at-`, so `.` / `..` can never appear. */
const SLUG = /^[a-z0-9._-]*-at-[a-z0-9._-]*$/u

export function userProjectPaths(repoRoot: string, slug: string): UserProjectPaths {
  if (!SLUG.test(slug)) throw new Error(`用户目录名非法: ${slug}`)
  const userRoot = join(repoRoot, TENON_PROJECT_DIR, 'users', slug)
  const localDir = join(userRoot, 'local')
  return {
    userRoot,
    testsDir: join(userRoot, 'tests'),
    baselinesDir: join(userRoot, 'baselines'),
    audit: join(userRoot, 'audit.jsonl'),
    localDir,
    activeChange: join(localDir, 'active-change'),
    authority: join(localDir, 'authority'),
    archived: join(localDir, 'archived.json'),
    localAudit: join(localDir, 'audit.jsonl'),
    deletingDir: join(localDir, 'deleting'),
    artifactsDir: join(localDir, 'artifacts'),
  }
}

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code
}

async function ensurePlainDirectory(path: string, mode: number): Promise<void> {
  try {
    await mkdir(path, { mode })
  } catch (error) {
    if (errnoCode(error) !== 'EEXIST') throw error
  }
  const entry = await lstat(path)
  if (!entry.isDirectory()) throw new Error(`目录不是普通目录: ${path}`)
}

/** True when `path` is an ordinary directory (a symlink or file means per-user state is ignored). */
export async function isPlainDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory()
  } catch {
    return false
  }
}

/** Create `.tenon/.gitignore` once, then `users/<slug>/local/` (0700) as ordinary directories. */
export async function ensureUserLocalDir(repoRoot: string, slug: string): Promise<UserProjectPaths> {
  const paths = userProjectPaths(repoRoot, slug)
  const tenonDir = join(repoRoot, TENON_PROJECT_DIR)
  await ensurePlainDirectory(tenonDir, 0o755)
  try {
    await writeFile(join(tenonDir, '.gitignore'), TENON_PROJECT_GITIGNORE, { flag: 'wx' })
  } catch (error) {
    if (errnoCode(error) !== 'EEXIST') throw error
  }
  await ensurePlainDirectory(join(tenonDir, 'users'), 0o755)
  await ensurePlainDirectory(paths.userRoot, 0o755)
  await ensurePlainDirectory(paths.localDir, 0o700)
  return paths
}

/** Temp + rename into an existing directory; refuses a symlink or non-file target. */
export async function writeUserLocalFile(path: string, content: string): Promise<void> {
  try {
    if (!(await lstat(path)).isFile()) throw new Error(`目标不是普通文件: ${path}`)
  } catch (error) {
    if (errnoCode(error) !== 'ENOENT') throw error
  }
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, content, { mode: 0o600, flag: 'wx' })
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}
