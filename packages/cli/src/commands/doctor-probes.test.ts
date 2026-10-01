import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { expectedStableLaunchers } from '../runtime/launchers.js'
import { resolveRuntimePaths } from '../runtime/paths.js'
import { legacyV020LauncherText } from '../runtime/test-support.js'
import type { TrustedExecutableProof } from '../runtime/types.js'
import type { RuntimeScopeSnapshot } from '../runtime/scope.js'
import type { TrustedExecutable } from './trusted-executable.js'
import { makeDoctorProbes } from './doctor-probes.js'

function probeScope(): RuntimeScopeSnapshot {
  const homeDir = '/tmp/tenon-doctor-probes'
  const env = { PATH: '/trusted/bin' }
  return { homeDir, env, paths: resolveRuntimePaths({ homeDir, env }) }
}

describe('doctor provenance adapter', () => {
  test('replays Bash then Node before the injected verifier spawn', async () => {
    const events: string[] = []
    const trusted = (name: 'bash' | 'node' | 'git' | 'codex' | 'claude') => ({
      executable: `/trusted/${name}`,
      requestedPath: `/trusted/${name}`,
      proof: { version: 1, platform: process.platform, requestedPath: `/trusted/${name}`, executable: { path: `/trusted/${name}`, dev: 1, ino: 1, mode: 0o755, uid: 0, size: 1 }, parents: [], sha256: 'a'.repeat(64) },
      verify: () => { events.push(`${name}-proof`); return true },
      assert: () => {},
    } satisfies TrustedExecutable)
    const probes = makeDoctorProbes(
      probeScope,
      '/trusted/root',
      {
        resolveTrustedCommand: (name) => trusted(name),
        run: async (file, args) => {
          events.push(`${file.slice('/trusted/'.length)}-spawn`)
          expect(args).toContain('--node')
          expect(args[args.indexOf('--node') + 1]).toBe('/trusted/node')
          return { code: 0, output: '' }
        },
      },
    )

    await expect(probes.runVerifySkills()).resolves.toEqual({ code: 0, output: '' })
    expect(events).toEqual(['bash-proof', 'node-proof', 'bash-spawn'])
  })

  test('Node drift fails closed without invoking the verifier', async () => {
    const events: string[] = []
    const trusted = (name: 'bash' | 'node' | 'git' | 'codex' | 'claude') => ({
      executable: `/trusted/${name}`,
      requestedPath: `/trusted/${name}`,
      proof: { version: 1, platform: process.platform, requestedPath: `/trusted/${name}`, executable: { path: `/trusted/${name}`, dev: 1, ino: 1, mode: 0o755, uid: 0, size: 1 }, parents: [], sha256: 'a'.repeat(64) },
      verify: () => { events.push(`${name}-proof`); return name !== 'node' },
      assert: () => {},
    } satisfies TrustedExecutable)
    const probes = makeDoctorProbes(
      probeScope,
      '/trusted/root',
      {
        resolveTrustedCommand: (name) => trusted(name),
        run: async () => {
          events.push('spawn')
          return { code: 0, output: '' }
        },
      },
    )

    await expect(probes.runVerifySkills()).resolves.toEqual({ code: 1, output: '可信 Bash/Node 身份已漂移' })
    expect(events).toEqual(['bash-proof', 'node-proof'])
  })
})

describe('doctor stable launcher probe', () => {
  const dirs: string[] = []
  afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))))

  const NODE = '/opt/node/bin/node'
  const proof: TrustedExecutableProof = {
    version: 1,
    platform: process.platform === 'darwin' ? 'darwin' : 'linux',
    requestedPath: NODE,
    executable: { path: NODE, dev: 1, ino: 2, mode: 0o100755, uid: 0, size: 3 },
    parents: [],
    sha256: 'ab'.repeat(32),
  }

  async function probeFor(write: (homeDir: string) => Promise<void>) {
    const homeDir = await mkdtemp(join(tmpdir(), 'tenon-doctor-launcher-'))
    dirs.push(homeDir)
    await mkdir(join(homeDir, '.local', 'bin'), { recursive: true })
    await write(homeDir)
    const env = { PATH: '/trusted/bin' }
    const scope: RuntimeScopeSnapshot = { homeDir, env, paths: resolveRuntimePaths({ homeDir, env }) }
    const probes = makeDoctorProbes(() => scope, '/trusted/root')
    if (probes.stableLauncherFormat === undefined) throw new Error('stableLauncherFormat probe must be wired')
    return { probe: probes.stableLauncherFormat, scope }
  }

  test('reads the two launchers of the scoped home and reports their format', async () => {
    for (const [format, text] of [
      ['legacy', legacyV020LauncherText],
      ['current', (paths: RuntimeScopeSnapshot['paths'], mode: 'cli' | 'hook', node: string, p: TrustedExecutableProof) => {
        const expected = expectedStableLaunchers(paths, '/unused', node, p)
        const file = mode === 'cli' ? expected.tenon : expected.hook
        if (file.state.kind !== 'file') throw new Error('launcher file')
        return file.state.content
      }],
    ] as const) {
      let scope: RuntimeScopeSnapshot | undefined
      const { probe } = await probeFor(async (homeDir) => {
        const env = { PATH: '/trusted/bin' }
        scope = { homeDir, env, paths: resolveRuntimePaths({ homeDir, env }) }
        await writeFile(join(homeDir, '.local', 'bin', 'tenon'), text(scope.paths, 'cli', NODE, proof), { mode: 0o755 })
        await writeFile(join(homeDir, '.local', 'bin', 'tenon-hook'), text(scope.paths, 'hook', NODE, proof), { mode: 0o755 })
      })
      expect(await probe()).toBe(format)
    }
  })

  test('reports absent when no launcher is installed', async () => {
    const { probe } = await probeFor(async () => {})
    expect(await probe()).toBe('absent')
  })
})
