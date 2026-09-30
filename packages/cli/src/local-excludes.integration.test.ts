/**
 * 任务期间生成的宿主子代理文件和测试输出目录，在 `git status` 里不显示为未跟踪（真机验收 F14 / 产品评估 P2）；
 * 归档回收后 Tenon 自己建出来的空 `.claude/` 目录也不留下。真临时项目、真 git、真 CLI，零 mock。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { freshHarness, rm, type Harness } from './integration-harness.js'

const CLAUDE = { TENON_HARNESS_HOST: 'claude-code', TENON_USER: 'a@x.io', TENON_USER_NAME: 'A' }

const WF = `name: hosted
steps:
  - id: build
    label: 实现
    gate: null
    skills: []
    inputs: []
    outputs: []
    agents:
      executors:
        - agent: builder
    tests:
      - id: probe
        direction: unit
        command: "true"
        label: 探针
        timeout_s: 60
    guards: []
    transitions:
      - event: build-done
        to: done
  - id: done
    label: 完结
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions: []
`

describe('本机生成物的忽略与清理', () => {
  let h: Harness
  afterEach(async () => { if (h) await rm(h.cwd, { recursive: true, force: true }) })

  function untracked(): string[] {
    const result = spawnSync('git', ['status', '--porcelain', '-uall'], { cwd: h.cwd, encoding: 'utf8' })
    return result.stdout.split('\n').filter((line) => line !== '').map((line) => line.slice(3))
  }

  test('生成 tenon-<name> 与跑测试之后：子代理文件、test-results 不在未跟踪列表里', async () => {
    h = await freshHarness()
    expect(spawnSync('git', ['init', '-q'], { cwd: h.cwd }).status).toBe(0)
    await mkdir(join(h.cwd, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(h.cwd, '.pipeline', 'workflows', 'hosted.yaml'), WF, 'utf8')
    expect(await h.run(['init', 'demo', '--track', 'backend', '--workflow', 'hosted', '--preset', 'full'], { env: CLAUDE }), h.err.join('\n')).toBe(0)
    expect(existsSync(join(h.cwd, '.claude', 'agents', 'tenon-builder.md'))).toBe(true)
    await mkdir(join(h.cwd, 'test-results'), { recursive: true })
    await writeFile(join(h.cwd, 'test-results', 'unit.xml'), '<x/>', 'utf8')
    expect(await h.run(['test', 'run', 'demo', 'probe'], { env: CLAUDE }), `${h.out.join('\n')}\n${h.err.join('\n')}`).toBe(0)

    const listed = untracked()
    expect(listed.filter((path) => path.startsWith('.claude/agents/tenon-'))).toEqual([])
    expect(listed.filter((path) => path.startsWith('test-results/'))).toEqual([])
  })
})
