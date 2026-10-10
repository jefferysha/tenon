import { describe, expect, test } from 'vitest'
import type { DevInstallMarker } from '../runtime/dev-install-marker.js'
import type { RuntimeInstaller } from '../runtime/installer.js'
import type { RuntimeDevSource, RuntimeReleaseManifest } from '../runtime/types.js'
import { makeDeps } from '../test-support.js'
import type { ReleasedDashboardStarter } from './dashboard.js'
import type { SetupEnv } from './setupEnvironment.js'
import { decideDevUpdate } from './update-dev-guard.js'
import { cmdUpdate } from './update.js'

const RELEASE_ID = `sha256-${'e'.repeat(64)}`
const DEV: RuntimeDevSource = {
  kind: 'dev', repoRealpath: '/work/tenon', commit: 'abcdef0123456789abcdef0123456789abcdef01', dirty: false,
  worktreeDigest: 'b'.repeat(40), skillsIndexDigest: 'c'.repeat(40),
}
const DEV_RELEASE: RuntimeReleaseManifest = {
  version: 2, releaseId: RELEASE_ID, payloadDigest: 'd'.repeat(64), createdAt: '2026-10-07T00:00:00Z',
  source: { host: 'claude', pluginVersion: '0.3.2' }, devSource: DEV,
}
const STABLE_RELEASE: RuntimeReleaseManifest = {
  version: 2, releaseId: RELEASE_ID, payloadDigest: 'd'.repeat(64), createdAt: '2026-10-07T00:00:00Z',
  source: { host: 'claude', pluginVersion: '0.3.2' },
  stableTarget: { version: '0.3.2', tag: 'v0.3.2', commit: 'a'.repeat(40) },
}

describe('decideDevUpdate', () => {
  test('a development install refuses a plain update and names both ways out', () => {
    const decision = decideDevUpdate(DEV_RELEASE, 'claude', false)
    expect(decision.action).toBe('refuse')
    const text = decision.action === 'refuse' ? decision.message.join('\n') : ''
    expect(text).toContain('0.3.2+dev.abcdef0')
    expect(text).toContain('/work/tenon')
    expect(text).toContain('tenon setup --claude --from-source /work/tenon')
    expect(text).toContain('tenon update --claude --to-stable')
  })

  test('--to-stable proceeds and marks the downgrade check as authorised', () => {
    expect(decideDevUpdate(DEV_RELEASE, 'claude', true)).toEqual({ action: 'proceed', fromDev: true })
  })

  test('a stable install, a missing runtime and a manifest v1 all proceed unchanged', () => {
    expect(decideDevUpdate(STABLE_RELEASE, 'claude', false)).toEqual({ action: 'proceed', fromDev: false })
    expect(decideDevUpdate(STABLE_RELEASE, 'claude', true)).toEqual({ action: 'proceed', fromDev: false })
    expect(decideDevUpdate(null, 'codex', false)).toEqual({ action: 'proceed', fromDev: false })
    expect(decideDevUpdate({
      version: 1, releaseId: RELEASE_ID, payloadDigest: 'd'.repeat(64), createdAt: '2026-10-07T00:00:00Z',
      source: { host: 'claude', pluginVersion: '0.3.2' },
    }, 'claude', false)).toEqual({ action: 'proceed', fromDev: false })
  })
})

