/**
 * 仓库配置的 git 远端名（`git remote`）。`pr_url` 的诚实取值依赖它：没有远端就没有 PR 可开，
 * 本地交付记 `no-remote`；有远端时只接受真实 URL。
 *
 * 不是 git 仓（`git remote` 非零退出）= 没有远端，返回 []；git 本身跑不起来（ENOENT 等）
 * 返回 null——判定不了，调用方据此失败关闭，不把「不知道」当成「没有」。
 */
import { execFile } from 'node:child_process'

export function gitRemoteNames(cwd: string): Promise<readonly string[] | null> {
  return new Promise((resolve) => {
    execFile('git', ['remote'], { cwd, timeout: 5000 }, (error, stdout) => {
      if (error !== null) {
        const code = (error as NodeJS.ErrnoException).code
        resolve(typeof code === 'number' ? [] : null)
        return
      }
      resolve(String(stdout).split('\n').map((line) => line.trim()).filter((line) => line !== ''))
    })
  })
}
