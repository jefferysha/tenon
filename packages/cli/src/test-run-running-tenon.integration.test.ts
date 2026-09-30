/**
 * `tenon test run` 给测试进程的 PATH 前置正在跑的 tenon（真机验收 F17）：内联步骤测试与目录套件两条运行路径都要。
 * harness 在进程内跑 CLI，PATH 上只有一个只认 code-size 的桩；这里把 process.argv[1] 指向一份叫 tenon.mjs 的
 * 假入口，测试命令里的 `tenon` 必须解析到它，而不是桩。
 */
import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { freshHarness, rm, type Harness } from './integration-harness.js'

const USER = { TENON_USER: 'a@x.io', TENON_USER_NAME: 'A' }

const WORKFLOW = `name: onpath
tracks:
  backend:
    steps:
      - id: build
        label: 实现
        gate: null
        skills: []
        inputs: []
        outputs: []
        tests:
          - id: probe
            direction: unit
            command: test "$(tenon whoami)" = fixture-tenon
            label: 探针
            timeout_s: 60
        guards: []
        transitions:
          - event: build-done
            to: done
      - id: done
        label: 完成
        gate: null
        skills: []
        inputs: []
        outputs: []
        guards: []
        transitions: []
`

describe('tenon test run × PATH 上的 tenon', () => {
  let h: Harness
  let originalEntry: string | undefined
  let entryDir: string | undefined
  afterEach(async () => {
    if (originalEntry !== undefined) process.argv[1] = originalEntry
    if (h) await rm(h.cwd, { recursive: true, force: true })
    if (entryDir !== undefined) await rm(entryDir, { recursive: true, force: true })
  })

  async function seed(): Promise<void> {
    h = await freshHarness()
    await mkdir(join(h.cwd, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(h.cwd, '.pipeline', 'workflows', 'onpath.yaml'), WORKFLOW, 'utf8')
    expect(await h.run(['init', 'demo', '--track', 'backend', '--workflow', 'onpath', '--preset', 'full'], { env: USER }), h.err.join('\n')).toBe(0)
    // 假入口不能放在夹具项目里（会改变工作区候选指纹）。
    entryDir = await mkdtemp(join(tmpdir(), 'tenon-entry-'))
    const entry = join(entryDir, 'tenon.mjs')
    await writeFile(entry, "console.log(process.argv[2] === 'whoami' ? 'fixture-tenon' : 'other')\n", 'utf8')
    await chmod(entry, 0o755)
    originalEntry = process.argv[1]
    process.argv[1] = entry
  }

  test('内联步骤测试：命令里的 tenon 解析到正在跑的入口', async () => {
    await seed()
    expect(await h.run(['test', 'run', 'demo', 'probe'], { env: USER }), `${h.out.join('\n')}\n${h.err.join('\n')}`).toBe(0)
    const dir = join(h.cwd, '.tenon', 'users', 'a-at-x.io', 'tests', 'demo')
    const record: unknown = JSON.parse(await readFile(join(dir, (await readdir(dir))[0] ?? ''), 'utf8'))
    expect(record).toMatchObject({ result: 'pass', exit_code: 0 })
  })

  test('目录套件：同一个 tenon 解析', async () => {
    await seed()
    expect(await h.run([
      'test', 'catalog', 'add', 'probe2', '--kind', 'custom', '--runner', 'custom',
      '--command', 'test "$(tenon whoami)" = fixture-tenon', '--report-format', 'exit-code',
    ], { env: USER }), h.err.join('\n')).toBe(0)
    expect(await h.run(['test', 'run', 'demo', '--suite', 'probe2', '--json'], { env: USER }), `${h.out.join('\n')}\n${h.err.join('\n')}`).toBe(0)
  })
})