describe('decideDevUpdate with the local install-channel marker', () => {
  const MARKER: DevInstallMarker = {
    host: 'codex', releaseId: RELEASE_ID, installedAt: '2026-10-07T12:00:00Z', devSource: DEV,
  }
  const text = (decision: ReturnType<typeof decideDevUpdate>) =>
    decision.action === 'refuse' ? decision.message.join('\n') : ''

  test('the host recorded in the marker wins over the flag of the current command', () => {
    const message = text(decideDevUpdate(DEV_RELEASE, 'claude', false, { marker: MARKER, inspectFailed: false }))
    expect(message).toContain('tenon setup --codex --from-source /work/tenon')
    expect(message).toContain('tenon update --codex --to-stable')
  })

  test('a marker of another release is stale: its host is ignored', () => {
    const stale = { ...MARKER, releaseId: `sha256-${'9'.repeat(64)}` }
    expect(text(decideDevUpdate(DEV_RELEASE, 'claude', false, { marker: stale, inspectFailed: false })))
      .toContain('tenon update --claude --to-stable')
  })

  test('when the runtime cannot be inspected a dev marker still refuses, and --to-stable still proceeds', () => {
    const refused = decideDevUpdate(null, 'claude', false, { marker: MARKER, inspectFailed: true })
    expect(refused.action).toBe('refuse')
    expect(text(refused)).toContain('源码开发安装')
    expect(text(refused)).toContain('tenon update --codex --to-stable')
    expect(decideDevUpdate(null, 'claude', true, { marker: MARKER, inspectFailed: true }))
      .toEqual({ action: 'proceed', fromDev: true })
  })

  test('no marker, or a runtime that was inspected fine as empty, goes to the stable path', () => {
    expect(decideDevUpdate(null, 'claude', false, { marker: null, inspectFailed: true }))
      .toEqual({ action: 'proceed', fromDev: false })
    expect(decideDevUpdate(null, 'claude', false, { marker: MARKER, inspectFailed: false }))
      .toEqual({ action: 'proceed', fromDev: false })
  })
})

function fixtures(active: RuntimeReleaseManifest, activeValid = true) {
  const binding = {
    executable: '/usr/bin/claude',
    verify: () => true,
    invocation: (args: readonly string[]) => ({ file: '/usr/bin/claude', args: [...args] }),
  }
  const env = {
    homeDir: () => '/home/test',
    runtimeEnv: () => ({}),
    resolveHostCommand: () => binding,
  } as unknown as SetupEnv
  const installer = {
    inspect: async () => ({
      selection: { version: 1, revision: 1, activeRelease: active.releaseId, previousRelease: null, updatedAt: '2026-10-07T00:00:00Z' },
      active, previous: null, activeValid, previousValid: false, lastAudit: null,
    }),
    // runNativeUpdate 的第一步：让它在这里失败，证明守卫已经放行而没有真的去更新。
    peekManagedJournal: async () => { throw new Error('probe stops here') },
    withManagedTransaction: async () => { throw new Error('no transaction expected') },
    rollback: async () => { throw new Error('unused') },
  } as unknown as RuntimeInstaller
  const starter = {
    inspect: async () => null, adopt: async () => null,
    start: async () => { throw new Error('no dashboard expected') },
  } as unknown as ReleasedDashboardStarter
  const resolver = { resolve: async () => { throw new Error('the release must not be resolved') } }
  return { env, installer, starter, resolver }
}

describe('cmdUpdate with a development install', () => {
  test('refuses before resolving any release or touching the host', async () => {
    const deps = makeDeps()
    const { env, installer, starter, resolver } = fixtures(DEV_RELEASE)
    expect(await cmdUpdate(deps, { claude: true }, env, installer, starter, resolver)).toBe(1)
    const err = deps.errLines.join('\n')
    expect(err).toContain('源码开发安装')
    expect(err).toContain('--to-stable')
    expect(err).not.toContain('must not be resolved')
  })

  test('still refuses when the dev release fails validation (fail-closed, never replaced silently)', async () => {
    const deps = makeDeps()
    const { env, installer, starter, resolver } = fixtures(DEV_RELEASE, false)
    expect(await cmdUpdate(deps, { claude: true }, env, installer, starter, resolver)).toBe(1)
    expect(deps.errLines.join('\n')).toContain('源码开发安装')
  })

  test('--to-stable passes the guard and continues into the stable update path', async () => {
    const deps = makeDeps()
    const { env, installer, starter, resolver } = fixtures(DEV_RELEASE)
    expect(await cmdUpdate(deps, { claude: true, toStable: true }, env, installer, starter, resolver)).toBe(1)
    const err = deps.errLines.join('\n')
    expect(err).not.toContain('源码开发安装')
    expect(err).toContain('probe stops here')
  })

  test('a stable install never sees the guard', async () => {
    const deps = makeDeps()
    const { env, installer, starter, resolver } = fixtures(STABLE_RELEASE)
    expect(await cmdUpdate(deps, { claude: true }, env, installer, starter, resolver)).toBe(1)
    expect(deps.errLines.join('\n')).not.toContain('源码开发安装')
  })
})
