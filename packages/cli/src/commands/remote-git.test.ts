import { describe, expect, test } from 'vitest'
import { runRemoteGit, TRANSIENT_REMOTE_FAILURE } from './remote-git.js'
import type { SetupEnv } from './setup.js'

type Result = ReturnType<SetupEnv['runCommand']>

function scripted(results: readonly Result[]): { env: Pick<SetupEnv, 'runCommand'>; calls: { args: readonly string[]; timeoutMs?: number }[] } {
  const calls: { args: readonly string[]; timeoutMs?: number }[] = []
  let index = 0
  return {
    calls,
    env: {
      runCommand: (_command, args, options) => {
        calls.push({ args: [...args], ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) })
        const result = results[Math.min(index, results.length - 1)]
        index += 1
        if (result === undefined) throw new Error('no scripted result')
        return result
      },
    },
  }
}

const TIMEOUT: Result = { code: 128, stdout: '', stderr: 'fatal: unable to access: SSL_connect: SSL_ERROR_SYSCALL' }
const OK: Result = { code: 0, stdout: 'ok', stderr: '' }

describe('runRemoteGit', () => {
  test('retries one transient failure and returns the successful attempt', () => {
    const { env, calls } = scripted([TIMEOUT, OK])
    const run = runRemoteGit(env, ['ls-remote', 'https://github.com/o/r.git', 'HEAD'])
    expect(run).toEqual({ result: OK, attempts: 2 })
    expect(calls).toEqual([
      { args: ['ls-remote', 'https://github.com/o/r.git', 'HEAD'], timeoutMs: 60_000 },
      { args: ['ls-remote', 'https://github.com/o/r.git', 'HEAD'], timeoutMs: 60_000 },
    ])
  })

  test('stops at the configured attempt budget and timeout', () => {
    const { env, calls } = scripted([TIMEOUT])
    const run = runRemoteGit(env, ['clone', 'x'], { attempts: 2, timeoutMs: 300_000 })
    expect(run.attempts).toBe(2)
    expect(run.result.code).toBe(128)
    expect(calls.map((call) => call.timeoutMs)).toEqual([300_000, 300_000])
  })

  test('does not retry a non-transient failure', () => {
    const { env, calls } = scripted([{ code: 128, stdout: '', stderr: "fatal: couldn't find remote ref HEAD" }])
    expect(runRemoteGit(env, ['fetch']).attempts).toBe(1)
    expect(calls).toHaveLength(1)
    expect(TRANSIENT_REMOTE_FAILURE.test("couldn't find remote ref")).toBe(false)
  })
})
