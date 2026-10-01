import { describe, expect, it } from 'vitest'
import { nodeIdentityGuard, type NodeIdentityGuardContext } from './stable-launcher-node-guard.js'
import type { TrustedExecutableProof, TrustedPathProof } from './types.js'

// A device number no other pinned field can collide with, so its absence is unambiguous.
const DEVICE = 987654321
const SHIFTED_DEVICE = 123456789

function pathProof(path: string, ino: number, mode: number, size: number, dev = DEVICE): TrustedPathProof {
  return { path, dev, ino, mode, uid: 501, size }
}

function proof(platform: 'darwin' | 'linux', dev = DEVICE): TrustedExecutableProof {
  return {
    version: 1,
    platform,
    requestedPath: '/opt/node/bin/node',
    executable: pathProof('/opt/node/bin/node', 4242, 0o100755, 99_000_000, dev),
    parents: [
      pathProof('/opt/node/bin', 4241, 0o40755, 96, dev),
      pathProof('/opt/node', 4240, 0o40755, 128, dev),
      pathProof('/opt', 4239, 0o40755, 64, dev),
      pathProof('/', 2, 0o40755, 704, dev),
    ],
    sha256: 'a'.repeat(64),
  }
}

function context(mode: 'cli' | 'hook'): NodeIdentityGuardContext {
  return {
    mode,
    bootstrap: '/data/bootstrap/active.mjs',
    rootAssignment: `TENON_RUNTIME_ROOTS='{"version":1,"dataRoot":"/data","stateRoot":"/state","configRoot":"/config"}'`,
    stateRoot: '/state',
  }
}

describe('nodeIdentityGuard persisted identity', () => {
  it.each(['darwin', 'linux'] as const)('never persists a device number on %s', (platform) => {
    const guard = nodeIdentityGuard(proof(platform), context('cli'))

    // st_dev is reassigned per mount: macOS APFS hands out a new one after every reboot.
    expect(guard).not.toContain('%d')
    expect(guard).not.toContain(String(DEVICE))
    expect(guard).toContain('%i')
    expect(guard).toContain(`'${'a'.repeat(64)}'`)
  })

  it.each(['darwin', 'linux'] as const)('renders the same launcher text when only device numbers differ on %s', (platform) => {
    for (const mode of ['cli', 'hook'] as const) {
      expect(nodeIdentityGuard(proof(platform, SHIFTED_DEVICE), context(mode)))
        .toBe(nodeIdentityGuard(proof(platform), context(mode)))
    }
  })

  it('still pins inode, mode, owner and size of the executable and inode, mode and owner of every parent', () => {
    const darwin = nodeIdentityGuard(proof('darwin'), context('cli'))
    expect(darwin).toContain("-f '%i:%p:%u:%z'")
    expect(darwin).toContain("'4242:100755:501:99000000'")
    expect(darwin).toContain("-f '%i:%p:%u'")
    expect(darwin).toContain("'4241:40755:501'")
    expect(darwin).toContain("'2:40755:501'")
    expect(darwin).toContain('/usr/bin/shasum -a 256')

    const linux = nodeIdentityGuard(proof('linux'), context('cli'))
    expect(linux).toContain("-c '%i:%f:%u:%s'")
    expect(linux).toContain("'4242:81ed:501:99000000'")
    expect(linux).toContain('/usr/bin/sha256sum')
  })

  it('keeps the symlink-swap and content-digest checks for the executable and every parent', () => {
    const guard = nodeIdentityGuard(proof('linux'), context('cli'))
    for (const path of ['/opt/node/bin/node', '/opt/node/bin', '/opt/node', '/opt', '/']) {
      expect(guard).toContain(`[ ! -L '${path}' ]`)
    }
    expect(guard).toContain(`= '${'a'.repeat(64)}'`)
  })

  it('emits nothing without a proof and refuses platforms it cannot pin', () => {
    expect(nodeIdentityGuard(undefined, context('cli'))).toBe('')
    expect(() => nodeIdentityGuard({ ...proof('linux'), platform: 'win32' }, context('cli')))
      .toThrow(/win32/u)
  })
})

describe('nodeIdentityGuard recovery and hook behavior', () => {
  it('lets only the repair-capable subcommands run on pinned bytes and names the repair command otherwise', () => {
    const guard = nodeIdentityGuard(proof('linux'), context('cli'))

    expect(guard).toContain('setup|update|doctor|runtime)')
    expect(guard).toContain('tenon setup --claude')
    expect(guard).toContain('tenon setup --codex')
    // A replaced Node cannot be reached through the launcher it invalidated: the manual command
    // runs the bootstrap with the PATH Node and the exact root contract the bootstrap requires.
    // The command is shell-quoted inside the printf argument; the integration tests execute it.
    expect(guard).toContain('env TENON_RUNTIME_ROOTS=')
    expect(guard).toContain('/data/bootstrap/active.mjs')
    expect(guard).toContain('cli setup --claude')
    expect(guard).toContain('exit 126')
  })

  it('rate-limits hook notices through a marker in the state dir and never blocks', () => {
    const guard = nodeIdentityGuard(proof('linux'), context('hook'))

    expect(guard).toContain("tenon_notice_marker='/state/launcher-node-identity.notice'")
    expect(guard).toContain('-mmin -30')
    expect(guard).toContain('set -C')
    // Exit 2 is the host's blocking code; a Node identity problem must only ever fail open.
    expect(guard).not.toMatch(/exit 2\b/u)
    expect(guard).not.toContain('setup|update|doctor|runtime')
  })
})
