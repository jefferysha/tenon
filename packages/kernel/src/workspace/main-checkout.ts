/**
 * 主检出定位：命令在 linked worktree 里执行时，按 `git rev-parse --git-common-dir` 的上一级找到主检出根。
 * 派发判定（只读比对）与旧项目级宿主文件清理（删除）共用这一份定位，两处看到的是同一个目录。
 *
 * 只认名为 `.git` 的公共目录（裸仓库、子模块的公共目录不叫 `.git`，没有「主检出」可言）；git 不可用、超时、
 * 不是仓库、本来就在主检出里，一律返回 undefined 而不抛错——调用方把它当作「没有另一个主检出」。
 */
import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** 主检出根（`projectRoot` 在 linked worktree 里时与它不同）；不是 git 仓库、git 不可用、没有主检出都返回 undefined。 */
export async function mainCheckoutOf(projectRoot: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: projectRoot, timeout: 1_500, maxBuffer: 4_096, windowsHide: true,
    })
    const common = String(stdout).trim()
    if (common === '' || basename(common) !== '.git') return undefined
    const main = dirname(common)
    return await realpath(main) === await realpath(projectRoot) ? undefined : main
  } catch {
    return undefined
  }
}
