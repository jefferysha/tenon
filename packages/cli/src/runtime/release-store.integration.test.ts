import { execFile } from 'node:child_process'
import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build as esbuild } from 'esbuild'
import { serializeProductRootContract } from '@tenon/kernel'
import { afterEach, describe, expect, it } from 'vitest'
import { TENON_RELEASE_VERSION } from '../commands/plugin-host.js'
import { publishManagedRelease } from '../commands/release-coordinator.js'
import type { ReleasedDashboardStarter } from '../commands/dashboard.js'
import { makeDeps } from '../test-support.js'
import { resolveRuntimePaths } from './paths.js'
import { REAL_RUNTIME_INSTALLER } from './installer.js'
import { captureStableLaunchers, expectedStableLaunchers } from './launchers.js'
import {
  copyReleasePayload,
  hashLegacyReleasePayload,
  hashReleasePayload,
} from './release-payload.js'
import { stableJson, writeAudit } from './release-store-codecs.js'
import { RuntimeReleaseStore } from './release-store.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const roots: string[] = []
const execFileAsync = promisify(execFile)
const CURRENT_RELEASE_TAG = `v${TENON_RELEASE_VERSION}` as const

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

async function freshRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `pipeline-runtime-${label}-`))
  roots.push(root)
  return root
}

async function candidateCopy(root: string, suffix = ''): Promise<string> {
  const candidate = join(root, `candidate${suffix}`)
  const entries = [
    '.agents/plugins/marketplace.json',
    '.claude-plugin/marketplace.json',
    '.claude-plugin/plugin.json',
    '.codex-plugin/plugin.json',
    'adapters',
    'hooks',
    'packages/cli/dist/tenon.mjs',
    'packages/dashboard-app/dist',
    'packages/server/dist/dashboard.mjs',
    'runtime/tenon-bootstrap.mjs',
    'skills',
    'templates',
    'tools/verify-skills.sh',
  ]
  for (const entry of entries) {
    await cp(join(repoRoot, entry), join(candidate, entry), { recursive: true, preserveTimestamps: false })
  }
  return candidate
}

function storeFor(root: string): RuntimeReleaseStore {
  return new RuntimeReleaseStore({
    paths: resolveRuntimePaths({ env: { TENON_RUNTIME_HOME: join(root, 'runtime') }, homeDir: root, platform: 'linux' }),
    now: () => '2026-07-24T00:00:00Z',
    retainedReleases: 3,
  })
}

function pathsFor(root: string) {
  return resolveRuntimePaths({ env: { TENON_RUNTIME_HOME: join(root, 'runtime') }, homeDir: root, platform: 'linux' })
}

