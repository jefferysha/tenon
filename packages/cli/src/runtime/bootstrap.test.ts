import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { chmod, copyFile, lstat, mkdtemp, mkdir, readdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { serializeProductRootContract } from '@tenon/kernel'
import { afterEach, describe, expect, it } from 'vitest'
import { freezeTrustedExecutable } from '../commands/trusted-executable.js'
import { expectedStableLaunchers, writeStableLaunchers } from './launchers.js'
import { resolveRuntimePaths } from './paths.js'
import { hashReleasePayload } from './release-payload.js'
import { runtimeReleaseIdV2 } from './release-store-codecs.js'
import { legacyV020LauncherText } from './test-support.js'
import type { RuntimePaths, TrustedExecutableProof } from './types.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const bootstrapSource = join(repoRoot, 'runtime', 'tenon-bootstrap.mjs')
const roots: string[] = []

interface V2FixtureManifest {
  releaseId: string
  source: { host: string; pluginVersion: string }
  stableTarget: { version: string; tag: string; commit: string }
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

async function freshRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `pipeline-bootstrap-${label}-`))
  roots.push(root)
  return root
}

async function payloadDigest(root: string): Promise<string> {
  const hash = createHash('sha256')
  async function visit(dir: string, relativePath: string): Promise<void> {
    const { readdir, lstat, readFile: read } = await import('node:fs/promises')
    const entries = await readdir(dir, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const path = join(dir, entry.name)
      const child = relativePath === '' ? entry.name : `${relativePath}/${entry.name}`
      const stat = await lstat(path)
      if (stat.isDirectory()) {
        hash.update(`D\u0000${child}\u0000`)
        await visit(path, child)
      } else if (stat.isFile()) {
        hash.update(`F\u0000${child}\u0000${(stat.mode & 0o777).toString(8)}\u0000`)
        hash.update(await read(path))
      } else {
        throw new Error(`unsupported fixture entry: ${child}`)
      }
    }
  }
  await visit(root, '')
  return hash.digest('hex')
}

async function createRelease(
  runtimeHome: string,
  marker: string,
  cliSource = `process.stdout.write(${JSON.stringify(marker)})\n`,
): Promise<string> {
  const stagingPayload = join(runtimeHome, 'fixture', marker, 'payload')
  await mkdir(join(stagingPayload, 'packages', 'cli', 'dist'), { recursive: true })
  await mkdir(join(stagingPayload, 'runtime'), { recursive: true })
  await mkdir(join(stagingPayload, 'hooks'), { recursive: true })
  await writeFile(join(stagingPayload, 'packages', 'cli', 'dist', 'tenon.mjs'), cliSource, 'utf8')
  await writeFile(join(stagingPayload, 'hooks', 'probe.sh'), '#!/bin/bash\nprintf TRUSTED_HOOK\n', 'utf8')
  await writeFile(join(stagingPayload, 'hooks', 'session-start.sh'), '#!/bin/bash\nprintf TRUSTED_SESSION_START\n', 'utf8')
  await copyFile(bootstrapSource, join(stagingPayload, 'runtime', 'tenon-bootstrap.mjs'))
  await chmod(join(stagingPayload, 'runtime', 'tenon-bootstrap.mjs'), 0o755)
  const digest = await payloadDigest(stagingPayload)
  const releaseId = `sha256-${digest}`
  const releaseRoot = join(runtimeHome, 'data', 'releases', releaseId)
  await mkdir(join(releaseRoot, 'payload', 'packages', 'cli', 'dist'), { recursive: true })
  await mkdir(join(releaseRoot, 'payload', 'runtime'), { recursive: true })
  await mkdir(join(releaseRoot, 'payload', 'hooks'), { recursive: true })
  await copyFile(join(stagingPayload, 'packages', 'cli', 'dist', 'tenon.mjs'), join(releaseRoot, 'payload', 'packages', 'cli', 'dist', 'tenon.mjs'))
  await copyFile(join(stagingPayload, 'hooks', 'probe.sh'), join(releaseRoot, 'payload', 'hooks', 'probe.sh'))
  await copyFile(join(stagingPayload, 'hooks', 'session-start.sh'), join(releaseRoot, 'payload', 'hooks', 'session-start.sh'))
  await copyFile(join(stagingPayload, 'runtime', 'tenon-bootstrap.mjs'), join(releaseRoot, 'payload', 'runtime', 'tenon-bootstrap.mjs'))
  await chmod(join(releaseRoot, 'payload', 'runtime', 'tenon-bootstrap.mjs'), 0o755)
  await writeFile(join(releaseRoot, 'release.json'), `${JSON.stringify({
    version: 1,
    releaseId,
    payloadDigest: digest,
    createdAt: '2026-07-24T00:00:00Z',
    source: { host: 'codex', pluginVersion: '1.0.0' },
  })}\n`, 'utf8')
  return releaseId
}

async function createV2Release(runtimeHome: string, marker: string): Promise<{
  releaseId: string
  manifestPath: string
}> {
  const stagingPayload = join(runtimeHome, 'fixture', marker, 'payload')
  await mkdir(join(stagingPayload, 'packages', 'cli', 'dist'), { recursive: true })
  await mkdir(join(stagingPayload, 'runtime'), { recursive: true })
  await writeFile(
    join(stagingPayload, 'packages', 'cli', 'dist', 'tenon.mjs'),
    `process.stdout.write(${JSON.stringify(marker)})\n`,
    'utf8',
  )
  await copyFile(bootstrapSource, join(stagingPayload, 'runtime', 'tenon-bootstrap.mjs'))
  await chmod(join(stagingPayload, 'runtime', 'tenon-bootstrap.mjs'), 0o755)
  const payloadDigest = await hashReleasePayload(stagingPayload)
  const source = { host: 'codex' as const, pluginVersion: '1.0.2' }
  const stableTarget = { version: '1.0.2', tag: 'v1.0.2', commit: 'a'.repeat(40) }
  const releaseId = runtimeReleaseIdV2(payloadDigest, source, stableTarget)
  const releaseRoot = join(runtimeHome, 'data', 'releases', releaseId)
  await mkdir(join(releaseRoot, 'payload', 'packages', 'cli', 'dist'), { recursive: true })
  await mkdir(join(releaseRoot, 'payload', 'runtime'), { recursive: true })
  await copyFile(
    join(stagingPayload, 'packages', 'cli', 'dist', 'tenon.mjs'),
    join(releaseRoot, 'payload', 'packages', 'cli', 'dist', 'tenon.mjs'),
  )
  await copyFile(
    join(stagingPayload, 'runtime', 'tenon-bootstrap.mjs'),
    join(releaseRoot, 'payload', 'runtime', 'tenon-bootstrap.mjs'),
  )
  await chmod(join(releaseRoot, 'payload', 'runtime', 'tenon-bootstrap.mjs'), 0o755)
  const manifestPath = join(releaseRoot, 'release.json')
  await writeFile(manifestPath, `${JSON.stringify({
    version: 2,
    releaseId,
    payloadDigest,
    createdAt: '2026-07-24T00:00:00Z',
    source,
    stableTarget,
  })}\n`, 'utf8')
  return { releaseId, manifestPath }
}

