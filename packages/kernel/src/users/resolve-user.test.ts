import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readUserConfig, resolveTenonUser, writeUserConfig } from './resolve-user.js'

let dir: string
let env: NodeJS.ProcessEnv
let configPath: string

function git(args: string[], cwd?: string): void {
  execFileSync('git', args, { cwd, env, stdio: 'ignore' })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tenon-user-'))
  mkdirSync(join(dir, 'home'))
  env = {
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

describe('resolveTenonUser', () => {
  it('env beats config beats git, and the name comes only from the chosen source', async () => {
    git(['config', '--file', join(dir, 'gitconfig'), 'user.email', 'git@x.io'])
    git(['config', '--file', join(dir, 'gitconfig'), 'user.name', 'Git Name'])
    expect(resolveTenonUser(undefined, env)).toEqual({
      id: 'git@x.io', name: 'Git Name', slug: 'git-at-x.io', source: 'git', trust: 'declared',
    })
    await writeUserConfig(configPath, { id: 'Conf@X.io' })
    expect(resolveTenonUser(undefined, env)).toMatchObject({ id: 'Conf@X.io', name: 'Conf', slug: 'conf-at-x.io', source: 'config' })
    expect(resolveTenonUser(undefined, { ...env, TENON_USER: 'env@x.io' }))
      .toMatchObject({ id: 'env@x.io', name: 'env', source: 'env' })
    expect(resolveTenonUser(undefined, { ...env, TENON_USER: 'env@x.io', TENON_USER_NAME: 'Env Name' }))
      .toMatchObject({ name: 'Env Name', source: 'env' })
  })

  it('an invalid higher source does not fall through', () => {
    git(['config', '--file', join(dir, 'gitconfig'), 'user.email', 'git@x.io'])
    expect(resolveTenonUser(undefined, { ...env, TENON_USER: 'not-an-email' })).toEqual({ missing: true, invalid: 'env' })
    mkdirSync(join(dir, 'runtime', 'config'), { recursive: true })
    writeFileSync(configPath, '{"id":"bad"}\n')
    expect(resolveTenonUser(undefined, env)).toEqual({ missing: true, invalid: 'config' })
    writeFileSync(configPath, 'not json')
    expect(resolveTenonUser(undefined, env)).toEqual({ missing: true, invalid: 'config' })
  })

  it('repo-scope email beats global; no git email is missing; a non-ASCII git email is invalid', () => {
    const repo = join(dir, 'repo')
    mkdirSync(repo)
    git(['init', '-q'], repo)
    expect(resolveTenonUser(repo, env)).toEqual({ missing: true })
    git(['config', '--file', join(dir, 'gitconfig'), 'user.email', 'global@x.io'])
    expect(resolveTenonUser(repo, env)).toMatchObject({ id: 'global@x.io', source: 'git' })
    git(['config', 'user.email', 'repo@x.io'], repo)
    expect(resolveTenonUser(repo, env)).toMatchObject({ id: 'repo@x.io', source: 'git' })
    expect(resolveTenonUser(undefined, env)).toMatchObject({ id: 'global@x.io' })
    git(['config', 'user.email', 'jéff@x.io'], repo)
    expect(resolveTenonUser(repo, env)).toEqual({ missing: true, invalid: 'git' })
  })
})

describe('user config file', () => {
  it('writes {id,name} atomically with 0600 and reads extra keys as ignored', async () => {
    await writeUserConfig(configPath, { id: 'jeff@x.io', name: 'Jeff Sha' })
    expect(readFileSync(configPath, 'utf8')).toBe('{"id":"jeff@x.io","name":"Jeff Sha"}\n')
    expect(statSync(configPath).mode & 0o777).toBe(0o600)
    writeFileSync(configPath, '{"id":"jeff@x.io","extra":true}')
    expect(readUserConfig(configPath)).toEqual({ id: 'jeff@x.io', name: 'jeff' })
    expect(readUserConfig(join(dir, 'absent.json'))).toBe('absent')
    writeFileSync(configPath, `{"id":"jeff@x.io","pad":"${'x'.repeat(5000)}"}`)
    expect(readUserConfig(configPath)).toBe('invalid')
    await expect(writeUserConfig(configPath, { id: 'bad' })).rejects.toThrow('用户邮箱非法: bad')
  })

  it('refuses a symlink target', async () => {
    mkdirSync(join(dir, 'runtime', 'config'), { recursive: true })
    writeFileSync(join(dir, 'target.json'), '{}')
    symlinkSync(join(dir, 'target.json'), configPath)
    expect(readUserConfig(configPath)).toBe('invalid')
    await expect(writeUserConfig(configPath, { id: 'jeff@x.io' })).rejects.toThrow('不是普通文件')
    expect(readFileSync(join(dir, 'target.json'), 'utf8')).toBe('{}')
  })
})
