/**
 * advance —— auto-transition 中间档 真实端到端集成测试（BACKLOG #31 / GOAL B14·D12·C9）。
 *
 * 零 mock：真临时项目（freshHarness）+ 真 init/set/transition 喂前置 + 真 kernel guard/transition +
 * 真调 cmdAdvance（真 fs realDeps）。断言的是真实副作用：.pipeline.yaml phase 真变 / 真停在复核门 /
 * guard 不过真不推进 / dry-run 真不改盘 / 硬门真不跨越。
 *
 * 说明：advance 尚未接入 program（收编由主会话统一接线），故用 h.run 做 init/set/transition 铺场，
 * 再用 realDeps 直调 cmdAdvance —— 与 main.ts 同一条 fs 副作用装配路径，只把 io 收进数组。
 */
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { freshHarness, realDeps, TEST_GIT_BUILD_TOKEN, type Harness } from './integration-harness.js'
import { cmdAdvance, type AdvanceOpts } from './commands/advance.js'

describe('真实 e2e —— advance auto-transition 中间档（HITL 红线：复核相位必停）', () => {
  let h: Harness
  beforeEach(async () => {
    h = await freshHarness()
  })
  afterEach(async () => {
    await rm(h.cwd, { recursive: true, force: true })
  })

  const cd = (name: string) => join(h.cwd, 'openspec', 'changes', name)
  const phaseOf = async (name: string): Promise<string> =>
    (await h.read(name)).match(/^phase: (.+)$/m)?.[1] ?? '?'

  /** 真调 cmdAdvance（真 fs realDeps）；返回 exit + 收集的 io */
  async function advance(name: string, opts: AdvanceOpts): Promise<{ code: number; out: string[]; err: string[] }> {
    const out: string[] = []
    const err: string[] = []
    const code = await cmdAdvance(realDeps(h.cwd, out, err), name, opts)
    return { code, out, err }
  }

  /** 完成 review 出口所需的真实 check → request → acknowledge，不使用测试侧 marker 删除旁路。 */
  async function approveReviewExit(name: string, event: string): Promise<void> {
    expect(await h.run(['review', 'request', name, '--event', event])).toBe(0)
    expect(await h.run(['review', 'acknowledge', name])).toBe(0)
  }

  /** cmdAdvance only advances state; it never fabricates host Skill calls. Record the phase work
   * explicitly when this suite wants to exercise the next transition rather than the Skill gate. */
  async function recordMandatorySkills(name: string): Promise<void> {
    const deps = realDeps(h.cwd, [], [])
    const dir = cd(name)
    const state = await deps.store.read(dir)
    const phase = String(state.fields.phase)
    const track = String(state.fields.track)
    const lines = deps.resolver.resolveDefaultMandatory(phase, track)
      .map((slot) => slot.alternatives[0])
      .filter((skill): skill is string => skill !== undefined)
      .map((skill) => `${JSON.stringify({ kind: 'tool', raw: `Skill: ${skill}` })}\n`)
      .join('')
    if (lines !== '') await appendFile(join(dir, '.pipeline-history.jsonl'), lines, 'utf8')
  }

  /** 用真实 review receipt + transition 把 change 推到 build 相位。 */
  async function seedToBuild(name: string): Promise<void> {
    await h.run(['init', name, '--track', 'backend', '--preset', 'full'])
    await h.seedGovernedDocumentEvidence(name)
    expect(await h.run(['transition', name, 'open-complete'])).toBe(0) // → explore（可正常工作，不自锁）
    // The seeded OpenSpec design is hash-bound in the document ledger. Reuse it rather than
    // overwriting it here; overwriting correctly makes explore->spec fail as stale evidence.
    await h.seedArtifact(name, 'design_doc', `openspec/changes/${name}/design.md`) // P6：artifact 字段白盒预置
    await approveReviewExit(name, 'explore-complete')
    expect(await h.run(['transition', name, 'explore-complete'])).toBe(0) // → spec
    await h.seedArtifact(name, 'plan', `docs/superpowers/plans/${name}.md`) // P6：artifact 字段白盒预置
    await approveReviewExit(name, 'spec-complete')
    expect(await h.run(['transition', name, 'spec-complete'])).toBe(0) // → build
    await recordMandatorySkills(name)
  }

  /** 让 build 出口 guard 真通过：tasks.md 全勾 + build mode/isolation/override + pre-Verify 收敛 */
  /** default 的 backend 轨在 build/verify 声明了必需测试；像真实用户那样先跑它们再出闸。 */
  async function armStepTests(name: string, step: string): Promise<void> {
    await h.satisfyStepTests(name, step)
  }

  async function armBuildGuard(name: string): Promise<void> {
    // seedToBuild 的真实 OpenSpec tasks.md 已有三项全部勾选；不得覆写它，否则 hash-bound
    // document ledger 会正确判为 stale，掩盖本用例要覆盖的 advance 行为。
    await h.run([
      'set-many', name,
      'build_mode=direct', 'isolation=worktree', 'direct_override=true',
      'pre_verify_review_result=pass',
    ])
    await armStepTests(name, 'build')
  }

  /** 让 verify 出口 guard + verify-pass 事件前置真通过（backend：双 review pass + 报告 + branch_status） */
  async function armVerifyGuard(name: string): Promise<void> {
    await h.seedArtifact(name, 'verification_report', `docs/superpowers/reports/${name}.md`)
    expect(await h.run(['set-many', name,
      'branch_status=handled'])).toBe(0)
    await armStepTests(name, 'verify')
  }

  /** 让 ship 出口 guard 真通过（backend：pr_url） */
  async function armShipGuard(name: string): Promise<void> {
    await h.run(['set', name, 'pr_url', 'https://example.com/pr/1'])
  }

  test('HITL 红线：默认从 build 只推进到 verify（复核相位）就停，绝不跑到 ship/archive', async () => {
    await seedToBuild('demo')
    await armBuildGuard('demo')
    // 即使 verify 出口也备齐（本可继续），默认档仍在 verify 复核门停——证 HITL 不越门
    await armVerifyGuard('demo')
    await armShipGuard('demo')

    const r = await advance('demo', {})
    expect(r.code).toBe(0)
    // .pipeline.yaml phase 真变：build → verify（真推进一步）
    expect(await phaseOf('demo')).toBe('verify')
    // build-complete 真冻结 build_sha（证真的走了 transition 事件体）
    expect(await h.read('demo')).toContain(`build_sha: ${TEST_GIT_BUILD_TOKEN}`)
    // 停在复核门，绝不自动跑完
    expect(r.out.some((l) => l.includes('[STOP]') && l.includes('复核相位'))).toBe(true)
    // 进入 verify 不写 marker；只有输出完成后的 review request 才能创建 v2 投影。
    await expect(readFile(join(h.cwd, '.pipeline-pending-review'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('HITL 红线：默认从复核相位（explore）立即停，绝不自动离开——phase 不变', async () => {
    await h.run(['init', 'demo', '--track', 'backend', '--preset', 'full'])
    await h.seedGovernedDocumentEvidence('demo')
    await h.run(['transition', 'demo', 'open-complete']) // → explore（复核相位）
    const before = await h.read('demo')

    const r = await advance('demo', {})
    expect(r.code).toBe(0)
    expect(await phaseOf('demo')).toBe('explore') // 未离开复核相位
    expect(await h.read('demo')).toBe(before) // 字节不变（零推进）
    expect(r.out.some((l) => l.includes('[STOP]') && l.includes('复核相位'))).toBe(true)
  })

  test('guard 不过时真不推进：build 缺 tasks.md → 停在 build，exit 2', async () => {
    await seedToBuild('demo')
    // 故意删掉已播种的 tasks.md（build 出口 tasks-all-done 缺文件即 FAIL）。cmdAdvance 先
    // 跑 guard，因此应在 document evidence 前以明确的 guard 失败停住。
    await rm(join(cd('demo'), 'tasks.md'))
    await h.run(['set-many', 'demo', 'build_mode=direct', 'isolation=worktree', 'direct_override=true'])
    const before = await h.read('demo')

    const r = await advance('demo', {})
    expect(r.code).toBe(2)
    expect(await phaseOf('demo')).toBe('build') // 相位不变
    expect(await h.read('demo')).toBe(before) // 零写盘
    expect(r.out.some((l) => l.includes('guard'))).toBe(true)
  })

  test('--dry-run 真不改盘：报计划、phase 与字节均不变', async () => {
    await seedToBuild('demo')
    await armBuildGuard('demo')
    const before = await h.read('demo')

    const r = await advance('demo', { dryRun: true })
    expect(r.code).toBe(0)
    expect(await h.read('demo')).toBe(before) // 字节不变
    expect(await phaseOf('demo')).toBe('build')
    expect(r.out.some((l) => l.includes('[DRY-RUN]'))).toBe(true)
    // 计划显示 build → verify 一步 + 预计停在复核相位
    expect(r.out.some((l) => l.includes('build') && l.includes('verify'))).toBe(true)
    expect(r.out.some((l) => l.includes('复核相位'))).toBe(true)
  })

  test('--through-gates 不伪造 review 确认：verify request/ack 后才可继续到 archive', async () => {
    await seedToBuild('demo')
    await armBuildGuard('demo')
    await armVerifyGuard('demo')
    await armShipGuard('demo')

    const first = await advance('demo', { throughGates: true })
    expect(first.code).toBe(0)
    expect(await phaseOf('demo')).toBe('verify')
    expect(first.out.some((l) => l.includes('确认回执'))).toBe(true)

    await recordMandatorySkills('demo')
    // 进了 verify 才轮到该步的评审者；真实宿主同样是先跑完评审再请求确认。
    await h.satisfyStepAgents('demo')
    await approveReviewExit('demo', 'verify-pass')
    const verifyExit = await advance('demo', { throughGates: true, maxSteps: 1 })
    expect(verifyExit.code).toBe(0)
    expect(await phaseOf('demo')).toBe('ship')
    // A new canonical visit was created by the direct advance call. Re-enter through the shared
    // harness so that this exact ship visit receives its real Skill/read evidence.
    expect(await h.run(['check', 'demo'])).toBe(0)
    const r = await advance('demo', { throughGates: true })
    expect(r.code).toBe(0)
    // 真跨经确认的 verify 出口，再到 archive 终态
    expect(await phaseOf('demo')).toBe('archive')
    // 历史 JSONL 真记满这几步 transition
    const hist = await readFile(join(cd('demo'), '.pipeline-history.jsonl'), 'utf8')
    const trans = hist.split('\n').filter((l) => l.includes('"kind":"transition"'))
    expect(trans.some((l) => l.includes('"to":"verify"'))).toBe(true)
    expect(trans.some((l) => l.includes('"to":"ship"'))).toBe(true)
    expect(trans.some((l) => l.includes('"to":"archive"'))).toBe(true)
    expect(r.out.some((l) => l.includes('[STOP]') && l.includes('终态'))).toBe(true)
    // 多阶段真实文件系统/治理链需要有限 CI 余量；该预算不是性能 SLA。
  }, 15_000)

  test('HITL 红线：--through-gates 仍不跨越 confirm 硬门（真 marker 新鲜存在 → 停）', async () => {
    await seedToBuild('demo')
    await armBuildGuard('demo')
    await armVerifyGuard('demo')
    await armShipGuard('demo')
    // 真植一个新鲜 confirm 硬门 marker
    await writeFile(join(h.cwd, '.pipeline-pending-confirm'), 'build\n请确认\ndemo\n', 'utf8')

    const r = await advance('demo', { throughGates: true })
    expect(r.code).toBe(0)
    // 硬门当前，绝不自动跨越——phase 停在 build，零推进
    expect(await phaseOf('demo')).toBe('build')
    expect(r.out.some((l) => l.includes('[STOP]') && l.includes('confirm'))).toBe(true)
  })
})

// ════ 非 default workflow（自定义 step 图；功能缺口补完：advance 此前只认 default manifest）════
describe('真实 e2e —— advance 非 default workflow（自定义 step 图自动推进）', () => {
  let h: Harness
  beforeEach(async () => {
    h = await freshHarness()
  })
  afterEach(async () => {
    await rm(h.cwd, { recursive: true, force: true })
  })

  const cd = (name: string) => join(h.cwd, 'openspec', 'changes', name)
  const phaseOf = async (name: string): Promise<string> =>
    (await h.read(name)).match(/^phase: (.+)$/m)?.[1] ?? '?'

  async function advance(name: string, opts: AdvanceOpts): Promise<{ code: number; out: string[]; err: string[] }> {
    const out: string[] = []
    const err: string[] = []
    const code = await cmdAdvance(realDeps(h.cwd, out, err), name, opts)
    return { code, out, err }
  }

  /** 三步单边链：c1 --go--> c2 --go2--> c3（终态）。 */
  const CHAIN_WF = `name: chain
steps:
  - id: c1
    label: one
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions:
      - event: go
        to: c2
  - id: c2
    label: two
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions:
      - event: go2
        to: c3
  - id: c3
    label: three
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions: []
`

  /** 多边分岔：f1 两条出边（pass→f2 / fail→f3）。 */
  const FORK_WF = `name: fork
steps:
  - id: f1
    label: fork
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions:
      - event: pass
        to: f2
      - event: fail
        to: f3
  - id: f2
    label: ok
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions:
      - event: done
        to: f3
  - id: f3
    label: end
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions: []
`

  /** g1 声明 nonempty-output guard（design_doc 必须产出）。 */
  const GUARDED_WF = `name: guarded
steps:
  - id: g1
    label: one
    gate: null
    skills: []
    inputs: []
    outputs:
      - field: design_doc
        type: file_path
    guards:
      - type: nonempty-output
    transitions:
      - event: done
        to: g2
  - id: g2
    label: end
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions: []
`

  /** 真落 workflow 定义 + 真 `init --workflow` 把 change 摆到首个 step（同 transition-custom-workflow 手法）。 */
  async function setupCustomChange(name: string, workflowName: string, workflowYaml: string): Promise<void> {
    const wfDir = join(h.cwd, '.pipeline', 'workflows')
    await mkdir(wfDir, { recursive: true })
    await writeFile(join(wfDir, `${workflowName}.yaml`), workflowYaml, 'utf8')
    expect(await h.run(['init', name, '--track', 'backend', '--preset', 'full', '--workflow', workflowName])).toBe(0)
  }

  test('单边推进多步到终态：phase 真变 c1→c3，history 真落两条 transition，[STOP] 终态', async () => {
    await setupCustomChange('cw', 'chain', CHAIN_WF)
    expect(await phaseOf('cw')).toBe('c1')

    const r = await advance('cw', {})
    expect(r.code).toBe(0)
    expect(await phaseOf('cw')).toBe('c3')
    const hist = await readFile(join(cd('cw'), '.pipeline-history.jsonl'), 'utf8')
    const trans = hist.split('\n').filter((l) => l.includes('"kind":"transition"'))
    expect(trans.some((l) => l.includes('"to":"c2"') && l.includes('"raw":"go"'))).toBe(true)
    expect(trans.some((l) => l.includes('"to":"c3"') && l.includes('"raw":"go2"'))).toBe(true)
    expect(r.out.some((l) => l.includes('[STOP]') && l.includes('终态'))).toBe(true)
  })

  test('多条出边 → 真停在原 step（需人选 event），[STOP] 列出可选 events', async () => {
    await setupCustomChange('cw', 'fork', FORK_WF)
    const before = await h.read('cw')

    const r = await advance('cw', {})
    expect(r.code).toBe(0)
    expect(await phaseOf('cw')).toBe('f1')
    expect(await h.read('cw')).toBe(before) // 字节不变（零推进）
    const stop = r.out.find((l) => l.includes('[STOP]'))
    expect(stop).toBeDefined()
    expect(stop).toContain('pass')
    expect(stop).toContain('fail')
  })

  test('guard 不过真不推进：g1 缺 design_doc → exit 2，phase 不变，打出 failures', async () => {
    await setupCustomChange('cw', 'guarded', GUARDED_WF)
    const before = await h.read('cw')

    const r = await advance('cw', {})
    expect(r.code).toBe(2)
    expect(await phaseOf('cw')).toBe('g1')
    expect(await h.read('cw')).toBe(before)
    expect(r.out.some((l) => l.includes('guard'))).toBe(true)
    expect(r.out.some((l) => l.includes('design_doc'))).toBe(true)
  })

  test('--max-steps 截停：chain 只真推进 1 步停在 c2', async () => {
    await setupCustomChange('cw', 'chain', CHAIN_WF)

    const r = await advance('cw', { maxSteps: 1 })
    expect(r.code).toBe(0)
    expect(await phaseOf('cw')).toBe('c2')
    expect(r.out.some((l) => l.includes('[STOP]') && l.includes('max-steps'))).toBe(true)
  })

  test('workflow 文件事后被删仍按初始化快照推进，不让插件更新锁死在途 Change', async () => {
    await setupCustomChange('cw', 'chain', CHAIN_WF)
    await rm(join(h.cwd, '.pipeline', 'workflows', 'chain.yaml'))

    const r = await advance('cw', {})
    expect(r.code).toBe(0)
    expect(await phaseOf('cw')).toBe('c3')
    expect(r.err.join('\n')).not.toContain('workflow plan fingerprint')
  })

  test('--dry-run 真不改盘（自定义轨）：报计划、phase 与字节均不变', async () => {
    await setupCustomChange('cw', 'chain', CHAIN_WF)
    const before = await h.read('cw')

    const r = await advance('cw', { dryRun: true })
    expect(r.code).toBe(0)
    expect(await h.read('cw')).toBe(before)
    expect(await phaseOf('cw')).toBe('c1')
    expect(r.out.some((l) => l.includes('[DRY-RUN]'))).toBe(true)
    expect(r.out.some((l) => l.includes('c1') && l.includes('c2'))).toBe(true)
  })
})
