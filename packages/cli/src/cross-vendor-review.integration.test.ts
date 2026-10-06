/**
 * 跨厂商评审（v0.3 differentiation）：评审者在工作流步骤里声明 `host: codex`（Claude 写、Codex 审），
 * `tenon agent prompt` 指明该在哪个宿主上跑并给出确切命令，`tenon agent record` 记下宿主；
 * 登记的宿主不符、或候选变了，裁决都失效。真 harness + 真落盘的台账与报告；模型与另一家的 CLI 一律不跑——
 * 报告由用例直接写进 `report_path`，"另一个宿主上跑完"用 `--host codex` 声明，或用直接写台账行的方式桩出一条不符的记录。
 */
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readAgentRuns } from '@tenon/kernel'
import { afterEach, describe, expect, test } from 'vitest'
import { freshHarness, rm, type Harness } from './integration-harness.js'

const CLAUDE = { TENON_HARNESS_HOST: 'claude-code' }
const CODEX = { TENON_HARNESS_HOST: 'codex' }
const TERMINAL = {}

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

/** 评审者不在步骤里写 host，只由 agent 定义建议 codex（路由用，不判失效）。 */
const SUGGESTED_WF = WF.replace('          host: codex\n', '').replace('agent: spec-consistency', 'agent: codex-reviewer')

const CODEX_REVIEWER = `---
name: codex-reviewer
description: 建议由 Codex 审的评审者
role: reviewer
version: 1.0.0
skills: []
tools: [Read, Grep, Glob]
host: codex
---

# codex-reviewer

## 职责

只读评审。
`

interface PromptJson {
  readonly run_id: string
  readonly report_path: string
  readonly subagent_type: string | null
  readonly prompt: string
  readonly host: {
    readonly required: string
    readonly source: string
    readonly enforced: boolean
    readonly current: string | null
    readonly run_on: null | { readonly host: string; readonly command: string; readonly prompt_file: string; readonly record: string }
  }
}

interface NextJson {
  readonly pass: boolean
  readonly blockers: readonly { readonly kind: string; readonly agent?: string; readonly required?: string; readonly recorded?: string | null }[]
  readonly agents: readonly {
    readonly agent: string
    readonly state: string
    readonly result: string | null
    readonly reruns: number
    readonly required_host: string | null
    readonly host: string | null
    readonly host_source: string | null
    readonly wrong_host: boolean
  }[]
}

interface LedgerRow {
  run_id: string
  agent: string
  status: string
  candidate: string
  host?: string
  host_source?: string
  [key: string]: unknown
}

