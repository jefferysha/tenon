/**
 * 任务 delete / archive 也清理升级前的版本留在项目里的宿主子代理文件（此前只有 transition 到完结才回收，删掉或归档任务后
 * `.claude/agents/tenon-*.md` 与 `.pipeline-owned.json` 一直留着）。现在文件不再是任务产物：清理不按「另一个在途任务还引用」区分。
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { computeContentHash, effectiveAgent, hostAgentPath, renderHostAgent } from '@tenon/kernel'
import { freshHarness, rm, type Harness } from './integration-harness.js'
import { builtinAgentLibrary } from './test-support.js'

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

describe('任务 delete / archive 清理旧版本留下的宿主 agent 文件', () => {
  let h: Harness
  afterEach(async () => { if (h) await rm(h.cwd, { recursive: true, force: true }) })

  const exists = (rel: string): boolean => existsSync(join(h.cwd, rel))

  async function task(name: string, flow: string, agent: string): Promise<void> {
    await mkdir(join(h.cwd, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(h.cwd, '.pipeline', 'workflows', `${flow}.yaml`), workflow(`        - agent: ${agent}`).replace('name: hosted', `name: ${flow}`), 'utf8')
    expect(await h.run(['init', name, '--track', 'backend', '--workflow', flow, '--preset', 'full'], { env: CLAUDE }), h.err.join('\n')).toBe(0)
  }

  /** 旧版本写的项目级文件：内容是当前库的渲染结果，并记进所有权清单。 */
  async function legacy(agent: string): Promise<string> {
    const definition = effectiveAgent(builtinAgentLibrary(), agent)?.definition
    if (definition === undefined) throw new Error(`内建库里没有 ${agent}`)
    const rendered = renderHostAgent('claude', definition)
    const rel = hostAgentPath('claude', agent)
    await mkdir(dirname(join(h.cwd, rel)), { recursive: true })
    await writeFile(join(h.cwd, rel), rendered, 'utf8')
    const manifest = join(h.cwd, '.pipeline-owned.json')
    const current = exists('.pipeline-owned.json') ? JSON.parse(await readFile(manifest, 'utf8')) as Record<string, string> : {}
    await writeFile(manifest, `${JSON.stringify({ ...current, [rel]: computeContentHash(rendered) }, null, 2)}\n`, 'utf8')
    return rel
  }

  test('立项本身不在项目里生成宿主文件', async () => {
    h = await freshHarness()
    await task('demo', 'hosted', 'builder')
    expect(exists('.claude')).toBe(false)
    expect(exists('.pipeline-owned.json')).toBe(false)
  })

  test('archive：旧文件、清单与空的 .claude 目录一并消失', async () => {
    h = await freshHarness()
    await task('demo', 'hosted', 'builder')
    const file = await legacy('builder')
    expect(await h.run(['task', 'archive', 'demo', '--yes'], { env: CLAUDE }), h.err.join('\n')).toBe(0)
    expect(exists(file)).toBe(false)
    expect(exists('.pipeline-owned.json')).toBe(false)
    expect(exists('.claude')).toBe(false)
    expect(h.err.join('\n')).toContain('已清理旧版本写进项目的宿主 agent 文件')
  })

  test('delete：同样清理，另一个在途任务还引用这个 agent 也照删', async () => {
    h = await freshHarness()
    await task('keep', 'keepflow', 'researcher')
    await task('gone', 'goneflow', 'builder')
    const builder = await legacy('builder')
    const researcher = await legacy('researcher')
    expect(await h.run(['task', 'delete', 'gone', '--yes'], { env: CLAUDE }), h.err.join('\n')).toBe(0)
    expect(exists(builder)).toBe(false)
    expect(exists(researcher)).toBe(false)
    expect(h.err.join('\n')).toContain('已清理旧版本写进项目的宿主 agent 文件')
  })
})
