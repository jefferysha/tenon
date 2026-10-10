import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { decodeNativeHostObservation, observeNativeHost } from './managed-host-state.js'
import type { SetupEnv } from './setupEnvironment.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function repoDir(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tenon-host-state-')))
  roots.push(root)
  return root
}

/** 只回答 observeNativeHost 会问的几类命令；其余视为未预期。 */
function fakeEnv(outputs: Record<string, string>): SetupEnv {
  const run = (cmd: string, args: string[]) => {
    if (cmd === 'git') {
      if (args.includes('rev-parse')) return { code: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '' }
      if (args.includes('symbolic-ref')) return { code: 0, stdout: 'main\n', stderr: '' }
      if (args.includes('diff')) return { code: 0, stdout: '', stderr: '' }
      if (args.includes('ls-files')) return { code: 0, stdout: '', stderr: '' }
    }
    const out = outputs[[cmd, ...args].join(' ')]
    return out === undefined
      ? { code: 127, stdout: '', stderr: `unexpected command: ${cmd} ${args.join(' ')}` }
      : { code: 0, stdout: out, stderr: '' }
  }
  return {
    homeDir: () => '/home/test',
    runtimeEnv: () => ({}),
    readText: () => undefined,
    runCommand: run,
  } as unknown as SetupEnv
}

describe('observeNativeHost on a directory marketplace (tenon setup --from-source)', () => {
  test('Claude: a directory marketplace has no repo field; its identity is the path', () => {
    const repo = repoDir()
    const env = fakeEnv({
      'claude plugin marketplace list --json': JSON.stringify([
        { name: 'tenon', source: 'directory', path: repo, installLocation: repo },
      ]),
      'claude plugin list --json': JSON.stringify([
        {
          id: 'tenon@tenon',
          version: '0.3.2',
          scope: 'user',
          enabled: true,
          installPath: '/home/test/.claude/plugins/cache/tenon/tenon/0.3.2',
          readFromFolder: repo,
          folderVersion: '0.3.2',
        },
      ]),
    })
    const observation = decodeNativeHostObservation(observeNativeHost(env, 'claude'))
    expect(observation.marketplace).toMatchObject({ root: repo, source: repo, sourceType: 'directory' })
    expect(observation.plugin).toMatchObject({ id: 'tenon@tenon', version: '0.3.2', enabled: true })
  })

  test('Claude: a github marketplace keeps reporting repo as its source', () => {
    const repo = repoDir()
    const env = fakeEnv({
      'claude plugin marketplace list --json': JSON.stringify([
        { name: 'tenon', source: 'github', repo: 'jefferysha/tenon', installLocation: repo },
      ]),
      'claude plugin list --json': '[]',
    })
    const observation = decodeNativeHostObservation(observeNativeHost(env, 'claude'))
    expect(observation.marketplace).toMatchObject({ source: 'jefferysha/tenon', sourceType: 'github' })
    expect(observation.plugin).toBeNull()
  })

  test('Codex: a local marketplace reports its source path and sourceType local', () => {
    const repo = repoDir()
    const env = fakeEnv({
      'codex plugin marketplace list --json': JSON.stringify({
        marketplaces: [{
          name: 'tenon',
          root: repo,
          marketplaceSource: { sourceType: 'local', source: repo },
        }],
      }),
      'codex plugin list --json': JSON.stringify({ installed: [] }),
    })
    const observation = decodeNativeHostObservation(observeNativeHost(env, 'codex'))
    expect(observation.marketplace).toMatchObject({ root: repo, source: repo, sourceType: 'local' })
  })

  test('Claude: an entry that is neither github nor directory still fails closed', () => {
    const repo = repoDir()
    const env = fakeEnv({
      'claude plugin marketplace list --json': JSON.stringify([
        { name: 'tenon', source: 'url', installLocation: repo },
      ]),
      'claude plugin list --json': '[]',
    })
    expect(() => observeNativeHost(env, 'claude')).toThrow('claude tenon marketplace identity 不完整')
  })
})
