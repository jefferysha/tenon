/**
 * 真实 e2e —— `tenon artifact register`（G2 P5）。零 mock：freshHarness 真临时项目 + 真 buildProgram
 * 解析 + 真 kernel store/loadWorkflow/compileWorkflow + 真 manifest EffectiveSkillResolver。
 *
 * 覆盖：default 轨真 state register（真 manifest producer 校验）、a|b token 拒、custom 轨 register、
 * custom 非 step skill 拒、custom step 不在图 / workflow 损坏 fail-loud、program 装配、--producer 缺失 usage。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { freshHarness, rm, type Harness } from './integration-harness.js'

const CH = 'artreg'

/** custom workflow：draft(skill-alpha/skill-beta，声明 design_doc effective-step-skills artifact) → final。 */
const CUSTOM_WF = `name: cwf
steps:
  - id: draft
    label: draft
    gate: null
    skills:
      - id: skill-alpha
      - id: skill-beta
    inputs: []
    outputs:
      - field: design_doc
        type: file_path
    artifacts:
      - field: design_doc
        type: file_path
        producer_policy: effective-step-skills
    guards: []
    transitions:
      - event: done
        to: final
  - id: final
    label: final
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions: []
`

describe('真实 e2e —— artifact register', () => {
  let h: Harness

  beforeEach(async () => {
    h = await freshHarness()
  })

  afterEach(async () => {
    await rm(h.cwd, { recursive: true, force: true })
  })

  async function writeWorkflow(name: string, yaml: string): Promise<void> {
    const wfDir = join(h.cwd, '.pipeline', 'workflows')
    await mkdir(wfDir, { recursive: true })
    await writeFile(join(wfDir, `${name}.yaml`), yaml, 'utf8')
  }

  // ── default 轨（真 manifest resolver）──
  test('default 轨：explore/frontend design_doc + 打包的 openspec-explore producer → 真写字段', async () => {
    expect(await h.run(['init', CH, '--track', 'frontend', '--preset', 'full'])).toBe(0)
    await h.seedPhase(CH, 'explore')

    expect(
      await h.run(['artifact', 'register', CH, 'design_doc', 'artifacts/design.md', '--producer', 'openspec-explore']),
      h.err.join('\n'),
    ).toBe(0)
    expect(h.err).toEqual([])
    expect(await h.read(CH)).toMatch(/^design_doc: artifacts\/design\.md$/m)
  })

  test('T-R6：动态 track 按 registry 的 frontend skill profile 校验 producer，不把 track id 当 profile', async () => {
    await mkdir(join(h.cwd, '.pipeline'), { recursive: true })
    await writeFile(join(h.cwd, '.pipeline', 'tracks.yaml'), `version: 1
tracks:
  - id: designer-mobile
    label: Designer Mobile
    workflow:
      default: default
      allowed: '*'
    policy_profile:
      review_seed: pending
      automation_eligible: true
      coverage_profile: frontend
      routing:
        enabled: false
      skills:
        matrix: true
        profile: frontend
`, 'utf8')

    // R6：registry entry 只提供 policy；可用性必须由 workflow branch 明确声明。
    // 使用真实 branch，避免把 registry-only track 当作 default workflow 的隐式分支。
    await writeWorkflow('designer-mobile', `name: designer-mobile
tracks:
  designer-mobile:
    label: Designer Mobile
    steps:
      - id: explore
        label: Explore
        gate: null
        skills:
          - id: openspec-explore
        inputs: []
        outputs:
          - field: design_doc
            type: file_path
        guards: []
        transitions: []
`)

    expect(await h.run(['init', CH, '--track', 'designer-mobile', '--preset', 'full', '--workflow', 'designer-mobile'])).toBe(0)
    expect(
      await h.run(['artifact', 'register', CH, 'design_doc', 'artifacts/design.md', '--producer', 'openspec-explore']),
      h.err.join('\n'),
    ).toBe(0)
    expect(h.err).toEqual([])
    expect(await h.read(CH)).toMatch(/^design_doc: artifacts\/design\.md$/m)
  })

  test('default 轨：整个 a|b token 作 producer → 拒（exit 1），字段不写', async () => {
    expect(await h.run(['init', CH, '--track', 'frontend', '--preset', 'full'])).toBe(0)
    await h.seedPhase(CH, 'explore')

    expect(await h.run(['artifact', 'register', CH, 'design_doc', 'x.md', '--producer', 'opsx:explore|openspec-explore'])).toBe(1)
    expect(await h.read(CH)).not.toMatch(/^design_doc: x\.md$/m)
  })

  test('default 轨：spec/pm 的显式 artifacts: [] 允许通过 set 写入 plan', async () => {
    expect(await h.run(['init', CH, '--track', 'pm', '--preset', 'full'])).toBe(0)
    await h.seedPhase(CH, 'spec')
    expect(await h.run(['set', CH, 'plan', 'p.md'])).toBe(0)
    expect(await h.read(CH)).toMatch(/^plan: p\.md$/m)
  })

  test('default 轨：spec/backend 的 plan 仍受 artifact 门禁约束', async () => {
    expect(await h.run(['init', CH, '--track', 'backend', '--preset', 'full'])).toBe(0)
    await h.seedPhase(CH, 'spec')
    expect(await h.run(['set', CH, 'plan', 'p.md'])).toBe(1)
    expect(h.err.join('\n')).toContain('artifact register')
    expect(await h.read(CH)).not.toMatch(/^plan: p\.md$/m)
  })

  test('default free：matrix=false 只关闭自动编排，不抹掉 verification_report producer allowlist', async () => {
    expect(await h.run(['init', CH, '--track', 'free', '--preset', 'full'])).toBe(0)
    await h.seedPhase(CH, 'verify')

    expect(
      await h.run([
        'artifact',
        'register',
        CH,
        'verification_report',
        'reports/verify.md',
        '--producer',
        'verification-before-completion',
      ]),
      h.err.join('\n'),
    ).toBe(0)
    expect(h.err).toEqual([])
    expect(await h.read(CH)).toMatch(/^verification_report: reports\/verify\.md$/m)
  })

  // ── custom 轨 ──
  test('custom 轨：draft step 声明的 skill-alpha 作 producer → 真写 design_doc', async () => {
    await writeWorkflow('cwf', CUSTOM_WF)
    expect(await h.run(['init', CH, '--track', 'backend', '--preset', 'full', '--workflow', 'cwf'])).toBe(0)
    expect(await h.read(CH)).toMatch(/^phase: draft$/m)

    expect(await h.run(['artifact', 'register', CH, 'design_doc', 'd.md', '--producer', 'skill-alpha'])).toBe(0)
    expect(h.err).toEqual([])
    expect(await h.read(CH)).toMatch(/^design_doc: d\.md$/m)
  })

  test('custom 轨：非 step skill 作 producer → 拒，字段不写', async () => {
    await writeWorkflow('cwf', CUSTOM_WF)
    expect(await h.run(['init', CH, '--track', 'backend', '--preset', 'full', '--workflow', 'cwf'])).toBe(0)
    expect(await h.run(['artifact', 'register', CH, 'design_doc', 'd.md', '--producer', 'not-a-step-skill'])).toBe(1)
    expect(await h.read(CH)).not.toMatch(/^design_doc: d\.md$/m)
  })

  test('custom 轨：初始化后改写 workflow 图仍按不可变快照登记', async () => {
    await writeWorkflow('cwf', CUSTOM_WF)
    expect(await h.run(['init', CH, '--track', 'backend', '--preset', 'full', '--workflow', 'cwf'])).toBe(0)
    // 改写 workflow：首 step 重命名为 draft2，原 phase 'draft' 不再在图里
    await writeWorkflow('cwf', CUSTOM_WF.replace('id: draft\n', 'id: draft2\n'))
    expect(await h.run(['artifact', 'register', CH, 'design_doc', 'd.md', '--producer', 'skill-alpha'])).toBe(0)
    expect(await h.read(CH)).toMatch(/^design_doc: d\.md$/m)
  })

  test('custom 轨：workflow 文件损坏不影响已初始化 Change 的冻结快照', async () => {
    await writeWorkflow('cwf', CUSTOM_WF)
    expect(await h.run(['init', CH, '--track', 'backend', '--preset', 'full', '--workflow', 'cwf'])).toBe(0)
    await writeWorkflow('cwf', 'name: cwf\nsteps:\n  - not-a-valid-step: true\n')
    expect(await h.run(['artifact', 'register', CH, 'design_doc', 'd.md', '--producer', 'skill-alpha'])).toBe(0)
    expect(await h.read(CH)).toMatch(/^design_doc: d\.md$/m)
  })

  // ── program 装配 / usage ──
  test('program 装配：bare `artifact`（无子命令）→ usage error exit 1', async () => {
    expect(await h.run(['artifact'])).toBe(1)
    expect(h.err.join('\n')).toContain('register')
  })

  test('--producer 缺失 → commander usage error（main 映射 exit 1）', async () => {
    expect(await h.run(['init', CH, '--track', 'frontend', '--preset', 'full'])).toBe(0)
    // harness 只接住 CliExit；commander 的 requiredOption 缺失抛 CommanderError（exitCode 1，main.ts 映射之）。
    await expect(h.run(['artifact', 'register', CH, 'design_doc', 'x.md'])).rejects.toMatchObject({ exitCode: 1 })
  })

  test('change 不存在 → exit 1（不建目录）', async () => {
    expect(await h.run(['artifact', 'register', 'nope', 'design_doc', 'x.md', '--producer', 'opsx:explore'])).toBe(1)
  })

  // ── P6 cutover：custom workflow 的 artifact 字段 set/set-many/cas 拒（codex 阻断 3 补测）──
  test('P6 custom 显式 artifact：draft 步 set design_doc → 拒 exit1，不写、指引 register', async () => {
    await writeWorkflow('cwf', CUSTOM_WF)
    expect(await h.run(['init', CH, '--track', 'backend', '--preset', 'full', '--workflow', 'cwf'])).toBe(0)
    expect(await h.read(CH)).toMatch(/^phase: draft$/m)
    expect(await h.run(['set', CH, 'design_doc', 'd.md'])).toBe(1)
    expect(await h.read(CH)).not.toMatch(/^design_doc: d\.md$/m)
    expect(h.err.join('\n')).toContain('artifact register')
  })

  test('P6 custom 显式 artifact：set-many 含 design_doc → 整批拒 exit1，非 artifact 字段也不写', async () => {
    await writeWorkflow('cwf', CUSTOM_WF)
    expect(await h.run(['init', CH, '--track', 'backend', '--preset', 'full', '--workflow', 'cwf'])).toBe(0)
    expect(await h.run(['set-many', CH, 'assignee=bob', 'design_doc=d.md'])).toBe(1)
    expect(await h.read(CH)).not.toMatch(/^design_doc: d\.md$/m)
    expect(await h.read(CH)).not.toMatch(/^assignee: bob$/m)
  })

  test('P6 custom 显式 artifact：cas design_doc → 拒 exit1（artifact 优先于 CAS 语义）', async () => {
    await writeWorkflow('cwf', CUSTOM_WF)
    expect(await h.run(['init', CH, '--track', 'backend', '--preset', 'full', '--workflow', 'cwf'])).toBe(0)
    expect(await h.run(['cas', CH, 'design_doc', '', 'd.md'])).toBe(1)
    expect(await h.read(CH)).not.toMatch(/^design_doc: d\.md$/m)
  })

  test('P6 custom fail-closed：workflow 损坏时 set artifact 候选字段 → 拒 exit1（不降级放行）', async () => {
    await writeWorkflow('cwf', CUSTOM_WF)
    expect(await h.run(['init', CH, '--track', 'backend', '--preset', 'full', '--workflow', 'cwf'])).toBe(0)
    await writeWorkflow('cwf', 'name: cwf\nsteps:\n  - not-a-valid-step: true\n')
    expect(await h.run(['set', CH, 'design_doc', 'd.md'])).toBe(1)
    expect(await h.read(CH)).not.toMatch(/^design_doc: d\.md$/m)
  })

  test('P6 阻断1 边界：custom workflow 把 track 声明为 file_path artifact → set track 被 cutover 拒（不绕过）', async () => {
    const TRACK_WF = `name: twf
steps:
  - id: s1
    label: s1
    gate: null
    skills: []
    inputs: []
    outputs:
      - field: track
        type: file_path
    artifacts:
      - field: track
        type: file_path
        producer_policy: effective-step-skills
    guards: []
    transitions: []
`
    await writeWorkflow('twf', TRACK_WF)
    expect(await h.run(['init', CH, '--track', 'backend', '--preset', 'full', '--workflow', 'twf'])).toBe(0)
    expect(await h.read(CH)).toMatch(/^phase: s1$/m)
    // track 是当前 step 的 artifact → set track 必须被 cutover 拒（旧代码无条件剔除 track 会漏判 → 绕过）
    expect(await h.run(['set', CH, 'track', 'frontend'])).toBe(1)
    expect(h.err.join('\n')).toContain('artifact register')
  })

  test('P6 custom 派生 artifact（file_path output、无显式 artifacts 块）：set 该字段 → 拒 exit1', async () => {
    const DERIVED_WF = `name: dwf
steps:
  - id: draft
    label: draft
    gate: null
    skills:
      - id: skill-alpha
    inputs: []
    outputs:
      - field: plan
        type: file_path
    guards: []
    transitions: []
`
    await writeWorkflow('dwf', DERIVED_WF)
    expect(await h.run(['init', CH, '--track', 'backend', '--preset', 'full', '--workflow', 'dwf'])).toBe(0)
    expect(await h.read(CH)).toMatch(/^phase: draft$/m)
    // plan 由 file_path output 派生成 artifact（无显式 artifacts 块）→ set 也拒
    expect(await h.run(['set', CH, 'plan', 'p.md'])).toBe(1)
    expect(await h.read(CH)).not.toMatch(/^plan: p\.md$/m)
    expect(h.err.join('\n')).toContain('artifact register')
  })

  test('P6 阻断1 边界：cas track（track 为 custom artifact）→ 拒 exit1（artifact 优先于 CAS）', async () => {
    const TRACK_WF2 = `name: twf2
steps:
  - id: s1
    label: s1
    gate: null
    skills: []
    inputs: []
    outputs:
      - field: track
        type: file_path
    artifacts:
      - field: track
        type: file_path
        producer_policy: effective-step-skills
    guards: []
    transitions: []
`
    await writeWorkflow('twf2', TRACK_WF2)
    expect(await h.run(['init', CH, '--track', 'backend', '--preset', 'full', '--workflow', 'twf2'])).toBe(0)
    // expect 命中当前 track=backend，但 track 是 artifact → 仍拒（不落盘、不因命中而写）
    expect(await h.run(['cas', CH, 'track', 'backend', 'frontend'])).toBe(1)
    expect(await h.read(CH)).toMatch(/^track: backend$/m)
  })

  test('P6 复审阻断1：set-many 切入把 track 声明为 artifact 的目标 workflow 同批写 track → 拒 exit1（meta 切入不绕过）', async () => {
    const TRACK_WF3 = `name: twf3
steps:
  - id: open
    label: open
    gate: null
    skills: []
    inputs: []
    outputs:
      - field: track
        type: file_path
    artifacts:
      - field: track
        type: file_path
        producer_policy: effective-step-skills
    guards: []
    transitions: []
`
    await writeWorkflow('twf3', TRACK_WF3)
    // 当前 default workflow（phase=open、不声明 track artifact）；切入 twf3（open step 声明 track 为 artifact）同批写 track
    expect(await h.run(['init', CH, '--track', 'backend', '--preset', 'full'])).toBe(0)
    expect(await h.run(['set-many', CH, 'workflow=twf3', 'track=frontend'])).toBe(1)
    expect(await h.read(CH)).not.toMatch(/^workflow: twf3$/m)
    expect(await h.read(CH)).not.toMatch(/^track: frontend$/m)
  })
})
