import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { expectedStableLaunchers } from '../runtime/launchers.js'
import { resolveRuntimePaths } from '../runtime/paths.js'
import { legacyV020LauncherText } from '../runtime/test-support.js'
import type { RuntimePaths } from '../runtime/types.js'
import {
  cmdInternalLauncherHeal,
  healLegacyStableLaunchers,
  LAUNCHER_HEAL_RETRY_MARKER,
  type LauncherHealEnv,
  type LauncherHealOutcome,
} from './launcher-heal.js'
import { freezeTrustedExecutable, type TrustedExecutable } from './trusted-executable.js'
import { makeDeps } from '../test-support.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

const PINNED_NODE = '#!/bin/sh\nprintf "PINNED-NODE %s\\n" "$*"\n'

interface Fixture {
  readonly root: string
  readonly home: string
  readonly bin: string
  readonly paths: RuntimePaths
  readonly node: string
  readonly trusted: TrustedExecutable
  readonly tenon: string
  readonly hook: string
}

async function legacyInstall(label: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), `tenon-launcher-heal-${label}-`))
  roots.push(root)
  const home = join(root, 'home')
  const paths = resolveRuntimePaths({ env: { TENON_RUNTIME_HOME: join(root, 'runtime') }, homeDir: home, platform: 'linux' })
  const node = join(root, 'pinned-node')
  await writeFile(node, PINNED_NODE, { mode: 0o755 })
  const trusted = freezeTrustedExecutable(node)
  if (trusted === undefined) throw new Error('test fixture Node must be trustworthy')
  await mkdir(paths.bootstrapRoot, { recursive: true })
  await writeFile(join(paths.bootstrapRoot, 'active.mjs'), '', 'utf8')
  const bin = join(home, '.local', 'bin')
  await mkdir(bin, { recursive: true })
  const tenon = join(bin, 'tenon')
  const hook = join(bin, 'tenon-hook')
  await writeFile(tenon, legacyV020LauncherText(paths, 'cli', trusted.executable, trusted.proof), { mode: 0o755 })
  await writeFile(hook, legacyV020LauncherText(paths, 'hook', trusted.executable, trusted.proof), { mode: 0o755 })
  return { root, home, bin, paths, node: trusted.executable, trusted, tenon, hook }
}

function heal(fx: Fixture, overrides: Partial<Parameters<typeof healLegacyStableLaunchers>[0]> = {}): Promise<LauncherHealOutcome> {
  return healLegacyStableLaunchers({
    paths: fx.paths,
    homeDir: fx.home,
    runningNode: fx.node,
    freezeNode: (path) => freezeTrustedExecutable(path),
    ...overrides,
  })
}

async function snapshot(fx: Fixture): Promise<readonly string[]> {
  const names = await readdir(fx.bin)
  return Promise.all(names.sort().map(async (name) => `${name}\n${await readFile(join(fx.bin, name), 'utf8').catch(() => '<unreadable>')}`))
}

