/**
 * 集成测试共用的夹具仓库工具：固定提交身份的 git 调用，以及「写一个文件（缺的父目录一并建出）」。
 * 单独成文件而不放进 integration-harness.ts：后者已接近仓库的文件行数线。
 */
import { spawnSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** 固定的提交身份与关闭签名：测试不依赖宿主的 git 配置。 */
export const GIT_ARGS = ['-c', 'user.name=runner', '-c', 'user.email=runner@example.com', '-c', 'commit.gpgsign=false']

/** 夹具提交要早于 harness 的固定时钟（任务创建时刻），任务起点才是这次提交而不是空树。 */
export const FIXTURE_DATE = '2026-06-01T00:00:00Z'

export interface GitResult {
  readonly status: number | null
  /** stdout 与 stderr 拼在一起，断言失败时一并带出。 */
  readonly output: string
}

/** 在 `cwd` 里跑一条 git；给了 `date` 就同时盖在作者和提交者时间上，否则沿用当前时钟。 */
export function runGit(cwd: string, args: readonly string[], date?: string): GitResult {
  const result = spawnSync('git', [...GIT_ARGS, ...args], {
    cwd,
    encoding: 'utf8',
    env: date === undefined ? process.env : { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

/** 写 `cwd` 下的相对路径文件，缺的父目录一并建出；已有同名文件就覆盖。 */
export async function putFile(cwd: string, rel: string, body = ''): Promise<void> {
  const abs = join(cwd, rel)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, body, 'utf8')
}
