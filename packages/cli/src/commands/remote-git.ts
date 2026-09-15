import type { SetupEnv } from './setup.js'

// A dropped or slow connection to GitHub is transient; a missing tag, ref or repository is not. Retrying keeps
// every proof unchanged because callers still validate each successful result.
export const TRANSIENT_REMOTE_FAILURE = /ETIMEDOUT|timed out|SSL_ERROR|SSL_connect|unable to access|Could not resolve host|Connection (?:reset|refused|timed out)|Failed to connect|early EOF|RPC failed|remote end hung up/iu
const REMOTE_GIT_TIMEOUT_MS = 60_000
const REMOTE_GIT_ATTEMPTS = 3
const REMOTE_GIT_RETRY_DELAY_MS = 500

export interface RemoteGitOptions {
  readonly timeoutMs?: number
  readonly attempts?: number
}

export function runRemoteGit(
  env: Pick<SetupEnv, 'runCommand'>,
  args: readonly string[],
  options: RemoteGitOptions = {},
): { readonly result: ReturnType<SetupEnv['runCommand']>; readonly attempts: number } {
  const timeoutMs = options.timeoutMs ?? REMOTE_GIT_TIMEOUT_MS
  const maxAttempts = options.attempts ?? REMOTE_GIT_ATTEMPTS
  let result = env.runCommand('git', [...args], { timeoutMs })
  let attempts = 1
  while (result.code !== 0 && attempts < maxAttempts && TRANSIENT_REMOTE_FAILURE.test(result.stderr)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, REMOTE_GIT_RETRY_DELAY_MS * attempts)
    result = env.runCommand('git', [...args], { timeoutMs })
    attempts += 1
  }
  return { result, attempts }
}
