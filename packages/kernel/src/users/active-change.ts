/** Per-user selected Change (`local/active-change`), read by hooks through `hooks/active-change.sh`. */
import { lstat, readFile } from 'node:fs/promises'
import { validateChangeName } from '../state/session.js'
import { ensureUserLocalDir, isPlainDirectory, userProjectPaths, writeUserLocalFile } from './user-paths.js'

/** `null` when absent, not a regular file, under a non-directory `local`, or not a valid Change name. */
export async function readActiveChange(repoRoot: string, slug: string): Promise<string | null> {
  const paths = userProjectPaths(repoRoot, slug)
  if (!(await isPlainDirectory(paths.localDir))) return null
  try {
    if (!(await lstat(paths.activeChange)).isFile()) return null
    // Mirrors bash `$(<file)`: only trailing newlines are removed.
    const name = (await readFile(paths.activeChange, 'utf8')).replace(/\n+$/u, '')
    return validateChangeName(name).ok ? name : null
  } catch {
    return null
  }
}

export async function writeActiveChange(repoRoot: string, slug: string, change: string): Promise<void> {
  const checked = validateChangeName(change)
  if (!checked.ok) throw new Error(checked.error)
  const paths = await ensureUserLocalDir(repoRoot, slug)
  await writeUserLocalFile(paths.activeChange, `${change}\n`)
}
