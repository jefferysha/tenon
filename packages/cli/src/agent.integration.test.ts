/**
 * 真实 e2e —— 步骤 agent：真 harness + 真临时项目 + 真落盘的冻结、台账与报告。
 * 模型一律不跑：报告由用例直接写进 `report_path`，`record` 只读它。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { freshHarness, rm, type Harness } from './integration-harness.js'

const USER_A = { TENON_USER: 'a@x.io', TENON_USER_NAME: 'A' }
const USER_B = { TENON_USER: 'b@x.io', TENON_USER_NAME: 'B' }

/**
 * build 步骤：两个并行执行者；verify 步骤：两个并行必需评审者 + 一个依赖它们的参考评审者。
 * agent 名取内建库里的现成 agent，避免用例自己造库。
 */
const AGENT_WF = `name: reviewed
tracks:
  backend:
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
            - agent: researcher
        guards: []
        transitions:
          - event: build-done
            to: verify
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
            - agent: spec-consistency
              required: true
              block_at: medium
            - agent: architecture
              required: false
              block_at: high
              depends_on: [security, spec-consistency]
        guards: []
        transitions:
          - event: verify-pass
            to: done
          - event: verify-fail
            to: build
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
  readonly step: string
  readonly candidate: string
  readonly wave: readonly string[]
  readonly pass: boolean
  readonly blockers: readonly { readonly kind: string; readonly agent?: string }[]
  readonly agents: readonly {
    readonly agent: string
    readonly role: string
    readonly state: string
    readonly result: string | null
    readonly findings: number
    readonly waiting_for: readonly string[]
  }[]
}

describe('真实 e2e —— 步骤 agent', () => {
  let h: Harness
  afterEach(async () => { if (h) await rm(h.cwd, { recursive: true, force: true }) })

  async function seed(workflow = AGENT_WF): Promise<void> {
    h = await freshHarness()
    await mkdir(join(h.cwd, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(h.cwd, '.pipeline', 'workflows', 'reviewed.yaml'), workflow, 'utf8')
    expect(await h.run(
      ['init', 'demo', '--track', 'backend', '--workflow', 'reviewed', '--preset', 'full'],
      { env: USER_A },
    ), h.err.join('\n')).toBe(0)
  }

  async function next(env = USER_A): Promise<NextJson> {
    expect(await h.run(['agent', 'next', 'demo', '--json'], { env }), h.err.join('\n')).toBe(0)
    return JSON.parse(h.out.join('')) as NextJson
  }

  /** 开始一个 agent，写报告，登记。`findings` 空 = 通过。 */
  async function runAgent(
    agent: string,
    findings: readonly { severity: string; location: string; message: string }[] = [],
    options: { readonly result?: 'done' | 'failed'; readonly env?: Record<string, string> } = {},
  ): Promise<number> {
    const env = options.env ?? USER_A
    const started = await h.run(['agent', 'prompt', 'demo', agent, '--json'], { env })
    if (started !== 0) return started
    const payload = JSON.parse(h.out.join('')) as { run_id: string; report_path: string }
    const body = options.result === undefined
      ? { findings }
      : { result: options.result, findings }
    await writeFile(
      join(h.cwd, payload.report_path),
      `# ${agent}\n\n说明\n\n\`\`\`tenon-result\n${JSON.stringify(body)}\n\`\`\`\n`,
      'utf8',
    )
    return h.run(['agent', 'record', 'demo', payload.run_id], { env })
  }

  test('冻结：引用到的 agent 随 Change 落盘，锁绑定 run 与工作流指纹', async () => {
    await seed()
    const lock = JSON.parse(await h.readIn('demo', '.pipeline-frozen/lock.json'))
    expect(lock.agents.map((entry: { name: string }) => entry.name))
      .toEqual(['architecture', 'builder', 'researcher', 'security', 'spec-consistency'])
    expect(lock.workflow_fingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  test('next：执行者第 0 波并行，评审者列出在等哪些执行者', async () => {
    await seed()
    const view = await next()
    expect(view.step).toBe('build')
    expect(view.wave).toEqual(['builder', 'researcher'])
    expect(view.agents.map((item) => `${item.agent}:${item.state}`)).toEqual(['builder:idle', 'researcher:idle'])
    expect(view.pass).toBe(false)
    expect(view.blockers.map((item) => item.kind)).toEqual(['executor-missing', 'executor-missing'])
  })

  test('prompt：两次同一 agent 复用同一个 run_id，交接内容含冻结正文与结束命令', async () => {
    await seed()
    expect(await h.run(['agent', 'prompt', 'demo', 'builder', '--json'], { env: USER_A })).toBe(0)
    const first = JSON.parse(h.out.join('')) as { run_id: string; prompt: string; skills: string[] }
    expect(first.skills).toEqual(['test-driven-development'])
    expect(first.prompt).toContain('<tenon-agent change="demo" step="build" role="executor"')
    expect(first.prompt).toContain('TDD')
    expect(first.prompt).toContain(`结束：tenon agent record demo ${first.run_id}`)
    expect(await h.run(['agent', 'prompt', 'demo', 'builder', '--json'], { env: USER_A })).toBe(0)
    expect((JSON.parse(h.out.join('')) as { run_id: string }).run_id).toBe(first.run_id)
  })

  test('prompt 拒绝：未声明的 agent、未轮到的评审者、不支持的宿主', async () => {
    await seed()
    expect(await h.run(['agent', 'prompt', 'demo', 'e2e'], { env: USER_A })).toBe(2)
    expect(h.err.join('\n')).toContain("agent 'e2e' 未在步骤 'build' 声明")
    // builder 没声明 hosts（缺省适用每个宿主），所以 --host 任意值都放行。
    expect(await h.run(['agent', 'prompt', 'demo', 'builder', '--host', 'nope'], { env: USER_A })).toBe(0)
    expect(await h.run(['agent', 'prompt', 'demo', 'security'], { env: USER_A })).toBe(2)
    expect(h.err.join('\n')).toContain("agent 'security' 未在步骤 'build' 声明")
  })

  test('执行者：done 之后 build 步骤放行；failed 仍被拦', async () => {
    await seed()
    expect(await runAgent('builder', [], { result: 'failed' }), h.err.join('\n')).toBe(0)
    let view = await next()
    expect(view.agents.find((item) => item.agent === 'builder'))
      .toMatchObject({ state: 'done', result: 'failed' })
    expect(view.blockers.map((item) => item.kind)).toEqual(['executor-failed', 'executor-missing'])
    expect(await runAgent('builder', [], { result: 'done' })).toBe(0)
    expect(await runAgent('researcher', [], { result: 'done' })).toBe(0)
    view = await next()
    expect(view.pass).toBe(true)
    expect(view.wave).toEqual([])
  })

  test('评审者：必需的报出阻断级别问题时离开步骤被拦，修完重跑放行；参考评审者不拦', async () => {
    await seed()
    expect(await runAgent('builder', [], { result: 'done' })).toBe(0)
    expect(await runAgent('researcher', [], { result: 'done' })).toBe(0)
    expect(await h.run(['transition', 'demo', 'build-done'], { env: USER_A }), h.err.join('\n')).toBe(0)
    expect((await next()).wave).toEqual(['security', 'spec-consistency'])

    expect(await runAgent('security', [{ severity: 'high', location: 'a.ts:1', message: '注入' }])).toBe(0)
    expect(await runAgent('spec-consistency')).toBe(0)
    let view = await next()
    expect(view.agents.find((item) => item.agent === 'security')).toMatchObject({ result: 'fail', findings: 1 })
    expect(view.pass).toBe(false)
    expect(view.blockers.find((item) => item.kind === 'reviewer-failed')?.agent).toBe('security')

    expect(await runAgent('security')).toBe(0)
    view = await next()
    expect(view.wave).toEqual(['architecture'])
    // 参考评审者报 critical 也不拦。
    expect(await runAgent('architecture', [{ severity: 'critical', location: 'b.ts:2', message: '环' }])).toBe(0)
    expect((await next()).pass).toBe(true)
  })

  test('候选变化：已完成的评审结论过期，进行中的登记被拒', async () => {
    await seed()
    expect(await runAgent('builder', [], { result: 'done' })).toBe(0)
    expect(await runAgent('researcher', [], { result: 'done' })).toBe(0)
    expect(await h.run(['transition', 'demo', 'build-done'], { env: USER_A })).toBe(0)
    expect(await runAgent('security')).toBe(0)
    expect(await writeFile(join(h.cwd, 'drift.ts'), 'export const drift = 1\n', 'utf8')).toBeUndefined()
    const view = await next()
    expect(view.agents.find((item) => item.agent === 'security')?.state).toBe('stale')
    expect(view.blockers.find((item) => item.kind === 'reviewer-stale')?.agent).toBe('security')
  })

  test('登记期间候选变化：exit 2，运行仍是进行中', async () => {
    await seed()
    expect(await runAgent('builder', [], { result: 'done' })).toBe(0)
    expect(await runAgent('researcher', [], { result: 'done' })).toBe(0)
    expect(await h.run(['transition', 'demo', 'build-done'], { env: USER_A })).toBe(0)
    expect(await h.run(['agent', 'prompt', 'demo', 'security', '--json'], { env: USER_A })).toBe(0)
    const payload = JSON.parse(h.out.join('')) as { run_id: string; report_path: string }
    await writeFile(join(h.cwd, 'drift.ts'), 'export const drift = 1\n', 'utf8')
    await writeFile(
      join(h.cwd, payload.report_path),
      '# security\n\n\`\`\`tenon-result\n{"findings":[]}\n\`\`\`\n',
      'utf8',
    )
    expect(await h.run(['agent', 'record', 'demo', payload.run_id], { env: USER_A })).toBe(2)
    expect(h.err.join('\n')).toContain('评审期间候选已变化')
  })

  test('报告无效与评审者自报结论都 exit 1', async () => {
    await seed()
    expect(await h.run(['agent', 'prompt', 'demo', 'builder', '--json'], { env: USER_A })).toBe(0)
    const payload = JSON.parse(h.out.join('')) as { run_id: string; report_path: string }
    expect(await h.run(['agent', 'record', 'demo', payload.run_id], { env: USER_A })).toBe(1)
    expect(h.err.join('\n')).toContain('报告无效')
    await writeFile(join(h.cwd, payload.report_path), '# 没有块\n', 'utf8')
    expect(await h.run(['agent', 'record', 'demo', payload.run_id], { env: USER_A })).toBe(1)
  })

  test('非负责人不能 prompt / record，但可以看 next', async () => {
    await seed()
    expect(await h.run(['agent', 'next', 'demo', '--json'], { env: USER_B })).toBe(0)
    expect(await h.run(['agent', 'prompt', 'demo', 'builder'], { env: USER_B })).toBe(1)
    expect(h.err.join('\n')).toMatch(/负责人|接手/u)
  })

  test('冻结之后改库不影响进行中的任务；台账每次状态变化一行', async () => {
    await seed()
    expect(await runAgent('builder', [], { result: 'done' })).toBe(0)
    const ledger = (await h.readIn('demo', '.pipeline-agent-runs.jsonl')).trim().split('\n')
    expect(ledger).toHaveLength(2)
    expect(JSON.parse(ledger[0] ?? '{}')).toMatchObject({ status: 'running', result: null })
    expect(JSON.parse(ledger[1] ?? '{}')).toMatchObject({ status: 'finished', result: 'done' })
    const frozen = await readFile(join(h.cwd, 'openspec/changes/demo/.pipeline-frozen/agents/builder.md'), 'utf8')
    expect(frozen).toContain('name: builder')
  })

  test('没有 agent 的步骤：next 报全部完成，转换不受影响', async () => {
    await seed(`name: reviewed
tracks:
  backend:
    steps:
      - id: build
        label: 实现
        gate: null
        skills: []
        inputs: []
        outputs: []
        guards: []
        transitions:
          - event: build-done
            to: build
`)
    const view = await next()
    expect(view).toMatchObject({ agents: [], wave: [], pass: true, blockers: [] })
    expect(await h.run(['transition', 'demo', 'build-done'], { env: USER_A })).toBe(0)
  })
  test('守卫：必需评审者未通过时离开步骤被拦，修完重跑放行；参考评审者不拦', async () => {
    await seed()
    expect(await runAgent('builder', [], { result: 'done' })).toBe(0)
    expect(await runAgent('researcher', [], { result: 'done' })).toBe(0)
    expect(await h.run(['transition', 'demo', 'build-done'], { env: USER_A })).toBe(0)

    expect(await h.run(['transition', 'demo', 'verify-pass'], { env: USER_A })).toBe(2)
    expect(h.err.join('\n')).toContain("评审者 'security' 未运行")

    expect(await runAgent('security', [{ severity: 'high', location: 'a.ts:1', message: '注入' }])).toBe(0)
    expect(await runAgent('spec-consistency')).toBe(0)
    expect(await h.run(['transition', 'demo', 'verify-pass'], { env: USER_A })).toBe(2)
    expect(h.err.join('\n')).toContain('a.ts:1 注入')

    expect(await runAgent('security')).toBe(0)
    // 参考评审者报 critical 也不拦。
    expect(await runAgent('architecture', [{ severity: 'critical', location: 'b.ts:2', message: '环' }])).toBe(0)
    expect(await h.run(['transition', 'demo', 'verify-pass'], { env: USER_A }), h.err.join('\n')).toBe(0)
  })

  test('守卫：候选变化后旧结论过期，重跑通过才放行', async () => {
    await seed()
    expect(await runAgent('builder', [], { result: 'done' })).toBe(0)
    expect(await runAgent('researcher', [], { result: 'done' })).toBe(0)
    expect(await h.run(['transition', 'demo', 'build-done'], { env: USER_A })).toBe(0)
    expect(await runAgent('security')).toBe(0)
    expect(await runAgent('spec-consistency')).toBe(0)
    await writeFile(join(h.cwd, 'drift.ts'), 'export const drift = 1\n', 'utf8')
    expect(await h.run(['transition', 'demo', 'verify-pass'], { env: USER_A })).toBe(2)
    expect(h.err.join('\n')).toContain('已过期')
    expect(await runAgent('security')).toBe(0)
    expect(await runAgent('spec-consistency')).toBe(0)
    expect(await h.run(['transition', 'demo', 'verify-pass'], { env: USER_A }), h.err.join('\n')).toBe(0)
  })

  test('守卫：退回边不检查 agent', async () => {
    await seed()
    expect(await runAgent('builder', [], { result: 'done' })).toBe(0)
    expect(await runAgent('researcher', [], { result: 'done' })).toBe(0)
    expect(await h.run(['transition', 'demo', 'build-done'], { env: USER_A })).toBe(0)
    expect(await h.run(['transition', 'demo', 'verify-fail'], { env: USER_A }), h.err.join('\n')).toBe(0)
  })

  test('守卫：执行者未完成时离开 build 被拦', async () => {
    await seed()
    expect(await h.run(['transition', 'demo', 'build-done'], { env: USER_A })).toBe(2)
    expect(h.err.join('\n')).toContain("执行者 'builder' 未运行")
    expect(await h.run(['check', 'demo'], { env: USER_A })).toBe(2)
    expect(h.out.join('\n')).toContain("[FAIL] agent: 执行者 'builder' 未运行")
  })
  test('技能门：agent 的技能只在它跑着时可加载', async () => {
    await seed()
    // builder 声明了 test-driven-development；它还没开始 → 拦住并点名开始命令。
    expect(await h.run(['internal-skill-gate', 'demo', 'test-driven-development'], { env: USER_A })).toBe(2)
    expect(h.err.join('\n')).toContain("技能 'test-driven-development' 属于 agent 'builder'")
    expect(h.err.join('\n')).toContain('tenon agent prompt demo builder')
    // 不属于任何 agent 的技能走原有的步骤 DAG（本步 skills: [] → 放行）。
    expect(await h.run(['internal-skill-gate', 'demo', 'unrelated-skill'], { env: USER_A })).toBe(0)

    expect(await h.run(['agent', 'prompt', 'demo', 'builder', '--json'], { env: USER_A })).toBe(0)
    const started = JSON.parse(h.out.join('')) as { run_id: string; report_path: string }
    expect(await h.run(['internal-skill-gate', 'demo', 'test-driven-development'], { env: USER_A })).toBe(0)

    await writeFile(
      join(h.cwd, started.report_path),
      '# builder\n\n\u0060\u0060\u0060tenon-result\n{"result":"done","findings":[]}\n\u0060\u0060\u0060\n',
      'utf8',
    )
    expect(await h.run(['agent', 'record', 'demo', started.run_id], { env: USER_A })).toBe(0)
    // 跑完就重新上锁。
    expect(await h.run(['internal-skill-gate', 'demo', 'test-driven-development'], { env: USER_A })).toBe(2)
  })

  test('技能门：冻结内容被改动时失败关闭', async () => {
    await seed()
    await writeFile(
      join(h.cwd, 'openspec/changes/demo/.pipeline-frozen/agents/builder.md'),
      '---\nname: builder\ndescription: 篡改\n---\n\n正文\n',
      'utf8',
    )
    expect(await h.run(['internal-skill-gate', 'demo', 'test-driven-development'], { env: USER_A })).toBe(2)
    expect(h.err.join('\n')).toContain('agent 记录不可读')
  })
})