function run(launcher: string, args: readonly string[]) {
  const result = spawnSync('/bin/sh', [launcher, ...args], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

describe.skipIf(process.platform === 'win32')('healLegacyStableLaunchers repairs only a provably identical install', () => {
  it('rewrites both launchers with the setup writer, keeping the roots and the Node', async () => {
    const fx = await legacyInstall('repair')

    expect(await heal(fx)).toEqual({ outcome: 'repaired' })

    const expected = expectedStableLaunchers(fx.paths, fx.home, fx.node, fx.trusted.proof)
    for (const [path, file] of [[fx.tenon, expected.tenon], [fx.hook, expected.hook]] as const) {
      if (file.state.kind !== 'file') throw new Error('expected a launcher file')
      expect(await readFile(path, 'utf8')).toBe(file.state.content)
      expect((await stat(path)).mode & 0o777).toBe(0o755)
      expect(file.state.content).not.toContain('%d')
    }
    // No transition marker, private capture or temp file is left beside the launchers.
    expect((await readdir(fx.bin)).sort()).toEqual(['tenon', 'tenon-hook'])
    // The repaired launcher is a working launcher.
    expect(run(fx.tenon, ['status'])).toEqual({
      status: 0,
      stdout: `PINNED-NODE ${join(fx.paths.bootstrapRoot, 'active.mjs')} cli status\n`,
      stderr: '',
    })
    // And a second pass has nothing to do.
    expect(await heal(fx)).toEqual({ outcome: 'current' })
  })

  it('does nothing when the pinned digest no longer matches the running Node', async () => {
    const fx = await legacyInstall('digest')
    await writeFile(fx.node, '#!/bin/sh\nprintf "REPLACED\\n"\n')
    const before = await snapshot(fx)

    expect(await heal(fx)).toEqual({ outcome: 'skipped', reason: 'node-digest-differs' })
    expect(await snapshot(fx)).toEqual(before)
  })

  it('does nothing when the launcher pins a different Node path than the one running', async () => {
    const fx = await legacyInstall('other-node')
    const other = join(fx.root, 'other-node')
    await writeFile(other, PINNED_NODE, { mode: 0o755 })
    const before = await snapshot(fx)

    expect(await heal(fx, { runningNode: other })).toEqual({ outcome: 'skipped', reason: 'node-path-differs' })
    expect(await snapshot(fx)).toEqual(before)
  })

  it('does nothing when the roots are not the ones the launcher exports', async () => {
    const fx = await legacyInstall('roots')
    const elsewhere = resolveRuntimePaths({
      env: { TENON_RUNTIME_HOME: join(fx.root, 'another-runtime') },
      homeDir: fx.home,
      platform: 'linux',
    })
    const before = await snapshot(fx)

    expect(await heal(fx, { paths: elsewhere })).toEqual({ outcome: 'skipped', reason: 'roots-differ' })
    expect(await snapshot(fx)).toEqual(before)
  })

  it('does not follow or replace a symlinked launcher, and leaves its target alone', async () => {
    const fx = await legacyInstall('symlink')
    const target = join(fx.root, 'real-tenon')
    await writeFile(target, legacyV020LauncherText(fx.paths, 'cli', fx.node, fx.trusted.proof), { mode: 0o755 })
    await rm(fx.tenon)
    await symlink(target, fx.tenon)
    const before = await snapshot(fx)
    const targetBefore = await readFile(target, 'utf8')

    expect(await heal(fx)).toEqual({ outcome: 'skipped', reason: 'launchers-not-tenon-generated' })
    expect(await snapshot(fx)).toEqual(before)
    expect(await readFile(target, 'utf8')).toBe(targetBefore)
    expect((await stat(fx.tenon)).isFile()).toBe(true)
  })

  it.each([
    ['a script that is not Tenon-generated', async (fx: Fixture) => {
      await writeFile(fx.tenon, "#!/bin/sh\n# my wrapper, mentions stat -f '%d:%i'\nexec tenon-real \"$@\"\n", { mode: 0o755 })
    }],
    ['a missing launcher', async (fx: Fixture) => { await rm(fx.hook) }],
    ['a launcher that execs another program', async (fx: Fixture) => {
      const text = await readFile(fx.hook, 'utf8')
      await writeFile(fx.hook, text.replace(/\nexec '[^\n]*' (?='[^\n]*' hook)/u, "\nexec '/usr/bin/evil' "), { mode: 0o755 })
    }],
  ])('does nothing for %s', async (_label, tamper) => {
    const fx = await legacyInstall('foreign')
    await tamper(fx)
    const before = await snapshot(fx)

    const result = await heal(fx)

    expect(result.outcome).toBe('skipped')
    expect(await snapshot(fx)).toEqual(before)
  })

  it('does nothing while an install transaction holds the lock or left a journal', async () => {
    const fx = await legacyInstall('busy')
    await mkdir(join(fx.paths.managedTransactionRoot, '.pipeline.lock'), { recursive: true })
    const before = await snapshot(fx)
    expect(await heal(fx)).toEqual({ outcome: 'skipped', reason: 'install-in-progress' })

    await rm(join(fx.paths.managedTransactionRoot, '.pipeline.lock'), { recursive: true })
    await writeFile(join(fx.paths.managedTransactionRoot, 'release-transaction.json'), '{}\n', 'utf8')
    expect(await heal(fx)).toEqual({ outcome: 'skipped', reason: 'install-journal-pending' })
    expect(await snapshot(fx)).toEqual(before)
  })

  it('is safe when several sessions repair at once: one rewrite, the rest see it done', async () => {
    const fx = await legacyInstall('concurrent')

    const results = await Promise.all(Array.from({ length: 6 }, () => heal(fx)))

    expect(results.filter((result) => result.outcome === 'repaired')).toHaveLength(1)
    for (const result of results) expect(['repaired', 'current']).toContain(result.outcome)
    const expected = expectedStableLaunchers(fx.paths, fx.home, fx.node, fx.trusted.proof)
    if (expected.tenon.state.kind !== 'file' || expected.hook.state.kind !== 'file') throw new Error('expected launcher files')
    expect(await readFile(fx.tenon, 'utf8')).toBe(expected.tenon.state.content)
    expect(await readFile(fx.hook, 'utf8')).toBe(expected.hook.state.content)
    expect((await readdir(fx.bin)).sort()).toEqual(['tenon', 'tenon-hook'])
  })
})

describe.skipIf(process.platform === 'win32')('cmdInternalLauncherHeal', () => {
  function env(fx: Fixture, overrides: Partial<LauncherHealEnv> = {}): LauncherHealEnv {
    return {
      homeDir: () => fx.home,
      runtimeEnv: () => ({ TENON_RUNTIME_HOME: join(fx.root, 'runtime') }),
      runningNode: () => fx.node,
      freezeNode: (path) => freezeTrustedExecutable(path),
      ...overrides,
    }
  }
  const marker = (fx: Fixture) => join(fx.paths.stateRoot, LAUNCHER_HEAL_RETRY_MARKER)

  it('prints one JSON line, exits 0 and clears the retry marker once the launchers are safe', async () => {
    const fx = await legacyInstall('cmd-repaired')
    await mkdir(fx.paths.stateRoot, { recursive: true })
    await writeFile(marker(fx), '1\n', 'utf8')
    const deps = makeDeps()

    expect(await cmdInternalLauncherHeal(deps, env(fx))).toBe(0)

    expect(deps.outLines).toEqual([JSON.stringify({ outcome: 'repaired' })])
    await expect(stat(marker(fx))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps the retry marker and still exits 0 when it declines to repair', async () => {
    const fx = await legacyInstall('cmd-skipped')
    await writeFile(fx.node, '#!/bin/sh\nexit 3\n')
    await chmod(fx.node, 0o755)
    await mkdir(fx.paths.stateRoot, { recursive: true })
    await writeFile(marker(fx), '1\n', 'utf8')
    const deps = makeDeps()

    expect(await cmdInternalLauncherHeal(deps, env(fx))).toBe(0)

    expect(deps.outLines).toEqual([JSON.stringify({ outcome: 'skipped', reason: 'node-digest-differs' })])
    expect((await stat(marker(fx))).isFile()).toBe(true)
  })

  it('reports a failure as data instead of throwing', async () => {
    const fx = await legacyInstall('cmd-failed')
    const deps = makeDeps()

    expect(await cmdInternalLauncherHeal(deps, env(fx, {
      freezeNode: () => { throw new Error('freeze exploded') },
    }))).toBe(0)

    expect(JSON.parse(deps.outLines.join('\n'))).toEqual({ outcome: 'failed', detail: 'freeze exploded' })
  })
})
