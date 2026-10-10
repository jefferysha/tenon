import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { buildProgram, CliExit } from '../program.js'
import { installChannelPath, writeInstallChannelMarker, type DevInstallMarker } from '../runtime/dev-install-marker.js'
import { resolveRuntimePaths } from '../runtime/paths.js'
import { makeDeps } from '../test-support.js'
import { clearDevInstallMarker } from './source-install.js'

/** 本 checkout 自己就是满足四项判据的 Tenon 源码仓库；dry-run 只读，用它省掉造夹具。 */
const checkout = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..'))

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function run(args: string[]) {
  const deps = makeDeps()
  let code = 0
  try {
    await buildProgram(deps).parseAsync(args, { from: 'user' })
  } catch (error) {
    if (error instanceof CliExit) code = error.code
    else throw error
  }
  return { code, out: deps.outLines.join('\n'), err: deps.errLines.join('\n') }
}

describe('tenon setup --from-source option wiring', () => {
  test('--dry-run prints the development plan for this checkout and changes nothing', async () => {
    const result = await run(['setup', '--claude', '--from-source', checkout, '--skip-build', '--dry-run'])
    expect(result.code).toBe(0)
    expect(result.out).toContain(`claude plugin marketplace add ${checkout}`)
    expect(result.out).toContain('--skip-build')
    expect(result.out).toContain('commit ')
  })

  test.each([
    ['an adapter host', ['setup', '--cursor', '--from-source', checkout, '--dry-run'], 'adapter'],
    ['--auto-update', ['setup', '--claude', '--from-source', checkout, '--auto-update', '--dry-run'], '--auto-update'],
    ['--skip-build without --from-source', ['setup', '--claude', '--skip-build', '--dry-run'], '--from-source'],
  ])('rejects %s before any work', async (_label, args, fragment) => {
    const result = await run(args)
    expect(result.code).toBe(1)
    expect(result.err).toContain(fragment)
  })

  test('a path that is not a Tenon source repository is refused in dry-run too', async () => {
    const result = await run(['setup', '--claude', '--from-source', tmpdir(), '--dry-run'])
    expect(result.code).toBe(1)
    expect(result.err).toContain('不是 Tenon 源码仓库')
  })
})

describe('clearDevInstallMarker', () => {
  const MARKER: DevInstallMarker = {
    host: 'claude',
    releaseId: `sha256-${'a'.repeat(64)}`,
    installedAt: '2026-10-07T12:00:00Z',
    devSource: {
      kind: 'dev', repoRealpath: '/work/tenon', commit: 'b'.repeat(40), dirty: false,
      worktreeDigest: 'c'.repeat(40), skillsIndexDigest: 'd'.repeat(40),
    },
  }

  test('removes the marker under the config root and is a no-op without one', () => {
    const root = mkdtempSync(join(tmpdir(), 'tenon-clear-marker-'))
    roots.push(root)
    const env = { homeDir: () => root, runtimeEnv: () => ({ TENON_RUNTIME_HOME: join(root, 'runtime') }) }
    const configRoot = resolveRuntimePaths({ homeDir: root, env: env.runtimeEnv() }).configRoot
    writeInstallChannelMarker(configRoot, MARKER)
    expect(existsSync(installChannelPath(configRoot))).toBe(true)
    clearDevInstallMarker(env)
    expect(existsSync(installChannelPath(configRoot))).toBe(false)
    expect(() => clearDevInstallMarker(env)).not.toThrow()
  })
})