function quoteLegacyShell(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function legacyV101LauncherText(
  paths: ReturnType<typeof pathsFor>,
  mode: 'cli' | 'hook',
): string {
  const bootstrap = join(paths.bootstrapRoot, 'active.mjs')
  const missing = mode === 'hook'
    ? 'exit 0'
    : 'printf "tenon runtime bootstrap unavailable; run tenon setup --codex or tenon setup --claude\\n" >&2\n  exit 1'
  return `#!/usr/bin/env bash
set -eu
export TENON_RUNTIME_ROOTS=${quoteLegacyShell(serializeProductRootContract(paths))}
# N-1 bootstrap ABI: previous verified releases read these exact roots during rollback.
export TENON_RUNTIME_DATA_ROOT=${quoteLegacyShell(paths.dataRoot)}
export TENON_RUNTIME_STATE_ROOT=${quoteLegacyShell(paths.stateRoot)}
export TENON_RUNTIME_CONFIG_ROOT=${quoteLegacyShell(paths.configRoot)}
[ -f ${quoteLegacyShell(bootstrap)} ] || { ${missing}; }
exec node ${quoteLegacyShell(bootstrap)} ${mode} "$@"
`
}

async function seedLegacyV101Activation(
  root: string,
  home: string,
  candidate: string,
  host: 'codex' | 'claude',
  pluginVersion = '1.0.1',
) {
  const paths = resolveRuntimePaths({ homeDir: home, env: {} })
  const stagingPayload = join(root, `legacy-${host}-payload`)
  await mkdir(stagingPayload, { recursive: true })
  await copyReleasePayload(candidate, stagingPayload)
  const payloadDigest = await hashLegacyReleasePayload(stagingPayload)
  const releaseId = `sha256-${payloadDigest}`
  const releaseRoot = join(paths.releasesRoot, releaseId)
  await mkdir(releaseRoot, { recursive: true })
  await cp(stagingPayload, join(releaseRoot, 'payload'), { recursive: true, preserveTimestamps: false })
  const release = {
    version: 1 as const,
    releaseId,
    payloadDigest,
    createdAt: '2026-07-24T00:00:00Z',
    source: { host, pluginVersion },
  }
  const selection = {
    version: 1 as const,
    revision: 1,
    activeRelease: releaseId,
    previousRelease: null,
    updatedAt: '2026-07-24T00:00:00Z',
  }
  await writeFile(join(releaseRoot, 'release.json'), stableJson(release))
  await mkdir(paths.stateRoot, { recursive: true })
  await writeFile(paths.selectionPath, stableJson(selection))
  const bin = join(home, '.local', 'bin')
  await mkdir(bin, { recursive: true })
  for (const mode of ['cli', 'hook'] as const) {
    const path = join(bin, mode === 'cli' ? 'tenon' : 'tenon-hook')
    await writeFile(path, legacyV101LauncherText(paths, mode), 'utf8')
    await chmod(path, 0o755)
  }
  return {
    selection,
    release,
    releaseRoot,
    checkpoint: {
      selection: {
        version: 1 as const,
        revision: 0,
        activeRelease: null,
        previousRelease: null,
        updatedAt: '1970-01-01T00:00:00Z',
      },
      launchers: {
        tenon: { path: join(bin, 'tenon'), state: { kind: 'missing' as const } },
        hook: { path: join(bin, 'tenon-hook'), state: { kind: 'missing' as const } },
      },
    },
  }
}

describe('RuntimeReleaseStore', () => {
  const isolatedScope = (homeDir: string) => ({ homeDir, env: {} })

  it('frames payload entries so a file body cannot impersonate the next file record', async () => {
    const root = await freshRoot('framed-payload-digest')
    const oneFile = join(root, 'one-file')
    const twoFiles = join(root, 'two-files')
    await mkdir(join(oneFile, 'templates'), { recursive: true })
    await mkdir(join(twoFiles, 'templates'), { recursive: true })
    const injectedRecord = 'F\u0000templates/collision-b\u0000644\u0000'
    await writeFile(join(oneFile, 'templates', 'collision-a'), `prefix${injectedRecord}suffix`, 'utf8')
    await writeFile(join(twoFiles, 'templates', 'collision-a'), 'prefix', 'utf8')
    await writeFile(join(twoFiles, 'templates', 'collision-b'), 'suffix', 'utf8')

    expect(await hashReleasePayload(oneFile)).not.toBe(await hashReleasePayload(twoFiles))
  })

  it('includes directory mode in the immutable payload identity', async () => {
    const root = await freshRoot('directory-mode-digest')
    const first = join(root, 'first')
    const second = join(root, 'second')
    await mkdir(join(first, 'templates'), { recursive: true, mode: 0o700 })
    await mkdir(join(second, 'templates'), { recursive: true, mode: 0o755 })
    await chmod(join(first, 'templates'), 0o700)
    await chmod(join(second, 'templates'), 0o755)

    expect(await hashReleasePayload(first)).not.toBe(await hashReleasePayload(second))
  })

  it('copies candidate directory modes exactly so the v2 payload identity is independent of umask', async () => {
    const root = await freshRoot('payload-directory-modes')
    const candidate = await candidateCopy(root)
    const restrictive = join(root, 'restrictive-payload')
    const ordinary = join(root, 'ordinary-payload')
    await chmod(join(candidate, 'skills'), 0o755)
    await chmod(join(candidate, '.codex-plugin'), 0o755)
    const originalUmask = process.umask()
    try {
      process.umask(0o077)
      await mkdir(restrictive, { recursive: true })
      await copyReleasePayload(candidate, restrictive)
      process.umask(0o022)
      await mkdir(ordinary, { recursive: true })
      await copyReleasePayload(candidate, ordinary)
    } finally {
      process.umask(originalUmask)
    }

    expect((await stat(join(restrictive, 'skills'))).mode & 0o777).toBe(0o755)
    expect((await stat(join(restrictive, '.codex-plugin'))).mode & 0o777).toBe(0o755)
    expect(await hashReleasePayload(restrictive)).toBe(await hashReleasePayload(ordinary))
  })

  it('holds one product-scoped transaction lock across the caller-defined managed release lifecycle', async () => {
    const root = await freshRoot('managed-transaction-lock')
    const home = join(root, 'home')
    const events: string[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })

    const first = REAL_RUNTIME_INSTALLER.withManagedTransaction(isolatedScope(home), async () => {
      events.push('first:start')
      await firstGate
      events.push('first:end')
    })
    const firstStarted = Date.now() + 10_000
    while (!events.includes('first:start')) {
      if (Date.now() > firstStarted) throw new Error('first transaction never acquired the lock')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const second = REAL_RUNTIME_INSTALLER.withManagedTransaction(isolatedScope(home), async () => {
      events.push('second:start')
      events.push('second:end')
    })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(events).toEqual(['first:start'])
    releaseFirst()
    await Promise.all([first, second])
    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end'])
  })

  it('stages, verifies, and atomically selects a complete candidate release', async () => {
    const root = await freshRoot('activate')
    const candidate = await candidateCopy(root)
    const store = storeFor(root)

    const activated = await store.stageAndActivate(candidate, 'codex')

    expect(activated.release.releaseId).toMatch(/^sha256-[a-f0-9]{64}$/)
    expect(activated.selection.activeRelease).toBe(activated.release.releaseId)
    expect(activated.selection.previousRelease).toBeNull()
    expect((await store.inspect()).activeValid).toBe(true)
  }, 30_000)

  it('executes a newly activated v2 release through the real stable launcher', async () => {
    const root = await freshRoot('v2-stable-launcher')
    const home = join(root, 'home')
    const candidate = await candidateCopy(root)
    await writeFile(
      join(candidate, 'packages', 'cli', 'dist', 'tenon.mjs'),
      'process.stdout.write(`V2_RUNTIME_CLI:${process.argv.slice(2).join(",")}`)\n',
      'utf8',
    )
    const target = {
      version: TENON_RELEASE_VERSION,
      tag: CURRENT_RELEASE_TAG,
      commit: 'a'.repeat(40),
    }

    const activation = await REAL_RUNTIME_INSTALLER.withManagedTransaction(
      isolatedScope(home),
      (transaction) => transaction.activate(candidate, 'codex', target.version, target),
    )
    const launcher = join(home, '.local', 'bin', 'tenon')
    const status = await execFileAsync(launcher, ['runtime', 'status', '--json'])
    const delegated = await execFileAsync(launcher, ['probe', 'v2'])

    expect(activation.release).toMatchObject({ version: 2, stableTarget: target })
    expect(JSON.parse(status.stdout)).toMatchObject({
      activeValid: true,
      selection: { activeRelease: activation.release.releaseId },
    })
    expect(delegated.stdout).toBe('V2_RUNTIME_CLI:probe,v2')
  }, 30_000)

  it('continues to validate an existing v1 manifest with the legacy payload digest', async () => {
    const root = await freshRoot('legacy-v1-manifest')
    const candidate = await candidateCopy(root)
    const paths = pathsFor(root)
    const stagingPayload = join(root, 'legacy-payload')
    await mkdir(stagingPayload, { recursive: true })
    await copyReleasePayload(candidate, stagingPayload)
    const payloadDigest = await hashLegacyReleasePayload(stagingPayload)
    const releaseId = `sha256-${payloadDigest}`
    const releaseRoot = join(paths.releasesRoot, releaseId)
    await mkdir(releaseRoot, { recursive: true })
    await cp(stagingPayload, join(releaseRoot, 'payload'), { recursive: true, preserveTimestamps: false })
    await writeFile(join(releaseRoot, 'release.json'), stableJson({
      version: 1,
      releaseId,
      payloadDigest,
      createdAt: '2026-07-24T00:00:00Z',
      source: { host: 'codex', pluginVersion: '1.0.2' },
    }))
    await mkdir(paths.stateRoot, { recursive: true })
    await writeFile(paths.selectionPath, stableJson({
      version: 1,
      revision: 1,
      activeRelease: releaseId,
      previousRelease: null,
      updatedAt: '2026-07-24T00:00:00Z',
    }))

    const inspection = await storeFor(root).inspect()

    expect(inspection.activeValid).toBe(true)
    expect(inspection.active).toMatchObject({ version: 1, releaseId, payloadDigest })
  }, 30_000)

  it('recovers a committed v1.0.1 activation from its exact legacy launcher bytes', async () => {
    const root = await freshRoot('legacy-v101-activation-launchers')
    const home = join(root, 'home')
    const candidate = await candidateCopy(root)
    const paths = resolveRuntimePaths({ homeDir: home, env: {} })
    const payloadRoot = join(root, 'legacy-payload')
    await mkdir(payloadRoot, { recursive: true })
    await copyReleasePayload(candidate, payloadRoot)
    const payloadDigest = await hashLegacyReleasePayload(payloadRoot)
    const releaseId = `sha256-${payloadDigest}`
    const releaseRoot = join(paths.releasesRoot, releaseId)
    await mkdir(releaseRoot, { recursive: true })
    await cp(payloadRoot, join(releaseRoot, 'payload'), { recursive: true, preserveTimestamps: false })
    await writeFile(join(releaseRoot, 'release.json'), stableJson({
      version: 1,
      releaseId,
      payloadDigest,
      createdAt: '2026-07-24T00:00:00Z',
      source: { host: 'codex', pluginVersion: '1.0.1' },
    }))
    await mkdir(paths.stateRoot, { recursive: true })
    await writeFile(paths.selectionPath, stableJson({
      version: 1,
      revision: 1,
      activeRelease: releaseId,
      previousRelease: null,
      updatedAt: '2026-07-24T00:00:00Z',
    }))
    const bin = join(home, '.local', 'bin')
    await mkdir(bin, { recursive: true })
    for (const mode of ['cli', 'hook'] as const) {
      const path = join(bin, mode === 'cli' ? 'tenon' : 'tenon-hook')
      await writeFile(path, legacyV101LauncherText(paths, mode), 'utf8')
      await chmod(path, 0o755)
    }
    const checkpoint = {
      selection: {
        version: 1 as const,
        revision: 0,
        activeRelease: null,
        previousRelease: null,
        updatedAt: '1970-01-01T00:00:00Z',
      },
      launchers: {
        tenon: { path: join(bin, 'tenon'), state: { kind: 'missing' as const } },
        hook: { path: join(bin, 'tenon-hook'), state: { kind: 'missing' as const } },
      },
    }

    const recovered = await REAL_RUNTIME_INSTALLER.withManagedTransaction(
      isolatedScope(home),
      (transaction) => transaction.recoverActivation(checkpoint, 'codex'),
    )

    expect(recovered).toMatchObject({
      state: 'activated',
      activation: { release: { version: 1, releaseId } },
    })
    expect(await readFile(join(bin, 'tenon'), 'utf8')).toContain(`exec '${process.execPath}'`)
    expect(await readFile(join(bin, 'tenon'), 'utf8')).not.toContain('exec node ')
  }, 30_000)

  it('uses the frozen absolute Bash for both candidate and stored-release verification', async () => {
    const root = await freshRoot('trusted-bash-revalidation')
    const candidate = await candidateCopy(root)
    const invocations: string[] = []
    const trustedBash = '/trusted/runtime/bash'
    const store = new RuntimeReleaseStore({
      paths: pathsFor(root),
      bashPath: trustedBash,
      runner: {
        run: async (file) => {
          invocations.push(file)
          return { code: 0, stdout: '', stderr: '' }
        },
      },
    })

    await store.stageAndActivate(candidate, 'codex')
    invocations.splice(0)

    expect((await store.inspect()).activeValid).toBe(true)
    expect(invocations).toContain(trustedBash)
    expect(invocations).not.toContain('bash')
  }, 30_000)

  it('replays Bash then Node for provenance and preserves selection on Node drift', async () => {
    const root = await freshRoot('trusted-node-provenance-drift')
    const candidate = await candidateCopy(root)
    const events: string[] = []
    let nodeTrusted = false
    let runnerCalls = 0
    const trustedBash = '/trusted/runtime/bash'
    const trustedNode = '/trusted/runtime/node'
    const runtimePaths = pathsFor(root)
    const store = new RuntimeReleaseStore({
      paths: runtimePaths,
      bashPath: trustedBash,
      nodePath: trustedNode,
      verifyBash: () => { events.push('bash-proof') },
      verifyNode: () => {
        events.push('node-proof')
        if (!nodeTrusted) throw new Error('trusted Node identity drifted')
      },
      runner: {
        run: async () => {
          runnerCalls += 1
          events.push('spawn')
          return { code: 0, stdout: '', stderr: '' }
        },
      },
    })
    const before = await store.inspect()
    const launchersBefore = await captureStableLaunchers(runtimePaths, root)

    await expect(store.stageAndActivate(candidate, 'codex')).rejects.toThrow('trusted Node identity drifted')
    expect(events).toEqual(['bash-proof', 'node-proof'])
    expect(runnerCalls).toBe(0)
    expect((await store.inspect()).selection).toEqual(before.selection)
    expect(await captureStableLaunchers(runtimePaths, root)).toEqual(launchersBefore)

    nodeTrusted = true
    await expect(store.stageAndActivate(candidate, 'codex')).resolves.toBeDefined()
    expect(events.slice(2, 5)).toEqual(['bash-proof', 'node-proof', 'spawn'])
  }, 30_000)

  it('revalidates the frozen Node identity when no Bash verifier is configured', async () => {
    const root = await freshRoot('trusted-node-only-revalidation')
    const candidate = await candidateCopy(root)
    let verifications = 0
    const store = new RuntimeReleaseStore({
      paths: pathsFor(root),
      nodePath: process.execPath,
      verifyNode: () => { verifications += 1 },
    })

    await store.stageAndActivate(candidate, 'codex')

    expect(verifications).toBeGreaterThan(0)
  }, 30_000)

  it('recovers an activation crash window from the pre-activation selection and launcher checkpoint', async () => {
    const root = await freshRoot('activation-checkpoint')
    const home = join(root, 'home')
    const candidate = await candidateCopy(root)
    const scope = isolatedScope(home)

    await REAL_RUNTIME_INSTALLER.withManagedTransaction(scope, async (transaction) => {
      const checkpoint = await transaction.checkpointActivation()
      await expect(transaction.recoverActivation(checkpoint, 'codex')).resolves.toEqual({
        state: 'not-started',
      })

      const activation = await transaction.activate(candidate, 'codex')
      const recovered = await transaction.recoverActivation(checkpoint, 'codex')

      expect(recovered).toMatchObject({
        state: 'activated',
        activation: {
          selection: activation.selection,
          release: activation.release,
          releaseRoot: activation.releaseRoot,
          launcherSnapshot: checkpoint.launchers,
        },
      })
    })
  }, 30_000)

  it.each(['tenon', 'hook'] as const)(
    'converges an installer-owned partial stable launcher pair after %s publication',
    async (published) => {
      const root = await freshRoot(`activation-partial-launcher-${published}`)
      const home = join(root, 'home')
      const candidate = await candidateCopy(root)
      const scope = isolatedScope(home)
      const paths = resolveRuntimePaths({ homeDir: home, env: {} })

      await REAL_RUNTIME_INSTALLER.withManagedTransaction(scope, async (transaction) => {
        const checkpoint = await transaction.checkpointActivation()
        await new RuntimeReleaseStore({ paths }).stageAndActivate(candidate, 'codex')
        const expected = expectedStableLaunchers(paths, home)
        const file = expected[published]
        if (file.state.kind !== 'file') throw new Error('expected launcher fixture must be a file')
        await mkdir(dirname(file.path), { recursive: true })
        await writeFile(file.path, file.state.content, 'utf8')
        await chmod(file.path, 0o600)

        const recovered = await transaction.recoverActivation(checkpoint, 'codex')

        expect(recovered.state).toBe('activated')
        for (const name of ['tenon', 'hook'] as const) {
          const launcher = expected[name]
          if (launcher.state.kind !== 'file') throw new Error('expected launcher fixture must be a file')
          expect(await readFile(launcher.path, 'utf8')).toBe(launcher.state.content)
          expect((await stat(launcher.path)).mode & 0o777).toBe(0o755)
        }
      })
    },
    30_000,
  )

  it('fails closed when activation recovery sees an external launcher in a partial pair', async () => {
    const root = await freshRoot('activation-third-party-launcher')
    const home = join(root, 'home')
    const candidate = await candidateCopy(root)
    const scope = isolatedScope(home)
    const paths = resolveRuntimePaths({ homeDir: home, env: {} })

    await REAL_RUNTIME_INSTALLER.withManagedTransaction(scope, async (transaction) => {
      const checkpoint = await transaction.checkpointActivation()
      await new RuntimeReleaseStore({ paths }).stageAndActivate(candidate, 'codex')
      const expected = expectedStableLaunchers(paths, home)
      const tenon = expected.tenon
      if (tenon.state.kind !== 'file') throw new Error('expected launcher fixture must be a file')
      await mkdir(dirname(tenon.path), { recursive: true })
      await writeFile(tenon.path, tenon.state.content, 'utf8')
      await chmod(tenon.path, 0o600)
      await writeFile(expected.hook.path, '#!/bin/sh\necho external-owner\n', 'utf8')
      await chmod(expected.hook.path, 0o755)

      await expect(transaction.recoverActivation(checkpoint, 'codex'))
        .rejects.toThrow(/partial pair 无法证明|third-party byte/)
      expect(await readFile(expected.hook.path, 'utf8')).toContain('external-owner')
    })
  }, 30_000)

  it.each([
    ['different-commit', { version: TENON_RELEASE_VERSION, tag: CURRENT_RELEASE_TAG, commit: 'b'.repeat(40) }],
    ['missing-target', undefined],
  ] as const)(
    'fails closed when real activating-runtime recovery returns a %s release identity',
    async (label, recoveredTarget) => {
      const root = await freshRoot(`activation-stable-target-${label}`)
      const home = join(root, 'home')
      const candidate = await candidateCopy(root)
      const scope = isolatedScope(home)
      const frozenTarget = {
        version: TENON_RELEASE_VERSION,
        tag: CURRENT_RELEASE_TAG,
        commit: 'a'.repeat(40),
      }
      await REAL_RUNTIME_INSTALLER.withManagedTransaction(scope, async (transaction) => {
        const checkpoint = await transaction.checkpointActivation()
        const journal = transaction.journal.create('update', 'codex', '2026-08-09T00:00:00Z')
        await transaction.journal.write({
          ...journal,
          phase: 'activating-runtime',
          dashboardPort: 18_765,
          dashboardBeforeAbsent: true,
          candidateRoot: candidate,
          stableTarget: frozenTarget,
          activationCheckpoint: checkpoint,
        })
        await transaction.activate(candidate, 'codex', frozenTarget.version, recoveredTarget)
      })
      let evidenceCommits = 0

      const outcome = await publishManagedRelease(makeDeps(), {
        operation: 'update',
        source: 'codex',
        runtime: scope,
        openBrowser: false,
        requiresStableTarget: true,
        proveFrozenTarget: async (target) => {
          expect(target).toEqual(frozenTarget)
        },
        prepareCandidate: async () => {
          throw new Error('persisted activating-runtime candidate must be recovered')
        },
        commitReadyEvidence: async () => { evidenceCommits += 1 },
      }, REAL_RUNTIME_INSTALLER, undefined)

      expect(outcome).toMatchObject({ ok: false, state: 'indeterminate' })
      expect(evidenceCommits).toBe(0)
      await expect(REAL_RUNTIME_INSTALLER.peekManagedJournal?.(scope)).resolves.toMatchObject({
        phase: 'activating-runtime',
        stableTarget: frozenTarget,
      })
    },
    30_000,
  )

  it('bridges a persisted v1.0.1 update WAL into one versioned setup with the real release store', async () => {
    const root = await freshRoot('legacy-update-to-versioned-setup')
    const home = join(root, 'home')
    const candidate = await candidateCopy(root)
    const scope = isolatedScope(home)
    const paths = resolveRuntimePaths({ homeDir: home, env: {} })
    const journalPath = join(paths.managedTransactionRoot, 'release-transaction.json')
    const target = {
      version: TENON_RELEASE_VERSION,
      tag: CURRENT_RELEASE_TAG,
      commit: 'a'.repeat(40),
    }
    await mkdir(paths.managedTransactionRoot, { recursive: true })
    await writeFile(journalPath, stableJson({
      version: 1,
      transactionId: 'v1.0.1-update-process',
      operation: 'update',
      source: 'codex',
      phase: 'candidate-resolved',
      startedAt: '2026-08-08T00:00:00Z',
      updatedAt: '2026-08-08T00:00:01Z',
      candidateRoot: '/v1.0.1/marketplace-cache',
      evidence: JSON.stringify({ step: 'marketplace-refresh', version: '1.0.1' }),
      hostSteps: [{
        id: 'marketplace-refresh',
        state: 'completed',
        result: '',
      }],
    }), 'utf8')
    let preparations = 0
    let evidenceCommits = 0

    const outcome = await publishManagedRelease(makeDeps(), {
      operation: 'setup',
      source: 'codex',
      runtime: scope,
      openBrowser: false,
      expectedPluginVersion: target.version,
      requiresStableTarget: true,
      resolveStableTargetBeforeRecovery: async () => target,
      proveFrozenTarget: async (value) => { expect(value).toEqual(target) },
      prepareCandidate: async () => {
        preparations += 1
        return { candidateRoot: candidate }
      },
      commitReadyEvidence: async (_activation, _candidate, transactionId, context) => {
        evidenceCommits += 1
        expect(transactionId).toBe('v1.0.1-update-process')
        expect(context.stableTarget).toEqual(target)
      },
    }, REAL_RUNTIME_INSTALLER, undefined)

    expect(outcome, JSON.stringify(outcome)).toMatchObject({
      ok: true,
      state: 'ready',
      stableTarget: target,
      activation: {
        release: {
          version: 2,
          source: { host: 'codex', pluginVersion: target.version },
          stableTarget: target,
        },
      },
    })
    expect(preparations).toBe(1)
    expect(evidenceCommits).toBe(1)
    await expect(readFile(journalPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  }, 30_000)

  it.each(
    (['codex', 'claude'] as const).flatMap((host) => (
      (['setup', 'update'] as const).flatMap((operation) => (
        [
          'preparing-host',
          'candidate-resolved',
          'activating-runtime',
          'runtime-activated',
          'starting-dashboard',
          'dashboard-ready',
          'evidence-committed',
        ] as const
      ).map((phase) => [host, operation, phase] as const))
    )),
  )('single setup bridges a real v1.0.1 %s %s/%s WAL through the release store', async (host, operation, phase) => {
    const root = await freshRoot(`legacy-${operation}-${host}-${phase}`)
    const home = join(root, 'home')
    const candidate = await candidateCopy(root)
    const scope = isolatedScope(home)
    const paths = resolveRuntimePaths({ homeDir: home, env: {} })
    const journalPath = join(paths.managedTransactionRoot, 'release-transaction.json')
    const advanced = phase === 'runtime-activated'
      || phase === 'starting-dashboard'
      || phase === 'dashboard-ready'
      || phase === 'evidence-committed'
    const activation = await seedLegacyV101Activation(
      root,
      home,
      candidate,
      host,
      operation === 'update' && advanced ? TENON_RELEASE_VERSION : '1.0.1',
    )
    const target = {
      version: TENON_RELEASE_VERSION,
      tag: CURRENT_RELEASE_TAG,
      commit: 'a'.repeat(40),
    }
    await mkdir(paths.managedTransactionRoot, { recursive: true })
    await writeFile(journalPath, stableJson({
      version: 1,
      transactionId: `legacy-v101-${host}-${operation}-${phase}`,
      operation,
      source: host,
      phase,
      startedAt: '2026-07-23T00:00:00Z',
      updatedAt: '2026-07-24T00:00:00Z',
      ...(phase === 'preparing-host'
        ? {
            hostSteps: [{
              id: operation === 'update' ? 'marketplace-refresh' : 'legacy-install',
              state: 'completed',
              result: '',
            }],
          }
        : { candidateRoot: '/v1.0.1/marketplace-cache' }),
      ...(phase === 'activating-runtime'
        || phase === 'runtime-activated'
        || phase === 'starting-dashboard'
        || phase === 'dashboard-ready'
        || phase === 'evidence-committed'
        ? { activationCheckpoint: activation.checkpoint }
        : {}),
      ...(phase === 'runtime-activated'
        || phase === 'starting-dashboard'
        || phase === 'dashboard-ready'
        || phase === 'evidence-committed'
        ? {
            activation: {
              selection: activation.selection,
              release: activation.release,
              releaseRoot: activation.releaseRoot,
            },
          }
        : {}),
      ...((phase === 'dashboard-ready' || phase === 'evidence-committed')
        ? {
            dashboard: {
              version: 1,
              port: 18_765,
              pid: 901,
              releaseId: activation.release.releaseId,
              stateScopeId: `sha256-v1-${'9'.repeat(64)}`,
              transactionId: `legacy-v101-${host}-${operation}-${phase}`,
              owner: 'transaction',
            },
          }
        : {}),
    }), 'utf8')
    let preparations = 0
    let evidenceCommits = 0
    const dashboard: ReleasedDashboardStarter = {
      inspect: async () => null,
      adopt: async () => null,
      start: async (_deps, payloadRoot, opts) => {
        const ownership = {
          version: 1 as const,
          serverVersion: opts.expectedServerVersion ?? target.version,
          port: opts.port ?? 18_765,
          pid: 902,
          releaseId: basename(dirname(payloadRoot)),
          stateScopeId: `sha256-v1-${'8'.repeat(64)}`,
          transactionId: opts.transactionId!,
          owner: 'transaction' as const,
        }
        return {
          state: 'ready' as const,
          session: {
            ownership,
            stop: async () => ({ state: 'stopped' as const }),
          },
        }
      },
    }

    const outcome = await publishManagedRelease(makeDeps(), {
      operation: 'setup',
      source: host,
      runtime: scope,
      openBrowser: false,
      expectedPluginVersion: target.version,
      requiresStableTarget: true,
      resolveStableTargetBeforeRecovery: async () => target,
      proveFrozenTarget: async (value) => { expect(value).toEqual(target) },
      prepareCandidate: async () => {
        preparations += 1
        return { candidateRoot: candidate }
      },
      commitReadyEvidence: async (_current, _candidate, transactionId, context) => {
        evidenceCommits += 1
        expect(transactionId).toBe(`legacy-v101-${host}-${operation}-${phase}`)
        expect(context.stableTarget).toEqual(target)
      },
    }, REAL_RUNTIME_INSTALLER, dashboard)

    expect(outcome, JSON.stringify(outcome)).toMatchObject({
      ok: true,
      state: 'ready',
      stableTarget: target,
      activation: {
        release: {
          version: 2,
          source: { host, pluginVersion: target.version },
          stableTarget: target,
        },
      },
    })
    expect(preparations).toBe(1)
    expect(evidenceCommits).toBe(1)
    await expect(readFile(journalPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  }, 30_000)

  it('leaves a v1.0.1 update WAL byte-identical when successor target resolution fails', async () => {
    const root = await freshRoot('legacy-update-resolver-failure')
    const home = join(root, 'home')
    const scope = isolatedScope(home)
    const paths = resolveRuntimePaths({ homeDir: home, env: {} })
    const journalPath = join(paths.managedTransactionRoot, 'release-transaction.json')
    await mkdir(paths.managedTransactionRoot, { recursive: true })
    const original = Buffer.from(`${JSON.stringify({
      version: 1,
      transactionId: 'v1.0.1-update-resolution-failure',
      operation: 'update',
      source: 'codex',
      phase: 'candidate-resolved',
      startedAt: '2026-08-08T00:00:00Z',
      updatedAt: '2026-08-08T00:00:01Z',
      candidateRoot: '/v1.0.1/marketplace-cache',
      evidence: JSON.stringify({ step: 'marketplace-refresh', version: '1.0.1' }),
    }, null, 2)}\n`)
    await writeFile(journalPath, original)
    let preparations = 0

    const outcome = await publishManagedRelease(makeDeps(), {
      operation: 'setup',
      source: 'codex',
      runtime: scope,
      openBrowser: false,
      requiresStableTarget: true,
      resolveStableTargetBeforeRecovery: async () => {
        throw new Error('release unavailable')
      },
      prepareCandidate: async () => {
        preparations += 1
        throw new Error('must not prepare')
      },
      commitReadyEvidence: async () => {
        throw new Error('must not commit')
      },
    }, REAL_RUNTIME_INSTALLER, undefined)

    expect(outcome).toMatchObject({ ok: false, state: 'indeterminate' })
    expect(preparations).toBe(0)
    expect(await readFile(journalPath)).toEqual(original)
  }, 30_000)

  it('rejects a current v2 WAL missing only its top-level stable target without legacy migration', async () => {
    const root = await freshRoot('v2-journal-missing-top-level-target')
    const home = join(root, 'home')
    const candidate = await candidateCopy(root)
    const scope = isolatedScope(home)
    const paths = resolveRuntimePaths({ homeDir: home, env: {} })
    const journalPath = join(paths.managedTransactionRoot, 'release-transaction.json')
    const target = {
      version: TENON_RELEASE_VERSION,
      tag: CURRENT_RELEASE_TAG,
      commit: 'a'.repeat(40),
    }
    const { checkpoint, activation } = await REAL_RUNTIME_INSTALLER.withManagedTransaction(
      scope,
      async (transaction) => {
        const checkpoint = await transaction.checkpointActivation()
        const activation = await transaction.activate(candidate, 'codex', target.version, target)
        return { checkpoint, activation }
      },
    )
    await mkdir(paths.managedTransactionRoot, { recursive: true })
    const original = Buffer.from(stableJson({
      version: 1,
      transactionId: 'corrupt-v2-missing-top-level-target',
      operation: 'update',
      source: 'codex',
      phase: 'runtime-activated',
      startedAt: '2026-08-09T00:00:00Z',
      updatedAt: '2026-08-09T00:00:01Z',
      dashboardPort: 18_765,
      dashboardBeforeAbsent: true,
      candidateRoot: candidate,
      activationCheckpoint: checkpoint,
      activation,
    }))
    await writeFile(journalPath, original)
    let targetResolutions = 0
    let dashboardInspections = 0
    let preparations = 0
    const dashboard: ReleasedDashboardStarter = {
      inspect: async () => {
        dashboardInspections += 1
        return null
      },
      adopt: async () => { throw new Error('must not adopt') },
      start: async () => { throw new Error('must not start') },
    }

    const outcome = await publishManagedRelease(makeDeps(), {
      operation: 'setup',
      source: 'codex',
      runtime: scope,
      openBrowser: false,
      expectedPluginVersion: target.version,
      requiresStableTarget: true,
      resolveStableTargetBeforeRecovery: async () => {
        targetResolutions += 1
        return target
      },
      proveFrozenTarget: async (value) => { expect(value).toEqual(target) },
      prepareCandidate: async () => {
        preparations += 1
        throw new Error('must not prepare')
      },
    }, REAL_RUNTIME_INSTALLER, dashboard)

    expect(outcome).toMatchObject({ ok: false, state: 'indeterminate' })
    expect(targetResolutions).toBe(0)
    expect(dashboardInspections).toBe(0)
    expect(preparations).toBe(0)
    expect((await REAL_RUNTIME_INSTALLER.inspect(scope)).selection).toEqual(activation.selection)
    expect(await readFile(journalPath)).toEqual(original)
  }, 30_000)

  it.each([
    ['explicit empty server version', 'dashboard-ready'],
    ['preexisting dashboard owner', 'dashboard-ready'],
    ['different dashboard release', 'dashboard-ready'],
    ['missing durable dashboard', 'evidence-committed'],
  ] as const)(
    'keeps a malformed legacy update WAL byte-identical for %s',
    async (malformation, phase) => {
      const root = await freshRoot(`legacy-dashboard-${malformation.replaceAll(' ', '-')}`)
      const home = join(root, 'home')
      const candidate = await candidateCopy(root)
      const scope = isolatedScope(home)
      const paths = resolveRuntimePaths({ homeDir: home, env: {} })
      const journalPath = join(paths.managedTransactionRoot, 'release-transaction.json')
      const activation = await seedLegacyV101Activation(root, home, candidate, 'codex', '1.0.2')
      const transactionId = `legacy-dashboard-${malformation.replaceAll(' ', '-')}`
      const target = {
        version: '1.0.2',
        tag: 'v1.0.2',
        commit: 'a'.repeat(40),
      }
      const durableDashboard = {
        version: 1 as const,
        port: 18_765,
        pid: 901,
        releaseId: malformation === 'different dashboard release'
          ? `sha256-${'f'.repeat(64)}`
          : activation.release.releaseId,
        stateScopeId: `sha256-v1-${'9'.repeat(64)}`,
        transactionId,
        owner: malformation === 'preexisting dashboard owner'
          ? 'preexisting' as const
          : 'transaction' as const,
        ...(malformation === 'explicit empty server version' ? { serverVersion: '' } : {}),
      }
      await mkdir(paths.managedTransactionRoot, { recursive: true })
      const original = Buffer.from(stableJson({
        version: 1,
        transactionId,
        operation: 'update',
        source: 'codex',
        phase,
        startedAt: '2026-07-23T00:00:00Z',
        updatedAt: '2026-07-24T00:00:00Z',
        candidateRoot: '/v1.0.1/marketplace-cache',
        activationCheckpoint: activation.checkpoint,
        activation: {
          selection: activation.selection,
          release: activation.release,
          releaseRoot: activation.releaseRoot,
        },
        ...(malformation === 'missing durable dashboard' ? {} : { dashboard: durableDashboard }),
      }))
      await writeFile(journalPath, original)
      let targetResolutions = 0
      let dashboardInspections = 0
      let preparations = 0
      const dashboard: ReleasedDashboardStarter = {
        inspect: async () => {
          dashboardInspections += 1
          return null
        },
        adopt: async () => { throw new Error('must not adopt') },
        start: async () => { throw new Error('must not start') },
      }

      const outcome = await publishManagedRelease(makeDeps(), {
        operation: 'setup',
        source: 'codex',
        runtime: scope,
        openBrowser: false,
        expectedPluginVersion: target.version,
        requiresStableTarget: true,
        resolveStableTargetBeforeRecovery: async () => {
          targetResolutions += 1
          return target
        },
        proveFrozenTarget: async (value) => { expect(value).toEqual(target) },
        prepareCandidate: async () => {
          preparations += 1
          throw new Error('must not prepare')
        },
      }, REAL_RUNTIME_INSTALLER, dashboard)

      expect(outcome).toMatchObject({ ok: false, state: 'indeterminate' })
      expect(targetResolutions).toBe(0)
      expect(dashboardInspections).toBe(0)
      expect(preparations).toBe(0)
      expect((await REAL_RUNTIME_INSTALLER.inspect(scope)).selection).toEqual(activation.selection)
      expect(await readFile(journalPath)).toEqual(original)
    },
    30_000,
  )

  it('reuses a fully verified content-addressed release when an idempotent publish collides', async () => {
    const root = await freshRoot('idempotent-release')
    const candidate = await candidateCopy(root)
    const store = storeFor(root)
    const first = await store.stageAndActivate(candidate, 'codex')

    // macOS reports ENOTEMPTY for this directory rename; Linux may report EEXIST. The public
    // installer contract is the same: validate the existing digest-addressed release and reuse it.
    const second = await store.stageAndActivate(candidate, 'codex')

    expect(second.release.releaseId).toBe(first.release.releaseId)
    expect(second.selection.activeRelease).toBe(first.release.releaseId)
    expect((await store.inspect()).activeValid).toBe(true)
  }, 30_000)

  it.each([
    ['codex', 'claude'],
    ['claude', 'codex'],
  ] as const)(
    'keeps identical payload activation provenance distinct for %s then %s',
    async (firstHost, secondHost) => {
      const root = await freshRoot(`cross-host-${firstHost}-${secondHost}`)
      const candidate = await candidateCopy(root)
      const store = storeFor(root)
      const target = {
        version: TENON_RELEASE_VERSION,
        tag: CURRENT_RELEASE_TAG,
        commit: 'a'.repeat(40),
      }

      const first = await store.stageAndActivate(candidate, firstHost, TENON_RELEASE_VERSION, target)
      const second = await store.stageAndActivate(candidate, secondHost, TENON_RELEASE_VERSION, target)

      expect(second.release.releaseId).not.toBe(first.release.releaseId)
      expect(second.release).toMatchObject({
        version: 2,
        source: { host: secondHost, pluginVersion: TENON_RELEASE_VERSION },
        stableTarget: target,
      })
      expect((await store.inspect()).active).toMatchObject({
        releaseId: second.release.releaseId,
        source: { host: secondHost },
      })
    },
    30_000,
  )

  it('rejects a malformed candidate without replacing the active release', async () => {
    const root = await freshRoot('reject')
    const healthy = await candidateCopy(root, '-healthy')
    const broken = await candidateCopy(root, '-broken')
    const store = storeFor(root)
    const first = await store.stageAndActivate(healthy, 'codex')
    await writeFile(join(broken, 'hooks', 'gate.sh'), 'if then\n', 'utf8')

    await expect(store.stageAndActivate(broken, 'codex')).rejects.toThrow(/语法|candidate|插件资产/i)

    expect((await store.inspect()).selection.activeRelease).toBe(first.release.releaseId)
  }, 30_000)

  it('rejects candidate Skill provenance drift before activation and preserves selection/launchers', async () => {
    const root = await freshRoot('provenance-drift-reject')
    const healthy = await candidateCopy(root, '-healthy')
    const broken = await candidateCopy(root, '-broken')
    const store = storeFor(root)
    const paths = pathsFor(root)
    const first = await store.stageAndActivate(healthy, 'codex')
    const selectionBefore = (await store.inspect()).selection
    const launchersBefore = await captureStableLaunchers(paths, root)
    await writeFile(join(broken, 'skills', 'tenon', 'SKILL.md'), '# candidate drift\n', 'utf8')

    await expect(store.stageAndActivate(broken, 'codex')).rejects.toThrow(/content-hash-mismatch|provenance|插件资产/i)

    expect((await store.inspect()).selection).toEqual(selectionBefore)
    expect((await captureStableLaunchers(paths, root))).toEqual(launchersBefore)
    expect((await store.inspect()).selection.activeRelease).toBe(first.release.releaseId)
  }, 30_000)

  it('rejects a candidate reintroducing skills-lock.json before activation', async () => {
    const root = await freshRoot('provenance-legacy-reject')
    const healthy = await candidateCopy(root, '-healthy')
    const broken = await candidateCopy(root, '-broken')
    const store = storeFor(root)
    const paths = pathsFor(root)
    const first = await store.stageAndActivate(healthy, 'codex')
    const launchersBefore = await captureStableLaunchers(paths, root)
    await writeFile(join(broken, 'skills-lock.json'), '{}\n', 'utf8')

    await expect(store.stageAndActivate(broken, 'codex')).rejects.toThrow(/legacy-provenance-source|skills-lock\.json|插件资产/i)
    expect((await store.inspect()).selection.activeRelease).toBe(first.release.releaseId)
    expect((await captureStableLaunchers(paths, root))).toEqual(launchersBefore)
  }, 30_000)

  it('rejects a candidate whose manifest version differs from the frozen release target', async () => {
    const root = await freshRoot('version-mismatch')
    const candidate = await candidateCopy(root)
    const store = storeFor(root)

    await expect(store.stageAndActivate(candidate, 'codex', '9.9.9'))
      .rejects.toThrow(/候选 plugin version .*冻结目标 9\.9\.9/)
    expect((await store.inspect()).selection.activeRelease).toBeNull()
  }, 30_000)

  it('rejects a candidate whose source identity changes after its payload was staged', async () => {
    const root = await freshRoot('candidate-stage-toctou')
    const candidate = await candidateCopy(root)
    let mutated = false
    const store = new RuntimeReleaseStore({
      paths: pathsFor(root),
      runner: {
        run: async () => {
          if (!mutated) {
            mutated = true
            for (const manifest of ['.codex-plugin/plugin.json', '.claude-plugin/plugin.json']) {
              const path = join(candidate, manifest)
              const value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
              value.version = '9.9.9'
              await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
            }
          }
          return { code: 0, stdout: '', stderr: '' }
        },
      },
    })

    await expect(store.stageAndActivate(candidate, 'codex', '9.9.9'))
      .rejects.toThrow(/候选.*漂移|payload.*不一致|staged/i)
    expect((await store.inspect()).selection.activeRelease).toBeNull()
  }, 30_000)

  it('rejects a candidate with no manifest version instead of publishing unknown identity', async () => {
    const root = await freshRoot('missing-version')
    const candidate = await candidateCopy(root)
    for (const manifest of ['.codex-plugin/plugin.json', '.claude-plugin/plugin.json']) {
      const path = join(candidate, manifest)
      const value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
      delete value.version
      await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    }

    await expect(storeFor(root).stageAndActivate(candidate, 'codex'))
      .rejects.toThrow(/version|插件资产/i)
    expect((await storeFor(root).inspect()).selection.activeRelease).toBeNull()
  }, 30_000)

  it('rejects a candidate when the Codex and Claude plugin manifest versions differ', async () => {
    const root = await freshRoot('split-manifest-version')
    const candidate = await candidateCopy(root)
    const claudeManifest = join(candidate, '.claude-plugin', 'plugin.json')
    const value = JSON.parse(await readFile(claudeManifest, 'utf8')) as Record<string, unknown>
    value.version = '9.9.9'
    await writeFile(claudeManifest, `${JSON.stringify(value, null, 2)}\n`, 'utf8')

    await expect(storeFor(root).stageAndActivate(candidate, 'codex', '1.0.2'))
      .rejects.toThrow(/manifest version 不一致|插件资产/i)
    expect((await storeFor(root).inspect()).selection.activeRelease).toBeNull()
  }, 30_000)

  it('rejects a candidate missing the Claude marketplace manifest without replacing selection', async () => {
    const root = await freshRoot('missing-claude-marketplace')
    const healthy = await candidateCopy(root, '-healthy')
    const broken = await candidateCopy(root, '-broken')
    const store = storeFor(root)
    const first = await store.stageAndActivate(healthy, 'codex')
    await rm(join(broken, '.claude-plugin', 'marketplace.json'))

    await expect(store.stageAndActivate(broken, 'codex')).rejects.toThrow(/marketplace\.json|插件资产/i)

    expect((await store.inspect()).selection.activeRelease).toBe(first.release.releaseId)
  }, 30_000)

  it('rolls back only to a fully verified previous release', async () => {
    const root = await freshRoot('rollback')
    const firstCandidate = await candidateCopy(root, '-one')
    const secondCandidate = await candidateCopy(root, '-two')
    await writeFile(
      join(secondCandidate, 'runtime', 'tenon-bootstrap.mjs'),
      `${await readFile(join(secondCandidate, 'runtime', 'tenon-bootstrap.mjs'), 'utf8')}\n// release-two\n`,
      'utf8',
    )
    const store = storeFor(root)
    const first = await store.stageAndActivate(firstCandidate, 'claude')
    const second = await store.stageAndActivate(secondCandidate, 'claude')

    const rolledBack = await store.rollbackToPrevious()

    expect(second.release.releaseId).not.toBe(first.release.releaseId)
    expect(rolledBack.selection.activeRelease).toBe(first.release.releaseId)
    expect(rolledBack.selection.previousRelease).toBe(second.release.releaseId)
  }, 30_000)

  it('keeps the current hardened bootstrap bytes when rolling back to a previous payload', async () => {
    const root = await freshRoot('rollback-keeps-bootstrap')
    const firstCandidate = await candidateCopy(root, '-one')
    const secondCandidate = await candidateCopy(root, '-two')
    await writeFile(
      join(firstCandidate, 'runtime', 'tenon-bootstrap.mjs'),
      `${await readFile(join(firstCandidate, 'runtime', 'tenon-bootstrap.mjs'), 'utf8')}\n// previous-bootstrap\n`,
      'utf8',
    )
    await writeFile(
      join(secondCandidate, 'runtime', 'tenon-bootstrap.mjs'),
      `${await readFile(join(secondCandidate, 'runtime', 'tenon-bootstrap.mjs'), 'utf8')}\n// hardened-current-bootstrap\n`,
      'utf8',
    )
    const store = storeFor(root)
    await store.stageAndActivate(firstCandidate, 'codex')
    await store.stageAndActivate(secondCandidate, 'codex')
    const activeBootstrap = join(pathsFor(root).bootstrapRoot, 'active.mjs')
    const before = await readFile(activeBootstrap, 'utf8')

    await store.rollbackToPrevious()

    expect(await readFile(activeBootstrap, 'utf8')).toBe(before)
    expect(before).toContain('hardened-current-bootstrap')
    expect(before).not.toContain('previous-bootstrap')
  }, 60_000)

  it('keeps the current hardened bootstrap and commits audit only after activation compensation selection', async () => {
    const root = await freshRoot('compensation-keeps-bootstrap')
    const firstCandidate = await candidateCopy(root, '-one')
    const secondCandidate = await candidateCopy(root, '-two')
    await writeFile(
      join(firstCandidate, 'runtime', 'tenon-bootstrap.mjs'),
      `${await readFile(join(firstCandidate, 'runtime', 'tenon-bootstrap.mjs'), 'utf8')}\n// previous-bootstrap\n`,
      'utf8',
    )
    await writeFile(
      join(secondCandidate, 'runtime', 'tenon-bootstrap.mjs'),
      `${await readFile(join(secondCandidate, 'runtime', 'tenon-bootstrap.mjs'), 'utf8')}\n// hardened-current-bootstrap\n`,
      'utf8',
    )
    const healthy = storeFor(root)
    const first = await healthy.stageAndActivate(firstCandidate, 'codex')
    const second = await healthy.stageAndActivate(secondCandidate, 'codex')
    const paths = pathsFor(root)
    const activeBootstrap = join(paths.bootstrapRoot, 'active.mjs')
    const before = await readFile(activeBootstrap, 'utf8')
    const observed: Array<{ readonly kind: string; readonly activeRelease: string | null }> = []
    const compensating = new RuntimeReleaseStore({
      paths,
      auditWriter: async (_paths, entry) => {
        const selection = JSON.parse(await readFile(paths.selectionPath, 'utf8')) as {
          readonly activeRelease: string | null
        }
        observed.push({ kind: entry.kind, activeRelease: selection.activeRelease })
      },
    })

    await compensating.revertActivation(second.selection)

    expect(await readFile(activeBootstrap, 'utf8')).toBe(before)
    expect(before).toContain('hardened-current-bootstrap')
    expect(before).not.toContain('previous-bootstrap')
    expect(observed).toEqual([
      { kind: 'rollback-prepared', activeRelease: second.release.releaseId },
      { kind: 'rolled-back', activeRelease: first.release.releaseId },
    ])
  }, 60_000)

  it('compensates only the exact activation, including a failed first-install readiness gate', async () => {
    const root = await freshRoot('revert-activation')
    const candidate = await candidateCopy(root)
    const store = storeFor(root)
    const activated = await store.stageAndActivate(candidate, 'codex')

    await store.revertActivation(activated.selection)

    const inspection = await store.inspect()
    expect(inspection.selection.activeRelease).toBeNull()
    expect(inspection.selection.previousRelease).toBe(activated.release.releaseId)
    expect(inspection.activeValid).toBe(false)
    await expect(store.revertActivation(activated.selection)).rejects.toThrow(/拒绝回滚非当前 activation/)
  }, 30_000)

  it('rejects symbolic links in a candidate payload', async () => {
    const root = await freshRoot('symlink')
    const candidate = await candidateCopy(root)
    await rm(join(candidate, 'packages', 'cli', 'dist', 'tenon.mjs'))
    await symlink('/tmp/not-a-pipeline', join(candidate, 'packages', 'cli', 'dist', 'tenon.mjs'))

    await expect(storeFor(root).stageAndActivate(candidate, 'codex')).rejects.toThrow(/符号链接/i)
  }, 30_000)

  it('never changes activation or rollback selection after an audit append failure', async () => {
    const root = await freshRoot('audit-failure')
    const firstCandidate = await candidateCopy(root, '-one')
    const secondCandidate = await candidateCopy(root, '-two')
    await writeFile(
      join(secondCandidate, 'runtime', 'tenon-bootstrap.mjs'),
      `${await readFile(join(secondCandidate, 'runtime', 'tenon-bootstrap.mjs'), 'utf8')}\n// second\n`,
      'utf8',
    )
    const healthy = storeFor(root)
    const first = await healthy.stageAndActivate(firstCandidate, 'codex')
    const second = await healthy.stageAndActivate(secondCandidate, 'codex')
    const failingAudit = new RuntimeReleaseStore({
      paths: pathsFor(root),
      auditWriter: async () => { throw new Error('injected audit append failure') },
    })

    await expect(failingAudit.rollbackToPrevious()).rejects.toThrow(/audit append failure/)
    expect((await healthy.inspect()).selection).toEqual(second.selection)

    const thirdCandidate = await candidateCopy(root, '-three')
    await writeFile(
      join(thirdCandidate, 'runtime', 'tenon-bootstrap.mjs'),
      `${await readFile(join(thirdCandidate, 'runtime', 'tenon-bootstrap.mjs'), 'utf8')}\n// third\n`,
      'utf8',
    )
    await expect(failingAudit.stageAndActivate(thirdCandidate, 'codex')).rejects.toThrow(/audit append failure/)
    expect((await healthy.inspect()).selection).toEqual(second.selection)
    expect(first.release.releaseId).not.toBe(second.release.releaseId)
  }, 60_000)

  it('persists a host refresh failure for runtime status diagnostics', async () => {
    const root = await freshRoot('update-diagnostic')
    const store = storeFor(root)

    await store.recordUpdateFailure('host marketplace refresh failed')

    expect((await store.inspect()).lastAudit).toMatchObject({
      kind: 'update-rejected',
      detail: 'host marketplace refresh failed',
    })
  })

  it('records prepared then terminal audit events around committed activation and rollback', async () => {
    const root = await freshRoot('audit-commit-order')
    const firstCandidate = await candidateCopy(root, '-one')
    const secondCandidate = await candidateCopy(root, '-two')
    await writeFile(
      join(secondCandidate, 'runtime', 'tenon-bootstrap.mjs'),
      `${await readFile(join(secondCandidate, 'runtime', 'tenon-bootstrap.mjs'), 'utf8')}\n// second-audit-release\n`,
      'utf8',
    )
    const events: string[] = []
    const store = new RuntimeReleaseStore({
      paths: pathsFor(root),
      auditWriter: async (_paths, entry) => { events.push(entry.kind) },
    })

    await store.stageAndActivate(firstCandidate, 'codex')
    await store.stageAndActivate(secondCandidate, 'codex')
    await store.rollbackToPrevious()

    expect(events).toEqual([
      'activation-prepared', 'activated',
      'activation-prepared', 'activated',
      'rollback-prepared', 'rolled-back',
    ])
  }, 60_000)

  it('marks a committed activation degraded and recovers its missing terminal audit on inspect', async () => {
    const root = await freshRoot('activation-terminal-audit-recovery')
    const candidate = await candidateCopy(root)
    let failTerminalOnce = true
    const store = new RuntimeReleaseStore({
      paths: pathsFor(root),
      auditWriter: async (paths, entry) => {
        if (entry.kind === 'activated' && failTerminalOnce) {
          failTerminalOnce = false
          throw new Error('injected terminal audit failure')
        }
        await writeAudit(paths, entry)
      },
    })

    const activation = await store.stageAndActivate(candidate, 'codex')
    expect(activation.auditPending).toBe(true)
    expect((await readFile(pathsFor(root).auditPath, 'utf8'))).toContain('activation-prepared')

    const recovered = await store.inspect()
    expect(recovered.auditPending).toBe(false)
    expect(recovered.lastAudit).toMatchObject({
      kind: 'activated',
      releaseId: activation.release.releaseId,
    })
    expect(recovered.selection).toEqual(activation.selection)
  }, 30_000)

  it('marks a committed rollback degraded and recovers its missing terminal audit on inspect', async () => {
    const root = await freshRoot('rollback-terminal-audit-recovery')
    const firstCandidate = await candidateCopy(root, '-one')
    const secondCandidate = await candidateCopy(root, '-two')
    await writeFile(
      join(secondCandidate, 'runtime', 'tenon-bootstrap.mjs'),
      `${await readFile(join(secondCandidate, 'runtime', 'tenon-bootstrap.mjs'), 'utf8')}\n// second-terminal-audit\n`,
      'utf8',
    )
    const healthy = storeFor(root)
    const first = await healthy.stageAndActivate(firstCandidate, 'codex')
    await healthy.stageAndActivate(secondCandidate, 'codex')
    let failTerminalOnce = true
    const store = new RuntimeReleaseStore({
      paths: pathsFor(root),
      auditWriter: async (paths, entry) => {
        if (entry.kind === 'rolled-back' && failTerminalOnce) {
          failTerminalOnce = false
          throw new Error('injected terminal audit failure')
        }
        await writeAudit(paths, entry)
      },
    })

    const activation = await store.rollbackToPrevious()
    expect(activation.release.releaseId).toBe(first.release.releaseId)
    expect(activation.auditPending).toBe(true)

    const recovered = await store.inspect()
    expect(recovered.auditPending).toBe(false)
    expect(recovered.lastAudit).toMatchObject({
      kind: 'rolled-back',
      releaseId: first.release.releaseId,
    })
    expect(recovered.selection).toEqual(activation.selection)
  }, 60_000)

  it('reports a truncated audit tail as corrupt instead of returning an older event as latest', async () => {
    const root = await freshRoot('audit-corrupt-tail')
    const paths = pathsFor(root)
    await mkdir(paths.stateRoot, { recursive: true })
    await writeFile(paths.auditPath, `${JSON.stringify({
      version: 1,
      at: '2026-07-24T00:00:00Z',
      kind: 'update-rejected',
      detail: 'older valid event',
    })}\n{"version":1`, 'utf8')

    expect(await storeFor(root).inspect()).toMatchObject({
      lastAudit: null,
      auditCorrupt: true,
    })
  })

  it('compensates a real installer activation across selection and exact stable launchers', async () => {
    const root = await freshRoot('installer-transaction')
    const home = join(root, 'home')
    const candidate = await candidateCopy(root)
    const bin = join(home, '.local', 'bin')
    const tenon = join(bin, 'tenon')
    const hook = join(bin, 'tenon-hook')
    await mkdir(bin, { recursive: true })
    await writeFile(tenon, '#!/bin/sh\necho previous-tenon\n', 'utf8')
    await writeFile(hook, '#!/bin/sh\necho previous-hook\n', 'utf8')
    await chmod(tenon, 0o750)
    await chmod(hook, 0o700)

    const activation = await REAL_RUNTIME_INSTALLER.withManagedTransaction(
      isolatedScope(home),
      (transaction) => transaction.activate(candidate, 'codex'),
    )
    expect(await readFile(tenon, 'utf8')).toContain('TENON_RUNTIME_DATA_ROOT')

    await REAL_RUNTIME_INSTALLER.withManagedTransaction(
      isolatedScope(home),
      (transaction) => transaction.revertActivation(activation),
    )
    await REAL_RUNTIME_INSTALLER.withManagedTransaction(
      isolatedScope(home),
      (transaction) => transaction.revertActivation(activation),
    )

    expect(await readFile(tenon, 'utf8')).toBe('#!/bin/sh\necho previous-tenon\n')
    expect(await readFile(hook, 'utf8')).toBe('#!/bin/sh\necho previous-hook\n')
    expect((await stat(tenon)).mode & 0o777).toBe(0o750)
    expect((await stat(hook)).mode & 0o777).toBe(0o700)
    expect((await REAL_RUNTIME_INSTALLER.inspect(isolatedScope(home))).selection.activeRelease).toBeNull()
  }, 30_000)

  it('proves the full activation selection before trusting recovery or compensation coordinates', async () => {
    const root = await freshRoot('installer-prove-selection')
    const home = join(root, 'home')
    const candidate = await candidateCopy(root)
    const activation = await REAL_RUNTIME_INSTALLER.withManagedTransaction(
      isolatedScope(home),
      (transaction) => transaction.activate(candidate, 'codex'),
    )

    await expect(REAL_RUNTIME_INSTALLER.withManagedTransaction(
      isolatedScope(home),
      (transaction) => transaction.proveActivation({
        ...activation,
        selection: {
          ...activation.selection,
          previousRelease: `sha256-${'c'.repeat(64)}`,
        },
      }),
    )).resolves.toBe(false)
  }, 30_000)

  it('never restores an old launcher snapshot after selection CAS proves another activation owns the runtime', async () => {
    const root = await freshRoot('installer-cas-ownership')
    const home = join(root, 'home')
    const firstCandidate = await candidateCopy(root, '-one')
    const secondCandidate = await candidateCopy(root, '-two')
    await writeFile(
      join(secondCandidate, 'runtime', 'tenon-bootstrap.mjs'),
      `${await readFile(join(secondCandidate, 'runtime', 'tenon-bootstrap.mjs'), 'utf8')}\n// concurrent-owner\n`,
      'utf8',
    )
    const paths = resolveRuntimePaths({ homeDir: home, env: {} })
    const first = await REAL_RUNTIME_INSTALLER.withManagedTransaction(
      isolatedScope(home),
      (transaction) => transaction.activate(firstCandidate, 'codex'),
    )
    const second = await new RuntimeReleaseStore({ paths }).stageAndActivate(secondCandidate, 'codex')
    const tenon = join(home, '.local', 'bin', 'tenon')
    await writeFile(tenon, '#!/bin/sh\necho concurrent-owner\n', 'utf8')

    await expect(REAL_RUNTIME_INSTALLER.withManagedTransaction(
      isolatedScope(home),
      (transaction) => transaction.revertActivation(first),
    )).rejects.toThrow(/拒绝覆盖/)

    expect((await REAL_RUNTIME_INSTALLER.inspect(isolatedScope(home))).selection.activeRelease).toBe(second.release.releaseId)
    expect(await readFile(tenon, 'utf8')).toBe('#!/bin/sh\necho concurrent-owner\n')
  }, 60_000)

  it('resolves one immutable path snapshot before locking a rollback transaction', async () => {
    const root = await freshRoot('installer-rollback-path-snapshot')
    const home = join(root, 'home')
    const runtimeA = join(root, 'runtime-a')
    const runtimeB = join(root, 'runtime-b')
    const firstCandidate = await candidateCopy(root, '-one')
    const secondCandidate = await candidateCopy(root, '-two')
    await writeFile(
      join(secondCandidate, 'runtime', 'tenon-bootstrap.mjs'),
      `${await readFile(join(secondCandidate, 'runtime', 'tenon-bootstrap.mjs'), 'utf8')}\n// second\n`,
      'utf8',
    )
    const stableScope = { homeDir: home, env: { TENON_RUNTIME_HOME: runtimeA } }
    await REAL_RUNTIME_INSTALLER.withManagedTransaction(
      stableScope,
      (transaction) => transaction.activate(firstCandidate, 'codex'),
    )
    await REAL_RUNTIME_INSTALLER.withManagedTransaction(
      stableScope,
      (transaction) => transaction.activate(secondCandidate, 'codex'),
    )

    let runtimeRootReads = 0
    const changingEnv = new Proxy<Record<string, string | undefined>>({}, {
      get: (_target, property) => {
        if (property !== 'TENON_RUNTIME_HOME') return undefined
        runtimeRootReads += 1
        return runtimeRootReads === 1 ? runtimeA : runtimeB
      },
    })
    const rolledBack = await REAL_RUNTIME_INSTALLER.rollback({ homeDir: home, env: changingEnv })

    expect(rolledBack.release.releaseId).toBe(
      (await REAL_RUNTIME_INSTALLER.inspect(stableScope)).selection.activeRelease,
    )
    expect(runtimeRootReads).toBe(1)
  }, 60_000)

  it('resumes the same explicit rollback target after selection committed before launcher convergence', async () => {
    const root = await freshRoot('installer-rollback-selection-crash')
    const home = join(root, 'home')
    const firstCandidate = await candidateCopy(root, '-one')
    const secondCandidate = await candidateCopy(root, '-two')
    await writeFile(
      join(secondCandidate, 'runtime', 'tenon-bootstrap.mjs'),
      `${await readFile(join(secondCandidate, 'runtime', 'tenon-bootstrap.mjs'), 'utf8')}\n// second\n`,
      'utf8',
    )
    const scope = isolatedScope(home)
    const first = await REAL_RUNTIME_INSTALLER.withManagedTransaction(
      scope,
      (transaction) => transaction.activate(firstCandidate, 'codex'),
    )
    await REAL_RUNTIME_INSTALLER.withManagedTransaction(
      scope,
      (transaction) => transaction.activate(secondCandidate, 'codex'),
    )
    const paths = resolveRuntimePaths({ homeDir: home, env: scope.env })
    const before = await REAL_RUNTIME_INSTALLER.inspect(scope)
    const launchers = await captureStableLaunchers(paths, home)
    const committed = await new RuntimeReleaseStore({ paths }).rollbackToPrevious()
    const journalPath = join(paths.managedTransactionRoot, 'runtime-rollback.json')
    await writeFile(journalPath, `${JSON.stringify({
      version: 1,
      transactionId: '11111111-1111-4111-8111-111111111111',
      beforeSelection: before.selection,
      target: {
        revision: before.selection.revision + 1,
        activeRelease: before.selection.previousRelease,
        previousRelease: before.selection.activeRelease,
      },
      launchers,
    }, null, 2)}\n`)

    const resumed = await REAL_RUNTIME_INSTALLER.rollback(scope)

    expect(resumed.release.releaseId).toBe(first.release.releaseId)
    expect(resumed.selection).toEqual(committed.selection)
    expect((await REAL_RUNTIME_INSTALLER.inspect(scope)).selection).toEqual(committed.selection)
    await expect(readFile(journalPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  }, 60_000)

  it('explicit rollback with exact hardened launchers never opens a capture transition', async () => {
    const root = await freshRoot('installer-rollback-exact-launchers')
    const home = join(root, 'home')
    const firstCandidate = await candidateCopy(root, '-one')
    const secondCandidate = await candidateCopy(root, '-two')
    await writeFile(
      join(secondCandidate, 'runtime', 'tenon-bootstrap.mjs'),
      `${await readFile(join(secondCandidate, 'runtime', 'tenon-bootstrap.mjs'), 'utf8')}\n// second\n`,
      'utf8',
    )
    const scope = isolatedScope(home)
    const first = await REAL_RUNTIME_INSTALLER.withManagedTransaction(
      scope,
      (transaction) => transaction.activate(firstCandidate, 'codex'),
    )
    await REAL_RUNTIME_INSTALLER.withManagedTransaction(
      scope,
      (transaction) => transaction.activate(secondCandidate, 'codex'),
    )
    const paths = resolveRuntimePaths({ homeDir: home, env: scope.env })
    const expected = expectedStableLaunchers(paths, home)
    const bootstrapBefore = await readFile(join(paths.bootstrapRoot, 'active.mjs'), 'utf8')
    await writeFile(`${expected.tenon.path}.tenon-transition-owner`, 'unrelated-owner\n', 'utf8')
    await writeFile(`${expected.hook.path}.tenon-transition-owner`, 'unrelated-owner\n', 'utf8')

    const rolledBack = await REAL_RUNTIME_INSTALLER.rollback(scope)

    expect(rolledBack.release.releaseId).toBe(first.release.releaseId)
    expect((await REAL_RUNTIME_INSTALLER.inspect(scope)).selection.activeRelease)
      .toBe(first.release.releaseId)
    expect(await readFile(join(paths.bootstrapRoot, 'active.mjs'), 'utf8')).toBe(bootstrapBefore)
    expect(await readFile(expected.tenon.path, 'utf8')).toBe(expected.tenon.state.kind === 'file'
      ? expected.tenon.state.content
      : '')
    expect(await readFile(expected.hook.path, 'utf8')).toBe(expected.hook.state.kind === 'file'
      ? expected.hook.state.content
      : '')
    expect(await readFile(`${expected.tenon.path}.tenon-transition-owner`, 'utf8'))
      .toBe('unrelated-owner\n')
    expect(await readFile(`${expected.hook.path}.tenon-transition-owner`, 'utf8'))
      .toBe('unrelated-owner\n')
  }, 60_000)

  it('keeps the real same-release selection and preexisting Dashboard aligned when evidence fails', async () => {
    const root = await freshRoot('same-release-evidence-compensation')
    const home = join(root, 'home')
    const candidate = await candidateCopy(root)
    const scope = {
      homeDir: home,
      env: { TENON_RUNTIME_HOME: join(root, 'runtime') },
    }
    let running: {
      version: 1
      serverVersion: string
      port: number
      pid: number
      releaseId: string
      stateScopeId: string
      transactionId: string
    } | null = null
    const starter: ReleasedDashboardStarter = {
      inspect: async () => running,
      adopt: async () => null,
      start: async (_deps, payloadRoot, opts) => {
        const releaseId = payloadRoot.split('/').at(-2)
        if (releaseId === undefined || opts.transactionId === undefined) {
          throw new Error('missing managed Dashboard identity')
        }
        running = {
          version: 1,
          serverVersion: opts.expectedServerVersion ?? '1.0.2',
          port: opts.port ?? 18_765,
          pid: 42_424,
          releaseId,
          stateScopeId: `sha256-v1-${'1'.repeat(64)}`,
          transactionId: opts.transactionId,
        }
        return {
          state: 'ready',
          session: {
            ownership: running,
            stop: async () => ({ state: 'stopped' as const }),
          },
        }
      },
    }
    const request = {
      operation: 'setup' as const,
      source: 'codex' as const,
      runtime: scope,
      openBrowser: false,
      prepareCandidate: () => ({ candidateRoot: candidate }),
    }

    expect(await publishManagedRelease(
      makeDeps(),
      request,
      REAL_RUNTIME_INSTALLER,
      starter,
    )).toMatchObject({ ok: true })
    const firstDashboard = running
    const firstSelection = (await REAL_RUNTIME_INSTALLER.inspect(scope)).selection

    expect(await publishManagedRelease(
      makeDeps(),
      {
        ...request,
        commitReadyEvidence: () => {
          throw new Error('injected evidence failure')
        },
      },
      REAL_RUNTIME_INSTALLER,
      starter,
    )).toMatchObject({ ok: false, state: 'restored' })

    const after = await REAL_RUNTIME_INSTALLER.inspect(scope)
    expect(after.activeValid).toBe(true)
    expect(after.selection.activeRelease).toBe(firstSelection.activeRelease)
    expect(after.selection.previousRelease).toBe(firstSelection.previousRelease)
    expect(running).toEqual(firstDashboard)
  }, 60_000)

  it('restores the previous Dashboard after evidence failure and a fresh real-store retry replaces it safely', async () => {
    const root = await freshRoot('changed-release-preexisting-compensation')
    const home = join(root, 'home')
    const firstCandidate = await candidateCopy(root, '-one')
    const secondCandidate = await candidateCopy(root, '-two')
    await writeFile(
      join(secondCandidate, 'runtime', 'tenon-bootstrap.mjs'),
      `${await readFile(join(secondCandidate, 'runtime', 'tenon-bootstrap.mjs'), 'utf8')}\n// changed release\n`,
      'utf8',
    )
    const scope = {
      homeDir: home,
      env: { TENON_RUNTIME_HOME: join(root, 'runtime') },
    }
    const first = await publishManagedRelease(
      makeDeps(),
      {
        operation: 'setup',
        source: 'codex',
        runtime: scope,
        openBrowser: false,
        prepareCandidate: () => ({ candidateRoot: firstCandidate }),
      },
      REAL_RUNTIME_INSTALLER,
      undefined,
    )
    expect(first).toMatchObject({ ok: true })
    if (!first.ok) throw new Error(first.detail)

    let running: {
      version: 1
      serverVersion: string
      port: number
      pid: number
      releaseId: string
      stateScopeId: string
      transactionId?: string
    } | null = {
      version: 1,
      serverVersion: '1.0.2',
      port: 43_210,
      pid: 42_425,
      releaseId: first.activation.release.releaseId,
      stateScopeId: `sha256-v1-${'2'.repeat(64)}`,
      transactionId: 'previous-service',
    }
    const events: string[] = []
    const starter: ReleasedDashboardStarter = {
      inspect: async () => running,
      adopt: async (_deps, identity) => {
        if (running === null || JSON.stringify(running) !== JSON.stringify(identity)) return null
        return {
          ownership: running,
          stop: async () => {
            events.push(`dashboard:stop:${identity.releaseId}`)
            running = null
            return { state: 'stopped' as const }
          },
        }
      },
      start: async (_deps, payloadRoot, opts) => {
        const releaseId = basename(dirname(payloadRoot))
        events.push(`dashboard:start:${releaseId}`)
        running = {
          version: 1,
          serverVersion: opts.expectedServerVersion ?? '1.0.2',
          port: opts.port ?? 18_765,
          pid: releaseId === first.activation.release.releaseId ? 42_425 : 42_426,
          releaseId,
          stateScopeId: `sha256-v1-${'2'.repeat(64)}`,
          ...(opts.transactionId === undefined ? {} : { transactionId: opts.transactionId }),
        }
        return {
          state: 'ready',
          session: {
            ownership: running,
            stop: async () => {
              events.push(`dashboard:stop:${releaseId}`)
              running = null
              return { state: 'stopped' as const }
            },
          },
        }
      },
    }

    const updateRequest = {
      operation: 'update' as const,
      source: 'codex' as const,
      runtime: scope,
      openBrowser: false,
      dashboardPort: 43_210,
      prepareCandidate: () => ({ candidateRoot: secondCandidate }),
    }
    const failedUpdate = await publishManagedRelease(
      makeDeps(),
      {
        ...updateRequest,
        commitReadyEvidence: () => {
          throw new Error('injected evidence failure')
        },
      },
      REAL_RUNTIME_INSTALLER,
      starter,
    )
    if (failedUpdate.ok || failedUpdate.state !== 'restored') {
      throw new Error(`expected restored compensation: ${failedUpdate.detail}`)
    }

    const restored = await REAL_RUNTIME_INSTALLER.inspect(scope)
    expect(restored.activeValid).toBe(true)
    expect(restored.selection.activeRelease).toBe(first.activation.release.releaseId)
    expect(running?.releaseId).toBe(first.activation.release.releaseId)
    expect(running?.transactionId).toMatch(/:restore$/)
    const journalPath = join(
      pathsFor(root).managedTransactionRoot,
      'release-transaction.json',
    )
    await expect(readFile(journalPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

    expect(await publishManagedRelease(
      makeDeps(),
      updateRequest,
      REAL_RUNTIME_INSTALLER,
      starter,
    )).toMatchObject({ ok: true, state: 'ready' })
    const recovered = await REAL_RUNTIME_INSTALLER.inspect(scope)
    expect(recovered.activeValid).toBe(true)
    expect(recovered.selection.activeRelease).toBe(running?.releaseId)
    expect(recovered.selection.activeRelease).not.toBe(first.activation.release.releaseId)
    await expect(readFile(journalPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(events.filter((event) =>
      event === `dashboard:stop:${first.activation.release.releaseId}`)).toHaveLength(2)
  }, 60_000)

  it('recovers a real persisted release journal after an abrupt process restart', async () => {
    const root = await freshRoot('process-restart-recovery')
    const candidate = await candidateCopy(root)
    const helper = join(root, 'release-restart-helper.mjs')
    const coordinatorPath = join(
      repoRoot,
      'packages',
      'cli',
      'src',
      'commands',
      'release-coordinator.ts',
    )
    const installerPath = join(repoRoot, 'packages', 'cli', 'src', 'runtime', 'installer.ts')
    await esbuild({
      stdin: {
        contents: `
          import { publishManagedRelease } from ${JSON.stringify(coordinatorPath)}
          import { REAL_RUNTIME_INSTALLER } from ${JSON.stringify(installerPath)}
          const [phase, root, candidate] = process.argv.slice(2)
          const scope = {
            homeDir: root + '/home',
            env: { TENON_RUNTIME_HOME: root + '/runtime' },
          }
          const starter = {
            inspect: async () => null,
            adopt: async () => null,
            start: async (_deps, payloadRoot, opts) => {
              if (phase === 'crash') process.exit(91)
              const releaseId = payloadRoot.split('/').at(-2)
              return {
                state: 'ready',
                session: {
                  ownership: {
                    version: 1,
                    serverVersion: opts.expectedServerVersion ?? '1.0.2',
                    port: opts.port ?? 18765,
                    pid: process.pid,
                    releaseId,
                    stateScopeId: 'sha256-v1-${'3'.repeat(64)}',
                    transactionId: opts.transactionId,
                  },
                  stop: async () => ({ state: 'stopped' }),
                },
              }
            },
          }
          const outcome = await publishManagedRelease(
            { clock: () => new Date().toISOString() },
            {
              operation: 'setup',
              source: 'codex',
              runtime: scope,
              openBrowser: false,
              dashboardPort: 43210,
              prepareCandidate: () => ({ candidateRoot: candidate }),
            },
            REAL_RUNTIME_INSTALLER,
            starter,
          )
          const inspection = await REAL_RUNTIME_INSTALLER.inspect(scope)
          process.stdout.write(JSON.stringify({ outcome, inspection }) + '\\n')
        `,
        sourcefile: 'release-restart-helper.ts',
        loader: 'ts',
        resolveDir: repoRoot,
      },
      outfile: helper,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      alias: {
        '@tenon/kernel': join(repoRoot, 'packages', 'kernel', 'src', 'index.ts'),
      },
    })

    await expect(execFileAsync(process.execPath, [helper, 'crash', root, candidate]))
      .rejects.toMatchObject({ code: 91 })
    const journalPath = join(
      pathsFor(root).managedTransactionRoot,
      'release-transaction.json',
    )
    expect(JSON.parse(await readFile(journalPath, 'utf8'))).toMatchObject({
      phase: 'starting-dashboard',
      dashboardPort: 43_210,
    })

    const recovered = await execFileAsync(
      process.execPath,
      [helper, 'recover', root, candidate],
    )
    const result = JSON.parse(recovered.stdout)
    expect(result.outcome, JSON.stringify(result)).toMatchObject({ ok: true, state: 'ready' })
    expect(result.inspection).toMatchObject({
      activeValid: true,
      selection: {
        activeRelease: result.outcome.activation.release.releaseId,
      },
    })
    await expect(readFile(journalPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  }, 60_000)

  it.each(['started', 'completed'] as const)(
    'recovers a native host %s checkpoint from the real journal after a process restart without replay',
    async (checkpointState) => {
    const root = await freshRoot(`native-host-${checkpointState}-process-restart`)
    const candidate = await candidateCopy(root)
    const helper = join(root, 'native-host-restart-helper.mjs')
    const coordinatorPath = join(
      repoRoot,
      'packages',
      'cli',
      'src',
      'commands',
      'release-coordinator.ts',
    )
    const hostCommandPath = join(
      repoRoot,
      'packages',
      'cli',
      'src',
      'commands',
      'managed-host-command.ts',
    )
    const installerPath = join(repoRoot, 'packages', 'cli', 'src', 'runtime', 'installer.ts')
    await esbuild({
      stdin: {
        contents: `
          import { readFileSync, writeFileSync } from 'node:fs'
          import { publishManagedRelease } from ${JSON.stringify(coordinatorPath)}
          import { runManagedHostCommand } from ${JSON.stringify(hostCommandPath)}
          import { REAL_RUNTIME_INSTALLER } from ${JSON.stringify(installerPath)}
          const [mode, root, candidate] = process.argv.slice(2)
          const marketplaceRoot = root + '/marketplace'
          const hostPath = root + '/host.json'
          const scope = {
            homeDir: root + '/home',
            env: { TENON_RUNTIME_HOME: root + '/runtime' },
          }
          const readHost = () => JSON.parse(readFileSync(hostPath, 'utf8'))
          const writeHost = (host) => writeFileSync(hostPath, JSON.stringify(host), 'utf8')
          const env = {
            homeDir: () => root + '/home',
            runtimeEnv: () => scope.env,
            readText: (path) => path === marketplaceRoot + '/.codex-plugin/plugin.json'
              ? JSON.stringify({ version: '1.0.1' })
              : undefined,
            runCommand: (cmd, args) => {
              const command = cmd + ' ' + args.join(' ')
              const host = readHost()
              if (command === 'codex plugin marketplace list --json') {
                return {
                  code: 0,
                  stdout: JSON.stringify({
                    marketplaces: [{
                      name: 'tenon',
                      root: marketplaceRoot,
                      marketplaceSource: {
                        sourceType: 'git',
                        source: 'https://github.com/jefferysha/tenon.git',
                      },
                    }],
                  }),
                  stderr: '',
                }
              }
              if (command === 'codex plugin list --json') {
                return {
                  code: 0,
                  stdout: JSON.stringify({
                    installed: [{
                      pluginId: 'tenon@tenon',
                      version: '1.0.1',
                      source: { path: marketplaceRoot },
                    }],
                  }),
                  stderr: '',
                }
              }
              if (command === 'git -C ' + marketplaceRoot + ' rev-parse HEAD') {
                return { code: 0, stdout: host.head + '\\n', stderr: '' }
              }
              if (command === 'git -C ' + marketplaceRoot + ' remote get-url origin') {
                return {
                  code: 0,
                  stdout: 'https://github.com/jefferysha/tenon.git\\n',
                  stderr: '',
                }
              }
              if (command === 'git ls-remote https://github.com/jefferysha/tenon.git refs/heads/main') {
                return {
                  code: 0,
                  stdout: host.remoteHead + '\\trefs/heads/main\\n',
                  stderr: '',
                }
              }
              if (command === 'codex plugin marketplace upgrade tenon --json') {
                host.executions += 1
                host.head = host.remoteHead
                writeHost(host)
                if (mode === 'crash-started') process.exit(91)
                return { code: 0, stdout: 'unexpected replay', stderr: '' }
              }
              return { code: 1, stdout: '', stderr: 'unexpected command: ' + command }
            },
          }
          const outcome = await publishManagedRelease(
            { clock: () => new Date().toISOString() },
            {
              operation: 'update',
              source: 'codex',
              runtime: scope,
              openBrowser: false,
              prepareCandidate: async (transaction) => {
                await runManagedHostCommand(
                  transaction,
                  'marketplace-refresh',
                  env,
                  {
                    cmd: 'codex',
                    args: ['plugin', 'marketplace', 'upgrade', 'tenon', '--json'],
                  },
                )
                if (mode === 'crash-completed') process.exit(92)
                return { candidateRoot: candidate }
              },
            },
            REAL_RUNTIME_INSTALLER,
            undefined,
          )
          process.stdout.write(JSON.stringify({ outcome, host: readHost() }) + '\\n')
        `,
        sourcefile: 'native-host-restart-helper.ts',
        loader: 'ts',
        resolveDir: repoRoot,
      },
      outfile: helper,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      alias: {
        '@tenon/kernel': join(repoRoot, 'packages', 'kernel', 'src', 'index.ts'),
      },
    })
    const hostPath = join(root, 'host.json')
    await writeFile(hostPath, JSON.stringify({
      head: 'a'.repeat(40),
      remoteHead: 'b'.repeat(40),
      executions: 0,
    }), 'utf8')

    await expect(execFileAsync(
      process.execPath,
      [helper, `crash-${checkpointState}`, root, candidate],
    )).rejects.toMatchObject({ code: checkpointState === 'started' ? 91 : 92 })
    const journalPath = join(pathsFor(root).managedTransactionRoot, 'release-transaction.json')
    expect(JSON.parse(await readFile(journalPath, 'utf8'))).toMatchObject({
      phase: 'preparing-host',
      hostSteps: [{ id: 'marketplace-refresh', state: checkpointState }],
    })
    expect(JSON.parse(await readFile(hostPath, 'utf8'))).toMatchObject({
      head: 'b'.repeat(40),
      executions: 1,
    })

    const recovered = await execFileAsync(process.execPath, [helper, 'recover', root, candidate])
    const result = JSON.parse(recovered.stdout)
    expect(result.outcome, recovered.stdout).toMatchObject({ ok: true, state: 'ready' })
    expect(result.host).toMatchObject({ head: 'b'.repeat(40), executions: 1 })
    await expect(readFile(journalPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    },
    60_000,
  )

  it('recovers every versioned rebind mutation across real process restarts without replay', async () => {
    const harnessRoot = await freshRoot('versioned-rebind-restart-harness')
    const helper = join(harnessRoot, 'versioned-rebind-restart-helper.mjs')
    const coordinatorPath = join(
      repoRoot,
      'packages',
      'cli',
      'src',
      'commands',
      'release-coordinator.ts',
    )
    const hostCommandPath = join(
      repoRoot,
      'packages',
      'cli',
      'src',
      'commands',
      'managed-host-command.ts',
    )
    const installerPath = join(repoRoot, 'packages', 'cli', 'src', 'runtime', 'installer.ts')
    await esbuild({
      stdin: {
        contents: `
          import { readFileSync, writeFileSync } from 'node:fs'
          import { publishManagedRelease } from ${JSON.stringify(coordinatorPath)}
          import { runManagedHostCommand } from ${JSON.stringify(hostCommandPath)}
          import { REAL_RUNTIME_INSTALLER } from ${JSON.stringify(installerPath)}
          const [mode, crashStep, root, candidate] = process.argv.slice(2)
          const marketplaceRoot = root + '/marketplace'
          const hostPath = root + '/host.json'
          const target = { version: ${JSON.stringify(TENON_RELEASE_VERSION)}, tag: ${JSON.stringify(CURRENT_RELEASE_TAG)}, commit: 'b'.repeat(40) }
          const scope = {
            homeDir: root + '/home',
            env: { TENON_RUNTIME_HOME: root + '/runtime' },
          }
          const readHost = () => JSON.parse(readFileSync(hostPath, 'utf8'))
          const writeHost = (host) => writeFileSync(hostPath, JSON.stringify(host), 'utf8')
          const mutate = (step, update) => {
            const host = readHost()
            host.executions[step] += 1
            update(host)
            writeHost(host)
            if (mode === 'crash-started' && crashStep === step) process.exit(91)
          }
          const env = {
            homeDir: () => scope.homeDir,
            runtimeEnv: () => scope.env,
            readText: (path) => {
              const host = readHost()
              if (path === scope.homeDir + '/.codex/config.toml') {
                return host.marketplacePresent
                  ? '[marketplaces.tenon]\\nsource_type = "git"\\nsource = "https://github.com/jefferysha/tenon.git"\\nref = "' + host.ref + '"\\n'
                  : undefined
              }
              if (path === marketplaceRoot + '/.codex-plugin/plugin.json'
                || path === marketplaceRoot + '/.claude-plugin/plugin.json'
                || path === marketplaceRoot + '/package.json') {
                return JSON.stringify({ version: host.marketplaceVersion })
              }
              return undefined
            },
            runCommand: (cmd, args) => {
              const command = cmd + ' ' + args.join(' ')
              const host = readHost()
              if (command === 'codex plugin marketplace list --json') {
                return {
                  code: 0,
                  stdout: JSON.stringify({
                    marketplaces: host.marketplacePresent ? [{
                      name: 'tenon',
                      root: marketplaceRoot,
                      marketplaceSource: {
                        sourceType: 'git',
                        source: 'https://github.com/jefferysha/tenon.git',
                      },
                    }] : [],
                  }),
                  stderr: '',
                }
              }
              if (command === 'codex plugin list --json') {
                return {
                  code: 0,
                  stdout: JSON.stringify({
                    installed: host.pluginPresent ? [{
                      pluginId: 'tenon@tenon',
                      version: host.pluginVersion,
                      enabled: true,
                      source: { path: marketplaceRoot },
                    }] : [],
                  }),
                  stderr: '',
                }
              }
              if (command === 'git -C ' + marketplaceRoot + ' rev-parse HEAD') {
                return host.marketplacePresent
                  ? { code: 0, stdout: host.head + '\\n', stderr: '' }
                  : { code: 1, stdout: '', stderr: 'absent' }
              }
              if (command === 'git -C ' + marketplaceRoot + ' diff --quiet HEAD --') {
                return { code: 0, stdout: '', stderr: '' }
              }
              if (command === 'git -C ' + marketplaceRoot + ' ls-files --others --exclude-standard') {
                return { code: 0, stdout: '', stderr: '' }
              }
              if (command === 'git -C ' + marketplaceRoot + ' remote get-url origin') {
                return {
                  code: 0,
                  stdout: 'https://github.com/jefferysha/tenon.git\\n',
                  stderr: '',
                }
              }
              if (command === 'codex plugin remove tenon@tenon --json') {
                mutate('plugin-remove', (value) => { value.pluginPresent = false })
                return { code: 0, stdout: '', stderr: '' }
              }
              if (command === 'codex plugin marketplace remove tenon --json') {
                mutate('marketplace-remove', (value) => {
                  value.marketplacePresent = false
                  value.pluginPresent = false
                  value.ref = null
                })
                return { code: 0, stdout: '', stderr: '' }
              }
              if (command === 'codex plugin marketplace add jefferysha/tenon --ref ${CURRENT_RELEASE_TAG} --json') {
                mutate('marketplace-register', (value) => {
                  value.marketplacePresent = true
                  value.pluginPresent = false
                  value.head = target.commit
                  value.ref = target.tag
                  value.marketplaceVersion = target.version
                })
                return { code: 0, stdout: '', stderr: '' }
              }
              if (command === 'codex plugin add tenon@tenon --json') {
                mutate('plugin-install', (value) => {
                  value.pluginPresent = true
                  value.pluginVersion = target.version
                })
                return { code: 0, stdout: '', stderr: '' }
              }
              return { code: 1, stdout: '', stderr: 'unexpected command: ' + command }
            },
          }
          const commands = [
            ['plugin-remove', ['plugin', 'remove', 'tenon@tenon', '--json']],
            ['marketplace-remove', ['plugin', 'marketplace', 'remove', 'tenon', '--json']],
            ['marketplace-register', ['plugin', 'marketplace', 'add', 'jefferysha/tenon', '--ref', ${JSON.stringify(CURRENT_RELEASE_TAG)}, '--json']],
            ['plugin-install', ['plugin', 'add', 'tenon@tenon', '--json']],
          ]
          const outcome = await publishManagedRelease(
            { clock: () => new Date().toISOString() },
            {
              operation: 'update',
              source: 'codex',
              requiresStableTarget: true,
              resolveStableTargetBeforeRecovery: async () => {
                const host = readHost()
                host.resolverCalls += 1
                writeHost(host)
                return target
              },
              proveFrozenTarget: (value) => {
                if (JSON.stringify(value) !== JSON.stringify(target)) throw new Error('frozen target drift')
              },
              runtime: scope,
              openBrowser: false,
              prepareCandidate: async (transaction) => {
                const frozen = await transaction.resolveStableTarget(
                  async () => target,
                  (value) => {
                    if (JSON.stringify(value) !== JSON.stringify(target)) throw new Error('frozen target drift')
                  },
                )
                for (const [step, args] of commands) {
                  await runManagedHostCommand(
                    transaction,
                    step,
                    env,
                    { cmd: 'codex', args },
                    frozen,
                  )
                  if (mode === 'crash-completed' && crashStep === step) process.exit(92)
                }
                return { candidateRoot: candidate }
              },
            },
            REAL_RUNTIME_INSTALLER,
            undefined,
          )
          process.stdout.write(JSON.stringify({ outcome, host: readHost() }) + '\\n')
        `,
        sourcefile: 'versioned-rebind-restart-helper.ts',
        loader: 'ts',
        resolveDir: repoRoot,
      },
      outfile: helper,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      alias: {
        '@tenon/kernel': join(repoRoot, 'packages', 'kernel', 'src', 'index.ts'),
      },
    })

    const steps = [
      'plugin-remove',
      'marketplace-remove',
      'marketplace-register',
      'plugin-install',
    ] as const
    for (const checkpointState of ['started', 'completed'] as const) {
      for (const step of steps) {
        const root = await freshRoot(`versioned-rebind-${checkpointState}-${step}`)
        const candidate = await candidateCopy(root)
        const hostPath = join(root, 'host.json')
        await writeFile(hostPath, JSON.stringify({
          marketplacePresent: true,
          pluginPresent: true,
          head: 'a'.repeat(40),
          ref: 'main',
          marketplaceVersion: '1.0.1',
          pluginVersion: '1.0.1',
          resolverCalls: 0,
          executions: {
            'plugin-remove': 0,
            'marketplace-remove': 0,
            'marketplace-register': 0,
            'plugin-install': 0,
          },
        }), 'utf8')

        await expect(execFileAsync(
          process.execPath,
          [helper, `crash-${checkpointState}`, step, root, candidate],
        )).rejects.toMatchObject({ code: checkpointState === 'started' ? 91 : 92 })
        const journalPath = join(pathsFor(root).managedTransactionRoot, 'release-transaction.json')
        const crashedJournal = JSON.parse(await readFile(journalPath, 'utf8'))
        expect(crashedJournal).toMatchObject({
          phase: 'preparing-host',
          stableTarget: { version: TENON_RELEASE_VERSION, tag: CURRENT_RELEASE_TAG, commit: 'b'.repeat(40) },
        })
        expect(crashedJournal.hostSteps.at(-1)).toMatchObject({ id: step, state: checkpointState })

        const recovered = await execFileAsync(
          process.execPath,
          [helper, 'recover', step, root, candidate],
        )
        const result = JSON.parse(recovered.stdout)
        expect(result.outcome, `${checkpointState}/${step}: ${recovered.stdout}`)
          .toMatchObject({ ok: true, state: 'ready' })
        expect(result.host).toMatchObject({
          marketplacePresent: true,
          pluginPresent: true,
          head: 'b'.repeat(40),
          ref: CURRENT_RELEASE_TAG,
          marketplaceVersion: TENON_RELEASE_VERSION,
          pluginVersion: TENON_RELEASE_VERSION,
          resolverCalls: 1,
          executions: {
            'plugin-remove': 1,
            'marketplace-remove': 1,
            'marketplace-register': 1,
            'plugin-install': 1,
          },
        })
        await expect(readFile(journalPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      }
    }
  }, 120_000)

  it('resumes every durable compensation phase after a real process crash without duplicate effects', async () => {
    const crashModes = [
      'crash-stopping-candidate',
      'crash-reverting-activation',
      'crash-restoring-previous',
      'crash-previous-restored',
    ] as const
    for (const crashMode of crashModes) {
      const root = await freshRoot(`compensation-${crashMode}`)
      const firstCandidate = await candidateCopy(root, '-one')
      const secondCandidate = await candidateCopy(root, '-two')
      await writeFile(
        join(secondCandidate, 'runtime', 'tenon-bootstrap.mjs'),
        `${await readFile(join(secondCandidate, 'runtime', 'tenon-bootstrap.mjs'), 'utf8')}\n`
          + `// ${crashMode}\n`,
        'utf8',
      )
      const helper = join(root, 'compensation-restart-helper.mjs')
      const coordinatorPath = join(repoRoot, 'packages', 'cli', 'src', 'commands', 'release-coordinator.ts')
      const installerPath = join(repoRoot, 'packages', 'cli', 'src', 'runtime', 'installer.ts')
      await esbuild({
        stdin: {
          contents: `
            import { readFile, writeFile, unlink } from 'node:fs/promises'
            import { publishManagedRelease } from ${JSON.stringify(coordinatorPath)}
            import { REAL_RUNTIME_INSTALLER } from ${JSON.stringify(installerPath)}
            const [mode, root, firstCandidate, secondCandidate] = process.argv.slice(2)
            const scope = {
              homeDir: root + '/home',
              env: { TENON_RUNTIME_HOME: root + '/runtime' },
            }
            const dashboardPath = root + '/dashboard.json'
            const startsPath = root + '/dashboard-starts.txt'
            const stopsPath = root + '/dashboard-stops.txt'
            const readDashboard = async () => {
              try { return JSON.parse(await readFile(dashboardPath, 'utf8')) }
              catch (error) {
                if (error?.code === 'ENOENT') return null
                throw error
              }
            }
            const writeDashboard = (identity) =>
              writeFile(dashboardPath, JSON.stringify(identity), 'utf8')
            const incrementCounter = async (path) => {
              let count = 0
              try { count = Number(await readFile(path, 'utf8')) }
              catch (error) { if (error?.code !== 'ENOENT') throw error }
              count += 1
              await writeFile(path, String(count), 'utf8')
              return count
            }
            const starter = {
              inspect: async () => readDashboard(),
              adopt: async (_deps, identity) => {
                const current = await readDashboard()
                const { owner: _owner, ...expected } = identity
                if (JSON.stringify(current) !== JSON.stringify(expected)) return null
                return {
                  ownership: current,
                  stop: async () => {
                    await incrementCounter(stopsPath)
                    await unlink(dashboardPath).catch((error) => {
                      if (error?.code !== 'ENOENT') throw error
                    })
                    return { state: 'stopped' }
                  },
                }
              },
              start: async (_deps, payloadRoot, opts) => {
                const releaseId = payloadRoot.split('/').at(-2)
                const starts = await incrementCounter(startsPath)
                const ownership = {
                  version: 1,
                  serverVersion: opts.expectedServerVersion ?? '1.0.2',
                  port: opts.port ?? 18765,
                  pid: 45000 + starts,
                  releaseId,
                  stateScopeId: 'sha256-v1-${'4'.repeat(64)}',
                  transactionId: opts.transactionId,
                }
                await writeDashboard(ownership)
                const restoringPrevious = opts.transactionId?.endsWith(':restore') === true
                if (mode === 'crash-restoring-previous' && restoringPrevious) process.exit(91)
                return {
                  state: 'ready',
                  session: {
                    ownership,
                    stop: async () => {
                      await incrementCounter(stopsPath)
                      await unlink(dashboardPath).catch((error) => {
                        if (error?.code !== 'ENOENT') throw error
                      })
                      if (mode === 'crash-stopping-candidate') process.exit(91)
                      return { state: 'stopped' }
                    },
                  },
                }
              },
            }
            const crashingInstaller = {
              ...REAL_RUNTIME_INSTALLER,
              withManagedTransaction: (runtimeScope, operation) =>
                REAL_RUNTIME_INSTALLER.withManagedTransaction(runtimeScope, (transaction) =>
                  operation({
                    ...transaction,
                    revertActivation: async (activation) => {
                      await transaction.revertActivation(activation)
                      if (mode === 'crash-reverting-activation') process.exit(91)
                    },
                    journal: {
                      ...transaction.journal,
                      write: async (record) => {
                        await transaction.journal.write(record)
                        if (mode === 'crash-previous-restored'
                          && record.phase === 'previous-restored') process.exit(91)
                      },
                    },
                  })),
            }
            if (mode === 'seed') {
              const outcome = await publishManagedRelease(
                { clock: () => new Date().toISOString() },
                {
                  operation: 'setup',
                  source: 'codex',
                  runtime: scope,
                  openBrowser: false,
                  dashboardPort: 43210,
                  prepareCandidate: () => ({ candidateRoot: firstCandidate }),
                },
                REAL_RUNTIME_INSTALLER,
                undefined,
              )
              if (!outcome.ok) throw new Error(outcome.detail)
              await writeDashboard({
                version: 1,
                serverVersion: '1.0.2',
                port: 43210,
                pid: 44000,
                releaseId: outcome.activation.release.releaseId,
                stateScopeId: 'sha256-v1-${'4'.repeat(64)}',
                transactionId: 'previous-service',
              })
              process.stdout.write(JSON.stringify({
                firstRelease: outcome.activation.release.releaseId,
              }) + '\\n')
            } else {
              const outcome = await publishManagedRelease(
                { clock: () => new Date().toISOString() },
                {
                  operation: 'update',
                  source: 'codex',
                  runtime: scope,
                  openBrowser: false,
                  dashboardPort: 43210,
                  prepareCandidate: () => ({ candidateRoot: secondCandidate }),
                  commitReadyEvidence: () => { throw new Error('injected evidence failure') },
                },
                mode === 'recover' ? REAL_RUNTIME_INSTALLER : crashingInstaller,
                starter,
              )
              const inspection = await REAL_RUNTIME_INSTALLER.inspect(scope)
              const dashboard = await readDashboard()
              const starts = Number(await readFile(startsPath, 'utf8'))
              const stops = Number(await readFile(stopsPath, 'utf8'))
              process.stdout.write(JSON.stringify({
                outcome, inspection, dashboard, starts, stops,
              }) + '\\n')
            }
          `,
          sourcefile: 'compensation-restart-helper.ts',
          loader: 'ts',
          resolveDir: repoRoot,
        },
        outfile: helper,
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node22',
        alias: {
          '@tenon/kernel': join(repoRoot, 'packages', 'kernel', 'src', 'index.ts'),
        },
      })

      const seeded = await execFileAsync(
        process.execPath,
        [helper, 'seed', root, firstCandidate, secondCandidate],
      )
      const firstRelease = JSON.parse(seeded.stdout).firstRelease as string
      await expect(execFileAsync(
        process.execPath,
        [helper, crashMode, root, firstCandidate, secondCandidate],
      )).rejects.toMatchObject({ code: 91 })

      const journalPath = join(pathsFor(root).managedTransactionRoot, 'release-transaction.json')
      const crashedJournal = JSON.parse(await readFile(journalPath, 'utf8'))
      const expectedCrashPhase = {
        'crash-stopping-candidate': 'stopping-candidate',
        'crash-reverting-activation': 'reverting-activation',
        'crash-restoring-previous': 'restoring-previous',
        'crash-previous-restored': 'previous-restored',
      } as const
      expect(crashedJournal.phase).toBe(expectedCrashPhase[crashMode])

      const preRecoveryInspection = await REAL_RUNTIME_INSTALLER.inspect({
        homeDir: join(root, 'home'),
        env: { TENON_RUNTIME_HOME: join(root, 'runtime') },
      })
      const preRecoveryDashboard = await readFile(join(root, 'dashboard.json'), 'utf8')
        .then((contents) => JSON.parse(contents))
        .catch((error) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
          throw error
        })
      if (crashMode === 'crash-stopping-candidate') {
        expect(preRecoveryInspection.selection.activeRelease).not.toBe(firstRelease)
        expect(preRecoveryInspection.selection.activeRelease).not.toBeNull()
        expect(preRecoveryDashboard).toBeNull()
      } else {
        expect(preRecoveryInspection.selection.activeRelease).toBe(firstRelease)
        if (
          crashMode === 'crash-restoring-previous'
          || crashMode === 'crash-previous-restored'
        ) {
          expect(preRecoveryDashboard).toMatchObject({
            releaseId: firstRelease,
            transactionId: expect.stringMatching(/:restore$/),
          })
        } else {
          expect(preRecoveryDashboard).toBeNull()
        }
      }

      const recovered = await execFileAsync(
        process.execPath,
        [helper, 'recover', root, firstCandidate, secondCandidate],
      )
      const result = JSON.parse(recovered.stdout)
      expect(result.outcome, `${crashMode}: ${recovered.stdout}`)
        .toMatchObject({ ok: false, state: 'restored' })
      expect(result.inspection.selection.activeRelease).toBe(firstRelease)
      expect(result.dashboard).toMatchObject({
        releaseId: firstRelease,
        transactionId: expect.stringMatching(/:restore$/),
      })
      expect(result.starts).toBe(2)
      expect(result.stops).toBe(2)
      await expect(readFile(journalPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    }
  }, 180_000)
})
