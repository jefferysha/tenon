import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serializeProductRootContract } from '@tenon/kernel'
import { afterEach, describe, expect, it } from 'vitest'
import { freezeTrustedExecutable } from '../commands/trusted-executable.js'
import { expectedStableLaunchers, writeStableLaunchers } from './launchers.js'
import { resolveRuntimePaths } from './paths.js'
import type { RuntimePaths, TrustedExecutableProof } from './types.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

const PINNED_NODE = '#!/bin/sh\nprintf "PINNED-NODE %s\\n" "$*"\n'
const MINUTE_MS = 60_000

interface Fixture {
  readonly root: string
  readonly paths: RuntimePaths
  readonly node: string
  readonly tenon: string
  readonly hook: string
  readonly bootstrap: string
  readonly marker: string
  readonly proof: TrustedExecutableProof
  readonly pinnedProof: TrustedExecutableProof
}

type ProofMutation = (proof: TrustedExecutableProof) => TrustedExecutableProof

/** A reboot gives every mount a new st_dev while inode, mode, owner, size and content stay put. */
const rebootedDevices: ProofMutation = (proof) => ({
  ...proof,
  executable: { ...proof.executable, dev: proof.executable.dev + 4 },
  parents: proof.parents.map((parent) => ({ ...parent, dev: parent.dev + 4 })),
})
/** The executable was re-created with identical bytes: inode differs, content digest does not. */
const sameBytesNewInode: ProofMutation = (proof) => ({
  ...proof,
  executable: { ...proof.executable, ino: proof.executable.ino + 1 },
})
/** The pin records different bytes than the file now holds. */
const otherDigest: ProofMutation = (proof) => ({ ...proof, sha256: 'f'.repeat(64) })

async function install(label: string, mutate: ProofMutation = (proof) => proof): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), `tenon-node-identity-${label}-`))
  roots.push(root)
  const paths = resolveRuntimePaths({ env: { TENON_RUNTIME_HOME: join(root, 'runtime') }, homeDir: root, platform: 'linux' })
  const node = join(root, 'pinned-node')
  await writeFile(node, PINNED_NODE, { mode: 0o755 })
  const trusted = freezeTrustedExecutable(node)
  if (trusted === undefined) throw new Error('test fixture Node must be trustworthy')
  const bootstrap = join(paths.bootstrapRoot, 'active.mjs')
  await mkdir(paths.bootstrapRoot, { recursive: true })
  await writeFile(bootstrap, '', 'utf8')
  const pinnedProof = mutate(trusted.proof)
  const written = await writeStableLaunchers(paths, root, {
    nodeExecutable: trusted.executable,
    nodeProof: pinnedProof,
    verifyNode: trusted.assert,
  })
  return {
    root,
    paths,
    node: trusted.executable,
    tenon: written.tenon,
    hook: written.hook,
    bootstrap,
    marker: join(paths.stateRoot, 'launcher-node-identity.notice'),
    proof: trusted.proof,
    pinnedProof,
  }
}

