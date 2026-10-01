/**
 * 跨厂商评审（host）与按风险挂载（attach_on）同时作用在评审者路径上：先按 attach_on 排除没挂载的评审者
 * （不投影、不排波、不阻断、`agent prompt` 拒绝），再对挂载的评审者判宿主。
 *
 * 真临时项目 + 真仓库 + 真冻结 agent；官方 `security` 声明 `attach_on: [auth, dependency, contract]`，
 * 这里的工作流又要求它在 codex 上跑。"在 Claude 上跑完的评审"用直接写台账行的方式桩出（命令本来不会产生这种记录）。
 */
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { freshHarness, rm, type Harness } from './integration-harness.js'
import { commitAll, initGit, writeFiles } from './integration-harness-tests.js'

const ENV = { TENON_USER: 'a@x.io', TENON_USER_NAME: 'A', TENON_TEST_REAL_DIFF: '1', TENON_TEST_TICKING_CLOCK: '1', TENON_HARNESS_HOST: 'claude-code' }
const CHANGE = 'demo'

const WF = `name: crossvendor
steps:
  - id: verify
    label: 验证
    gate: null
    skills: []
    inputs: []
    outputs: []
    agents:
      reviewers:
        - agent: security
          required: true
          block_at: medium
          host: codex
        - agent: spec-consistency
          required: true
          block_at: medium
    guards: []
    transitions:
      - event: verify-pass
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

interface NextJson {
  readonly pass: boolean
  readonly wave: readonly string[]
  readonly blockers: readonly { readonly kind: string; readonly agent?: string; readonly required?: string; readonly recorded?: string | null }[]
  readonly agents: readonly { readonly agent: string; readonly state: string; readonly required_host: string | null; readonly wrong_host: boolean }[]
}

interface PromptJson { readonly run_id: string }

describe('评审者的 attach_on 与 host 组合', () => {
  let h: Harness | undefined
  afterEach(async () => { if (h) await rm(h.cwd, { recursive: true, force: true }); h = undefined })

  async function project(): Promise<Harness> {
    const harness = await freshHarness()
    h = harness
    await writeFiles(harness.cwd, {
      'package.json': '{ "name": "scoped", "private": true, "type": "module" }\n',
      'src/add.js': 'export const add = (a, b) => a + b\n',
    })
    await mkdir(join(harness.cwd, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(harness.cwd, '.pipeline', 'workflows', 'crossvendor.yaml'), WF, 'utf8')
    initGit(harness.cwd)
    commitAll(harness.cwd, 'base', '2026-01-01T00:00:00Z')
    expect(await harness.run(['init', CHANGE, '--track', 'backend', '--workflow', 'crossvendor', '--preset', 'full'], { env: ENV }), harness.err.join('\n')).toBe(0)
    return harness
  }

  async function next(harness: Harness): Promise<NextJson> {
    expect(await harness.run(['agent', 'next', CHANGE, '--json'], { env: ENV }), harness.err.join('\n')).toBe(0)
    return JSON.parse(harness.out.join('\n')) as NextJson
  }

  async function forgeClaudeVerdict(harness: Harness): Promise<void> {
    expect(await harness.run(['agent', 'prompt', CHANGE, 'security', '--json'], { env: ENV }), harness.err.join('\n')).toBe(0)
    const started = JSON.parse(harness.out.join('\n')) as PromptJson
    const ledger = await harness.readIn(CHANGE, '.pipeline-agent-runs.jsonl')
    const running = ledger.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((row) => row.run_id === started.run_id)
    const finished = {
      ...running, status: 'finished', result: 'pass', findings: [], report_digest: 'sha256:abc',
      finished_at: '2026-09-30T00:00:00.000Z', host: 'claude', host_source: 'detected',
    }
    await appendFile(join(harness.cwd, 'openspec', 'changes', CHANGE, '.pipeline-agent-runs.jsonl'), `${JSON.stringify(finished)}\n`, 'utf8')
  }

  test('改动没碰到鉴权：要求宿主的 security 直接缺席（不在 next、不在 status、不阻断），prompt 被拒，其余评审者照常', async () => {
    const harness = await project()
    await writeFiles(harness.cwd, { 'src/add.js': 'export const add = (a, b) => a + b + 0\n' })
    const current = await next(harness)
    expect(current.agents.map((agent) => agent.agent)).toEqual(['spec-consistency'])
    expect(current.wave).toEqual(['spec-consistency'])
    expect(current.blockers).toEqual([{ kind: 'reviewer-missing', agent: 'spec-consistency' }])

    expect(await harness.run(['status', CHANGE, '--json'], { env: ENV }), harness.err.join('\n')).toBe(0)
    const step = JSON.parse(harness.out.join('\n')).step as { reviewers: { agent: string }[] }
    expect(step.reviewers.map((reviewer) => reviewer.agent)).toEqual(['spec-consistency'])

    expect(await harness.run(['agent', 'prompt', CHANGE, 'security', '--json'], { env: ENV })).toBe(2)
    expect(harness.err.join('\n')).toContain('只在 auth/dependency/contract 路径变化时挂载')
  })

  test('改动碰到鉴权：security 挂载，登记的宿主不是 codex → 该评审者 stale、单独报 reviewer-wrong-host', async () => {
    const harness = await project()
    await writeFiles(harness.cwd, { 'src/auth/login.js': 'export const login = () => true\n' })
    await forgeClaudeVerdict(harness)
    const current = await next(harness)
    expect(current.agents.find((agent) => agent.agent === 'security')).toMatchObject({ state: 'stale', required_host: 'codex', wrong_host: true })
    expect(current.blockers).toContainEqual({ kind: 'reviewer-wrong-host', agent: 'security', required: 'codex', recorded: 'claude' })
  })

  test('宿主不符的记录先在台账里，随后改动不再碰鉴权：security 变成缺席，不再有宿主阻断', async () => {
    const harness = await project()
    await writeFiles(harness.cwd, { 'src/auth/login.js': 'export const login = () => true\n' })
    await forgeClaudeVerdict(harness)
    expect((await next(harness)).blockers.map((blocker) => blocker.kind)).toContain('reviewer-wrong-host')

    await rm(join(harness.cwd, 'src', 'auth'), { recursive: true, force: true })
    const after = await next(harness)
    expect(after.agents.map((agent) => agent.agent)).toEqual(['spec-consistency'])
    expect(after.blockers.map((blocker) => blocker.kind)).not.toContain('reviewer-wrong-host')
    expect(after.blockers).toEqual([{ kind: 'reviewer-missing', agent: 'spec-consistency' }])
  })
})
