import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { gitEnvironment, runGit } from './git-exec.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function scratch(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tenon-git-exec-')))
  roots.push(root)
  return root
}

/** 建夹具用的环境：去掉调用方进程里的 GIT_*，与被测的 gitEnvironment 无关。 */
function fixtureEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(process.env)) if (!name.startsWith('GIT_')) env[name] = value
  return env
}

async function repo(): Promise<string> {
  const dir = join(await scratch(), 'repo')
  await mkdir(dir)
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, env: fixtureEnv(), stdio: 'ignore' })
  return dir
}

describe('gitEnvironment：git 子进程用的环境', () => {
  it('去掉全部 GIT_ 变量（名字不分大小写），保留其余，并固定 C 语言环境', () => {
    const env = gitEnvironment({ GIT_DIR: 'x', git_work_tree: 'y', Git_Common_Dir: 'z', PATH: '/bin', LANG: 'zh' })
    expect(Object.keys(env).sort()).toEqual(['LANG', 'LC_ALL', 'PATH'])
    expect(env.PATH).toBe('/bin')
    expect(env.LANG).toBe('C')
    expect(env.LC_ALL).toBe('C')
  })

  it('不给来源时取当前进程环境', () => {
    const saved = process.env.GIT_DIR
    try {
      process.env.GIT_DIR = '/somewhere/else'
      expect(gitEnvironment().GIT_DIR).toBeUndefined()
      expect(gitEnvironment().PATH).toBe(process.env.PATH)
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = saved
    }
  })

  it('名字只是含有 git_ 而不是以它开头的变量保留', () => {
    const env = gitEnvironment({ MY_GIT_HOME: 'keep', GITHUB_TOKEN: 'keep-too' })
    expect(env.MY_GIT_HOME).toBe('keep')
    expect(env.GITHUB_TOKEN).toBe('keep-too')
  })
})

describe('runGit：固定 cwd、带超时与输出上限的 git 调用', () => {
  it('在仓库里返回 git 的标准输出', async () => {
    expect(await runGit(await repo(), ['rev-parse', '--is-inside-work-tree'])).toBe('true\n')
  })

  it('不是仓库：照常抛出，由调用方失败关闭', async () => {
    await expect(runGit(await scratch(), ['rev-parse', '--git-dir'])).rejects.toBeDefined()
  })

  it('输出超过 maxBuffer：抛出而不是截断', async () => {
    await expect(runGit(await repo(), ['rev-parse', '--is-inside-work-tree'], { maxBuffer: 1 })).rejects.toBeDefined()
  })

  it('进程环境里的 GIT_DIR 指向别处也不影响结果', async () => {
    const mine = await repo()
    const other = await scratch()
    const saved = process.env.GIT_DIR
    try {
      process.env.GIT_DIR = join(other, 'nowhere')
      expect(await runGit(mine, ['rev-parse', '--is-inside-work-tree'])).toBe('true\n')
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = saved
    }
  })
})