function run(launcher: string, args: readonly string[], env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync('/bin/sh', [launcher, ...args], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', ...env },
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function lines(text: string): string[] {
  return text.split('\n').filter((line) => line !== '')
}

describe.skipIf(process.platform === 'win32')('stable launcher Node identity after the device numbers change', () => {
  it('renders the identical launcher when only device numbers differ, then keeps every command and hook running', async () => {
    const fx = await install('reboot', rebootedDevices)

    expect(expectedStableLaunchers(fx.paths, fx.root, fx.node, fx.pinnedProof))
      .toEqual(expectedStableLaunchers(fx.paths, fx.root, fx.node, fx.proof))
    const text = await readFile(fx.tenon, 'utf8')
    expect(text).not.toContain('%d')

    for (const args of [['setup', '--claude'], ['status'], ['--version']]) {
      expect(run(fx.tenon, args)).toEqual({
        status: 0,
        stdout: `PINNED-NODE ${fx.bootstrap} cli ${args.join(' ')}\n`,
        stderr: '',
      })
    }
    expect(run(fx.hook, ['gate'])).toEqual({
      status: 0,
      stdout: `PINNED-NODE ${fx.bootstrap} hook gate\n`,
      stderr: '',
    })
  })
})

describe.skipIf(process.platform === 'win32')('stable launcher recovery when the pinned Node bytes are unchanged', () => {
  it.each([
    [['setup', '--claude']],
    [['update', '--codex']],
    [['doctor']],
    [['runtime', 'status']],
  ])('still runs `tenon %s` so it can re-pin', async (args) => {
    const fx = await install('moved-allowed', sameBytesNewInode)

    expect(run(fx.tenon, args)).toEqual({
      status: 0,
      stdout: `PINNED-NODE ${fx.bootstrap} cli ${args.join(' ')}\n`,
      stderr: '',
    })
  })

  it.each([[['status']], [['init', 'task']], [[]]])('refuses `tenon %s` with one line naming the repair command', async (args) => {
    const fx = await install('moved-refused', sameBytesNewInode)

    const result = run(fx.tenon, args)

    expect(result.status).toBe(126)
    expect(result.stdout).toBe('')
    const message = lines(result.stderr)
    expect(message).toHaveLength(1)
    expect(message[0]).toContain('Node identity changed')
    expect(message[0]).toContain('tenon setup --claude')
    expect(message[0]).toContain('tenon setup --codex')
  })

  it('prints a hook notice once per quiet window and otherwise fails open without blocking', async () => {
    const fx = await install('hook-rate-limit', sameBytesNewInode)

    const first = run(fx.hook, ['gate'])
    expect(first.status).toBe(126)
    expect(first.status).not.toBe(2)
    expect(first.stdout).toBe('')
    expect(lines(first.stderr)).toHaveLength(1)
    expect(first.stderr).toContain('Node identity changed')
    expect((await stat(fx.marker)).isFile()).toBe(true)

    for (const hook of ['gate', 'breadcrumb', 'gate', 'statusline']) {
      expect(run(fx.hook, [hook])).toEqual({ status: 0, stdout: '', stderr: '' })
    }

    const inside = new Date(Date.now() - 29 * MINUTE_MS)
    await utimes(fx.marker, inside, inside)
    expect(run(fx.hook, ['gate'])).toEqual({ status: 0, stdout: '', stderr: '' })

    const expired = new Date(Date.now() - 31 * MINUTE_MS)
    await utimes(fx.marker, expired, expired)
    const again = run(fx.hook, ['gate'])
    expect(again.status).toBe(126)
    expect(lines(again.stderr)).toHaveLength(1)
    expect(run(fx.hook, ['gate'])).toEqual({ status: 0, stdout: '', stderr: '' })
  })

  it('fails open silently when the state dir cannot hold the marker', async () => {
    const fx = await install('hook-no-marker', sameBytesNewInode)
    await mkdir(join(fx.paths.stateRoot, '..'), { recursive: true })
    await writeFile(fx.paths.stateRoot, 'a file where the state directory should be', 'utf8')

    expect(run(fx.hook, ['gate'])).toEqual({ status: 0, stdout: '', stderr: '' })
  })
})

describe.skipIf(process.platform === 'win32')('stable launcher recovery when the pinned Node really changed', () => {
  async function stubPathNode(fx: Fixture): Promise<string> {
    const bin = join(fx.root, 'path-bin')
    await mkdir(bin, { recursive: true })
    await writeFile(
      join(bin, 'node'),
      '#!/bin/sh\nprintf "PATH-NODE roots=%s args=%s\\n" "$TENON_RUNTIME_ROOTS" "$*"\n',
      { mode: 0o755 },
    )
    return bin
  }

  function repairCommand(stderr: string): string {
    const [message] = lines(stderr)
    const marker = 'repair with: '
    const start = (message ?? '').indexOf(marker)
    const end = (message ?? '').indexOf('   (Codex')
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    return (message ?? '').slice(start + marker.length, end)
  }

  it.each([
    ['replaced bytes', async (fx: Fixture) => { await writeFile(fx.node, '#!/bin/sh\nprintf "REPLACED\\n"\n') }],
    ['a removed binary', async (fx: Fixture) => { await rm(fx.node) }],
    ['a symlink swapped in for identical bytes', async (fx: Fixture) => {
      const real = join(fx.root, 'real-node')
      await rename(fx.node, real)
      await symlink(real, fx.node)
    }],
  ])('refuses even setup after %s and prints a repair command that works', async (_label, tamper) => {
    const fx = await install('changed')
    await tamper(fx)

    for (const args of [['setup', '--claude'], ['status']]) {
      const refused = run(fx.tenon, args)
      expect(refused.status).toBe(126)
      expect(refused.stdout).toBe('')
      expect(lines(refused.stderr)).toHaveLength(1)
      expect(refused.stderr).toContain('Node identity changed')
    }

    const command = repairCommand(run(fx.tenon, ['setup', '--claude']).stderr)
    const bin = await stubPathNode(fx)
    const repaired = spawnSync('/bin/sh', ['-c', command], {
      encoding: 'utf8',
      env: { PATH: `${bin}:/usr/bin:/bin` },
    })
    expect(repaired.status).toBe(0)
    expect(repaired.stdout).toBe(
      `PATH-NODE roots=${serializeProductRootContract(fx.paths)} args=${fx.bootstrap} cli setup --claude\n`,
    )
  })

  it('prints a repair command that survives spaces and quotes in the runtime paths', async () => {
    // macOS keeps Tenon's roots under "Application Support"; a user name can carry a quote.
    const fx = await install("it's a space")
    await writeFile(fx.node, '#!/bin/sh\nprintf "REPLACED\\n"\n')

    const command = repairCommand(run(fx.tenon, ['setup', '--claude']).stderr)
    const bin = await stubPathNode(fx)
    const repaired = spawnSync('/bin/sh', ['-c', command], {
      encoding: 'utf8',
      env: { PATH: `${bin}:/usr/bin:/bin` },
    })

    expect(repaired.status).toBe(0)
    expect(repaired.stdout).toBe(
      `PATH-NODE roots=${serializeProductRootContract(fx.paths)} args=${fx.bootstrap} cli setup --claude\n`,
    )
  })

  it('refuses setup when the pinned digest does not match even though every stat field does', async () => {
    const fx = await install('digest-only', otherDigest)

    const refused = run(fx.tenon, ['setup', '--claude'])

    expect(refused.status).toBe(126)
    expect(refused.stdout).toBe('')
    expect(refused.stderr).toContain('replaced or removed')
  })

  it('keeps hooks quiet after the first notice in the replaced-Node state too', async () => {
    const fx = await install('changed-hook')
    await chmod(fx.node, 0o755)
    await writeFile(fx.node, '#!/bin/sh\nprintf "REPLACED\\n"\n')

    const first = run(fx.hook, ['gate'])
    expect(first.status).toBe(126)
    expect(lines(first.stderr)).toHaveLength(1)
    expect(run(fx.hook, ['gate'])).toEqual({ status: 0, stdout: '', stderr: '' })
  })
})
