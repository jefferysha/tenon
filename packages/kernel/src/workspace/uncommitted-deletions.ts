/**
 * 未提交删除 count: how many Changes 删除 removed from the working tree without committing. Delete never
 * touches git history or the index, so this is the only signal that tells the user what is still theirs
 * to commit. Paths in porcelain output are repository-relative, so Tenon projects keep `openspec/` at the
 * git root; a non-repository or a failing git reports `null` rather than a wrong count.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { isPlainDirectory } from '../users/user-paths.js'
import { isTaskLifecycleName, taskChangeDir } from './task-archive.js'

const execFileAsync = promisify(execFile)
const CHANGES_PREFIX = 'openspec/changes/'

export type GitStatusRunner = (repoRoot: string, args: readonly string[]) => Promise<{ code: number; stdout: string }>

export const gitStatusRunner: GitStatusRunner = async (repoRoot, args) => {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoRoot, ...args], {
      timeout: 5_000,
      maxBuffer: 4_194_304,
      windowsHide: true,
    })
    return { code: 0, stdout: String(stdout) }
  } catch (error) {
    const code = (error as { code?: unknown }).code
    return { code: typeof code === 'number' && code !== 0 ? code : 1, stdout: '' }
  }
}

/** `openspec/changes/<name>/…` → `<name>`; a bare Change directory entry or another path → `null`. */
function changeNameOf(path: string): string | null {
  if (!path.startsWith(CHANGES_PREFIX)) return null
  const rest = path.slice(CHANGES_PREFIX.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return null
  const name = rest.slice(0, slash)
  return isTaskLifecycleName(name) ? name : null
}

export async function countUncommittedTaskDeletions(
  repoRoot: string,
  git: GitStatusRunner = gitStatusRunner,
): Promise<number | null> {
  const result = await git(repoRoot, [
    'status', '--porcelain=v1', '-z', '--untracked-files=no', '--', 'openspec/changes',
  ])
  if (result.code !== 0) return null
  const fields = result.stdout.split('\0')
  const names = new Set<string>()
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index] ?? ''
    if (field.length < 4) continue
    const [x, y] = [field[0] ?? '', field[1] ?? '']
    // A rename or copy carries its source path in the following NUL-terminated field.
    if (x === 'R' || x === 'C') index += 1
    if (x !== 'D' && y !== 'D') continue
    const name = changeNameOf(field.slice(3))
    if (name !== null) names.add(name)
  }
  let count = 0
  for (const name of names) {
    if (!(await isPlainDirectory(taskChangeDir(repoRoot, name)))) count += 1
  }
  return count
}
