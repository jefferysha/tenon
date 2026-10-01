import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { expectedStableLaunchers } from './launchers.js'
import { resolveRuntimePaths } from './paths.js'
import {
  inspectStableLauncherFormat,
  parseManagedLauncher,
  readLauncherFile,
} from './stable-launcher-format.js'
import { legacyV020LauncherText } from './test-support.js'
import type { TrustedExecutableProof, TrustedPathProof } from './types.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

const NODE = "/opt/it's/node/bin/node"
const DIGEST = 'ab'.repeat(32)

function entry(path: string, ino: number, mode: number, size: number): TrustedPathProof {
  return { path, dev: 16_777_234, ino, mode, uid: 501, size }
}

function proof(platform: 'darwin' | 'linux'): TrustedExecutableProof {
  return {
    version: 1,
    platform,
    requestedPath: NODE,
    executable: entry(NODE, 42, 0o100755, 99),
    parents: [entry("/opt/it's/node/bin", 41, 0o40755, 96), entry('/', 2, 0o40755, 704)],
    sha256: DIGEST,
  }
}

async function home(): Promise<{ root: string; bin: string; tenon: string; hook: string }> {
  const root = await mkdtemp(join(tmpdir(), 'tenon-launcher-format-'))
  roots.push(root)
  const bin = join(root, '.local', 'bin')
  await mkdir(bin, { recursive: true })
  return { root, bin, tenon: join(bin, 'tenon'), hook: join(bin, 'tenon-hook') }
}

describe('parseManagedLauncher', () => {
  const paths = resolveRuntimePaths({ env: { TENON_RUNTIME_HOME: "/tmp/it's a home" }, homeDir: "/tmp/it's a home", platform: 'linux' })

  it.each(['darwin', 'linux'] as const)('recognises the v0.2.0 device-pinned launcher on %s', (platform) => {
    for (const mode of ['cli', 'hook'] as const) {
      expect(parseManagedLauncher(legacyV020LauncherText(paths, mode, NODE, proof(platform)))).toEqual({
        mode,
        rootContract: expect.stringContaining('"version":1'),
        nodePath: NODE,
        legacy: true,
        digest: DIGEST,
      })
    }
  })

  it('does not call the current launcher legacy', () => {
    const current = expectedStableLaunchers(paths, '/tmp/it\'s a home', NODE, proof('linux'))
    for (const file of [current.tenon, current.hook]) {
      if (file.state.kind !== 'file') throw new Error('expected a launcher file')
      expect(parseManagedLauncher(file.state.content)).toMatchObject({ legacy: false, nodePath: NODE })
    }
  })

  it.each([
    ['an unrelated script', '#!/bin/sh\necho hello\n'],
    ['the v1.0.1 launcher', '#!/usr/bin/env bash\nset -eu\nexec node /x/active.mjs cli "$@"\n'],
    ['a script that merely mentions the stat format', "#!/bin/sh\n# stat -f '%d:%i'\necho hi\n"],
    ['a Tenon header without an exec line', '#!/bin/sh\nset -eu\nexport TENON_RUNTIME_ROOTS=\'{}\'\nexport TENON_NODE_PATH=\'/n\'\n'],
  ])('leaves %s alone', (_label, text) => {
    expect(parseManagedLauncher(text)).toBeUndefined()
  })

  it('refuses a launcher whose exec target is not the Node it pins', () => {
    const text = legacyV020LauncherText(paths, 'cli', NODE, proof('linux'))
      .replace(/\nexec '[^\n]*' (?='[^\n]*' cli)/u, "\nexec '/usr/bin/evil' ")
    expect(parseManagedLauncher(text)).toBeUndefined()
  })
})

describe('inspectStableLauncherFormat', () => {
  const paths = resolveRuntimePaths({ env: { TENON_RUNTIME_HOME: '/tmp/format-home' }, homeDir: '/tmp/format-home', platform: 'linux' })

  async function writeLaunchers(h: Awaited<ReturnType<typeof home>>, text: (mode: 'cli' | 'hook') => string): Promise<void> {
    await writeFile(h.tenon, text('cli'), { mode: 0o755 })
    await writeFile(h.hook, text('hook'), { mode: 0o755 })
  }
  const legacy = (mode: 'cli' | 'hook') => legacyV020LauncherText(paths, mode, NODE, proof('linux'))
  const current = (mode: 'cli' | 'hook') => {
    const file = expectedStableLaunchers(paths, '/tmp/format-home', NODE, proof('linux'))[mode === 'cli' ? 'tenon' : 'hook']
    if (file.state.kind !== 'file') throw new Error('expected a launcher file')
    return file.state.content
  }

  it('reports legacy, current and absent', async () => {
    const h = await home()
    expect(await inspectStableLauncherFormat(h.root)).toBe('absent')
    await writeLaunchers(h, legacy)
    expect(await inspectStableLauncherFormat(h.root)).toBe('legacy')
    await writeLaunchers(h, current)
    expect(await inspectStableLauncherFormat(h.root)).toBe('current')
  })

  it('is legacy while either launcher still pins a device number', async () => {
    const h = await home()
    await writeFile(h.tenon, current('cli'), { mode: 0o755 })
    await writeFile(h.hook, legacy('hook'), { mode: 0o755 })
    expect(await inspectStableLauncherFormat(h.root)).toBe('legacy')
  })

  it('treats a symlink, a foreign script and a lone launcher as unmanaged', async () => {
    const h = await home()
    const elsewhere = join(h.root, 'elsewhere')
    await writeFile(elsewhere, legacy('cli'), { mode: 0o755 })
    await symlink(elsewhere, h.tenon)
    await writeFile(h.hook, current('hook'), { mode: 0o755 })
    expect(await readLauncherFile(h.tenon)).toEqual({ kind: 'unmanaged' })
    expect(await inspectStableLauncherFormat(h.root)).toBe('unmanaged')

    await rm(h.tenon)
    await writeFile(h.tenon, "#!/bin/sh\n# stat -f '%d:%i' is mentioned here\necho mine\n", { mode: 0o755 })
    expect(await inspectStableLauncherFormat(h.root)).toBe('unmanaged')

    await rm(h.tenon)
    expect(await readLauncherFile(h.tenon)).toEqual({ kind: 'missing' })
    expect(await inspectStableLauncherFormat(h.root)).toBe('unmanaged')
  })

  it('still reports a device-pinned launcher next to a file it does not manage', async () => {
    const h = await home()
    await writeFile(h.tenon, '#!/bin/sh\necho mine\n', { mode: 0o755 })
    await writeFile(h.hook, legacy('hook'), { mode: 0o755 })
    expect(await inspectStableLauncherFormat(h.root)).toBe('legacy')
  })
})
