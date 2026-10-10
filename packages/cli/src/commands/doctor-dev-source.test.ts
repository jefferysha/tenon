import { appendFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import type { SourceDriftFacts } from '../deps.js'
import { computeDevSourceIdentity } from '../runtime/dev-source-identity.js'
import {
  cleanupSourceRepoFixtures, makeSourceRepo, trackFixtureRoot,
} from '../runtime/dev-source-test-support.js'
import type { RuntimeInstaller } from '../runtime/installer.js'
import { resolveRuntimePaths } from '../runtime/paths.js'
import { runtimeReleaseIdV2 } from '../runtime/release-store-codecs.js'
import type { RuntimeDevSource, RuntimeReleaseManifest } from '../runtime/types.js'
import { mockDoctorProbes } from '../test-support.js'
import { checkProductIdentity, createDoctorProductIdentityProbe } from './doctor-product-identity.js'
import { checkSourceDrift, collectSourceDriftFacts } from './doctor-source-drift.js'

const DEV: RuntimeDevSource = {
  kind: 'dev', repoRealpath: '/work/tenon', commit: 'abcdef0123456789abcdef0123456789abcdef01', dirty: true,
  worktreeDigest: 'b'.repeat(40), skillsIndexDigest: 'c'.repeat(40),
}
const SOURCE = { host: 'claude' as const, pluginVersion: '0.3.2' }
const DEV_MANIFEST: RuntimeReleaseManifest = {
  version: 2,
  releaseId: runtimeReleaseIdV2('d'.repeat(64), SOURCE, undefined, DEV),
  payloadDigest: 'd'.repeat(64),
  createdAt: '2026-10-07T00:00:00Z',
  source: SOURCE,
  devSource: DEV,
}

describe('identity:release for a development install', () => {
  test('is yellow, shows the +dev label and names both ways out', async () => {
    const check = await checkProductIdentity(mockDoctorProbes({
      productIdentity: async () => ({
        state: 'dev', host: 'claude', runtimePluginVersion: '0.3.2', runtimeReleaseId: DEV_MANIFEST.releaseId,
        repoRealpath: DEV.repoRealpath, commit: DEV.commit, dirty: true,
      }),
    }))
    expect(check.id).toBe('identity:release')
    expect(check.status).toBe('yellow')
    expect(check.detail).toContain('0.3.2+dev.abcdef0')
    expect(check.detail).toContain('/work/tenon')
    expect(check.hint).toContain('tenon setup --claude --from-source /work/tenon')
    expect(check.hint).toContain('tenon update --claude --to-stable')
  })

  test('the real probe reports dev from a development manifest without needing a stable target or the host', async () => {
    const homeDir = '/home/doctor-dev-test'
    const env = { PATH: '/trusted/bin' }
    const scope = { homeDir, env, paths: resolveRuntimePaths({ homeDir, env }) }
    const trusted = { executable: '/trusted/bin/x', requestedPath: '/trusted/bin/x', verify: () => true, assert: () => {}, proof: {} }
    const installer = {
      inspect: async () => ({
        selection: { version: 1, revision: 1, activeRelease: DEV_MANIFEST.releaseId, previousRelease: null, updatedAt: '2026-10-07T00:00:00Z' },
        active: DEV_MANIFEST, previous: null, activeValid: true, previousValid: false, lastAudit: null,
      }),
    } as unknown as RuntimeInstaller
    const unreachable = (): never => { throw new Error('the development branch must not touch the host, the payload or the dashboard') }
    const probe = createDoctorProductIdentityProbe(() => scope, installer, {
      resolveTrustedCommand: () => trusted,
      resolveHostCommand: unreachable,
      readText: unreachable,
      run: unreachable,
      inspectCandidate: unreachable,
      probeDashboard: unreachable,
    } as never)
    expect(await probe()).toEqual({
      state: 'dev', host: 'claude', runtimePluginVersion: '0.3.2', runtimeReleaseId: DEV_MANIFEST.releaseId,
      repoRealpath: '/work/tenon', commit: DEV.commit, dirty: true,
    })
  })
})

afterEach(cleanupSourceRepoFixtures)

function drift(facts: SourceDriftFacts) {
  return checkSourceDrift(mockDoctorProbes({ sourceDrift: async () => facts }))
}

describe('source:drift check', () => {
  test('outside a Tenon source repository it is green and says so', async () => {
    const check = await drift({ state: 'not-source-repo' })
    expect(check).toMatchObject({ id: 'source:drift', status: 'green' })
    expect(check.detail).toContain('不适用')
  })

  test('a source repository with no verified runtime is yellow and offers the install command', async () => {
    const check = await drift({ state: 'source-repo', repo: '/work/tenon', installed: null, live: DEV })
    expect(check.status).toBe('yellow')
    expect(check.hint).toContain('tenon setup --claude --from-source /work/tenon')
  })

  test('a stable install inside the source repository is yellow and uses the installed host in the command', async () => {
    const check = await drift({
      state: 'source-repo', repo: '/work/tenon', live: DEV,
      installed: { channel: 'stable', host: 'codex', version: '0.3.2' },
    })
    expect(check.status).toBe('yellow')
    expect(check.detail).toContain('正式版 0.3.2')
    expect(check.hint).toContain('tenon setup --codex --from-source /work/tenon')
  })

  test('an in-sync development install is green; commit and dirty alone are not drift', async () => {
    const check = await drift({
      state: 'source-repo', repo: '/work/tenon',
      installed: { channel: 'dev', host: 'claude', releaseId: DEV_MANIFEST.releaseId, devSource: DEV },
      live: { ...DEV, commit: 'f'.repeat(40), dirty: false },
    })
    expect(check.status).toBe('green')
  })

  test('a drifted development install is yellow, lists the reasons and offers the sync command', async () => {
    const check = await drift({
      state: 'source-repo', repo: '/work/tenon',
      installed: { channel: 'dev', host: 'claude', releaseId: DEV_MANIFEST.releaseId, devSource: DEV },
      live: { ...DEV, worktreeDigest: '1'.repeat(40) },
    })
    expect(check.status).toBe('yellow')
    expect(check.detail).toContain('安装内容已变')
    expect(check.hint).toContain('tenon setup --claude --from-source /work/tenon')
  })

  test('a live identity that cannot be computed is yellow, not red', async () => {
    const check = await drift({
      state: 'source-repo', repo: '/work/tenon',
      installed: { channel: 'dev', host: 'claude', releaseId: DEV_MANIFEST.releaseId, devSource: DEV },
      live: { error: 'git 不可用' },
    })
    expect(check.status).toBe('yellow')
    expect(check.detail).toContain('git 不可用')
  })

  test('a probe that was never wired is visible as yellow', async () => {
    const probes = mockDoctorProbes()
    const check = await checkSourceDrift({ ...probes, sourceDrift: undefined })
    expect(check.status).toBe('yellow')
  })
})

describe('collectSourceDriftFacts', () => {
  test('outside any git repository, and inside a git repository that is not a Tenon source repository, there is nothing to compare', async () => {
    const bare = trackFixtureRoot(realpathSync(mkdtempSync(join(tmpdir(), 'tenon-drift-bare-'))))
    expect(await collectSourceDriftFacts({ cwd: bare, inspectActive: async () => null })).toEqual({ state: 'not-source-repo' })
    const notTenon = makeSourceRepo()
    rmSync(join(notTenon, 'runtime', 'tenon-bootstrap.mjs'))
    expect(await collectSourceDriftFacts({ cwd: notTenon, inspectActive: async () => null })).toEqual({ state: 'not-source-repo' })
  })

  test('from a sub directory of the source repository it resolves the repository root', async () => {
    const root = makeSourceRepo()
    const facts = await collectSourceDriftFacts({ cwd: join(root, 'hooks'), inspectActive: async () => null })
    expect(facts).toMatchObject({ state: 'source-repo', repo: root, installed: null })
    expect(facts.state === 'source-repo' && 'error' in facts.live).toBe(false)
  })

  test('an installed development source equal to the workspace is green, and goes yellow after an installed-content edit', async () => {
    const root = makeSourceRepo()
    const installedSource = computeDevSourceIdentity(root)
    const manifest: RuntimeReleaseManifest = {
      version: 2,
      releaseId: runtimeReleaseIdV2('d'.repeat(64), SOURCE, undefined, installedSource),
      payloadDigest: 'd'.repeat(64),
      createdAt: '2026-10-07T00:00:00Z',
      source: SOURCE,
      devSource: installedSource,
    }
    const check = async () => checkSourceDrift(mockDoctorProbes({
      sourceDrift: () => collectSourceDriftFacts({ cwd: root, inspectActive: async () => manifest }),
    }))
    expect((await check()).status).toBe('green')
    appendFileSync(join(root, 'hooks', 'gate.sh'), '# edited after install\n')
    const after = await check()
    expect(after.status).toBe('yellow')
    expect(after.detail).toContain('安装内容已变')
  })

  test('a stable manifest is reported as stable with its host and version', async () => {
    const root = makeSourceRepo()
    const stable: RuntimeReleaseManifest = {
      version: 2, releaseId: `sha256-${'e'.repeat(64)}`, payloadDigest: 'd'.repeat(64), createdAt: '2026-10-07T00:00:00Z',
      source: SOURCE, stableTarget: { version: '0.3.2', tag: 'v0.3.2', commit: 'a'.repeat(40) },
    }
    const facts = await collectSourceDriftFacts({ cwd: root, inspectActive: async () => stable })
    expect(facts).toMatchObject({ installed: { channel: 'stable', host: 'claude', version: '0.3.2' } })
  })

  test('an inspectActive that throws still yields facts instead of an exception (doctor never throws)', async () => {
    const root = makeSourceRepo()
    const facts = await collectSourceDriftFacts({
      cwd: root,
      inspectActive: async () => { throw new Error('runtime unreadable') },
    })
    expect(facts).toMatchObject({ state: 'source-repo', repo: root, installed: null })
  })
})
