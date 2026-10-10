import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { REAL_SETUP_ENV } from './setupEnvironment.js'

const previousRuntimeHome = process.env.TENON_RUNTIME_HOME
let runtimeHome: string | undefined
afterEach(() => {
  if (previousRuntimeHome === undefined) delete process.env.TENON_RUNTIME_HOME
  else process.env.TENON_RUNTIME_HOME = previousRuntimeHome
  if (runtimeHome !== undefined) rmSync(runtimeHome, { recursive: true, force: true })
  runtimeHome = undefined
})

describe('REAL_SETUP_ENV.withHostMutationLock', () => {
  test('takes the host lock on a fresh runtime home whose state directory does not exist yet', async () => {
    runtimeHome = mkdtempSync(join(tmpdir(), 'tenon-host-lock-'))
    process.env.TENON_RUNTIME_HOME = runtimeHome
    const withLock = REAL_SETUP_ENV.withHostMutationLock
    expect(withLock).toBeDefined()
    await expect(withLock?.('claude', async () => 'locked-ok')).resolves.toBe('locked-ok')
  })
})

describe('REAL_SETUP_ENV.runCommand', () => {
  test('surfaces timeout diagnostics from execFileSync in stderr', () => {
    const result = REAL_SETUP_ENV.runCommand(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 1000)'],
      { timeoutMs: 20 },
    )

    expect(result.code).not.toBe(0)
    expect(result.stderr).not.toBe('')
    expect(result.stderr).toMatch(/timeout|ETIMEDOUT/i)
  })
})
