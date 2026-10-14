/**
 * 测试信任相关的 git 调用，由 repo-identity.ts（仓库身份）使用。
 *
 * 这些调用的答案决定命令要不要被信任，所以不能让环境把答案指到别处：`GIT_DIR`、`GIT_COMMON_DIR`、`GIT_WORK_TREE`、
 * `GIT_CONFIG_*` 都能改写 git 的结论，而 agent 运行 `tenon test run` 时能设置它们。因此子进程环境清掉全部 `GIT_*`，
 * 固定 C 语言环境（输出格式不随用户的语言变），并带超时与输出上限。
 * 失败（不是仓库、git 不可用、超时、输出超限）照常抛出，由调用方决定怎么失败关闭。
 *
 * kernel workspace/host-local.ts 的同名函数只去掉选择仓库的那几个变量，口径不同，这里不复用也不改它。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024

/** 进程环境去掉全部 GIT_ 变量（名字不分大小写），并固定 LC_ALL=C、LANG=C。 */
export function gitEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(source)) {
    // Windows 的环境变量名不区分大小写。
    if (!name.toUpperCase().startsWith('GIT_')) env[name] = value
  }
  return { ...env, LC_ALL: 'C', LANG: 'C' }
}

export interface RunGitOptions {
  readonly maxBuffer?: number
  readonly timeoutMs?: number
}

/** git <args>，cwd 固定、带超时与输出上限、环境经 gitEnvironment；失败照常抛出，由调用方决定失败关闭。 */
export async function runGit(cwd: string, args: readonly string[], options: RunGitOptions = {}): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], {
    cwd,
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
    env: gitEnvironment(),
    encoding: 'utf8',
  })
  return stdout
}
