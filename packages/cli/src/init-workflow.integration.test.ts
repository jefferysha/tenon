/**
 * 真实 e2e —— `tenon init --workflow <name>`（whole-branch review 补：此前没有任何
 * 支持的命令能把一个 change 摆到自定义 workflow 的首个 step 上，除非该 step 恰好叫
 * `open`——`tenon set <name> phase <custom-id>` 被 manifest 派生的 7 相位枚举挡下，
 * `transition-custom-workflow.integration.test.ts` / `internal-skill-gate-hook.integration.
 * test.ts` 都不得不用手改 .pipeline.yaml 的 phase 行来搭测试夹具）。
 *
 * 零 mock：真 harness（真 buildProgram + 真临时项目 + 真 kernel store）+ 真在磁盘落一份
 * `.pipeline/workflows/<name>.yaml` + 真跑 `tenon init --workflow <name>`，断言真落盘的
 * workflow/phase 字段，并链式验证创建出的 change 立即可被其它真实命令（internal-skill-gate/
 * transition）消费，不需要任何手工改写状态文件。
 */
import { appendFile, lstat, mkdir, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { readSkillInvocationEvidence } from '@tenon/kernel'
import { freshHarness, rm, type Harness } from './integration-harness.js'

const TWO_STEP_WF = `name: onboarding
steps:
  - id: intake
    label: intake
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions:
      - event: complete
        to: done
  - id: done
    label: done
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions: []
`

const THREE_STEP_GOVERNED_WF = `name: compact-governed
openspec: true
document_contract:
  version: v1
  slots:
    - kind: proposal
      owner_step: shape
      producers: [writer]
  reads:
    - step: implement
      kinds: [proposal]
    - step: verify
      kinds: [proposal]
steps:
  - id: shape
    label: shape
    gate: null
    skills:
      - id: writer
    inputs: []
    outputs: []
    guards: []
    transitions:
      - event: shape-complete
        to: implement
  - id: implement
    label: implement
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions:
      - event: implement-complete
        to: verify
  - id: verify
    label: verify
    gate: review
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions: []
`

describe('真实 e2e —— init --workflow 落地自定义 workflow 的首个 step', () => {
  let h: Harness

  beforeEach(async () => {
    h = await freshHarness()
  })

  afterEach(async () => {
    await rm(h.cwd, { recursive: true, force: true })
  })

  async function seedWorkflow(name: string, yaml: string): Promise<void> {
    const wfDir = join(h.cwd, '.pipeline', 'workflows')
    await mkdir(wfDir, { recursive: true })
    await writeFile(join(wfDir, `${name}.yaml`), yaml, 'utf8')
  }

  test('省略 --workflow：workflow=default、phase=open（零回归，逐字对齐此前行为）', async () => {
    expect(await h.run(['init', 'demo', '--track', 'backend', '--preset', 'full'])).toBe(0)
    const content = await h.read('demo')
    expect(content).toMatch(/^workflow: default$/m)
    expect(content).toMatch(/^phase: open$/m)
    expect(JSON.parse(await h.readIn('demo', '.pipeline-workflow-governance.json')))
      .toMatchObject({ document_profile: 'legacy-full' })
    // state-first CLI init 也必须留下 OpenSpec 继续点；正常入口中 richer openspec-propose 若已先
    // 写这些文件，repository 的 wx scaffold 会保留它们，这里覆盖无 OpenSpec skill 的恢复路径。
    expect(await h.readIn('demo', 'proposal.md')).toContain('# 提案')
    expect(await h.readIn('demo', 'design.md')).toContain('# 设计')
    expect(await h.readIn('demo', 'tasks.md')).toContain('- [ ]')
  })

  test('治理文档默认中文，显式 --document-locale en 固定英文且非法值 fail-loud', async () => {
    expect(await h.run([
      'init', 'english-docs', '--track', 'backend', '--preset', 'full',
      '--document-locale', 'en',
    ])).toBe(0)
    expect(await h.readIn('english-docs', 'proposal.md')).toContain('# Proposal')
    expect(JSON.parse(await h.readIn('english-docs', '.pipeline-document-locale.json')))
      .toEqual({ version: 1, locale: 'en' })
    expect(await h.read('english-docs')).not.toMatch(/^pipeline_document_locale:/m)
    expect(await h.run([
      'document', 'scaffold', 'english-docs', 'superpower-design',
    ])).toBe(0)
    expect(await h.readIn(
      'english-docs',
      '../../../docs/superpowers/specs/english-docs-design.md',
    )).toContain('# Technical design')

    await h.seedGovernedDocumentEvidence('english-docs')
    await appendFile(
      join(h.cwd, 'openspec', 'changes', 'english-docs', '.pipeline-history.jsonl'),
      `${JSON.stringify({
        ts: '2026-07-25T00:00:00Z', kind: 'tool', raw: 'Skill: openspec-propose',
      })}\n`,
      'utf8',
    )
    await appendFile(
      join(h.cwd, 'openspec', 'changes', 'english-docs', '.pipeline-history.jsonl'),
      `${JSON.stringify({
        ts: '2026-07-25T00:00:00Z', kind: 'tool', raw: 'Skill: openspec-propose',
      })}\n`,
      'utf8',
    )
    expect(await h.run(['transition', 'english-docs', 'open-complete'])).toBe(0)
    expect(JSON.parse(await h.readIn('english-docs', '.pipeline-document-locale.json')))
      .toEqual({ version: 1, locale: 'en' })

    expect(await h.run([
      'init', 'bad-locale', '--track', 'backend', '--preset', 'full',
      '--document-locale', 'fr',
    ])).toBe(1)
    await expect(h.readIn('bad-locale', 'proposal.md')).rejects.toThrow()
  })

  test('document scaffold 只补 contract 声明的缺失结构，不伪造 document record', async () => {
    expect(await h.run(['init', 'scaffold-docs', '--track', 'frontend', '--preset', 'full'])).toBe(0)
    expect(await h.run([
      'document', 'scaffold', 'scaffold-docs', 'verification-report',
    ])).toBe(0)
    expect(await h.readIn(
      'scaffold-docs',
      '../../../docs/superpowers/reports/scaffold-docs-verify.md',
    )).toContain('# 验证报告')
    const ledger = JSON.parse(await h.readIn('scaffold-docs', '.pipeline-documents.json')) as {
      records: unknown[]
    }
    expect(ledger.records).toHaveLength(0)
  })

  test('document scaffold 拒绝父目录 symlink 逃逸项目根', async () => {
    const outside = `${h.cwd}-outside`
    await mkdir(outside, { recursive: true })
    try {
      expect(await h.run(['init', 'safe-docs', '--track', 'frontend', '--preset', 'full'])).toBe(0)
      await mkdir(join(h.cwd, 'docs'), { recursive: true })
      await symlink(outside, join(h.cwd, 'docs', 'superpowers'))
      expect(await h.run([
        'document', 'scaffold', 'safe-docs', 'verification-report',
      ])).toBe(1)
      await expect(lstat(join(outside, 'reports'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(join(outside, 'reports', 'safe-docs-verify.md'), 'utf8')).rejects.toThrow()
      expect(h.err.join('\n')).toContain('路径')
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  test('document scaffold 在 locale pin 前拒绝 symlink Change 根', async () => {
    const outside = `${h.cwd}-change-outside`
    await mkdir(outside, { recursive: true })
    try {
      expect(await h.run(['init', 'safe-root', '--track', 'frontend', '--preset', 'full'])).toBe(0)
      await rename(
        join(h.cwd, 'openspec', 'changes', 'safe-root'),
        join(h.cwd, 'openspec', 'changes', 'safe-root-real'),
      )
      await symlink(outside, join(h.cwd, 'openspec', 'changes', 'safe-root'))
      expect(await h.run([
        'document', 'scaffold', 'safe-root', 'verification-report',
      ])).toBe(1)
      await expect(readFile(join(outside, '.pipeline-document-locale.json'), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' })
      expect(h.err.join('\n')).toMatch(/symlink|Change 根/)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  test('tenon init 在预置 Change symlink 时零外部写入且不留下半状态', async () => {
    const outside = `${h.cwd}-init-outside`
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'marker.txt'), 'unchanged\n', 'utf8')
    try {
      await mkdir(join(h.cwd, 'openspec', 'changes'), { recursive: true })
      await symlink(outside, join(h.cwd, 'openspec', 'changes', 'symlink-init'))

      expect(await h.run([
        'init', 'symlink-init', '--track', 'backend', '--preset', 'full',
      ])).toBe(1)

      expect(await readdir(outside)).toEqual(['marker.txt'])
      expect(await readFile(join(outside, 'marker.txt'), 'utf8')).toBe('unchanged\n')
      expect(h.err.join('\n')).toMatch(/symlink|Change 根|可信/)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  test('delta spec scaffold 要求真实 capability，不把 Change 名当 capability', async () => {
    expect(await h.run(['init', 'capability-docs', '--track', 'backend', '--preset', 'full'])).toBe(0)
    expect(await h.run([
      'document', 'scaffold', 'capability-docs', 'delta-spec',
    ])).toBe(1)
    expect(h.err.join('\n')).toContain('--capability')
    expect(await h.run([
      'document', 'scaffold', 'capability-docs', 'delta-spec',
      '--capability', 'runtime-documents',
    ])).toBe(0)
    expect(await h.readIn(
      'capability-docs',
      'specs/runtime-documents/spec.md',
    )).toContain('# OpenSpec 增量规格')
    await expect(h.readIn(
      'capability-docs',
      'specs/capability-docs/spec.md',
    )).rejects.toThrow()
  })

  test('default phase 出口要求当前 visit 的 mandatory Skill 证据', async () => {
    const name = 'default-skill-gate'
    expect(await h.run(['init', name, '--track', 'backend', '--preset', 'full'])).toBe(0)
    await h.seedGovernedDocumentEvidence(name, { autoSkills: false })
    expect(await h.run(['transition', name, 'open-complete'])).toBe(2)
    expect(h.err.join('\n')).toContain('openspec-propose')
    await appendFile(
      join(h.cwd, 'openspec', 'changes', name, '.pipeline-history.jsonl'),
      [
        { ts: '2026-07-25T00:00:00Z', kind: 'tool', raw: 'Skill: openspec-propose' },
        { ts: '2026-07-25T00:00:00Z', kind: 'tool', raw: 'Skill: openspec-propose' },
      ].map((entry) => JSON.stringify(entry)).join('\n') + '\n',
      'utf8',
    )
    expect(await h.run(['transition', name, 'open-complete'])).toBe(0)
  })

  test('simple Track 默认绑定内建 simple workflow，从 change 开始且不生成完整 OpenSpec 文档链', async () => {
    expect(await h.run(['init', 'tiny-fix', '--track', 'simple', '--preset', 'tweak'])).toBe(0)
    const content = await h.read('tiny-fix')
    expect(content).toMatch(/^workflow: simple$/m)
    expect(content).toMatch(/^phase: change$/m)
    expect(content).not.toMatch(/^pipeline_document_profile:/m)
    await expect(h.readIn('tiny-fix', 'proposal.md')).rejects.toThrow()
    await expect(h.readIn('tiny-fix', 'tasks.md')).rejects.toThrow()
  })

  test('free/default 是完整七阶段 Change，但不继承标准 Track policy', async () => {
    expect(await h.run(['init', 'free-default', '--track', 'free', '--preset', 'full'])).toBe(0)
    const content = await h.read('free-default')
    expect(content).toMatch(/^track: free$/m)
    expect(content).toMatch(/^workflow: default$/m)
    expect(content).toMatch(/^phase: open$/m)
    expect(await h.readIn('free-default', 'proposal.md')).toContain('# 提案')
    expect(await h.readIn('free-default', 'design.md')).toContain('# 设计')
    expect(await h.readIn('free-default', 'tasks.md')).toContain('- [ ]')
    expect(await h.run(['set', 'free-default', 'automation', 'queued'])).toBe(0)
    expect(await h.run(['afk', 'enqueue', 'free-default'])).toBe(3)
  })

  test('free/default 可从 Open 完整推进到 Archive，且不要求工程双 review 或 PR URL', async () => {
    const name = 'free-lifecycle'
    expect(await h.run(['init', name, '--track', 'free', '--preset', 'full'])).toBe(0)
    await h.seedGovernedDocumentEvidence(name)
    await h.seedArtifact(name, 'design_doc', `openspec/changes/${name}/design.md`)
    await h.seedArtifact(name, 'plan', `docs/superpowers/plans/${name}.md`)
    await h.seedArtifact(name, 'verification_report', `docs/superpowers/reports/${name}.md`)
    const recordSkills = async (...skills: string[]): Promise<void> => {
      await appendFile(
        join(h.cwd, 'openspec', 'changes', name, '.pipeline-history.jsonl'),
        `${skills.map((skill) => JSON.stringify({
          ts: '2026-07-25T00:00:00Z', kind: 'tool', raw: `Skill: ${skill}`,
        })).join('\n')}\n`,
        'utf8',
      )
    }

    await recordSkills('openspec-propose')
    expect(await h.run(['transition', name, 'open-complete'])).toBe(0)
    await recordSkills('brainstorming')
    expect(await h.run(['document', 'read', name, 'all'])).toBe(0)
    expect(
      await h.run(['review', 'request', name, '--event', 'explore-complete']),
      h.err.join('\n'),
    ).toBe(0)
    expect(await h.run(['review', 'acknowledge', name])).toBe(0)
    expect(await h.run(['transition', name, 'explore-complete'])).toBe(0)
    await recordSkills('openspec-propose', 'writing-plans')
    expect(await h.run(['document', 'read', name, 'all'])).toBe(0)
    expect(await h.run(['review', 'request', name, '--event', 'spec-complete'])).toBe(0)
    expect(await h.run(['review', 'acknowledge', name])).toBe(0)
    expect(await h.run(['transition', name, 'spec-complete'])).toBe(0)

    // free 的 build 就绪证据是必需评审者 spec-consistency：跑过之后通过结论才写得进。
    await h.satisfyStepAgents(name)
    expect(await h.run([
      'set-many', name,
      'build_mode=direct', 'isolation=worktree', 'direct_override=true',
      'pre_verify_review_result=pass',
    ]), h.err.join('\n')).toBe(0)
    await recordSkills('test-driven-development')
    expect(await h.run(['document', 'read', name, 'all'])).toBe(0)
    expect(await h.run(['transition', name, 'build-complete'])).toBe(0)
    expect(await h.run(['set', name, 'branch_status', 'handled'])).toBe(0)
    await recordSkills('verification-before-completion')
    expect(await h.run(['document', 'read', name, 'all'])).toBe(0)
    expect(
      await h.run(['review', 'request', name, '--event', 'verify-pass']),
      h.err.join('\n'),
    ).toBe(0)
    expect(await h.run(['review', 'acknowledge', name])).toBe(0)
    expect(await h.run(['transition', name, 'verify-pass'])).toBe(0)

    await recordSkills('finishing-a-development-branch')
    await h.seedAppliedSpec(name)
    expect(await h.run(['document', 'read', name, 'all'])).toBe(0)
    expect(await h.run(['transition', name, 'ship-complete']), h.err.join('\n')).toBe(0)
    expect(await h.run(['document', 'read', name, 'all'])).toBe(0)
    await recordSkills()
    expect(await h.run(['transition', name, 'archived'])).toBe(0)
    const completed = await h.read(name)
    expect(completed).toMatch(/^track: free$/m)
    expect(completed).toMatch(/^phase: archive$/m)
    expect(completed).toMatch(/^verify_result: pass$/m)
    expect(completed).toMatch(/^agent_review_result: pending$/m)
    expect(completed).toMatch(/^codex_review_result: pending$/m)
    expect(completed).toMatch(/^pr_url: null$/m)
    expect(completed).toMatch(/^archived: true$/m)
  }, 30_000)

  test('simple workflow 完整生命周期可验证后结束；范围扩大走独立 escalated 终态', async () => {
    expect(await h.run(['init', 'tiny-done', '--track', 'simple', '--preset', 'tweak'])).toBe(0)
    // change 步骤不声明技能：边界写在 step prompt 里，转换不再要求技能证据。
    expect(await h.run(['transition', 'tiny-done', 'change-complete'])).toBe(0)
    expect((await h.read('tiny-done'))).toMatch(/^phase: verify$/m)
    expect(await h.run(['transition', 'tiny-done', 'verify-pass'])).toBe(2)
    await appendFile(
      join(h.cwd, 'openspec', 'changes', 'tiny-done', '.pipeline-history.jsonl'),
      `${JSON.stringify({ ts: '2026-07-24T00:01:00Z', kind: 'tool', raw: 'Skill: verification-before-completion' })}\n`,
      'utf8',
    )
    expect(await h.run(['transition', 'tiny-done', 'verify-pass'])).toBe(0)
    const completed = await h.read('tiny-done')
    expect(completed).toMatch(/^phase: done$/m)
    expect(completed).toMatch(/^phase_status: done$/m)
    expect(completed).toMatch(/^verify_result: pass$/m)
    expect(completed).toMatch(/^archived: true$/m)

    expect(await h.run(['init', 'tiny-expanded', '--track', 'simple', '--preset', 'tweak'])).toBe(0)
    expect(await h.run(['transition', 'tiny-expanded', 'scope-expanded'])).toBe(0)
    const escalated = await h.read('tiny-expanded')
    expect(escalated).toMatch(/^phase: escalated$/m)
    expect(escalated).toMatch(/^phase_status: done$/m)
    expect(escalated).toMatch(/^archived: true$/m)

    expect(await h.run(['list', '--json'])).toBe(0)
    const active = JSON.parse(h.out[0]!) as {
      changes: Array<{ name: string }>
    }
    expect(active.changes.map((change) => change.name)).not.toContain('tiny-done')
    expect(active.changes.map((change) => change.name)).not.toContain('tiny-expanded')
  }, 15_000)

  test('--workflow onboarding：真落 workflow=onboarding + phase=intake（workflow 首个 step 的 id，不是硬编码 open）', async () => {
    await seedWorkflow('onboarding', TWO_STEP_WF)
    expect(await h.run(['init', 'demo', '--track', 'backend', '--preset', 'full', '--workflow', 'onboarding'])).toBe(0)
    const content = await h.read('demo')
    expect(content).toMatch(/^workflow: onboarding$/m)
    expect(content).toMatch(/^phase: intake$/m)
  })

  test('free 可绑定任意已存在的自定义 Workflow，并从其真实首 Step 开始', async () => {
    await seedWorkflow('onboarding', TWO_STEP_WF)
    expect(await h.run(['init', 'free-custom', '--track', 'free', '--preset', 'full', '--workflow', 'onboarding'])).toBe(0)
    const content = await h.read('free-custom')
    expect(content).toMatch(/^track: free$/m)
    expect(content).toMatch(/^workflow: onboarding$/m)
    expect(content).toMatch(/^phase: intake$/m)
    expect(await h.run(['internal-skill-gate', 'free-custom', 'anything'])).toBe(0)
  })

  test('三步 workflow 可执行声明式 document contract，不继承七阶段文档矩阵', async () => {
    await seedWorkflow('compact-governed', THREE_STEP_GOVERNED_WF)
    expect(
      await h.run([
        'init', 'compact-run', '--track', 'free', '--preset', 'full',
        '--workflow', 'compact-governed',
      ]),
    ).toBe(0)
    expect((await h.read('compact-run'))).toMatch(/^phase: shape$/m)
    expect(JSON.parse(await h.readIn('compact-run', '.pipeline-workflow-governance.json')))
      .toMatchObject({ document_profile: 'document-v1' })

    expect(await h.run(['document', 'status', 'compact-run'])).toBe(2)
    expect(h.out.join('\n')).toContain("proposal")
    expect(h.out.join('\n')).not.toContain('superpower-design')

    const documentPath = join(h.cwd, 'docs', 'compact-run-proposal.md')
    await mkdir(join(h.cwd, 'docs'), { recursive: true })
    await writeFile(documentPath, '# Compact proposal\n', 'utf8')
    await appendFile(
      join(h.cwd, 'openspec', 'changes', 'compact-run', '.pipeline-history.jsonl'),
      `${JSON.stringify({ ts: '2026-07-07T00:00:00Z', kind: 'tool', raw: 'Skill: writer' })}\n`,
      'utf8',
    )
    // A bare history row cannot mint v1. The native PostToolUse adapter must seal the exact host
    // session/tool identity against the canonical visit before document production can complete it.
    expect(
      await h.run([
        'document', 'record', 'compact-run', 'proposal', 'docs/compact-run-proposal.md',
        '--producer', 'writer',
      ]),
    ).toBe(1)
    expect(await h.run([
      'internal-native-skill-receipt', 'compact-run', 'writer',
      'native-session-compact', 'native-tool-compact', '2026-07-07T00:00:00Z',
    ])).toBe(0)
    expect(
      await h.run([
        'document', 'record', 'compact-run', 'proposal', 'docs/compact-run-proposal.md',
        '--producer', 'writer',
      ]),
    ).toBe(0)
    const evidence = await readSkillInvocationEvidence(
      join(h.cwd, 'openspec', 'changes', 'compact-run'),
    )
    expect(evidence.items).toEqual([
      expect.objectContaining({
        skill: { id: 'writer', version: '1' },
        status: 'completed',
        artifacts: [expect.objectContaining({ ref: 'docs/compact-run-proposal.md', state: 'bound' })],
      }),
    ])
    expect(await h.run(['transition', 'compact-run', 'shape-complete'])).toBe(0)
    expect((await h.read('compact-run'))).toMatch(/^phase: implement$/m)

    expect(await h.run(['check', 'compact-run'])).toBe(2)
    expect(h.out.join('\n')).toContain("尚未由 implement 的当前 step visit 读取")
    expect(await h.run(['document', 'read', 'compact-run', 'all'])).toBe(0)
    expect(await h.run(['check', 'compact-run'])).toBe(0)
    expect(await h.run(['transition', 'compact-run', 'implement-complete'])).toBe(0)
    expect((await h.read('compact-run'))).toMatch(/^phase: verify$/m)

    expect(await h.run(['check', 'compact-run'])).toBe(2)
    expect(h.out.join('\n')).toContain("尚未由 verify 的当前 step visit 读取")
    expect(h.out.join('\n')).not.toContain('delta-spec')
    expect(await h.run(['document', 'read', 'compact-run', 'all'])).toBe(0)
    expect(await h.run(['check', 'compact-run'])).toBe(0)
  })

  test('document-v1 初始化绑定完整快照，后续删除 contract 仍按原 contract 治理', async () => {
    await seedWorkflow('compact-governed', THREE_STEP_GOVERNED_WF)
    const initCode = await h.run([
      'init', 'bound-docs', '--track', 'free', '--preset', 'full',
      '--workflow', 'compact-governed',
    ])
    expect(initCode, h.err.join('\n')).toBe(0)
    expect(JSON.parse(
      await h.readIn('bound-docs', '.pipeline-workflow-governance.json'),
    ).document_governance_fingerprint).toMatch(/^[0-9a-f]{64}$/)

    await seedWorkflow(
      'compact-governed',
      THREE_STEP_GOVERNED_WF.replace(/document_contract:[\s\S]*?(?=steps:)/, ''),
    )
    expect(await h.run(['document', 'status', 'bound-docs'])).toBe(2)
    expect(h.err.join('\n')).not.toContain('不可降级为自由模式')
    expect(h.out.join('\n')).toContain('workflow=compact-governed')
  })

  test('openspec: true 的自定义 workflow（无契约）建 ledger；仍写 openspec_contract 的 YAML 按 E1 拒绝', async () => {
    await seedWorkflow('bare-governed', TWO_STEP_WF.replace(/^name: \S+\n/, 'name: bare-governed\nopenspec: true\n'))
    expect(await h.run(['init', 'bare', '--track', 'backend', '--preset', 'full', '--workflow', 'bare-governed']), h.err.join('\n')).toBe(0)
    expect(JSON.parse(await h.readIn('bare', '.pipeline-documents.json'))).toMatchObject({ records: [] })
    expect(await h.run(['document', 'status', 'bare'])).toBe(0)

    await seedWorkflow('old-contract', TWO_STEP_WF.replace(/^name: \S+\n/, 'name: old-contract\nopenspec_contract: required\n'))
    expect(await h.run(['init', 'old', '--track', 'backend', '--preset', 'full', '--workflow', 'old-contract'])).toBe(1)
    expect(h.err.join('\n')).toContain('openspec_contract 已移除——改为 openspec: true 并声明 document_contract')
    await expect(h.read('old')).rejects.toThrow()
  })

  test('--workflow 指向不存在的文件：exit 1，不落盘任何 change 目录（先校验后创建，不留半成品）', async () => {
    const code = await h.run(['init', 'demo', '--track', 'backend', '--preset', 'full', '--workflow', 'ghost'])
    expect(code).toBe(1)
    expect(h.err.join('\n')).toContain("workflow 'ghost' 未找到")
    await expect(h.read('demo')).rejects.toThrow()
  })

  test('--workflow 指向非法 workflow（transitions.to 指向不存在的 step）：exit 1，不落盘（E5 保存时校验在 init 这一步同样生效，非法 workflow 不会先创建 change 再报错）', async () => {
    await seedWorkflow(
      'broken',
      `name: broken
steps:
  - id: s1
    label: x
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions:
      - event: go
        to: does-not-exist
`,
    )
    const code = await h.run(['init', 'demo', '--track', 'backend', '--preset', 'full', '--workflow', 'broken'])
    expect(code).toBe(1)
    expect(h.err.join('\n')).toContain('does-not-exist')
    await expect(h.read('demo')).rejects.toThrow()
  })

  test('端到端链式验证：init --workflow 创建的 change 立即可被 internal-skill-gate 消费，不需要任何手工改写状态文件', async () => {
    await seedWorkflow('onboarding', TWO_STEP_WF)
    expect(await h.run(['init', 'demo', '--track', 'backend', '--preset', 'full', '--workflow', 'onboarding'])).toBe(0)
    // internal-skill-gate 对 skills:[] 的 step 一律放行（opt-in 语义）——只是验证它能读到正确
    // 的 workflow/phase 组合并找到 step，而不是报 "step 不在 workflow 里"。
    const code = await h.run(['internal-skill-gate', 'demo', 'anything'])
    expect(code).toBe(0)
    expect(h.err.join('\n')).not.toContain('不在 workflow')
  })

  test('端到端链式验证：init --workflow 创建的 change 立即可被 transition 真推进（真实 event 名，无需手改 phase）', async () => {
    await seedWorkflow('onboarding', TWO_STEP_WF)
    expect(await h.run(['init', 'demo', '--track', 'backend', '--preset', 'full', '--workflow', 'onboarding'])).toBe(0)
    expect(await h.run(['transition', 'demo', 'complete'])).toBe(0)
    const content = await h.read('demo')
    expect(content).toMatch(/^phase: done$/m)
  })
  test('工作流引用库里没有的 agent：exit 1，不落盘任何 change 目录（冻结在发布之前解析）', async () => {
    await seedWorkflow('ghost-agent', `name: ghost-agent
steps:
  - id: s1
    label: x
    gate: null
    skills: []
    inputs: []
    outputs: []
    agents:
      reviewers:
        - agent: no-such-agent
          required: true
          block_at: high
    guards: []
    transitions: []
`)
    const code = await h.run(['init', 'demo', '--track', 'backend', '--preset', 'full', '--workflow', 'ghost-agent'])
    expect(code).toBe(1)
    expect(h.err.join('\n')).toContain('no-such-agent')
    await expect(h.read('demo')).rejects.toThrow()
  })

  test('内建 agent 随 Change 创建冻结进 .pipeline-frozen，之后改库不影响该 Change', async () => {
    await seedWorkflow('reviewed', `name: reviewed
steps:
  - id: s1
    label: x
    gate: null
    skills: []
    inputs: []
    outputs: []
    agents:
      reviewers:
        - agent: security
          required: true
          block_at: medium
    guards: []
    transitions: []
`)
    expect(await h.run(['init', 'demo', '--track', 'backend', '--preset', 'full', '--workflow', 'reviewed'])).toBe(0)
    const lock = JSON.parse(await h.readIn('demo', '.pipeline-frozen/lock.json'))
    expect(lock).toMatchObject({ version: 1, agents: [{ name: 'security', source: 'builtin' }] })
    expect(lock.agents[0].digest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(await h.readIn('demo', '.pipeline-frozen/agents/security.md')).toContain('name: security')
  })
})