describe('跨厂商评审', () => {
  let h: Harness
  afterEach(async () => { if (h) await rm(h.cwd, { recursive: true, force: true }) })

  async function seed(workflow = WF, extra: Record<string, string> = {}): Promise<void> {
    h = await freshHarness()
    await mkdir(join(h.cwd, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(h.cwd, '.pipeline', 'workflows', 'crossvendor.yaml'), workflow, 'utf8')
    for (const [path, text] of Object.entries(extra)) {
      await mkdir(join(h.cwd, path, '..'), { recursive: true })
      await writeFile(join(h.cwd, path), text, 'utf8')
    }
    expect(await h.run(['init', 'demo', '--track', 'backend', '--workflow', 'crossvendor', '--preset', 'full'], { env: TERMINAL }), h.err.join('\n')).toBe(0)
  }

  async function prompt(agent: string, env: Record<string, string>, args: string[] = []): Promise<PromptJson> {
    expect(await h.run(['agent', 'prompt', 'demo', agent, '--json', ...args], { env }), h.err.join('\n')).toBe(0)
    return JSON.parse(h.out.join('')) as PromptJson
  }

  async function report(started: PromptJson, findings: readonly object[] = []): Promise<void> {
    await writeFile(join(h.cwd, started.report_path), `# r\n\n\`\`\`tenon-result\n${JSON.stringify({ findings })}\n\`\`\`\n`, 'utf8')
  }

  async function next(): Promise<NextJson> {
    expect(await h.run(['agent', 'next', 'demo', '--json'], { env: CLAUDE }), h.err.join('\n')).toBe(0)
    return JSON.parse(h.out.join('')) as NextJson
  }

  /** 读出来的台账：台账行叠加旁注（host / host_source / rerun_reason 在旁注里，见 kernel state/agent-run-meta.ts）。 */
  async function ledger(): Promise<LedgerRow[]> {
    return [...await readAgentRuns(join(h.cwd, 'openspec', 'changes', 'demo'))] as unknown as LedgerRow[]
  }

  /** 台账文件里的原始行：不含上一个发行版读不了的键。 */
  async function rawLedger(): Promise<Record<string, unknown>[]> {
    return (await h.readIn('demo', '.pipeline-agent-runs.jsonl')).split('\n').filter((item) => item !== '').map((line) => JSON.parse(line) as Record<string, unknown>)
  }

  const view = async (agent: string): Promise<NextJson['agents'][number]> =>
    (await next()).agents.find((item) => item.agent === agent) as NextJson['agents'][number]

  /** 绕开命令直接写一行台账（"在 Claude 上跑完的评审被登记成 claude"这种命令本来就不会产生的记录）。 */
  async function forgeFinished(started: PromptJson, host: string | undefined): Promise<void> {
    const running = (await ledger()).find((row) => row.run_id === started.run_id) as LedgerRow
    const row = {
      ...running, status: 'finished', result: 'pass', findings: [], report_digest: 'sha256:abc', finished_at: '2026-09-30T00:00:00.000Z',
      ...(host === undefined ? {} : { host, host_source: 'detected' }),
    }
    await appendFile(join(h.cwd, 'openspec', 'changes', 'demo', '.pipeline-agent-runs.jsonl'), `${JSON.stringify(row)}\n`, 'utf8')
  }

  test('prompt 在 Claude 里：指明该在 codex 上跑，提示词写进文件，给出 codex exec 命令和带 --host 的登记命令，不记本宿主的子代理', async () => {
    await seed()
    const started = await prompt('security', CLAUDE)
    expect(started.subagent_type).toBeNull()
    expect(started.host).toMatchObject({ required: 'codex', source: 'step', enforced: true, current: 'claude' })
    const runOn = started.host.run_on
    expect(runOn).toMatchObject({
      host: 'codex',
      command: `codex exec --sandbox workspace-write - < ${runOn?.prompt_file}`,
      record: `tenon agent record demo ${started.run_id} --host codex`,
    })
    expect(runOn?.prompt_file).toBe(`openspec/changes/demo/.pipeline-agent-reports/${started.run_id}.prompt.md`)
    const file = await readFile(join(h.cwd, runOn?.prompt_file ?? ''), 'utf8')
    expect(file).toBe(started.prompt)
    expect(file).toContain(`结束：tenon agent record demo ${started.run_id} --host codex`)
    expect((await ledger()).find((row) => row.run_id === started.run_id)).not.toHaveProperty('subagent')
  })

  test('prompt 的文字输出：路由说明（运行命令与登记命令），不是提示词正文', async () => {
    await seed()
    expect(await h.run(['agent', 'prompt', 'demo', 'security'], { env: CLAUDE }), h.err.join('\n')).toBe(0)
    const text = h.out.join('\n')
    expect(text).toContain("[ROUTE] 评审者 'security' 须在 codex 上运行（工作流步骤要求，登记的宿主不符则结论无效）；当前宿主：claude")
    expect(text).toMatch(/运行：codex exec --sandbox workspace-write - < openspec\/changes\/demo\/\.pipeline-agent-reports\/\S+\.prompt\.md/)
    expect(text).toMatch(/登记.*：tenon agent record demo \S+ --host codex/)
    expect(text).not.toContain('<tenon-agent')
  })

  test('没有要求的评审者、以及已经在 codex 上：不路由，提示词正文照旧', async () => {
    await seed()
    const free = await prompt('spec-consistency', CLAUDE)
    expect(free.host).toMatchObject({ required: 'any', source: 'none', enforced: false, run_on: null })
    expect(free.prompt).not.toContain('--host')
    const there = await prompt('security', CODEX)
    expect(there.host).toMatchObject({ required: 'codex', current: 'codex', run_on: null })
    expect(there.prompt).toContain(`结束：tenon agent record demo ${there.run_id} --host codex`)
    expect(existsSync(join(h.cwd, there.report_path.replace(/\.md$/u, '.prompt.md')))).toBe(false)
  })

  test('纯终端也路由（当前宿主未知）；claude 要求时给 claude -p 命令', async () => {
    await seed(WF.replace('host: codex', 'host: claude'))
    const started = await prompt('security', TERMINAL)
    expect(started.host).toMatchObject({ required: 'claude', current: null })
    expect(started.host.run_on?.command).toBe(
      `claude -p --allowedTools "Read,Grep,Glob,Write,Bash(tenon agent record:*)" < ${started.host.run_on?.prompt_file}`,
    )
  })

  test('在 Claude 里登记要求 codex 的评审：exit 2、什么都不写，并给出该怎么办；--host codex 声明之后登记成功，宿主与来源进台账', async () => {
    await seed()
    const started = await prompt('security', CLAUDE)
    await report(started)
    expect(await h.run(['agent', 'record', 'demo', started.run_id], { env: CLAUDE })).toBe(2)
    expect(h.err.join('\n')).toContain("评审者 'security' 须在 codex 上运行，这次登记的宿主是 claude，结论无效、未登记")
    expect(h.err.join('\n')).toContain(`tenon agent record demo ${started.run_id} --host codex`)
    expect((await ledger()).find((row) => row.run_id === started.run_id)?.status).toBe('running')

    expect(await h.run(['agent', 'record', 'demo', started.run_id, '--host', 'codex'], { env: CLAUDE }), h.err.join('\n')).toBe(0)
    expect(h.out.join('\n')).toContain('host=codex (声明)')
    expect((await ledger()).find((row) => row.run_id === started.run_id)).toMatchObject({ status: 'finished', host: 'codex', host_source: 'declared' })
    // 宿主与来源在旁注里，台账行不含这两个键（上一个发行版的台账读取器是闭集）。
    expect((await rawLedger()).some((row) => 'host' in row || 'host_source' in row)).toBe(false)
    expect(JSON.parse((await h.readIn('demo', '.pipeline-agent-run-meta.jsonl')).trim().split('\n').at(-1) ?? '{}'))
      .toMatchObject({ run_id: started.run_id, host: 'codex', host_source: 'declared' })
    expect(await view('security')).toMatchObject({ state: 'done', result: 'pass', required_host: 'codex', host: 'codex', host_source: 'declared', wrong_host: false })
  })

  test('在 codex 里登记：宿主由环境判出（detected），不需要 --host', async () => {
    await seed()
    const started = await prompt('security', CODEX)
    await report(started)
    expect(await h.run(['agent', 'record', 'demo', started.run_id], { env: CODEX }), h.err.join('\n')).toBe(0)
    expect((await ledger()).find((row) => row.run_id === started.run_id)).toMatchObject({ host: 'codex', host_source: 'detected' })
  })

  test('纯终端登记要求宿主的评审：宿主未知也拒绝，提示用 --host 声明', async () => {
    await seed()
    const started = await prompt('security', TERMINAL)
    await report(started)
    expect(await h.run(['agent', 'record', 'demo', started.run_id], { env: TERMINAL })).toBe(2)
    expect(h.err.join('\n')).toContain('未知（终端里请用 --host 声明）')
    expect(await h.run(['agent', 'record', 'demo', started.run_id, '--host', 'nope'], { env: TERMINAL })).toBe(1)
    expect(h.err.join('\n')).toContain("--host 'nope' 不是已知宿主")
  })

  test('没有宿主要求的评审：在 Claude 里登记，宿主照记（detected），裁决不受影响', async () => {
    await seed()
    const started = await prompt('spec-consistency', CLAUDE)
    await report(started)
    expect(await h.run(['agent', 'record', 'demo', started.run_id], { env: CLAUDE }), h.err.join('\n')).toBe(0)
    expect(await view('spec-consistency')).toMatchObject({ state: 'done', result: 'pass', required_host: null, host: 'claude', host_source: 'detected', wrong_host: false })
  })

  test('候选变化使裁决失效：codex 的评审通过之后改代码 → stale，必须再在 codex 上跑', async () => {
    await seed()
    const started = await prompt('security', CLAUDE)
    await report(started)
    expect(await h.run(['agent', 'record', 'demo', started.run_id, '--host', 'codex'], { env: CLAUDE }), h.err.join('\n')).toBe(0)
    expect((await view('security')).state).toBe('done')

    await writeFile(join(h.cwd, 'changed.txt'), '代码变了\n', 'utf8')
    const stale = await next()
    expect(stale.agents.find((item) => item.agent === 'security')).toMatchObject({ state: 'stale', host: 'codex' })
    expect(stale.blockers).toContainEqual({ kind: 'reviewer-stale', agent: 'security' })
    const again = await prompt('security', CLAUDE)
    expect(again.host.run_on?.host).toBe('codex')
    expect(again.run_id).not.toBe(started.run_id)
  })

  test('评审期间候选变了：登记被拒（exit 2），与宿主无关', async () => {
    await seed()
    const started = await prompt('security', CLAUDE)
    await report(started)
    await writeFile(join(h.cwd, 'changed.txt'), '评审期间改了代码\n', 'utf8')
    expect(await h.run(['agent', 'record', 'demo', started.run_id, '--host', 'codex'], { env: CLAUDE })).toBe(2)
    expect(h.err.join('\n')).toContain('评审期间候选已变化')
  })

  test('台账里登记的宿主不符（桩出的 claude 记录）：裁决无效、单独报 reviewer-wrong-host，不挡成过期；离开步骤被拦', async () => {
    await seed()
    const started = await prompt('security', CLAUDE)
    await forgeFinished(started, 'claude')
    const current = await next()
    expect(current.pass).toBe(false)
    expect(current.agents.find((item) => item.agent === 'security')).toMatchObject({
      state: 'stale', result: null, required_host: 'codex', host: 'claude', wrong_host: true,
    })
    expect(current.blockers).toContainEqual({ kind: 'reviewer-wrong-host', agent: 'security', required: 'codex', recorded: 'claude' })
    expect(await h.run(['agent', 'next', 'demo'], { env: CLAUDE })).toBe(0)
    expect(h.out.join('\n')).toContain('宿主不符：要求 codex，登记 claude，结论无效')
    expect(await h.run(['transition', 'demo', 'verify-pass'], { env: CLAUDE })).not.toBe(0)
    expect(h.err.join('\n')).toContain("评审者 'security' 须在 codex 上运行，登记的宿主是 claude")
  })

  test('status --json 的出边阻断：reviewer-wrong-host 带结构化的 subject（评审者）与 state（wrong-host），客户端不必解析整句', async () => {
    await seed()
    const started = await prompt('security', CLAUDE)
    await forgeFinished(started, 'claude')
    expect(await h.run(['status', 'demo', '--json'], { env: CLAUDE }), h.err.join('\n')).toBe(0)
    const status = JSON.parse(h.out.join('')) as {
      step: { exits: Array<{ event: string; blockers: Array<{ source: string; code: string; subject?: string; state?: string; message: string }> }> }
    }
    const exit = status.step.exits.find((item) => item.event === 'verify-pass')
    const blocker = exit?.blockers.find((item) => item.code === 'reviewer-wrong-host')
    expect(blocker).toMatchObject({ source: 'reviewer', code: 'reviewer-wrong-host', subject: 'security', state: 'wrong-host' })
    expect(blocker?.message).toContain("评审者 'security' 须在 codex 上运行")
    // 其余评审者阻断沿用整句，不带结构化字段。
    const missing = exit?.blockers.find((item) => item.code === 'reviewer-missing')
    expect(missing).toBeDefined()
    expect(missing).not.toHaveProperty('subject')
  })

  test('没有登记宿主的旧记录同样无效；在对的宿主上重跑不需要 --rerun-reason，也不算"翻转"', async () => {
    await seed()
    const first = await prompt('security', CLAUDE)
    await forgeFinished(first, undefined)
    expect((await view('security')).wrong_host).toBe(true)

    const second = await prompt('security', CLAUDE)
    expect(second.run_id).not.toBe(first.run_id)
    await report(second)
    expect(await h.run(['agent', 'record', 'demo', second.run_id, '--host', 'codex'], { env: CLAUDE }), h.err.join('\n')).toBe(0)
    expect(await view('security')).toMatchObject({ state: 'done', result: 'pass', wrong_host: false, reruns: 0, host: 'codex' })
  })

  test('有效的 codex 评审已存在时，再开一次仍要写重跑原因（无效记录不算，有效的算）', async () => {
    await seed()
    const first = await prompt('security', CLAUDE)
    await report(first)
    expect(await h.run(['agent', 'record', 'demo', first.run_id, '--host', 'codex'], { env: CLAUDE }), h.err.join('\n')).toBe(0)
    expect(await h.run(['agent', 'prompt', 'demo', 'security', '--json'], { env: CLAUDE })).toBe(2)
    expect(h.err.join('\n')).toContain('不能靠重跑换结论')
  })

  test('agent 定义建议 codex、步骤没写：只路由，不判失效（在 Claude 里登记也有效）', async () => {
    await seed(SUGGESTED_WF, { '.tenon/agents/codex-reviewer.md': CODEX_REVIEWER })
    const started = await prompt('codex-reviewer', CLAUDE)
    expect(started.host).toMatchObject({ required: 'codex', source: 'agent', enforced: false, current: 'claude' })
    expect(started.host.run_on?.command).toContain('codex exec')
    await report(started)
    expect(await h.run(['agent', 'record', 'demo', started.run_id], { env: CLAUDE }), h.err.join('\n')).toBe(0)
    expect(await view('codex-reviewer')).toMatchObject({ state: 'done', result: 'pass', required_host: null, host: 'claude', wrong_host: false })
  })

  test('步骤写 host: any 盖过 agent 定义的建议：不路由', async () => {
    await seed(SUGGESTED_WF.replace('agent: codex-reviewer\n', 'agent: codex-reviewer\n          host: any\n'), { '.tenon/agents/codex-reviewer.md': CODEX_REVIEWER })
    const started = await prompt('codex-reviewer', CLAUDE)
    expect(started.host).toMatchObject({ required: 'any', source: 'step', enforced: false, run_on: null })
  })

  test('status --json：评审者带 required_host / route_host / wrong_host', async () => {
    await seed()
    expect(await h.run(['status', 'demo', '--json'], { env: CLAUDE }), h.err.join('\n')).toBe(0)
    const status = JSON.parse(h.out.join('')) as {
      step: { reviewers: Array<{ agent: string; required_host: string | null; route_host: string | null; wrong_host: boolean }> }
    }
    expect(status.step.reviewers.find((item) => item.agent === 'security')).toMatchObject({ required_host: 'codex', route_host: 'codex', wrong_host: false })
    expect(status.step.reviewers.find((item) => item.agent === 'spec-consistency')).toMatchObject({ required_host: null, route_host: null })
  })

  test('工作流里 host 写错值：立项就拒绝', async () => {
    h = await freshHarness()
    await mkdir(join(h.cwd, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(h.cwd, '.pipeline', 'workflows', 'crossvendor.yaml'), WF.replace('host: codex', 'host: gemini'), 'utf8')
    expect(await h.run(['init', 'demo', '--track', 'backend', '--workflow', 'crossvendor', '--preset', 'full'], { env: TERMINAL })).not.toBe(0)
    expect(h.err.join('\n')).toContain('host')
  })
})
