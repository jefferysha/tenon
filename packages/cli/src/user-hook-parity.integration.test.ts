import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isTenonUser, resolveTenonUser } from '@tenon/kernel'
import { REPO_ROOT } from './integration-harness.js'

const HOOK = join(REPO_ROOT, 'hooks', 'tenon-user.sh')
let dir: string
let repo: string
let base: NodeJS.ProcessEnv

function bashSlug(root: string, env: NodeJS.ProcessEnv): string | null {
  const result = spawnSync('bash', ['-c', '. "$1"; pipeline_user_slug "$2"', 'parity', HOOK, root], { env, encoding: 'utf8' })
  return result.status === 0 ? result.stdout : null
}

function tsSlug(root: string, env: NodeJS.ProcessEnv): string | null {
  const resolved = resolveTenonUser(root, env)
  return isTenonUser(resolved) ? resolved.slug : null
}

function expectParity(env: NodeJS.ProcessEnv, label: string): void {
  expect(bashSlug(repo, env), label).toBe(tsSlug(repo, env))
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tenon-user-parity-'))
  repo = join(dir, 'repo')
  mkdirSync(repo)
  mkdirSync(join(dir, 'home'))
  base = {
    PATH: process.env.PATH,
    HOME: join(dir, 'home'),
    GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    TENON_RUNTIME_HOME: join(dir, 'runtime'),
  }
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('bash tenon-user.sh and kernel resolveTenonUser agree on the slug', () => {
  it('env ids, valid and invalid', () => {
    const ids = [
      'Jeff.Sha@Example.COM', 'a+b@x.io', 'a-@b.c', '+x@y.z', 'A__B@C.D', "o'brien@x.io", '  spaced@x.io ',
      `${'a'.repeat(195)}@x.io`, `${'a'.repeat(196)}@x.io`, 'bad', 'a@b@c', 'jéff@x.io', 'x<y@z.io', 'q"q@z.io', "'lead@x.io",
      '@x.io', 'x@', 'tab\tbed@x.io', 'back\\slash@x.io', 'UPPER@CASE.IO', 'dots..and--dashes@x.io',
    ]
    for (const id of ids) expectParity({ ...base, TENON_USER: id }, id)
    expect(bashSlug(repo, { ...base, TENON_USER: 'Jeff.Sha@Example.COM' })).toBe('jeff.sha-at-example.com')
  })

  it('config file source, including invalid content, and env precedence over it', () => {
    const configDir = join(dir, 'runtime', 'config')
    mkdirSync(configDir, { recursive: true })
    const configPath = join(configDir, 'user.json')
    const contents = [
      '{"id":"Conf@X.io","name":"Conf"}\n', '{"id":"conf@x.io","extra":{"a":1}}', '{"id":"bad"}', 'not json',
      `{"id":"big@x.io","pad":"${'x'.repeat(5000)}"}`, '{"name":"no id"}',
    ]
    for (const content of contents) {
      writeFileSync(configPath, content)
      expectParity(base, content.slice(0, 40))
    }
    writeFileSync(configPath, '{"id":"conf@x.io"}')
    expectParity({ ...base, TENON_USER: 'env@x.io' }, 'env beats config')
    expectParity({ ...base, TENON_USER: 'not-an-email' }, 'invalid env does not fall through')
  })

  it('git source: global, repo scope, and none', () => {
    expectParity(base, 'no identity')
    execFileSync('git', ['config', '--file', join(dir, 'gitconfig'), 'user.email', 'Global@X.io'], { env: base })
    expectParity(base, 'global git')
    execFileSync('git', ['init', '-q'], { cwd: repo, env: base })
    execFileSync('git', ['config', 'user.email', 'repo+scope@x.io'], { cwd: repo, env: base })
    expectParity(base, 'repo git')
    expect(bashSlug(repo, base)).toBe('repo-scope-at-x.io')
  })
})
