import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { makeDeps } from '../test-support.js'
import {
  cmdDashboard,
  REAL_DASHBOARD_RUNTIME,
  startReleasedDashboard,
  type DashboardCommandEnvironment,
  type DashboardRuntime,
} from './dashboard.js'
import { createReleasedDashboardStarter } from './released-dashboard-starter.js'

interface Calls {
  launches: Array<{ serverBundle: string; env: NodeJS.ProcessEnv; nodeExecutable?: string }>
  detached: Array<{ serverBundle: string; env: NodeJS.ProcessEnv; nodeExecutable?: string }>
  healthPorts: number[]
  expectedReleaseIds: Array<string | undefined>
  expectedStateScopeIds: string[]
  expectedTransactionIds: Array<string | undefined>
  openedUrls: string[]
  terminated: number
}

const TEST_NODE_PATH = '/trusted/dashboard-test-node'
const TEST_DASHBOARD_COMMAND_ENV: DashboardCommandEnvironment = {
  resolveTrustedNode: () => ({
    executable: TEST_NODE_PATH,
    requestedPath: TEST_NODE_PATH,
    proof: {
      version: 1,
      platform: process.platform,
      requestedPath: TEST_NODE_PATH,
      executable: {
        path: TEST_NODE_PATH,
        dev: 1,
        ino: 1,
        mode: 0o100755,
        uid: 0,
        size: 1,
      },
      parents: [],
      sha256: '0'.repeat(64),
    },
    verify: () => true,
    assert: () => {},
  }),
}

function runtime(overrides: Partial<DashboardRuntime> = {}): { runtime: DashboardRuntime; calls: Calls } {
  const calls: Calls = {
    launches: [],
    detached: [],
    healthPorts: [],
    expectedReleaseIds: [],
    expectedStateScopeIds: [],
    expectedTransactionIds: [],
    openedUrls: [],
    terminated: 0,
  }
  return {
    runtime: {
      resolveRoot: () => '/plugin/tenon',
      fileExists: () => true,
      launch: async (serverBundle, env, nodeExecutable) => {
        calls.launches.push({ serverBundle, env, nodeExecutable })
        return 0
      },
      launchDetached: async (serverBundle, env, nodeExecutable) => {
        calls.detached.push({ serverBundle, env, nodeExecutable })
        return {
          pid: 321,
          terminate: async () => {
            calls.terminated += 1
          },
        }
      },
      resolveStateScopeId: () => `sha256-v1-${'1'.repeat(64)}`,
      waitForHealthyServer: async (
        port,
        expectedReleaseId,
        expectedStateScopeId,
        expectedTransactionId,
      ) => {
        calls.healthPorts.push(port)
        calls.expectedReleaseIds.push(expectedReleaseId)
        calls.expectedStateScopeIds.push(expectedStateScopeId)
        calls.expectedTransactionIds.push(expectedTransactionId)
        return {
          version: 1,
          port,
          pid: 321,
          releaseId: expectedReleaseId ?? 'unmanaged',
          stateScopeId: expectedStateScopeId,
          ...(expectedTransactionId === undefined ? {} : { transactionId: expectedTransactionId }),
        }
      },
      probeHealthyServer: async () => null,
      stopOwnedDashboard: async () => {
        calls.terminated += 1
        return true
      },
      openBrowser: async (url) => {
        calls.openedUrls.push(url)
        return true
      },
      ...overrides,
    },
    calls,
  }
}

