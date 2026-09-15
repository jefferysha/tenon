import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveTenonUser } from '@tenon/kernel'
import { makeDeps, type TestDeps } from '../test-support.js'
import { cmdUser, cmdUserSet } from './user.js'

let dir: string
let base: NodeJS.ProcessEnv
let configPath: string

function depsFor(env: NodeJS.ProcessEnv): TestDeps {
  const deps = makeDeps()
  deps.user = () => resolveTenonUser(undefined, env)
  deps.userConfigPath = () => configPath
  deps.env = (name) => env[name]
  return deps
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tenon-user-cmd-'))
  mkdirSync(join(dir, 'home'))
  base = {
    PATH: process.env.PATH,
    HOME: join(dir, 'home'),
    GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    TENON_RUNTIME_HOME: join(dir, 'runtime'),
  }
  configPath = join(dir, 'runtime', 'config', 'user.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('tenon user', () => {
  it('prints the env user as a ref plus source, and as JSON', async () => {
    const deps = depsFor({ ...base, TENON_USER: 'tester@tenon.test', TENON_USER_NAME: 'Tester' })
    expect(await cmdUser(deps)).toBe(0)
    expect(deps.outLines).toEqual(['Tester <tester@tenon.test> env'])
    const json = depsFor({ ...base, TENON_USER: 'tester@tenon.test', TENON_USER_NAME: 'Tester' })
    expect(await cmdUser(json, { json: true })).toBe(0)
    expect(JSON.parse(json.outLines[0] ?? '')).toEqual({
      user: { id: 'tester@tenon.test', name: 'Tester', slug: 'tester-at-tenon.test', source: 'env', trust: 'declared' },
    })
  })

  it('reports the git source', async () => {
    execFileSync('git', ['config', '--file', join(dir, 'gitconfig'), 'user.email', 'git@x.io'])
    const deps = depsFor(base)
    expect(await cmdUser(deps, { json: true })).toBe(0)
    expect(JSON.parse(deps.outLines[0] ?? '')).toMatchObject({ user: { id: 'git@x.io', source: 'git' } })
  })

  it('missing or invalid identity exits 1 with the setup hint', async () => {
    const missing = depsFor(base)
    expect(await cmdUser(missing, { json: true })).toBe(1)
    expect(JSON.parse(missing.outLines[0] ?? '')).toEqual({ user: null })
    expect(missing.errLines[0]).toContain('ERROR: 未设置用户身份')
    const invalid = depsFor({ ...base, TENON_USER: 'not-an-email' })
    expect(await cmdUser(invalid, { json: true })).toBe(1)
    expect(JSON.parse(invalid.outLines[0] ?? '')).toEqual({ user: null, invalid: 'env' })
  })
})

describe('tenon user set', () => {
  it('writes user.json and prints the config user', async () => {
    const deps = depsFor(base)
    expect(await cmdUserSet(deps, 'jeff@x.io', { name: 'Jeff Sha' })).toBe(0)
    expect(readFileSync(configPath, 'utf8')).toBe('{"id":"jeff@x.io","name":"Jeff Sha"}\n')
    expect(deps.outLines).toEqual(['Jeff Sha <jeff@x.io> config'])
    expect(deps.errLines).toEqual([])
  })

  it('warns when TENON_USER overrides the file', async () => {
    const deps = depsFor({ ...base, TENON_USER: 'env@x.io' })
    expect(await cmdUserSet(deps, 'jeff@x.io')).toBe(0)
    expect(deps.errLines).toEqual(['WARN: TENON_USER 覆盖本机配置'])
    expect(deps.outLines).toEqual(['env <env@x.io> env'])
  })

  it('rejects an invalid id without writing', async () => {
    const deps = depsFor(base)
    expect(await cmdUserSet(deps, 'bad')).toBe(1)
    expect(deps.errLines).toEqual(['ERROR: 用户邮箱非法: bad'])
    expect(existsSync(configPath)).toBe(false)
  })
})
