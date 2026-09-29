/**
 * 真实 e2e —— 宿主原生 agent 文件：任务冻结 agent 时为当前宿主生成 `tenon-<name>`，prompt 下发专属
 * 子代理类型并记进运行记录，任务完结时回收，卸载只删 Tenon 生成的文件。两种宿主各一遍，全在临时目录。
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { freshHarness, rm, type Harness } from './integration-harness.js'

const CLAUDE = { TENON_HARNESS_HOST: 'claude-code' }
const CODEX = { TENON_HARNESS_HOST: 'codex' }

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
      reviewers:
        - agent: code-size
          required: true
          block_at: medium
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

interface PromptJson {
  readonly run_id: string
  readonly role: string
  readonly report_path: string
  readonly subagent_type: string | null
  readonly native: boolean
}

describe('真实 e2e —— 宿主原生 agent 文件', () => {
  let h: Harness
  afterEach(async () => { if (h) await rm(h.cwd, { recursive: true, force: true }) })

  const exists = (rel: string): boolean => existsSync(join(h.cwd, rel))
  const owned = async (): Promise<Record<string, string>> =>
    JSON.parse(await readFile(join(h.cwd, '.pipeline-owned.json'), 'utf8')) as Record<string, string>

  async function seed(name = 'demo', env: Record<string, string> = CLAUDE): Promise<void> {
    await mkdir(join(h.cwd, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(h.cwd, '.pipeline', 'workflows', 'hosted.yaml'), WF, 'utf8')
    expect(await h.run(['init', name, '--track', 'backend', '--workflow', 'hosted', '--preset', 'full'], { env }), h.err.join('\n')).toBe(0)
  }

  async function prompt(agent: string, args: string[] = [], env: Record<string, string> = CLAUDE, change = 'demo'): Promise<PromptJson> {
    expect(await h.run(['agent', 'prompt', change, agent, '--json', ...args], { env }), h.err.join('\n')).toBe(0)
    return JSON.parse(h.out.join('')) as PromptJson
  }

  async function finish(started: PromptJson, args: string[] = [], change = 'demo'): Promise<void> {
    const body = started.role === 'executor' ? '{"result":"done","findings":[]}' : '{"findings":[]}'
    await writeFile(join(h.cwd, started.report_path), `# r\n\n\`\`\`tenon-result\n${body}\n\`\`\`\n`, 'utf8')
    expect(await h.run(['agent', 'record', change, started.run_id, ...args]), h.err.join('\n')).toBe(0)
  }

  async function runs(change = 'demo'): Promise<readonly { agent: string; status: string; subagent?: unknown }[]> {
    const text = await h.readIn(change, '.pipeline-agent-runs.jsonl')
    const latest = new Map<string, { agent: string; status: string; subagent?: unknown; run_id: string }>()
    for (const line of text.split('\n').filter((item) => item !== '')) {
      const row = JSON.parse(line) as { agent: string; status: string; subagent?: unknown; run_id: string }
      latest.set(row.run_id, row)
    }
    return [...latest.values()]
  }

  test('Claude Code 里立项：冻结的 agent 都生成 .claude/agents/tenon-<name>.md 并记进所有权清单', async () => {
    h = await freshHarness()
    await seed()
    const builder = await readFile(join(h.cwd, '.claude', 'agents', 'tenon-builder.md'), 'utf8')
    expect(builder).toContain('name: tenon-builder')
    expect(builder).toContain('tools: Read, Write, Edit, Bash, Grep, Glob, Skill')
    expect(await readFile(join(h.cwd, '.claude', 'agents', 'tenon-code-size.md'), 'utf8')).toContain('tools: Read, Grep, Glob')
    expect(Object.keys(await owned()).sort()).toEqual(['.claude/agents/tenon-builder.md', '.claude/agents/tenon-code-size.md'])
    expect(exists('.codex/agents')).toBe(false)
  })

  test('终端里立项不生成；prompt --host claude 当场生成并下发专属子代理，记录里可见', async () => {
    h = await freshHarness()
    await seed('demo', {})
    expect(exists('.claude/agents')).toBe(false)
    const started = await prompt('builder', ['--host', 'claude'], {})
    expect(started).toMatchObject({ subagent_type: 'tenon-builder', native: true })
    expect(exists('.claude/agents/tenon-code-size.md')).toBe(true)
    await finish(started)
    expect(h.out.join('\n')).toContain('subagent=tenon-builder')
    expect((await runs()).find((row) => row.agent === 'builder')?.subagent).toEqual({ host: 'claude', type: 'tenon-builder', native: true })
  })

  test('Codex：生成 .codex/agents/tenon-<name>.toml；code-size 只读沙箱；Claude 别名型号省略', async () => {
    h = await freshHarness()
    await seed('demo', CODEX)
    const toml = await readFile(join(h.cwd, '.codex', 'agents', 'tenon-code-size.toml'), 'utf8')
    expect(toml).toContain('name = "tenon-code-size"')
    expect(toml).toContain('sandbox_mode = "read-only"')
    expect(toml).not.toContain('model =')
    const started = await prompt('builder', [], CODEX)
    expect(started).toMatchObject({ subagent_type: 'tenon-builder', native: true })
  })

  test('生成不了（同名文件不是 Tenon 的）→ 退回通用子代理并在记录里标明；record --subagent 记实际用的', async () => {
    h = await freshHarness()
    await mkdir(join(h.cwd, '.claude', 'agents'), { recursive: true })
    await writeFile(join(h.cwd, '.claude', 'agents', 'tenon-builder.md'), '用户自己的\n', 'utf8')
    await seed()
    expect(h.err.join('\n')).toContain('未生成')
    expect(await readFile(join(h.cwd, '.claude', 'agents', 'tenon-builder.md'), 'utf8')).toBe('用户自己的\n')
    const builder = await prompt('builder')
    expect(builder).toMatchObject({ subagent_type: 'general-purpose', native: false })
    await finish(builder)
    expect((await runs()).find((row) => row.agent === 'builder')?.subagent).toEqual({ host: 'claude', type: 'general-purpose', native: false })

    const reviewer = await prompt('code-size')
    expect(reviewer).toMatchObject({ subagent_type: 'tenon-code-size', native: true })
    await finish(reviewer, ['--subagent', 'general-purpose'])
    expect((await runs()).find((row) => row.agent === 'code-size')?.subagent).toEqual({ host: 'claude', type: 'general-purpose', native: false })
  })

  test('完结时回收：只删没有在途任务引用的 tenon- 文件；另一个在途任务用的保留', async () => {
    h = await freshHarness()
    await seed('demo')
    await seed('other')
    await h.satisfyStepAgents('demo')
    expect(await h.run(['transition', 'demo', 'build-done'], { env: CLAUDE }), h.err.join('\n')).toBe(0)
    expect(await h.run(['transition', 'demo', 'archived'], { env: CLAUDE }), h.err.join('\n')).toBe(0)
    expect(exists('.claude/agents/tenon-builder.md')).toBe(true)

    await h.satisfyStepAgents('other')
    expect(await h.run(['transition', 'other', 'build-done'], { env: CLAUDE }), h.err.join('\n')).toBe(0)
    expect(await h.run(['transition', 'other', 'archived'], { env: CLAUDE }), h.err.join('\n')).toBe(0)
    expect(h.err.join('\n')).toContain('已回收宿主 agent 文件')
    expect(exists('.claude/agents/tenon-builder.md')).toBe(false)
    expect(exists('.claude/agents/tenon-code-size.md')).toBe(false)
    expect(exists('.pipeline-owned.json')).toBe(false)
  })

  test('卸载只删 Tenon 生成且没改过的宿主文件；用户的 agent 与改过的文件保留', async () => {
    h = await freshHarness()
    await mkdir(join(h.cwd, '.claude', 'agents'), { recursive: true })
    await writeFile(join(h.cwd, '.claude', 'agents', 'mine.md'), '用户\n', 'utf8')
    await seed()
    await writeFile(join(h.cwd, '.claude', 'agents', 'tenon-code-size.md'), '改过\n', 'utf8')
    expect(await h.run(['uninstall', '--yes']), h.err.join('\n')).toBe(0)
    expect(exists('.claude/agents/tenon-builder.md')).toBe(false)
    expect(await readFile(join(h.cwd, '.claude', 'agents', 'tenon-code-size.md'), 'utf8')).toBe('改过\n')
    expect(await readFile(join(h.cwd, '.claude', 'agents', 'mine.md'), 'utf8')).toBe('用户\n')
  })
})