describe('tenon dashboard', () => {
  test('starts the server and SPA bundled inside the installed plugin, with the default single port', async () => {
    const deps = makeDeps()
    const { runtime: dashboard, calls } = runtime()

    expect(await cmdDashboard(deps, {}, dashboard, TEST_DASHBOARD_COMMAND_ENV)).toBe(0)
    expect(calls.launches).toHaveLength(1)
    expect(calls.launches[0]?.serverBundle).toBe('/plugin/tenon/packages/server/dist/dashboard.mjs')
    expect(calls.launches[0]?.env.TENON_DASHBOARD_PORT).toBe('18765')
    expect(deps.outLines.join('\n')).toContain('http://127.0.0.1:18765/')
    expect(deps.outLines.join('\n')).toContain('/plugin/tenon/packages/dashboard-app/dist/index.html')
  })

  test('supports the former 8765 port as an explicit compatibility override', async () => {
    const deps = makeDeps()
    const { runtime: dashboard, calls } = runtime()

    expect(await cmdDashboard(
      deps,
      { port: '8765' },
      dashboard,
      TEST_DASHBOARD_COMMAND_ENV,
    )).toBe(0)
    expect(calls.launches[0]?.env.TENON_DASHBOARD_PORT).toBe('8765')
    expect(deps.outLines.join('\n')).toContain('http://127.0.0.1:8765/')
  })

  test('background mode waits for the managed dashboard health check before opening the browser', async () => {
    const deps = makeDeps()
    const { runtime: dashboard, calls } = runtime()

    expect(await cmdDashboard(
      deps,
      { background: true, open: true },
      dashboard,
      TEST_DASHBOARD_COMMAND_ENV,
    )).toBe(0)
    expect(calls.launches).toEqual([])
    expect(calls.detached).toHaveLength(1)
    expect(calls.detached[0]?.serverBundle).toBe('/plugin/tenon/packages/server/dist/dashboard.mjs')
    expect(calls.detached[0]?.env.TENON_DASHBOARD_PORT).toBe('18765')
    expect(calls.healthPorts).toEqual([18765])
    expect(calls.expectedReleaseIds).toEqual([undefined])
    expect(calls.expectedStateScopeIds).toEqual([`sha256-v1-${'1'.repeat(64)}`])
    expect(calls.expectedTransactionIds).toEqual([undefined])
    expect(calls.openedUrls).toEqual(['http://127.0.0.1:18765/'])
    expect(deps.outLines.join('\n')).toContain('健康检查通过')
  })

  describe('a dashboard that already runs', () => {
    const running = (port = 18765) => ({
      version: 1 as const,
      port,
      pid: 4242,
      releaseId: 'unmanaged',
      stateScopeId: `sha256-v1-${'1'.repeat(64)}`,
    })

    test('--open asks the running server to open the signed-in browser; it starts and freezes nothing', async () => {
      const deps = makeDeps()
      const { runtime: dashboard, calls } = runtime({ probeHealthyServer: async () => running() })
      // No trusted Node is needed to talk to a server that is already up.
      const noNode: DashboardCommandEnvironment = { resolveTrustedNode: () => undefined }

      expect(await cmdDashboard(deps, { open: true }, dashboard, noNode)).toBe(0)
      expect(calls.detached).toEqual([])
      expect(calls.launches).toEqual([])
      expect(calls.openedUrls).toEqual(['http://127.0.0.1:18765/'])
      const output = deps.outLines.join('\n')
      expect(output).toContain('已在运行')
      expect(output).toContain('一次性登录链接只交给浏览器')
    })

    test('--background is a no-op that says how to sign in', async () => {
      const deps = makeDeps()
      const { runtime: dashboard, calls } = runtime({ probeHealthyServer: async () => running() })

      expect(await cmdDashboard(deps, { background: true }, dashboard, TEST_DASHBOARD_COMMAND_ENV)).toBe(0)
      expect(calls.detached).toEqual([])
      expect(calls.openedUrls).toEqual([])
      expect(deps.outLines.join('\n')).toContain('tenon dashboard --open')
    })

    test('--open fails with headless guidance when the server could not open a browser', async () => {
      const deps = makeDeps()
      const { runtime: dashboard, calls } = runtime({
        probeHealthyServer: async () => running(),
        openBrowser: async () => false,
      })

      expect(await cmdDashboard(deps, { open: true }, dashboard, TEST_DASHBOARD_COMMAND_ENV)).toBe(1)
      expect(calls.detached).toEqual([])
      const errors = deps.errLines.join('\n')
      expect(errors).toContain('无法自动打开浏览器')
      expect(errors).toContain('一次性登录链接')
    })

    test('a probe that throws falls back to the normal managed start', async () => {
      const deps = makeDeps()
      const { runtime: dashboard, calls } = runtime({
        probeHealthyServer: async () => { throw new Error('probe exploded') },
      })

      expect(await cmdDashboard(deps, { open: true }, dashboard, TEST_DASHBOARD_COMMAND_ENV)).toBe(0)
      expect(calls.detached).toHaveLength(1)
      expect(calls.openedUrls).toEqual(['http://127.0.0.1:18765/'])
    })
  })

  test('release coordinator inspect observes any transaction identity without granting ownership', async () => {
    const identity = {
      version: 1 as const,
      port: 18765,
      pid: 321,
      releaseId: `sha256-${'a'.repeat(64)}`,
      stateScopeId: `sha256-v1-${'1'.repeat(64)}`,
      transactionId: 'transaction-other',
    }
    const observations: Array<string | undefined> = []
    const { runtime: dashboard } = runtime({
      probeHealthyServer: async (_port, _release, _scope, transactionPolicy) => {
        observations.push(transactionPolicy)
        return identity
      },
    })

    await expect(createReleasedDashboardStarter(dashboard).inspect(makeDeps(), {}))
      .resolves.toEqual(identity)
    expect(observations).toEqual(['*'])
  })

  test('immutable release startup requires the exact content-addressed health identity', async () => {
    const deps = makeDeps()
    const { runtime: dashboard, calls } = runtime()
    const releaseId = `sha256-${'a'.repeat(64)}`

    const outcome = await startReleasedDashboard(
      deps,
      `/runtime/releases/${releaseId}/payload`,
      {},
      dashboard,
    )
    expect(outcome).toMatchObject({ state: 'ready' })
    if (outcome.state === 'ready') {
      expect(await outcome.session.stop()).toEqual({ state: 'stopped' })
    }
    expect(calls.expectedReleaseIds).toEqual([releaseId])
    expect(calls.expectedStateScopeIds).toEqual([`sha256-v1-${'1'.repeat(64)}`])
    expect(calls.terminated).toBe(1)
  })

  test('managed release start threads transaction identity through env and readiness', async () => {
    const deps = makeDeps()
    const { runtime: dashboard, calls } = runtime()
    const releaseId = `sha256-${'a'.repeat(64)}`

    const outcome = await startReleasedDashboard(
      deps,
      `/runtime/releases/${releaseId}/payload`,
      { transactionId: 'transaction-dashboard-test' },
      dashboard,
    )

    expect(outcome).toMatchObject({
      state: 'ready',
      session: { ownership: { transactionId: 'transaction-dashboard-test' } },
    })
    expect(calls.detached[0]?.env.TENON_MANAGED_TRANSACTION_ID)
      .toBe('transaction-dashboard-test')
    expect(calls.expectedTransactionIds).toEqual(['transaction-dashboard-test'])
  })

  test('managed release start re-proves and uses the frozen Node immediately before spawn', async () => {
    const deps = makeDeps()
    const { runtime: dashboard, calls } = runtime()
    const releaseId = `sha256-${'a'.repeat(64)}`
    let verifies = 0

    expect(await startReleasedDashboard(
      deps,
      `/runtime/releases/${releaseId}/payload`,
      {
        transactionId: 'transaction-dashboard-node',
        trustedNodePath: '/trusted/node',
        verifyTrustedNode: () => { verifies += 1 },
      },
      dashboard,
    )).toMatchObject({ state: 'ready' })

    expect(verifies).toBe(1)
    expect(calls.detached).toEqual([expect.objectContaining({ nodeExecutable: '/trusted/node' })])
  })

  test('managed release start rejects frozen Node drift before spawning Dashboard', async () => {
    const deps = makeDeps()
    const { runtime: dashboard, calls } = runtime()
    const releaseId = `sha256-${'a'.repeat(64)}`

    expect(await startReleasedDashboard(
      deps,
      `/runtime/releases/${releaseId}/payload`,
      {
        trustedNodePath: '/trusted/node',
        verifyTrustedNode: () => { throw new Error('frozen node changed') },
      },
      dashboard,
    )).toMatchObject({
      state: 'indeterminate',
      detail: expect.stringContaining('frozen node changed'),
    })
    expect(calls.detached).toEqual([])
  })

  test('dashboard command uses one frozen Node for foreground and background starts', async () => {
    const foreground = runtime()
    let foregroundVerifies = 0
    expect(await cmdDashboard(makeDeps(), {}, foreground.runtime, {
      resolveTrustedNode: () => ({
        executable: '/trusted/dashboard-node',
        requestedPath: '/trusted/dashboard-node',
        verify: () => true,
        assert: () => { foregroundVerifies += 1 },
      }),
    })).toBe(0)
    expect(foreground.calls.launches).toEqual([
      expect.objectContaining({ nodeExecutable: '/trusted/dashboard-node' }),
    ])
    expect(foregroundVerifies).toBe(1)

    const background = runtime()
    let backgroundVerifies = 0
    expect(await cmdDashboard(makeDeps(), { background: true }, background.runtime, {
      resolveTrustedNode: () => ({
        executable: '/trusted/dashboard-node',
        requestedPath: '/trusted/dashboard-node',
        verify: () => true,
        assert: () => { backgroundVerifies += 1 },
      }),
    })).toBe(0)
    expect(background.calls.detached).toEqual([
      expect.objectContaining({ nodeExecutable: '/trusted/dashboard-node' }),
    ])
    expect(backgroundVerifies).toBe(1)
  })

  test('dashboard command rejects frozen Node drift before any foreground or detached spawn', async () => {
    for (const opts of [{}, { background: true }]) {
      const candidate = runtime()
      expect(await cmdDashboard(makeDeps(), opts, candidate.runtime, {
        resolveTrustedNode: () => ({
          executable: '/trusted/dashboard-node',
          requestedPath: '/trusted/dashboard-node',
          verify: () => false,
          assert: () => { throw new Error('node drift') },
        }),
      })).toBe(1)
      expect(candidate.calls.launches).toEqual([])
      expect(candidate.calls.detached).toEqual([])
    }
  })

  test('managed release start rejects health served by a PID other than the spawned child', async () => {
    const deps = makeDeps()
    const releaseId = `sha256-${'a'.repeat(64)}`
    const { runtime: dashboard, calls } = runtime({
      waitForHealthyServer: async (port, expectedReleaseId, expectedStateScopeId, expectedTransactionId) => ({
        version: 1,
        port,
        pid: 999,
        releaseId: expectedReleaseId ?? 'unmanaged',
        stateScopeId: expectedStateScopeId,
        ...(expectedTransactionId === undefined ? {} : { transactionId: expectedTransactionId }),
      }),
    })

    expect(await startReleasedDashboard(
      deps,
      `/runtime/releases/${releaseId}/payload`,
      { transactionId: 'transaction-dashboard-test' },
      dashboard,
    )).toMatchObject({
      state: 'failed',
      detail: expect.stringContaining('identity'),
    })
    expect(calls.terminated).toBe(1)
  })

  test('managed startup rejects a payload path without a release identity before spawning', async () => {
    const deps = makeDeps()
    const { runtime: dashboard, calls } = runtime()

    expect(await startReleasedDashboard(deps, '/mutable/plugin', {}, dashboard)).toMatchObject({
      state: 'failed',
    })
    expect(calls.detached).toEqual([])
    expect(deps.errLines.join('\n')).toContain('release identity')
  })

  test('background mode fails closed when the spawned process never exposes a pipeline health endpoint', async () => {
    const deps = makeDeps()
    const { runtime: dashboard, calls } = runtime({ waitForHealthyServer: async () => null })

    expect(await cmdDashboard(
      deps,
      { background: true, open: true },
      dashboard,
      TEST_DASHBOARD_COMMAND_ENV,
    )).toBe(1)
    expect(calls.openedUrls).toEqual([])
    expect(calls.terminated).toBe(1)
    expect(deps.errLines.join('\n')).toContain('未通过健康检查')
  })

  test('managed startup exposes unconfirmed candidate termination instead of reporting a compensatable readiness failure', async () => {
    const deps = makeDeps()
    const releaseId = `sha256-${'a'.repeat(64)}`
    const { runtime: dashboard } = runtime({
      waitForHealthyServer: async () => null,
      launchDetached: async () => ({
        pid: 321,
        terminate: async () => {
          throw new Error('process still owns the port')
        },
      }),
    })

    expect(await startReleasedDashboard(
      deps,
      `/runtime/releases/${releaseId}/payload`,
      {},
      dashboard,
    )).toMatchObject({
      state: 'indeterminate',
      detail: 'process still owns the port',
    })
  })

  test('terminates the spawned candidate when state-scope resolution throws', async () => {
    const deps = makeDeps()
    const releaseId = `sha256-${'a'.repeat(64)}`
    const { runtime: dashboard, calls } = runtime({
      resolveStateScopeId: () => {
        throw new Error('state root contract unavailable')
      },
    })

    expect(await startReleasedDashboard(
      deps,
      `/runtime/releases/${releaseId}/payload`,
      {},
      dashboard,
    )).toMatchObject({
      state: 'failed',
      detail: expect.stringContaining('state root contract unavailable'),
    })
    expect(calls.terminated).toBe(1)
  })

  test('terminates the spawned candidate when the health probe throws', async () => {
    const deps = makeDeps()
    const releaseId = `sha256-${'a'.repeat(64)}`
    const { runtime: dashboard, calls } = runtime({
      waitForHealthyServer: async () => {
        throw new Error('health transport failed')
      },
    })

    expect(await startReleasedDashboard(
      deps,
      `/runtime/releases/${releaseId}/payload`,
      {},
      dashboard,
    )).toMatchObject({
      state: 'failed',
      detail: expect.stringContaining('health transport failed'),
    })
    expect(calls.terminated).toBe(1)
  })

  test('real detached termination resolves only after a SIGTERM-resistant process has exited', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-dashboard-termination-'))
    const pidPath = join(root, 'pid')
    const bundle = join(root, 'server.mjs')
    try {
      await writeFile(bundle, `
import { writeFileSync } from 'node:fs'
writeFileSync(process.env.TENON_TEST_PID_PATH, String(process.pid))
process.on('SIGTERM', () => {})
setInterval(() => {}, 1000)
`, 'utf8')
      await chmod(bundle, 0o755)
      const handle = await REAL_DASHBOARD_RUNTIME.launchDetached(bundle, {
        ...process.env,
        TENON_TEST_PID_PATH: pidPath,
      })
      expect(handle).not.toBeNull()

      let pid = 0
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          pid = Number.parseInt(await readFile(pidPath, 'utf8'), 10)
          break
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
      }
      expect(pid).toBeGreaterThan(0)

      await handle?.terminate()
      expect(() => process.kill(pid, 0)).toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 10_000)

  test('dry-run verifies the released assets without launching a child process', async () => {
    const deps = makeDeps()
    const { runtime: dashboard, calls } = runtime()

    expect(await cmdDashboard(deps, { dryRun: true }, dashboard)).toBe(0)
    expect(calls.launches).toEqual([])
    expect(deps.outLines.join('\n')).toContain('--dry-run')
  })

  test('fails before launch when either release asset is absent', async () => {
    const deps = makeDeps()
    const { runtime: dashboard, calls } = runtime({
      fileExists: (path) => !path.endsWith('/packages/dashboard-app/dist/index.html'),
    })

    expect(await cmdDashboard(deps, {}, dashboard)).toBe(1)
    expect(calls.launches).toEqual([])
    expect(deps.errLines.join('\n')).toContain('缺少已发布 dashboard 资产')
    expect(deps.errLines.join('\n')).toContain('tenon update --codex')
  })

  test('rejects an invalid port before inspecting or launching the package', async () => {
    const deps = makeDeps()
    const { runtime: dashboard, calls } = runtime({
      fileExists: () => {
        throw new Error('asset lookup must not run')
      },
    })

    expect(await cmdDashboard(deps, { port: '70000' }, dashboard)).toBe(1)
    expect(calls.launches).toEqual([])
    expect(deps.errLines.join('\n')).toContain('1 到 65535')
  })
})
