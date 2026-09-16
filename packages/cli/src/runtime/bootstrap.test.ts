import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { hashReleasePayload } from './release-payload.js'
import { runtimeReleaseIdV2 } from './release-store-codecs.js'

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

async function createRelease(runtimeHome: string, marker: string): Promise<string> {
  const stagingPayload = join(runtimeHome, 'fixture', marker, 'payload')
  await mkdir(join(stagingPayload, 'packages', 'cli', 'dist'), { recursive: true })
  await mkdir(join(stagingPayload, 'runtime'), { recursive: true })
  await mkdir(join(stagingPayload, 'hooks'), { recursive: true })
  await writeFile(join(stagingPayload, 'packages', 'cli', 'dist', 'tenon.mjs'), `process.stdout.write(${JSON.stringify(marker)})\n`, 'utf8')
  await writeFile(join(stagingPayload, 'hooks', 'probe.sh'), '#!/bin/bash\nprintf TRUSTED_HOOK\n', 'utf8')
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
})
