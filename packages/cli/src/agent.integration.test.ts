/**
 * 真实 e2e —— 步骤 agent：真 harness + 真临时项目 + 真落盘的冻结、台账与报告。
 * 模型一律不跑：报告由用例直接写进 `report_path`，`record` 只读它。
 */
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENT_RERUN_REASON_MAX, resolveProductPaths } from '@tenon/kernel'
import { afterEach, describe, expect, test } from 'vitest'
import { FIXED_CLOCK, freshHarness, rm, TEST_GIT_BUILD_TOKEN, type Harness } from './integration-harness.js'

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
  readonly complete?: boolean
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
    options: { readonly result?: 'done' | 'failed'; readonly env?: Record<string, string>; readonly rerunReason?: string } = {},
  ): Promise<number> {
    const env = options.env ?? USER_A
    const started = await h.run(
      ['agent', 'prompt', 'demo', agent, '--json', ...(options.rerunReason === undefined ? [] : ['--rerun-reason', options.rerunReason])],
      { env },
    )
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
    expect(await h.run(['agent', 'prompt', 'demo', 'e2e'], { env: USER_A })).toBe(1)
    expect(h.err.join('\n')).toContain("agent 'e2e' 未在步骤 'build' 声明")
    // builder 没声明 hosts（缺省适用每个宿主），所以 --host 任意值都放行。
    expect(await h.run(['agent', 'prompt', 'demo', 'builder', '--host', 'nope'], { env: USER_A })).toBe(0)
    expect(await h.run(['agent', 'prompt', 'demo', 'security'], { env: USER_A })).toBe(1)
    expect(h.err.join('\n')).toContain("agent 'security' 未在步骤 'build' 声明")
  })

  test('prompt --host：agent 声明 hosts 时只放行其中的宿主（skills/tenon 的 run-agent 传本宿主 id）', async () => {
    const runtimeHome = await mkdtemp(join(tmpdir(), 'tenon-agent-hosts-'))
    const env = { ...USER_A, TENON_RUNTIME_HOME: runtimeHome }
    const customDir = join(resolveProductPaths({ env }).configRoot, 'agents', 'custom')
    await mkdir(customDir, { recursive: true })
    await writeFile(join(customDir, 'codex-only.md'), [
      '---',
      'name: codex-only',
      'description: 只在 Codex 上跑的执行者',
      'skills: []',
      'tools: [Read]',
      'hosts: [codex]',
      '---',
      '',
      '# codex-only',
      '',
      '只在 Codex 宿主上执行。',
      '',
    ].join('\n'), 'utf8')
    h = await freshHarness()
    await mkdir(join(h.cwd, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(
      join(h.cwd, '.pipeline', 'workflows', 'reviewed.yaml'),
      AGENT_WF.replace('            - agent: builder\n            - agent: researcher\n', '            - agent: codex-only\n'),
      'utf8',
    )
    try {
      expect(await h.run(
        ['init', 'demo', '--track', 'backend', '--workflow', 'reviewed', '--preset', 'full'],
        { env },
      ), h.err.join('\n')).toBe(0)
      expect(await h.run(['agent', 'prompt', 'demo', 'codex-only', '--host', 'claude', '--json'], { env })).toBe(2)
      expect(h.err.join('\n')).toContain("agent 'codex-only' 不支持宿主 'claude'")
      expect(await h.run(['agent', 'prompt', 'demo', 'codex-only', '--host', 'codex', '--json'], { env }), h.err.join('\n')).toBe(0)
      expect((JSON.parse(h.out.join('')) as { run_id: string }).run_id).toMatch(/\S/u)
    } finally {
      await rm(runtimeHome, { recursive: true, force: true })
    }
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

    // 同一份代码（候选没变）上已经有结论，不写原因就重跑：拒绝；写明原因的重跑留痕并以它为准。
    expect(await runAgent('security')).toBe(2)
    expect(h.err.join('\n')).toContain('同一份代码不能靠重跑换结论')
    expect(await runAgent('security', [], { rerunReason: '上一轮提示缺少 DESIGN.md，补充后重跑' })).toBe(0)
    view = await next()
    expect(view.wave).toEqual(['architecture'])
    // 参考评审者报 critical 也不拦。
    expect(await runAgent('architecture', [{ severity: 'critical', location: 'b.ts:2', message: '环' }])).toBe(0)
    expect((await next()).pass).toBe(true)
  })

  test('F8 重跑防刷：同候选写明原因的重跑留痕（次数、翻转、原因）；改代码换候选后的重跑不需要原因', async () => {
    await seed()
    expect(await runAgent('builder', [], { result: 'done' })).toBe(0)
    expect(await runAgent('researcher', [], { result: 'done' })).toBe(0)
    expect(await h.run(['transition', 'demo', 'build-done'], { env: USER_A })).toBe(0)
    expect(await runAgent('spec-consistency')).toBe(0)
    expect(await runAgent('security', [{ severity: 'medium', location: 'a.ts:1', message: '缺少校验' }])).toBe(0)
    expect(await runAgent('security', [], { rerunReason: '   ' })).toBe(1)
    expect(h.err.join('\n')).toContain('--rerun-reason')
    expect(await runAgent('security', [], { rerunReason: '补充了设计稿后重跑' })).toBe(0)
    const view = (await next()).agents.find((item) => item.agent === 'security') as unknown as Record<string, unknown>
    expect(view).toMatchObject({ result: 'pass', reruns: 1, flipped: true, rerun_reason: '补充了设计稿后重跑' })
    expect(await h.run(['agent', 'next', 'demo'], { env: USER_A })).toBe(0)
    expect(h.out.join('\n')).toContain('security 评审者 已完成 通过 重跑 1 次（结论翻转）：补充了设计稿后重跑')
    // 台账留着每一次运行；原因记在旁注里（上一个发行版读不了台账行里的新键），读出来仍挂在这次运行上。
    const rows = (await h.readIn('demo', '.pipeline-agent-runs.jsonl')).trim().split('\n').map((line) => JSON.parse(line) as { agent: string; status: string; run_id: string; rerun_reason?: string })
    expect(rows.filter((row) => row.agent === 'security' && row.status === 'finished')).toHaveLength(2)
    expect(rows.some((row) => row.rerun_reason !== undefined)).toBe(false)
    const meta = (await h.readIn('demo', '.pipeline-agent-run-meta.jsonl')).trim().split('\n').map((line) => JSON.parse(line) as { run_id: string; rerun_reason?: string })
    expect(meta.filter((row) => row.rerun_reason === '补充了设计稿后重跑').map((row) => row.run_id)).toContain(rows.filter((row) => row.agent === 'security').at(-1)?.run_id)

    // 换候选（代码真的变了）之后，上一候选的结论过期，新候选上的第一次运行不需要原因。
    await writeFile(join(h.cwd, 'fix.ts'), 'export const fixed = true\n', 'utf8')
    expect(await runAgent('security', [{ severity: 'high', location: 'fix.ts:1', message: '新问题' }])).toBe(0)
    expect((await next()).agents.find((item) => item.agent === 'security')).toMatchObject({ result: 'fail', findings: 1 })
  })

  test('F8 台账里没有原因的同候选重跑（旧版本写的行、手工追加的行）：取最严结论，重跑换不来通过', async () => {
    await seed()
    expect(await runAgent('builder', [], { result: 'done' })).toBe(0)
    expect(await runAgent('researcher', [], { result: 'done' })).toBe(0)
    expect(await h.run(['transition', 'demo', 'build-done'], { env: USER_A })).toBe(0)
    expect(await runAgent('spec-consistency')).toBe(0)
    expect(await runAgent('security', [{ severity: 'high', location: 'a.ts:1', message: '注入' }])).toBe(0)
    const rows = (await h.readIn('demo', '.pipeline-agent-runs.jsonl')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    const failed = rows.filter((row) => row.agent === 'security').at(-1) as Record<string, unknown>
    // 不走 CLI、直接往台账追加一条同候选的「通过」运行（没有 rerun_reason）。
    await appendFile(join(h.cwd, 'openspec/changes/demo/.pipeline-agent-runs.jsonl'), `${JSON.stringify({
      ...failed, run_id: 'forged-pass', result: 'pass', findings: [], finished_at: '2099-01-01T00:00:00Z',
    })}\n`, 'utf8')
    const view = await next()
    expect(view.pass).toBe(false)
    expect(view.blockers.find((item) => item.kind === 'reviewer-failed')?.agent).toBe('security')
    expect(view.agents.find((item) => item.agent === 'security')).toMatchObject({ result: 'fail', findings: 1, reruns: 1, flipped: true, rerun_reason: null })
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

  test('verify 冻结了 build token 时改代码，评审结论同样过期（与测试记录同一候选）', async () => {
    await seed(AGENT_WF
      .replace(
        '        label: 实现\n        gate: null\n        skills: []\n        inputs: []\n        outputs: []',
        '        label: 实现\n        gate: null\n        skills: []\n        inputs: []\n        outputs:\n          - field: build_sha\n            type: string',
      )
      .replace(
        '        label: 验证\n        gate: null\n        skills: []\n        inputs: []',
        '        label: 验证\n        gate: null\n        skills: []\n        inputs:\n          - field: build_sha\n            type: string',
      ))
    // 白盒预置「已进入 verify 且 build token 已冻结」（生产里由 build 出口 transition 的 freeze-build-sha 写入）。
    await h.seedArtifact('demo', 'build_sha', TEST_GIT_BUILD_TOKEN)
    await h.seedPhase('demo', 'verify')
    expect(await runAgent('security'), h.err.join('\n')).toBe(0)
    const before = await next()
    expect(before.candidate).toMatch(/^workspace:sha256:/u)
    expect(before.agents.find((item) => item.agent === 'security')?.state).toBe('done')
    await writeFile(join(h.cwd, 'drift.ts'), 'export const drift = 1\n', 'utf8')
    const after = await next()
    expect(after.agents.find((item) => item.agent === 'security')?.state).toBe('stale')
    expect(after.blockers.find((item) => item.kind === 'reviewer-stale')?.agent).toBe('security')
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

    expect(await runAgent('security', [], { rerunReason: '修完注入问题后复审' })).toBe(0)
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

  interface StepAgentJson {
    readonly agent: string
    readonly wave: number
    readonly status: string
  }
  interface StatusStepJson {
    readonly step: {
      readonly executors: readonly StepAgentJson[]
      readonly reviewers: readonly StepAgentJson[]
      readonly next: readonly { readonly action: string; readonly [key: string]: unknown }[]
    }
  }

  /** 宿主加载 `tenon`：history 行 + PostToolUse 最终调用的生产命令（同 next-action-runner）。 */
  async function loadTenon(): Promise<void> {
    expect(await h.run(['session', 'activate', 'demo'], { env: USER_A }), h.err.join('\n')).toBe(0)
    await appendFile(
      join(h.cwd, 'openspec/changes/demo/.pipeline-history.jsonl'),
      `${JSON.stringify({ ts: FIXED_CLOCK, kind: 'tool', raw: 'Skill: tenon' })}\n`,
      'utf8',
    )
    expect(await h.run(
      ['internal-native-skill-receipt', 'demo', 'tenon', 'agent-session', `tool-${Math.random()}`, FIXED_CLOCK],
      { env: USER_A },
    ), h.err.join('\n')).toBe(0)
  }

  async function status(): Promise<StatusStepJson['step']> {
    expect(await h.run(['status', 'demo', '--json'], { env: USER_A }), h.err.join('\n')).toBe(0)
    return (JSON.parse(h.out.join('\n')) as StatusStepJson).step
  }

  /** D3：波次是依赖分层，不是声明序号——互不依赖的评审者同在第 0 波，与 agent next 一致。 */
  test('status 投影的波次与 agent next 同源：无依赖者同为 wave 0', async () => {
    await seed()
    let step = await status()
    expect(step.executors.map((item) => `${item.agent}:${item.wave}`)).toEqual(['builder:0', 'researcher:0'])
    expect(await runAgent('builder', [], { result: 'done' })).toBe(0)
    expect(await runAgent('researcher', [], { result: 'done' })).toBe(0)
    expect(await h.run(['transition', 'demo', 'build-done'], { env: USER_A }), h.err.join('\n')).toBe(0)
    await loadTenon()
    step = await status()
    expect(step.reviewers.map((item) => `${item.agent}:${item.wave}`))
      .toEqual(['security:0', 'spec-consistency:0', 'architecture:1'])
    expect(step.next).toEqual([
      { action: 'run-agent', agent: 'security', role: 'reviewer', wave: 0 },
      { action: 'run-agent', agent: 'spec-consistency', role: 'reviewer', wave: 0 },
    ])
    expect((await next()).wave).toEqual(['security', 'spec-consistency'])
  })

  /** D4 / D5：prompt 之后还没 record，next 指回那次运行；agent next 不说「全部完成」。 */
  test('执行者仍在运行：next 要求登记它，agent next 不报全部完成', async () => {
    await seed()
    await loadTenon()
    expect(await h.run(['agent', 'prompt', 'demo', 'builder', '--json'], { env: USER_A })).toBe(0)
    const started = JSON.parse(h.out.join('')) as { run_id: string; report_path: string }
    expect(await runAgent('researcher', [], { result: 'done' })).toBe(0)
    const step = await status()
    expect(step.next).toEqual([{
      action: 'run-agent', agent: 'builder', role: 'executor', wave: 0,
      status: 'running', run_id: started.run_id, report_path: started.report_path,
      // 下一步（verify）声明的评审者口径随本步 agent 下发（真机第五轮）。
      review_bar: [
        expect.objectContaining({ step: 'verify', agent: 'security', required: true, block_at: 'medium' }),
        expect.objectContaining({ step: 'verify', agent: 'spec-consistency', required: true, block_at: 'medium' }),
        expect.objectContaining({ step: 'verify', agent: 'architecture', required: false, block_at: 'high' }),
      ],
    }])
    expect(await h.run(['agent', 'next', 'demo'], { env: USER_A })).toBe(0)
    expect(h.out.join('\n')).not.toContain('全部完成')
    expect(h.out.join('\n')).toContain(`进行中：builder；完成后 tenon agent record demo ${started.run_id}`)
    expect((await next()).complete).toBe(false)
  })

  test('评审者在等必需测试：agent next 说在等什么，不说全部完成', async () => {
    await seed(AGENT_WF.replace(
      `        agents:
          reviewers:`,
      `        tests:
          - id: unit
            direction: unit
            command: "exit 0"
            required: true
        agents:
          reviewers:`,
    ))
    expect(await runAgent('builder', [], { result: 'done' })).toBe(0)
    expect(await runAgent('researcher', [], { result: 'done' })).toBe(0)
    expect(await h.run(['transition', 'demo', 'build-done'], { env: USER_A }), h.err.join('\n')).toBe(0)
    expect(await h.run(['agent', 'next', 'demo'], { env: USER_A })).toBe(0)
    const text = h.out.join('\n')
    expect(text).not.toContain('全部完成')
    expect(text).toContain('等待：security ← test:unit')
  })

  test('TENON_LANG：agent next 的人读行与 prompt / record 的拒绝在 en 下是英文，zh 与原来的中文逐字一致', async () => {
    const EN = { ...USER_A, TENON_LANG: 'en' }
    const ZH = { ...USER_A, TENON_LANG: 'zh' }
    const cjk = /[㐀-鿿＀-￯　-〿]/u
    const both = async (args: readonly string[]): Promise<{ code: number; zh: string; en: string }> => {
      const code = await h.run([...args], { env: ZH })
      const zh = [...h.out, ...h.err].join('\n')
      expect(await h.run([...args], { env: EN })).toBe(code)
      const en = [...h.out, ...h.err].join('\n')
      expect(cjk.test(en), `en 输出里有中文：${en}`).toBe(false)
      return { code, zh, en }
    }
    const started = async (agent: string): Promise<{ run_id: string; report_path: string }> => {
      expect(await h.run(['agent', 'prompt', 'demo', agent, '--json'], { env: USER_A }), h.err.join('\n')).toBe(0)
      return JSON.parse(h.out.join('')) as { run_id: string; report_path: string }
    }
    const report = (path: string, text: string): Promise<void> => writeFile(join(h.cwd, path), text, 'utf8')
    const result = (findings: readonly object[]): string => `# r\n\n\`\`\`tenon-result\n${JSON.stringify({ findings })}\n\`\`\`\n`
    await seed()

    // build 步骤：人读的 next 行（角色、状态、下一波）。
    let seen = await both(['agent', 'next', 'demo'])
    expect(seen.zh).toBe('builder 执行者 未运行\nresearcher 执行者 未运行\n下一波：builder, researcher')
    expect(seen.en).toBe('builder executor idle\nresearcher executor idle\nNext wave: builder, researcher')

    // prompt 的拒绝：未声明的 agent、非法的 --rerun-reason。
    seen = await both(['agent', 'prompt', 'demo', 'nosuch'])
    expect(seen).toMatchObject({ code: 1, zh: "ERROR: agent 'nosuch' 未在步骤 'build' 声明", en: "ERROR: agent 'nosuch' is not declared in step 'build'" })
    seen = await both(['agent', 'prompt', 'demo', 'builder', '--rerun-reason', '   '])
    expect(seen).toMatchObject({
      code: 1,
      zh: `ERROR: --rerun-reason 需要一行不超过 ${AGENT_RERUN_REASON_MAX} 字的原因`,
      en: `ERROR: --rerun-reason needs a one-line reason of at most ${AGENT_RERUN_REASON_MAX} characters`,
    })

    // record 的拒绝：没有这个运行、非法的 --subagent、报告读不到 / 太大 / 不是 tenon-result。
    seen = await both(['agent', 'record', 'demo', 'nope'])
    expect(seen).toMatchObject({ code: 1, zh: "ERROR: run 'nope' 不是本次步骤访问中进行中的运行", en: "ERROR: run 'nope' is not a running run of this step visit" })
    seen = await both(['agent', 'record', 'demo', 'nope', '--subagent', '!!'])
    expect(seen).toMatchObject({ code: 1, zh: "ERROR: --subagent '!!' 非法", en: "ERROR: --subagent '!!' is not valid" })
    const builder = await started('builder')
    seen = await both(['agent', 'record', 'demo', builder.run_id])
    expect(seen).toMatchObject({
      code: 1,
      zh: `ERROR: 报告无效：${builder.report_path} 读不到`,
      en: `ERROR: invalid report: cannot read ${builder.report_path}`,
    })
    await report(builder.report_path, 'x'.repeat(256 * 1024 + 1))
    seen = await both(['agent', 'record', 'demo', builder.run_id])
    expect(seen).toMatchObject({ code: 1, zh: 'ERROR: 报告无效：超过 262144 字节', en: 'ERROR: invalid report: larger than 262144 bytes' })
    await report(builder.report_path, '没有 tenon-result 块\n')
    expect(await h.run(['agent', 'record', 'demo', builder.run_id], { env: ZH })).toBe(1)
    expect(h.err.join('\n')).toMatch(/^ERROR: 报告无效：/u)
    expect(await h.run(['agent', 'record', 'demo', builder.run_id], { env: EN })).toBe(1)
    expect(h.err.join('\n')).toMatch(/^ERROR: invalid report: /u)

    // 两个执行者都做完：状态 / 结果词与「全部完成」。
    await report(builder.report_path, `# r\n\n\`\`\`tenon-result\n${JSON.stringify({ result: 'done', findings: [] })}\n\`\`\`\n`)
    expect(await h.run(['agent', 'record', 'demo', builder.run_id], { env: USER_A }), h.err.join('\n')).toBe(0)
    expect(await runAgent('researcher', [], { result: 'done' })).toBe(0)
    seen = await both(['agent', 'next', 'demo'])
    expect(seen.zh).toBe('builder 执行者 已完成 完成\nresearcher 执行者 已完成 完成\n全部完成')
    expect(seen.en).toBe('builder executor done done\nresearcher executor done done\nAll done')

    // verify 步骤：架构评审在等两个必需评审者；prompt 拒绝它。
    expect(await h.run(['transition', 'demo', 'build-done'], { env: USER_A }), h.err.join('\n')).toBe(0)
    seen = await both(['agent', 'prompt', 'demo', 'architecture'])
    expect(seen).toMatchObject({
      code: 2,
      zh: "ERROR: agent 'architecture' 还需等待：agent:security, agent:spec-consistency",
      en: "ERROR: agent 'architecture' still has to wait for: agent:security, agent:spec-consistency",
    })

    // 同一份代码上已有结论：重跑被拒，zh 是原来那句整段，en 是整段英文；带原因重跑后 next 行写明次数与原因。
    expect(await runAgent('security', [{ severity: 'high', location: 'a.ts:1', message: 'x' }])).toBe(0)
    seen = await both(['agent', 'prompt', 'demo', 'security'])
    expect(seen.code).toBe(2)
    expect(seen.zh).toBe(
      "ERROR: 评审者 'security' 在当前候选上已经有 1 次结论（fail）：同一份代码不能靠重跑换结论。"
      + '改代码换候选后再重跑；确有需要（例如上次的提示缺上下文）用 tenon agent prompt demo security --rerun-reason <原因> 写明并留痕，'
      + '判定会把同一候选上的所有运行一并看（没有原因的重跑取最严结论，有原因的以最后一次为准）',
    )
    expect(seen.en).toBe(
      "ERROR: reviewer 'security' already has 1 verdict(s) on the current candidate (fail): the same code cannot change its verdict by rerunning. "
      + 'Change the code to get a new candidate, then rerun; if you really need to (for example the last prompt lacked context), '
      + 'state why and leave a trace with tenon agent prompt demo security --rerun-reason <reason>. '
      + 'The verdict looks at every run on the same candidate together (a rerun without a reason takes the strictest verdict, a rerun with a reason takes the last one)',
    )
    expect(await runAgent('security', [], { rerunReason: 'retry' })).toBe(0)
    seen = await both(['agent', 'next', 'demo'])
    expect(seen.zh).toContain('security 评审者 已完成 通过 重跑 1 次（结论翻转）：retry\n')
    expect(seen.en).toContain('security reviewer done pass reran 1 time(s) (verdict flipped): retry\n')

    // 评审期间候选变了：登记被拒。
    const review = await started('spec-consistency')
    await report(review.report_path, result([]))
    await writeFile(join(h.cwd, 'changed.txt'), 'changed during the review\n', 'utf8')
    seen = await both(['agent', 'record', 'demo', review.run_id])
    expect(seen).toMatchObject({
      code: 2,
      zh: 'ERROR: 评审期间候选已变化；重跑：tenon agent prompt demo spec-consistency',
      en: 'ERROR: the candidate changed during the review; run it again: tenon agent prompt demo spec-consistency',
    })
  })
})
