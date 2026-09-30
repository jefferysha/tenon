/**
 * 任务 delete / archive 也回收为它生成的宿主子代理文件（产品评估 P2：此前只有 transition 到完结才回收，
 * 删掉或归档任务后 `.claude/agents/tenon-*.md` 与 `.pipeline-owned.json` 一直留着）。另一个在途任务还用的保留。
 */
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { freshHarness, rm, type Harness } from './integration-harness.js'

const CLAUDE = { TENON_HARNESS_HOST: 'claude-code', TENON_USER: 'a@x.io', TENON_USER_NAME: 'A' }

const workflow = (agents: string): string => `name: hosted
steps:
  - id: build
    label: 实现
    gate: null
    skills: []
    inputs: []
    outputs: []
    agents:
      executors:
${agents}
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

describe('任务 delete / archive 回收宿主 agent 文件', () => {
  let h: Harness
  afterEach(async () => { if (h) await rm(h.cwd, { recursive: true, force: true }) })

  const exists = (rel: string): boolean => existsSync(join(h.cwd, rel))

  async function task(name: string, flow: string, agent: string): Promise<void> {
    await mkdir(join(h.cwd, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(h.cwd, '.pipeline', 'workflows', `${flow}.yaml`), workflow(`        - agent: ${agent}`).replace('name: hosted', `name: ${flow}`), 'utf8')
    expect(await h.run(['init', name, '--track', 'backend', '--workflow', flow, '--preset', 'full'], { env: CLAUDE }), h.err.join('\n')).toBe(0)
  }

  test('archive：没有别的在途任务用的文件、清单与空的 .claude 目录一并消失', async () => {
    h = await freshHarness()
    await task('demo', 'hosted', 'builder')
    expect(exists('.claude/agents/tenon-builder.md')).toBe(true)
    expect(await h.run(['task', 'archive', 'demo', '--yes'], { env: CLAUDE }), h.err.join('\n')).toBe(0)
    expect(exists('.claude/agents/tenon-builder.md')).toBe(false)
    expect(exists('.pipeline-owned.json')).toBe(false)
    expect(exists('.claude')).toBe(false)
  })

  test('delete：同样回收；另一个在途任务还在用的 agent 文件保留', async () => {
    h = await freshHarness()
    await task('keep', 'keepflow', 'researcher')
    await task('gone', 'goneflow', 'builder')
    expect(exists('.claude/agents/tenon-builder.md')).toBe(true)
    expect(exists('.claude/agents/tenon-researcher.md')).toBe(true)
    expect(await h.run(['task', 'delete', 'gone', '--yes'], { env: CLAUDE }), h.err.join('\n')).toBe(0)
    expect(exists('.claude/agents/tenon-builder.md')).toBe(false)
    expect(exists('.claude/agents/tenon-researcher.md')).toBe(true)
    expect(h.err.join('\n')).toContain('已回收宿主 agent 文件')
  })
})
