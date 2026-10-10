import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const config = join(root, 'tools', 'fixtures', 'vitest-isolation', 'vitest.config.mjs')

// 在 Tenon 会话里，或经 `tenon test run`，宿主进程带着这些变量；测试进程必须无视它们。
const HOST_ENV = {
  TENON_USER: 'someone@example.com',
  TENON_USER_NAME: 'Someone',
  TENON_RUNTIME_ROOTS: '{"data":"/host/data","state":"/host/state","config":"/host/config"}',
  TENON_RUNTIME_DATA_ROOT: '/host/data',
  TENON_RUNTIME_STATE_ROOT: '/host/state',
  TENON_RUNTIME_CONFIG_ROOT: '/host/config',
  TENON_BASE_BRANCH: 'main',
  TENON_CHANGE_NAME: 'host-change',
}

function runProbe(extraEnv) {
  return spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', config], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...HOST_ENV, ...extraEnv },
  })
}

test('the vitest setup overrides a host-declared identity, runtime home and change context', () => {
  const hostHome = mkdtempSync(join(tmpdir(), 'tenon-host-home-'))
  try {
    const result = runProbe({ TENON_RUNTIME_HOME: hostHome, PROBE_HOST_RUNTIME_HOME: hostHome })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    // 宿主的运行时根一个字节都没被写。
    assert.deepEqual(readdirSync(hostHome), [])
  } finally {
    rmSync(hostHome, { recursive: true, force: true })
  }
})

test('the probe fails without the setup when the host context leaks in (the assertion is not vacuous)', () => {
  const control = join(root, 'tools', 'fixtures', 'vitest-isolation', 'vitest.no-setup.config.mjs')
  const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', control], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...HOST_ENV, TENON_RUNTIME_HOME: '/host/home', PROBE_HOST_RUNTIME_HOME: '/host/home' },
  })
  assert.notEqual(result.status, 0)
  assert.match(`${result.stdout}${result.stderr}`, /expected 'someone@example\.com' to be 'tester@tenon\.test'/)
})
