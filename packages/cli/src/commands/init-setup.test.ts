import { existsSync } from 'node:fs'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { spawnSetup } from './init-setup.js'

describe('spawnSetup —— 真执行器：输出逐行交给 log，退出码原样返回', () => {
  const temps: string[] = []
  afterEach(async () => {
    for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true })
  })

  async function cwdDir(): Promise<string> {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'spawn-setup-')))
    temps.push(dir)
    return dir
  }

  test('在 cwd 里执行；stdout 与 stderr 的行都进 log，没有换行结尾的最后一段也不丢；退出码 0', async () => {
    const cwd = await cwdDir()
    const lines: string[] = []
    const command = `node -e "console.log('out-1'); console.error('err-1'); process.stdout.write('tail-without-newline'); require('fs').writeFileSync('here','1')"`
    expect(await spawnSetup({ command, cwd, log: (line) => lines.push(line) })).toBe(0)
    expect([...lines].sort()).toEqual(['err-1', 'out-1', 'tail-without-newline'])
    expect(existsSync(join(cwd, 'here'))).toBe(true)
  })

  test('非零退出码原样返回，失败前的输出仍然交给 log', async () => {
    const cwd = await cwdDir()
    const lines: string[] = []
    const command = `node -e "console.error('about to fail'); process.exit(3)"`
    expect(await spawnSetup({ command, cwd, log: (line) => lines.push(line) })).toBe(3)
    expect(lines).toEqual(['about to fail'])
  })

  test('工作目录不存在：起不来，返回 127 并把原因交给 log，不抛错', async () => {
    const cwd = join(await cwdDir(), 'missing')
    const lines: string[] = []
    expect(await spawnSetup({ command: 'node -e "0"', cwd, log: (line) => lines.push(line) })).toBe(127)
    expect(lines.join('\n')).toMatch(/ENOENT/)
  })
})