async function installBootstrap(runtimeHome: string): Promise<string> {
  const active = join(runtimeHome, 'data', 'bootstrap', 'active.mjs')
  await mkdir(dirname(active), { recursive: true })
  await copyFile(bootstrapSource, active)
  await chmod(active, 0o755)
  return active
}

async function runBootstrap(
  runtimeHome: string,
  bootstrap: string,
  args: string[],
  input = '',
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const home = join(runtimeHome, 'home')
  await mkdir(home, { recursive: true })
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, [bootstrap, ...args], {
      env: {
        ...process.env,
        HOME: home,
        TENON_RUNTIME_ROOTS: JSON.stringify({
          version: 1,
          dataRoot: join(runtimeHome, 'data'),
          stateRoot: join(runtimeHome, 'state'),
          configRoot: join(runtimeHome, 'config'),
        }),
        ...extraEnv,
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.on('error', (error) => resolveResult({ stdout, stderr: `${stderr}${error.message}`, code: 1 }))
    child.on('close', (code) => resolveResult({ stdout, stderr, code: code ?? 1 }))
    child.stdin.end(input)
  })
}

describe('stable runtime bootstrap', () => {
  it('executes managed hooks with the absolute system Bash instead of an attacker-controlled PATH entry', async () => {
    const root = await freshRoot('trusted-hook-bash')
    const activeRelease = await createRelease(root, 'active')
    const bootstrap = await installBootstrap(root)
    const state = join(root, 'state')
    const attackerBin = join(root, 'attacker-bin')
    const attackerMarker = join(root, 'attacker-bash-ran')
    await mkdir(state, { recursive: true })
    await mkdir(attackerBin, { recursive: true })
    await writeFile(join(attackerBin, 'bash'), `#!/bin/sh\nprintf compromised > ${JSON.stringify(attackerMarker)}\n`, 'utf8')
    await chmod(join(attackerBin, 'bash'), 0o755)
    await writeFile(join(state, 'selection.json'), `${JSON.stringify({
      version: 1,
      revision: 1,
      activeRelease,
      previousRelease: null,
      updatedAt: '2026-07-24T00:00:00Z',
    })}\n`, 'utf8')

    const result = await runBootstrap(root, bootstrap, ['hook', 'probe'], '', {
      PATH: `${attackerBin}:${process.env.PATH ?? ''}`,
    })

    expect(result).toMatchObject({ code: 0, stdout: 'TRUSTED_HOOK' })
    await expect(readFile(attackerMarker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([
    ['source host', (manifest: V2FixtureManifest) => { manifest.source.host = 'claude' }],
    ['stable target', (manifest: V2FixtureManifest) => { manifest.stableTarget.commit = 'b'.repeat(40) }],
    ['release id', (manifest: V2FixtureManifest) => { manifest.releaseId = `sha256-${'b'.repeat(64)}` }],
  ])('rejects a v2 manifest whose %s is not bound to its release id', async (_label, mutate) => {
    const root = await freshRoot('v2-identity-drift')
    const release = await createV2Release(root, 'UNVERIFIED_V2_EXECUTED')
    const bootstrap = await installBootstrap(root)
    const manifest = JSON.parse(await readFile(release.manifestPath, 'utf8')) as V2FixtureManifest
    mutate(manifest)
    await writeFile(release.manifestPath, `${JSON.stringify(manifest)}\n`, 'utf8')
    const state = join(root, 'state')
    await mkdir(state, { recursive: true })
    await writeFile(join(state, 'selection.json'), `${JSON.stringify({
      version: 1,
      revision: 1,
      activeRelease: release.releaseId,
      previousRelease: null,
      updatedAt: '2026-07-24T00:00:00Z',
    })}\n`, 'utf8')

    const status = await runBootstrap(root, bootstrap, ['cli', 'runtime', 'status', '--json'])
    const delegated = await runBootstrap(root, bootstrap, ['cli', 'probe'])

    expect(JSON.parse(status.stdout)).toMatchObject({ activeValid: false })
    expect(delegated.code).toBe(1)
    expect(delegated.stdout).not.toContain('UNVERIFIED_V2_EXECUTED')
  })

  it('projects verified v2 active identity through public runtime status', async () => {
    const root = await freshRoot('v2-public-status')
    const release = await createV2Release(root, 'V2_STATUS')
    const bootstrap = await installBootstrap(root)
    const state = join(root, 'state')
    await mkdir(state, { recursive: true })
    await writeFile(join(state, 'selection.json'), `${JSON.stringify({
      version: 1,
      revision: 1,
      activeRelease: release.releaseId,
      previousRelease: null,
      updatedAt: '2026-07-24T00:00:00Z',
    })}\n`, 'utf8')

    const status = await runBootstrap(root, bootstrap, ['cli', 'runtime', 'status', '--json'])
    const manifest = JSON.parse(await readFile(release.manifestPath, 'utf8')) as V2FixtureManifest & {
      version: 2
      payloadDigest: string
    }

    expect(JSON.parse(status.stdout)).toMatchObject({
      activeValid: true,
      active: {
        version: 2,
        releaseId: release.releaseId,
        payloadDigest: manifest.payloadDigest,
        source: manifest.source,
        stableTarget: manifest.stableTarget,
      },
      previous: null,
      auditCorrupt: false,
    })
  })

  it('can roll back while the active payload is unavailable, after verifying the previous release digest', async () => {
    const root = await freshRoot('rollback')
    const activeRelease = await createRelease(root, 'active')
    const previousRelease = await createRelease(root, 'previous')
    const bootstrap = await installBootstrap(root)
    const state = join(root, 'state')
    await mkdir(state, { recursive: true })
    await writeFile(join(state, 'selection.json'), `${JSON.stringify({
      version: 1,
      revision: 2,
      activeRelease,
      previousRelease,
      updatedAt: '2026-07-24T00:00:00Z',
    })}\n`, 'utf8')
    const result = await runBootstrap(root, bootstrap, ['cli', 'runtime', 'repair', '--rollback'])

    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      selection: { activeRelease: previousRelease, previousRelease: activeRelease, revision: 3 },
    })
    expect(JSON.parse(await readFile(join(state, 'selection.json'), 'utf8'))).toMatchObject({
      activeRelease: previousRelease,
      previousRelease: activeRelease,
    })
  })

  it('keeps the rollback journal and recovers a terminal audit append failure without swapping twice', async () => {
    const root = await freshRoot('rollback-terminal-audit')
    const activeRelease = await createRelease(root, 'active')
    const previousRelease = await createRelease(root, 'previous')
    const bootstrap = await installBootstrap(root)
    const state = join(root, 'state')
    await mkdir(state, { recursive: true })
    await writeFile(join(state, 'selection.json'), `${JSON.stringify({
      version: 1,
      revision: 2,
      activeRelease,
      previousRelease,
      updatedAt: '2026-07-24T00:00:00Z',
    })}\n`, 'utf8')
    const marker = join(root, 'fail-terminal-audit-once')

    const first = await runBootstrap(
      root,
      bootstrap,
      ['cli', 'runtime', 'repair', '--rollback'],
      '',
      { TENON_TEST_FAIL_ROLLBACK_TERMINAL_AUDIT_ONCE: marker },
    )
    expect(first.code).toBe(1)
    expect(first.stderr).toMatch(/terminal audit failure/iu)
    expect(JSON.parse(await readFile(join(state, 'selection.json'), 'utf8'))).toMatchObject({
      activeRelease: previousRelease,
      previousRelease: activeRelease,
      revision: 3,
    })
    await expect(readFile(join(state, 'managed-release-transaction', 'runtime-rollback.json'), 'utf8'))
      .resolves.toContain(previousRelease)

    const second = await runBootstrap(root, bootstrap, ['cli', 'runtime', 'repair', '--rollback'])
    expect(second.code).toBe(0)
    expect(JSON.parse(second.stdout)).toMatchObject({
      ok: true,
      selection: { activeRelease: previousRelease, previousRelease: activeRelease, revision: 3 },
    })
    await expect(readFile(join(state, 'managed-release-transaction', 'runtime-rollback.json'), 'utf8'))
      .rejects.toThrow(/ENOENT/u)
    expect(await readFile(join(state, 'audit.jsonl'), 'utf8')).toMatch(/"kind":"rolled-back"/u)
  })

  it('does not reclaim a live runtime lock merely because its heartbeat is stale', async () => {
    const root = await freshRoot('live-stale-runtime-lock')
    const activeRelease = await createRelease(root, 'active')
    const previousRelease = await createRelease(root, 'previous')
    const bootstrap = await installBootstrap(root)
    const state = join(root, 'state')
    await mkdir(state, { recursive: true })
    const selection = {
      version: 1,
      revision: 2,
      activeRelease,
      previousRelease,
      updatedAt: '2026-07-24T00:00:00Z',
    }
    await writeFile(join(state, 'selection.json'), `${JSON.stringify(selection)}\n`, 'utf8')
    const lock = join(state, 'managed-release-transaction', '.pipeline.lock')
    await mkdir(lock, { recursive: true })
    const owner = join(lock, 'owner')
    const token = `${process.pid}.abcdef0123456789.${Date.now() - 120_000}`
    const original = `${JSON.stringify({
      version: 1,
      token,
      pid: process.pid,
      createdAt: Date.now() - 120_000,
    })}\n`
    await writeFile(owner, original)
    const stale = new Date(Date.now() - 120_000)
    await utimes(owner, stale, stale)

    const result = await runBootstrap(
      root,
      bootstrap,
      ['cli', 'runtime', 'repair', '--rollback'],
      '',
      { TENON_TEST_STATE_LOCK_TIMEOUT_MS: '200' },
    )

    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/lock acquisition timed out/iu)
    expect(await readFile(owner, 'utf8')).toBe(original)
    expect(JSON.parse(await readFile(join(state, 'selection.json'), 'utf8'))).toEqual(selection)
  })

  it('keeps the hardened bootstrap bytes across rollback instead of installing the previous payload bootstrap', async () => {
    const root = await freshRoot('rollback-bootstrap-bytes')
    const activeRelease = await createRelease(root, 'active')
    const previousRelease = await createRelease(root, 'previous')
    const previousBootstrap = join(root, 'data', 'releases', previousRelease, 'payload', 'runtime', 'tenon-bootstrap.mjs')
    await writeFile(previousBootstrap, `${await readFile(previousBootstrap, 'utf8')}\n// unsafe-previous-bootstrap\n`, 'utf8')
    const previousPayload = join(root, 'data', 'releases', previousRelease, 'payload')
    const previousManifestPath = join(root, 'data', 'releases', previousRelease, 'release.json')
    const previousManifest = JSON.parse(await readFile(previousManifestPath, 'utf8')) as Record<string, unknown>
    previousManifest.payloadDigest = await payloadDigest(previousPayload)
    const replacementRelease = `sha256-${String(previousManifest.payloadDigest)}`
    previousManifest.releaseId = replacementRelease
    const replacementRoot = join(root, 'data', 'releases', replacementRelease)
    await import('node:fs/promises').then(({ rename }) => rename(
      join(root, 'data', 'releases', previousRelease), replacementRoot,
    ))
    await writeFile(join(replacementRoot, 'release.json'), `${JSON.stringify(previousManifest)}\n`, 'utf8')
    const bootstrap = await installBootstrap(root)
    const before = await readFile(bootstrap, 'utf8')
    const state = join(root, 'state')
    await mkdir(state, { recursive: true })
    await writeFile(join(state, 'selection.json'), `${JSON.stringify({
      version: 1,
      revision: 2,
      activeRelease,
      previousRelease: replacementRelease,
      updatedAt: '2026-07-24T00:00:00Z',
    })}\n`, 'utf8')

    const result = await runBootstrap(root, bootstrap, ['cli', 'runtime', 'repair', '--rollback'])

    expect(result.code).toBe(0)
    expect(await readFile(bootstrap, 'utf8')).toBe(before)
    expect(await readFile(bootstrap, 'utf8')).not.toContain('unsafe-previous-bootstrap')

    const attackerBin = join(root, 'rollback-attacker-bin')
    const attackerMarker = join(root, 'rollback-attacker-bash-ran')
    await mkdir(attackerBin, { recursive: true })
    await writeFile(join(attackerBin, 'bash'), `#!/bin/sh\nprintf compromised > ${JSON.stringify(attackerMarker)}\n`, 'utf8')
    await chmod(join(attackerBin, 'bash'), 0o755)

    const hook = await runBootstrap(root, bootstrap, ['hook', 'probe'], '', {
      PATH: `${attackerBin}:${process.env.PATH ?? ''}`,
    })

    expect(hook).toMatchObject({ code: 0, stdout: 'TRUSTED_HOOK' })
    await expect(readFile(attackerMarker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('resumes a committed rollback target without a second swap and repairs a partial launcher pair', async () => {
    const root = await freshRoot('rollback-selection-crash')
    const activeRelease = await createRelease(root, 'active')
    const previousRelease = await createRelease(root, 'previous')
    const bootstrap = await installBootstrap(root)
    const state = join(root, 'state')
    const home = join(root, 'home')
    await mkdir(state, { recursive: true })
    await writeFile(join(state, 'selection.json'), `${JSON.stringify({
      version: 1,
      revision: 2,
      activeRelease,
      previousRelease,
      updatedAt: '2026-07-24T00:00:00Z',
    })}\n`, 'utf8')
    expect((await runBootstrap(root, bootstrap, ['cli', 'runtime', 'repair', '--rollback'])).code).toBe(0)

    const tenon = join(home, '.local', 'bin', 'tenon')
    const hook = join(home, '.local', 'bin', 'tenon-hook')
    const launcherSnapshot = {
      tenon: {
        path: tenon,
        state: { kind: 'file', content: await readFile(tenon, 'utf8'), mode: (await stat(tenon)).mode & 0o777 },
      },
      hook: {
        path: hook,
        state: { kind: 'file', content: await readFile(hook, 'utf8'), mode: (await stat(hook)).mode & 0o777 },
      },
    }
    const beforeSelection = {
      version: 1,
      revision: 4,
      activeRelease,
      previousRelease,
      updatedAt: '2026-07-24T00:00:00Z',
    }
    const targetSelection = {
      version: 1,
      revision: 5,
      activeRelease: previousRelease,
      previousRelease: activeRelease,
      updatedAt: '2026-07-24T00:01:00Z',
    }
    const transactionRoot = join(state, 'managed-release-transaction')
    const journalPath = join(transactionRoot, 'runtime-rollback.json')
    await mkdir(transactionRoot, { recursive: true })
    await writeFile(journalPath, `${JSON.stringify({
      version: 1,
      transactionId: '11111111-1111-4111-8111-111111111111',
      beforeSelection,
      target: {
        revision: 5,
        activeRelease: previousRelease,
        previousRelease: activeRelease,
      },
      launchers: launcherSnapshot,
    }, null, 2)}\n`)
    await writeFile(join(state, 'selection.json'), `${JSON.stringify(targetSelection)}\n`)
    await rm(hook)

    const resumed = await runBootstrap(root, bootstrap, ['cli', 'runtime', 'repair', '--rollback'])

    expect(resumed.code, resumed.stderr).toBe(0)
    expect(JSON.parse(resumed.stdout).selection).toEqual(targetSelection)
    expect(JSON.parse(await readFile(join(state, 'selection.json'), 'utf8'))).toEqual(targetSelection)
    expect(await readFile(hook, 'utf8')).toBe(launcherSnapshot.hook.state.content)
    await expect(readFile(journalPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a rollback whose previous payload no longer matches its stored digest', async () => {
    const root = await freshRoot('tamper')
    const activeRelease = await createRelease(root, 'active')
    const previousRelease = await createRelease(root, 'previous')
    const bootstrap = await installBootstrap(root)
    const state = join(root, 'state')
    await mkdir(state, { recursive: true })
    await writeFile(join(state, 'selection.json'), `${JSON.stringify({
      version: 1,
      revision: 2,
      activeRelease,
      previousRelease,
      updatedAt: '2026-07-24T00:00:00Z',
    })}\n`, 'utf8')
    await writeFile(join(root, 'data', 'releases', previousRelease, 'payload', 'packages', 'cli', 'dist', 'tenon.mjs'), 'tampered\n', 'utf8')

    const result = await runBootstrap(root, bootstrap, ['cli', 'runtime', 'repair', '--rollback'])

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('integrity check failed')
    expect(JSON.parse(await readFile(join(state, 'selection.json'), 'utf8'))).toMatchObject({ activeRelease, previousRelease })
  })

  it('refuses to execute an active payload whose content no longer matches its manifest digest', async () => {
    const root = await freshRoot('active-tamper')
    const activeRelease = await createRelease(root, 'VERIFIED_ACTIVE')
    const bootstrap = await installBootstrap(root)
    const state = join(root, 'state')
    await mkdir(state, { recursive: true })
    await writeFile(join(state, 'selection.json'), `${JSON.stringify({
      version: 1,
      revision: 1,
      activeRelease,
      previousRelease: null,
      updatedAt: '2026-07-24T00:00:00Z',
    })}\n`, 'utf8')
    await writeFile(join(state, 'audit.jsonl'), `${JSON.stringify({
      version: 1,
      at: '2026-07-24T00:00:00Z',
      kind: 'update-rejected',
      detail: 'host refresh failed',
    })}\n`, 'utf8')
    await writeFile(
      join(root, 'data', 'releases', activeRelease, 'payload', 'packages', 'cli', 'dist', 'tenon.mjs'),
      'process.stdout.write("UNVERIFIED_ACTIVE_EXECUTED")\n',
      'utf8',
    )

    const result = await runBootstrap(root, bootstrap, ['cli', '--help'])
    const status = await runBootstrap(root, bootstrap, ['cli', 'runtime', 'status', '--json'])

    expect(result.code).toBe(1)
    expect(result.stdout).not.toContain('UNVERIFIED_ACTIVE_EXECUTED')
    expect(result.stderr).toContain('runtime is unavailable')
    expect(JSON.parse(status.stdout)).toMatchObject({
      activeValid: false,
      lastAudit: { kind: 'update-rejected', detail: 'host refresh failed' },
    })
  })

  async function selectActive(root: string, activeRelease: string): Promise<string> {
    const state = join(root, 'state')
    await mkdir(state, { recursive: true })
    await writeFile(join(state, 'selection.json'), `${JSON.stringify({
      version: 1,
      revision: 1,
      activeRelease,
      previousRelease: null,
      updatedAt: '2026-07-24T00:00:00Z',
    })}\n`, 'utf8')
    return state
  }

  it('remembers a verified payload digest by stat fingerprint and reuses it on the next dispatch', async () => {
    const root = await freshRoot('digest-cache')
    const activeRelease = await createRelease(root, 'CACHED_ACTIVE_1')
    const bootstrap = await installBootstrap(root)
    const state = await selectActive(root, activeRelease)

    const first = await runBootstrap(root, bootstrap, ['cli', '--help'])
    expect(first).toMatchObject({ code: 0, stdout: 'CACHED_ACTIVE_1' })
    const cache = JSON.parse(await readFile(join(state, 'payload-digest-cache.json'), 'utf8'))
    expect(cache).toEqual({
      version: 1,
      releases: {
        [activeRelease]: { manifestVersion: 1, payloadDigest: activeRelease.slice('sha256-'.length), fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) },
      },
    })
    const second = await runBootstrap(root, bootstrap, ['cli', '--help'])
    expect(second).toMatchObject({ code: 0, stdout: 'CACHED_ACTIVE_1' })
    expect(JSON.parse(await readFile(join(state, 'payload-digest-cache.json'), 'utf8'))).toEqual(cache)
  })

  it('still refuses a same-size content change with its mtime restored after the cache is warm', async () => {
    const root = await freshRoot('digest-cache-tamper')
    const activeRelease = await createRelease(root, 'CACHED_ACTIVE_1')
    const bootstrap = await installBootstrap(root)
    await selectActive(root, activeRelease)
    expect((await runBootstrap(root, bootstrap, ['cli', '--help'])).stdout).toBe('CACHED_ACTIVE_1')

    const cli = join(root, 'data', 'releases', activeRelease, 'payload', 'packages', 'cli', 'dist', 'tenon.mjs')
    const before = await stat(cli)
    await writeFile(cli, `process.stdout.write(${JSON.stringify('FORGED_ACTIVE_1')})\n`, 'utf8')
    await utimes(cli, before.atime, before.mtime)
    expect((await stat(cli)).size).toBe(before.size)

    const result = await runBootstrap(root, bootstrap, ['cli', '--help'])
    expect(result.code).toBe(1)
    expect(result.stdout).not.toContain('FORGED_ACTIVE_1')
    expect(result.stderr).toContain('runtime is unavailable')
  })

  it('falls back to a full payload hash when the digest cache is unreadable', async () => {
    const root = await freshRoot('digest-cache-corrupt')
    const activeRelease = await createRelease(root, 'CACHED_ACTIVE_1')
    const bootstrap = await installBootstrap(root)
    const state = await selectActive(root, activeRelease)
    await writeFile(join(state, 'payload-digest-cache.json'), '{', 'utf8')

    expect(await runBootstrap(root, bootstrap, ['cli', '--help'])).toMatchObject({ code: 0, stdout: 'CACHED_ACTIVE_1' })
    expect(JSON.parse(await readFile(join(state, 'payload-digest-cache.json'), 'utf8')).releases[activeRelease])
      .toMatchObject({ payloadDigest: activeRelease.slice('sha256-'.length) })
  })

  it('reports a truncated audit tail instead of presenting an older event as lastAudit', async () => {
    const root = await freshRoot('audit-corrupt-tail')
    const activeRelease = await createRelease(root, 'ACTIVE')
    const bootstrap = await installBootstrap(root)
    const state = join(root, 'state')
    await mkdir(state, { recursive: true })
    await writeFile(join(state, 'selection.json'), `${JSON.stringify({
      version: 1,
      revision: 1,
      activeRelease,
      previousRelease: null,
      updatedAt: '2026-07-24T00:00:00Z',
    })}\n`, 'utf8')
    await writeFile(join(state, 'audit.jsonl'), `${JSON.stringify({
      version: 1,
      at: '2026-07-24T00:00:00Z',
      kind: 'update-rejected',
      detail: 'older valid event',
    })}\n{"version":1`, 'utf8')

    const status = await runBootstrap(root, bootstrap, ['cli', 'runtime', 'status', '--json'])

    expect(JSON.parse(status.stdout)).toMatchObject({
      lastAudit: null,
      auditCorrupt: true,
    })
  })

  it('blocks only project mutation through gate while the runtime is unavailable, leaving the exact repair command reachable', async () => {
    const root = await freshRoot('gate')
    const bootstrap = await installBootstrap(root)
    const mutation = JSON.stringify({ tool_name: 'Bash', command: 'touch src/app.ts' })
    const recovery = JSON.stringify({ tool_name: 'Bash', command: 'tenon runtime repair --rollback' })
    const attacker = JSON.stringify({ tool_name: 'Bash', command: '/tmp/evil/tenon runtime repair --rollback' })

    expect((await runBootstrap(root, bootstrap, ['hook', 'gate'], mutation)).code).toBe(2)
    expect((await runBootstrap(root, bootstrap, ['hook', 'gate'], recovery)).code).toBe(0)
    expect((await runBootstrap(root, bootstrap, ['hook', 'gate'], attacker)).code).toBe(2)
  })

  it('treats a cache entry keyed by an older stat fingerprint as a miss and rewrites it', async () => {
    const root = await freshRoot('digest-cache-stale-fingerprint')
    const activeRelease = await createRelease(root, 'CACHED_ACTIVE_1')
    const bootstrap = await installBootstrap(root)
    const state = await selectActive(root, activeRelease)
    const digest = activeRelease.slice('sha256-'.length)
    // v0.2.0 keyed the fingerprint by the device number, which macOS reassigns on every reboot.
    await writeFile(join(state, 'payload-digest-cache.json'), `${JSON.stringify({
      version: 1,
      releases: { [activeRelease]: { manifestVersion: 1, payloadDigest: digest, fingerprint: '0'.repeat(64) } },
    })}\n`, 'utf8')

    expect(await runBootstrap(root, bootstrap, ['cli', '--help'])).toMatchObject({ code: 0, stdout: 'CACHED_ACTIVE_1' })

    const cache = JSON.parse(await readFile(join(state, 'payload-digest-cache.json'), 'utf8'))
    expect(cache.releases[activeRelease].fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(cache.releases[activeRelease].fingerprint).not.toBe('0'.repeat(64))
  })

  const canonicalNode = (() => {
    try {
      return process.platform !== 'win32'
        && realpathSync(process.execPath) === process.execPath
        && freezeTrustedExecutable(process.execPath) !== undefined
    } catch {
      return false
    }
  })()

  function guardBlock(launcher: string): string {
    return launcher.slice(launcher.indexOf('tenon_node_state=changed'), launcher.indexOf('\nexec '))
  }

  it.skipIf(!canonicalNode)('writes rollback launchers whose Node guard is byte-identical to the installer generator', async () => {
    const root = await freshRoot('rollback-guard-parity')
    const activeRelease = await createRelease(root, 'active')
    const previousRelease = await createRelease(root, 'previous')
    const bootstrap = await installBootstrap(root)
    const state = join(root, 'state')
    await mkdir(state, { recursive: true })
    await writeFile(join(state, 'selection.json'), `${JSON.stringify({
      version: 1,
      revision: 2,
      activeRelease,
      previousRelease,
      updatedAt: '2026-07-24T00:00:00Z',
    })}\n`, 'utf8')
    expect((await runBootstrap(root, bootstrap, ['cli', 'runtime', 'repair', '--rollback'])).code).toBe(0)

    const home = join(root, 'home')
    const paths = resolveRuntimePaths({ env: { TENON_RUNTIME_HOME: root }, homeDir: home, platform: process.platform })
    expect(paths.dataRoot).toBe(join(root, 'data'))
    const trusted = freezeTrustedExecutable(process.execPath)
    if (trusted === undefined) throw new Error('canonical test Node must be trustworthy')
    const expected = expectedStableLaunchers(paths, home, process.execPath, trusted.proof)
    for (const [name, file] of [['tenon', 'tenon'], ['hook', 'tenon-hook']] as const) {
      const written = await readFile(join(home, '.local', 'bin', file), 'utf8')
      const generated = expected[name].state.kind === 'file' ? expected[name].state.content : ''
      expect(guardBlock(written)).not.toBe('')
      expect(guardBlock(written)).toBe(guardBlock(generated))
      expect(written).not.toContain('%d')
    }
  })

  it.skipIf(process.platform === 'win32')('runs the repair command a replaced-Node launcher prints through the real bootstrap', async () => {
    const root = await freshRoot('node-repair-through-bootstrap')
    const activeRelease = await createRelease(
      root,
      'repair',
      "process.stdout.write(`CLI:${process.argv.slice(2).join(' ')}`)\n",
    )
    await installBootstrap(root)
    await selectActive(root, activeRelease)
    const home = join(root, 'home')
    await mkdir(home, { recursive: true })
    const paths = resolveRuntimePaths({ env: { TENON_RUNTIME_HOME: root }, homeDir: home, platform: process.platform })
    const pinned = join(root, 'pinned-node')
    await writeFile(pinned, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const trusted = freezeTrustedExecutable(pinned)
    if (trusted === undefined) throw new Error('test fixture Node must be trustworthy')
    const launchers = await writeStableLaunchers(paths, home, {
      nodeExecutable: trusted.executable,
      nodeProof: trusted.proof,
      verifyNode: trusted.assert,
    })
    // Node was upgraded in place: the launcher it pinned now refuses to start anything.
    await writeFile(pinned, '#!/bin/sh\nexit 99\n')

    const refused = spawnSync('/bin/sh', [launchers.tenon, 'setup', '--claude'], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin' },
    })
    expect(refused.status).toBe(126)
    const message = refused.stderr.trim()
    expect(message.split('\n')).toHaveLength(1)
    const start = message.indexOf('repair with: ') + 'repair with: '.length
    const command = message.slice(start, message.indexOf('   (Codex'))

    const repaired = spawnSync('/bin/sh', ['-c', command], {
      encoding: 'utf8',
      env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home },
    })
    expect(repaired.stderr).toBe('')
    expect(repaired.status).toBe(0)
    expect(repaired.stdout).toBe('CLI:setup --claude')
  })
})


const distMain = join(repoRoot, 'packages', 'cli', 'dist', 'main.js')
const e2eNode = (() => {
  try {
    return process.platform !== 'win32'
      && existsSync(distMain)
      && realpathSync(process.execPath) === process.execPath
      && freezeTrustedExecutable(process.execPath) !== undefined
  } catch {
    return false
  }
})()

describe.skipIf(process.platform === 'win32')('legacy launcher self-heal in the bootstrap', () => {
  interface Install {
    readonly root: string
    readonly home: string
    readonly bin: string
    readonly tenon: string
    readonly hook: string
    readonly bootstrap: string
    readonly log: string
    readonly paths: RuntimePaths
    readonly marker: string
  }

  const stubCli = (log: string, outcome: string, code: number, healDelayMs: number) => `
import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2)
if (args[0] === 'internal-launcher-heal') {
  appendFileSync(${JSON.stringify(log)}, 'heal\\n')
  await new Promise((resolve) => setTimeout(resolve, ${healDelayMs}))
  process.stdout.write(JSON.stringify({ outcome: ${JSON.stringify(outcome)} }) + '\\n')
} else {
  appendFileSync(${JSON.stringify(log)}, 'cmd:' + args.join(' ') + '\\n')
  process.exitCode = ${code}
}
`

  function fakeProof(node: string): TrustedExecutableProof {
    const entry = (path: string) => ({ path, dev: 1, ino: 2, mode: 0o100755, uid: 0, size: 3 })
    return {
      version: 1,
      platform: process.platform === 'darwin' ? 'darwin' : 'linux',
      requestedPath: node,
      executable: entry(node),
      parents: [],
      sha256: 'cd'.repeat(32),
    }
  }

  async function install(label: string, options: {
    readonly outcome?: string
    readonly code?: number
    readonly healDelayMs?: number
    readonly cliSource?: string
    readonly launchers?: (paths: RuntimePaths, node: string) => { readonly tenon: string; readonly hook: string } | 'none'
  } = {}): Promise<Install> {
    const root = await freshRoot(label)
    const log = join(root, 'calls.log')
    const release = await createRelease(
      root,
      label,
      options.cliSource ?? stubCli(log, options.outcome ?? 'repaired', options.code ?? 0, options.healDelayMs ?? 0),
    )
    const bootstrap = await installBootstrap(root)
    const state = join(root, 'state')
    await mkdir(state, { recursive: true })
    await writeFile(join(state, 'selection.json'), `${JSON.stringify({
      version: 1,
      revision: 1,
      activeRelease: release,
      previousRelease: null,
      updatedAt: '2026-07-24T00:00:00Z',
    })}\n`, 'utf8')
    const home = join(root, 'home')
    const bin = join(home, '.local', 'bin')
    await mkdir(bin, { recursive: true })
    const paths = resolveRuntimePaths({ env: { TENON_RUNTIME_HOME: root }, homeDir: home, platform: process.platform })
    expect(paths.dataRoot).toBe(join(root, 'data'))
    const node = '/opt/fake-node/bin/node'
    const written = (options.launchers ?? ((p, n) => ({
      tenon: legacyV020LauncherText(p, 'cli', n, fakeProof(n)),
      hook: legacyV020LauncherText(p, 'hook', n, fakeProof(n)),
    })))(paths, node)
    if (written !== 'none') {
      await writeFile(join(bin, 'tenon'), written.tenon, { mode: 0o755 })
      await writeFile(join(bin, 'tenon-hook'), written.hook, { mode: 0o755 })
    }
    return {
      root, home, bin, tenon: join(bin, 'tenon'), hook: join(bin, 'tenon-hook'), bootstrap, log, paths,
      marker: join(state, 'launcher-heal.retry'),
    }
  }

  async function calls(fx: Install): Promise<string[]> {
    return (await readFile(fx.log, 'utf8').catch(() => '')).split('\n').filter((line) => line !== '')
  }

  const lines = (text: string) => text.split('\n').filter((line) => line !== '')

  it('repairs on the first CLI command after an update, says so once, and keeps the command exit code', async () => {
    const fx = await install('heal-cli', { outcome: 'repaired', code: 7 })

    const first = await runBootstrap(fx.root, fx.bootstrap, ['cli', 'status'])

    expect(first.code).toBe(7)
    expect(lines(first.stderr)).toEqual(['tenon: stable launchers updated to the restart-safe format.'])
    expect(await calls(fx)).toEqual(['heal', 'cmd:status'])
  })

  it('names `tenon setup` once when the repair fails, keeps the exit code, and backs off for 30 minutes', async () => {
    const fx = await install('heal-failed', { outcome: 'failed', code: 3 })

    const first = await runBootstrap(fx.root, fx.bootstrap, ['cli', 'status'])
    expect(first.code).toBe(3)
    expect(lines(first.stderr)).toHaveLength(1)
    expect(first.stderr).toContain('tenon setup --claude')
    expect(first.stderr).toContain('tenon setup --codex')

    const second = await runBootstrap(fx.root, fx.bootstrap, ['cli', 'status'])
    expect(second.code).toBe(3)
    expect(second.stderr).toBe('')
    expect(await calls(fx)).toEqual(['heal', 'cmd:status', 'cmd:status'])

    const stale = new Date(Date.now() - 31 * 60_000)
    await utimes(fx.marker, stale, stale)
    const third = await runBootstrap(fx.root, fx.bootstrap, ['cli', 'status'])
    expect(lines(third.stderr)).toHaveLength(1)
    expect(await calls(fx)).toEqual(['heal', 'cmd:status', 'cmd:status', 'heal', 'cmd:status'])
  })

  it('stays silent when the repair declines because the install is not provably the same', async () => {
    const fx = await install('heal-declined', { outcome: 'skipped' })

    const result = await runBootstrap(fx.root, fx.bootstrap, ['cli', 'status'])

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(await calls(fx)).toEqual(['heal', 'cmd:status'])
  })

  it('never starts a repair for setup or update, which rewrite the launchers themselves', async () => {
    const fx = await install('heal-excluded')

    await runBootstrap(fx.root, fx.bootstrap, ['cli', 'setup', '--claude'])
    await runBootstrap(fx.root, fx.bootstrap, ['cli', 'update', '--codex'])

    expect(await calls(fx)).toEqual(['cmd:setup --claude', 'cmd:update --codex'])
  })

  it('leaves current-format, absent and unmanaged launchers alone', async () => {
    const current = await install('heal-current', {
      launchers: (paths, node) => {
        const expected = expectedStableLaunchers(paths, join(paths.dataRoot, '..', 'home'), node, fakeProof(node))
        if (expected.tenon.state.kind !== 'file' || expected.hook.state.kind !== 'file') throw new Error('launcher files')
        return { tenon: expected.tenon.state.content, hook: expected.hook.state.content }
      },
    })
    const absent = await install('heal-absent', { launchers: () => 'none' })
    const foreign = await install('heal-foreign', {
      launchers: () => ({
        tenon: "#!/bin/sh\n# stat -f '%d:%i' -- my own wrapper\nexec tenon-real \"$@\"\n",
        hook: "#!/bin/sh\nexec tenon-hook-real \"$@\"\n",
      }),
    })
    const linked = await install('heal-linked')
    const target = join(linked.root, 'real-tenon')
    await writeFile(target, await readFile(linked.tenon, 'utf8'), { mode: 0o755 })
    await rm(linked.tenon)
    await symlink(target, linked.tenon)
    const lone = await install('heal-lone')
    await rm(lone.tenon)

    for (const fx of [current, absent, foreign, linked, lone]) {
      const result = await runBootstrap(fx.root, fx.bootstrap, ['cli', 'status'])
      expect(result.code).toBe(0)
      expect(result.stderr).toBe('')
      expect(await calls(fx)).toEqual(['cmd:status'])
    }
    expect((await lstat(linked.tenon)).isSymbolicLink()).toBe(true)
  })

  it('starts the repair detached from a session-start hook, so the session does not wait for it', async () => {
    const fx = await install('heal-hook', { outcome: 'repaired', healDelayMs: 5000 })
    const started = Date.now()

    const result = await runBootstrap(fx.root, fx.bootstrap, ['hook', 'session-start'])

    expect(result).toMatchObject({ code: 0, stdout: 'TRUSTED_SESSION_START', stderr: '' })
    expect(Date.now() - started).toBeLessThan(3000)
    for (let waited = 0; (await calls(fx)).length === 0 && waited < 10_000; waited += 50) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(await calls(fx)).toEqual(['heal'])
  })

  it('repairs only from session-start, not from other hooks', async () => {
    const fx = await install('heal-other-hook', { outcome: 'repaired' })

    const result = await runBootstrap(fx.root, fx.bootstrap, ['hook', 'probe'])
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(result).toMatchObject({ code: 0, stdout: 'TRUSTED_HOOK', stderr: '' })
    expect(await calls(fx)).toEqual([])
  })

  describe.skipIf(!e2eNode)('with the real repair', () => {
    const shim = `await import(${JSON.stringify(pathToFileURL(distMain).href)})\n`

    async function realInstall(label: string, nodeOverride?: string): Promise<Install & { readonly expected: () => { tenon: string; hook: string } }> {
      const trusted = freezeTrustedExecutable(process.execPath)
      if (trusted === undefined) throw new Error('canonical test Node must be trustworthy')
      const pinned = nodeOverride ?? trusted.executable
      const fx = await install(label, {
        cliSource: shim,
        launchers: (paths) => ({
          tenon: legacyV020LauncherText(paths, 'cli', pinned, trusted.proof),
          hook: legacyV020LauncherText(paths, 'hook', pinned, trusted.proof),
        }),
      })
      return {
        ...fx,
        expected: () => {
          const expected = expectedStableLaunchers(fx.paths, fx.home, trusted.executable, trusted.proof)
          if (expected.tenon.state.kind !== 'file' || expected.hook.state.kind !== 'file') throw new Error('launcher files')
          return { tenon: expected.tenon.state.content, hook: expected.hook.state.content }
        },
      }
    }

    async function expectRepaired(fx: Awaited<ReturnType<typeof realInstall>>): Promise<void> {
      const expected = fx.expected()
      expect(await readFile(fx.tenon, 'utf8')).toBe(expected.tenon)
      expect(await readFile(fx.hook, 'utf8')).toBe(expected.hook)
      expect(expected.tenon).not.toContain('%d')
      expect((await readdir(fx.bin)).sort()).toEqual(['tenon', 'tenon-hook'])
      expect((await stat(fx.tenon)).mode & 0o777).toBe(0o755)
    }

    it('repairs a v0.2.0 install through the real CLI path and then stays quiet', async () => {
      const fx = await realInstall('real-cli')

      const first = await runBootstrap(fx.root, fx.bootstrap, ['cli', '--help'])
      expect(first.code, first.stderr).toBe(0)
      expect(lines(first.stderr)).toEqual(['tenon: stable launchers updated to the restart-safe format.'])
      await expectRepaired(fx)

      const second = await runBootstrap(fx.root, fx.bootstrap, ['cli', '--help'])
      expect(second.code).toBe(0)
      expect(second.stderr).toBe('')
    }, 60_000)

    it('repairs a v0.2.0 install from a session-start hook without printing anything', async () => {
      const fx = await realInstall('real-hook')

      const result = await runBootstrap(fx.root, fx.bootstrap, ['hook', 'session-start'])
      expect(result).toMatchObject({ code: 0, stdout: 'TRUSTED_SESSION_START', stderr: '' })

      // The writer replaces `tenon` first and `tenon-hook` second, and the repair runs detached, so wait
      // until the whole pair is in place and the transition files are gone.
      const expected = fx.expected()
      const settled = async () => (await readFile(fx.tenon, 'utf8').catch(() => '')) === expected.tenon
        && (await readFile(fx.hook, 'utf8').catch(() => '')) === expected.hook
        && (await readdir(fx.bin)).length === 2
      for (let waited = 0; !await settled() && waited < 30_000; waited += 100) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      await expectRepaired(fx)
    }, 60_000)

    it('is safe when several sessions start at once: one repair, one message, a working pair', async () => {
      const fx = await realInstall('real-concurrent')

      const results = await Promise.all(Array.from({ length: 4 }, () => runBootstrap(fx.root, fx.bootstrap, ['cli', '--help'])))

      for (const result of results) expect(result.code, result.stderr).toBe(0)
      expect(results.flatMap((result) => lines(result.stderr))).toEqual(['tenon: stable launchers updated to the restart-safe format.'])
      await expectRepaired(fx)
    }, 90_000)

    it('serializes repair processes that race past the retry marker', async () => {
      const fx = await realInstall('real-writer-race')
      const release = JSON.parse(await readFile(join(fx.root, 'state', 'selection.json'), 'utf8')).activeRelease as string
      const cli = join(fx.root, 'data', 'releases', release, 'payload', 'packages', 'cli', 'dist', 'tenon.mjs')
      const roots = serializeProductRootContract(fx.paths)
      const heal = () => new Promise<string>((resolveHeal) => {
        const child = spawn(process.execPath, [cli, 'internal-launcher-heal'], {
          env: { ...process.env, HOME: fx.home, TENON_RUNTIME_ROOTS: roots },
        })
        let out = ''
        child.stdout.setEncoding('utf8')
        child.stdout.on('data', (chunk: string) => { out += chunk })
        child.on('close', () => resolveHeal(out.trim()))
      })

      const results = (await Promise.all(Array.from({ length: 4 }, heal)))
        .map((line) => JSON.parse(line) as { readonly outcome: string; readonly reason?: string })

      expect(results.filter((result) => result.outcome === 'repaired')).toHaveLength(1)
      // A racer either finds the pair already repaired, or finds the managed-transaction lock held by the
      // repairing process and declines. Any other skip reason, or a failure, is a real defect.
      for (const result of results) {
        if (result.outcome === 'repaired' || result.outcome === 'current') continue
        expect(result).toEqual({ outcome: 'skipped', reason: 'install-in-progress' })
      }
      await expectRepaired(fx)
    }, 90_000)

    it('leaves a launcher that pins a different Node than the running one untouched and says nothing', async () => {
      const other = '/opt/some-other-node/bin/node'
      const fx = await realInstall('real-other-node', other)
      const before = [await readFile(fx.tenon, 'utf8'), await readFile(fx.hook, 'utf8')]

      const result = await runBootstrap(fx.root, fx.bootstrap, ['cli', '--help'])

      expect(result.code, result.stderr).toBe(0)
      expect(result.stderr).toBe('')
      expect([await readFile(fx.tenon, 'utf8'), await readFile(fx.hook, 'utf8')]).toEqual(before)
    }, 60_000)
  })
})
