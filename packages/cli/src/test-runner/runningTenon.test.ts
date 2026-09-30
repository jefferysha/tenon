/**
 * 测试进程 PATH 上的 tenon（真机验收 F17）：`env -i PATH=/usr/bin:/bin` 这种解析不到 tenon 的环境里，
 * `tenon test code-size --json` 曾以 127 失败。这里用真实 sh 子进程验证前置后的解析结果。
 */
import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runningTenonBinDir, withRunningTenon } from './runningTenon.js'

let dir = ''
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'tenon-running-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const BARE_PATH = '/usr/bin:/bin'

function sh(command: string, env: NodeJS.ProcessEnv): { code: number | null; out: string } {
  const result = spawnSync('/bin/sh', ['-c', command], { env, encoding: 'utf8' })
  return { code: result.status, out: `${result.stdout}${result.stderr}`.trim() }
}

/** 一份会回显参数的假 CLI 入口（文件名必须是 tenon.mjs，同真入口）。 */
async function fakeEntry(): Promise<string> {
  await mkdir(join(dir, 'dist'), { recursive: true })
  const entry = join(dir, 'dist', 'tenon.mjs')
  await writeFile(entry, "console.log('running tenon ' + process.argv.slice(2).join(' '))\n", 'utf8')
  return entry
}

describe('withRunningTenon', () => {
  it('PATH 上没有 tenon 时前置转发脚本：命令解析到正在跑的入口，不再 127', async () => {
    const entry = await fakeEntry()
    const bare: NodeJS.ProcessEnv = { PATH: BARE_PATH }
    expect(sh('tenon test code-size --json', bare).code).toBe(127)

    const env = await withRunningTenon(bare, { runDir: join(dir, 'run'), entry, home: join(dir, 'home') })
    const result = sh('tenon test code-size --json', env)
    expect(result).toEqual({ code: 0, out: 'running tenon test code-size --json' })
    expect(env.PATH?.startsWith(join(dir, 'run', 'bin'))).toBe(true)
    expect(env.PATH?.endsWith(BARE_PATH)).toBe(true)
  })

  it('经稳定启动器启动（环境带 TENON_RUNTIME_ROOTS）且启动器在盘上：前置启动器目录，不另写转发脚本', async () => {
    const home = join(dir, 'home')
    const launcherDir = join(home, '.local', 'bin')
    await mkdir(launcherDir, { recursive: true })
    await writeFile(join(launcherDir, 'tenon'), '#!/bin/sh\necho launcher "$@"\n', 'utf8')
    await chmod(join(launcherDir, 'tenon'), 0o755)

    const env = await withRunningTenon({ PATH: BARE_PATH, TENON_RUNTIME_ROOTS: '{}' }, {
      runDir: join(dir, 'run'), entry: join(dir, 'payload', 'packages', 'cli', 'dist', 'tenon.mjs'), home,
    })
    expect(sh('tenon status', env)).toEqual({ code: 0, out: 'launcher status' })
    expect(env.PATH?.split(':')[0]).toBe(launcherDir)
    await expect(runningTenonBinDir({ PATH: BARE_PATH }, { runDir: join(dir, 'other'), entry: join(dir, 'missing', 'tenon.mjs'), home }))
      .resolves.toBeUndefined()
  })

  it('入口不是 tenon.mjs（被嵌入的调用、测试运行器）或平台不支持时不动 PATH', async () => {
    const env: NodeJS.ProcessEnv = { PATH: BARE_PATH }
    const runner = join(dir, 'vitest.mjs')
    await writeFile(runner, '', 'utf8')
    expect(await withRunningTenon(env, { runDir: join(dir, 'run'), entry: runner, home: dir })).toBe(env)
    const entry = await fakeEntry()
    expect(await withRunningTenon(env, { runDir: join(dir, 'run'), entry, home: dir, platform: 'win32' })).toBe(env)
  })

  it('已有同名目录时不重复出现在 PATH 里', async () => {
    const entry = await fakeEntry()
    const once = await withRunningTenon({ PATH: BARE_PATH }, { runDir: join(dir, 'run'), entry, home: dir })
    const twice = await withRunningTenon(once, { runDir: join(dir, 'run'), entry, home: dir })
    expect(twice.PATH?.split(':').filter((entryDir) => entryDir === join(dir, 'run', 'bin'))).toHaveLength(1)
  })
})
