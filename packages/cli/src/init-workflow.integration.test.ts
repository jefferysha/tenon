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
import { readSkillInvocationEvidence, serializeWorkflow } from '@tenon/kernel'
import { simpleWorkflow, targetDefaultWorkflow } from '@tenon/kernel/workflow/test-support'
import { freshHarness, rm, type Harness } from './integration-harness.js'

/** 已退役的内建 simple 的定义（change → verify → done / escalated），改名为项目自己的平铺工作流 tiny。 */
const TINY_WF = serializeWorkflow({ ...simpleWorkflow(), name: 'tiny' })

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

  test('省略 --workflow：workflow=default、phase=open（新任务：不铺 proposal / design，没有文档账本，留 tasks.md 与第一次步骤访问）', async () => {
    expect(await h.run(['init', 'demo', '--track', 'backend', '--preset', 'full'])).toBe(0)
    const content = await h.read('demo')
    expect(content).toMatch(/^workflow: default$/m)
    expect(content).toMatch(/^phase: open$/m)
    // 没有旧文档契约：治理绑定里没有 legacy-full / document-v1，文档账本不存在，proposal / design 由技能写出而不是预铺。
    expect(JSON.parse(await h.readIn('demo', '.pipeline-workflow-governance.json')).document_profile).toBeUndefined()
    await expect(h.readIn('demo', '.pipeline-documents.json')).rejects.toThrow()
    await expect(h.readIn('demo', 'proposal.md')).rejects.toThrow()
    await expect(h.readIn('demo', 'design.md')).rejects.toThrow()
    // 任务清单 tasks.md 仍在；产出账本里已经有第一次步骤访问（open）。
    expect(await h.readIn('demo', 'tasks.md')).toContain('- [ ]')
    const ledger = JSON.parse(await h.readIn('demo', '.pipeline-step-outputs.json')) as {
      visits: { step: string; sequence: number; exit: unknown }[]
    }
    expect(ledger.visits).toMatchObject([{ step: 'open', sequence: 0, exit: null }])
  })

  test('升级前创建的任务（冻结着文档契约）：workflow=default、phase=open、legacy-full 绑定、三份 OpenSpec 骨架照旧', async () => {
    expect(await h.initLegacyContractDefault('demo', 'backend')).toBe(0)
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
    await expect(h.readIn('demo', '.pipeline-step-outputs.json')).rejects.toThrow()
  })

  test('新任务的治理文档语言：显式 --document-locale en 固定英文（tasks.md 与语言文件）且非法值 fail-loud', async () => {
    expect(await h.run([
      'init', 'english-tasks', '--track', 'backend', '--preset', 'full',
      '--document-locale', 'en',
    ])).toBe(0)
    // 阶段标题取工作流里的步骤标签，任务项是按语言渲染的模板文案。
    expect(await h.readIn('english-tasks', 'tasks.md')).toContain('- [ ] Break this phase goal into verifiable tasks.')
    expect(JSON.parse(await h.readIn('english-tasks', '.pipeline-document-locale.json')))
      .toEqual({ version: 1, locale: 'en' })
    expect(await h.run([
      'init', 'bad-locale-observed', '--track', 'backend', '--preset', 'full',
      '--document-locale', 'fr',
    ])).toBe(1)
    await expect(h.readIn('bad-locale-observed', 'tasks.md')).rejects.toThrow()
  })

  test('治理文档默认中文，显式 --document-locale en 固定英文且非法值 fail-loud（契约模式：scaffold 的三份文档）', async () => {
    expect(await h.initLegacyContractDefault('english-docs', 'backend', 'full', { documentLocale: 'en' })).toBe(0)
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
    expect(await h.initLegacyContractDefault('scaffold-docs', 'frontend')).toBe(0)
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
      expect(await h.initLegacyContractDefault('safe-docs', 'frontend')).toBe(0)
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
      expect(await h.initLegacyContractDefault('safe-root', 'frontend')).toBe(0)
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
    expect(await h.initLegacyContractDefault('capability-docs', 'backend')).toBe(0)
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

  test('轻量的平铺工作流（原内建 simple 的定义）从 change 开始，且不生成完整 OpenSpec 文档链', async () => {
    await seedWorkflow('tiny', TINY_WF)
    expect(await h.run(['init', 'tiny-fix', '--preset', 'tweak', '--workflow', 'tiny'])).toBe(0)
    const content = await h.read('tiny-fix')
    expect(content).toMatch(/^workflow: tiny$/m)
    expect(content).toMatch(/^track: tiny$/m)
    expect(content).toMatch(/^phase: change$/m)
    expect(content).not.toMatch(/^pipeline_document_profile:/m)
    await expect(h.readIn('tiny-fix', 'proposal.md')).rejects.toThrow()
    await expect(h.readIn('tiny-fix', 'tasks.md')).rejects.toThrow()
  })

  test('free 轨道已退役（--track free 报错并列出可选轨道），升级前建的 free 在途任务走旧引擎的用例在 track-resolution 里', async () => {
    expect(await h.run(['init', 'free-default', '--track', 'free', '--preset', 'full'])).toBe(1)
    expect(h.err.join('\n')).toContain('lite, pm, frontend, backend')
    await expect(h.readIn('free-default', 'proposal.md')).rejects.toThrow()
  })

  test('轻量工作流完整生命周期可验证后结束；范围扩大走独立 escalated 终态', async () => {
    await seedWorkflow('tiny', TINY_WF)
    expect(await h.run(['init', 'tiny-done', '--preset', 'tweak', '--workflow', 'tiny'])).toBe(0)
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

    expect(await h.run(['init', 'tiny-expanded', '--preset', 'tweak', '--workflow', 'tiny'])).toBe(0)
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
    expect(await h.run(['init', 'demo', '--preset', 'full', '--workflow', 'onboarding'])).toBe(0)
    const content = await h.read('demo')
    expect(content).toMatch(/^workflow: onboarding$/m)
    expect(content).toMatch(/^phase: intake$/m)
  })

  test('平铺的自定义 Workflow 不用写 --track：轨道是与工作流同名的隐式轨道，从其真实首 Step 开始', async () => {
    await seedWorkflow('onboarding', TWO_STEP_WF)
    expect(await h.run(['init', 'flat-custom', '--preset', 'full', '--workflow', 'onboarding'])).toBe(0)
    const content = await h.read('flat-custom')
    expect(content).toMatch(/^track: onboarding$/m)
    expect(content).toMatch(/^workflow: onboarding$/m)
    expect(content).toMatch(/^phase: intake$/m)
    expect(await h.run(['internal-skill-gate', 'flat-custom', 'anything'])).toBe(0)
  })

  // `document_contract` 已不能再写进新的 workflow 定义（校验直接拒绝，见 design.integration.test.ts）；
  // 升级前创建的任务冻结着它：下面几条用不经校验的快照立项，其后命令只认冻结的契约。
  test('三步 workflow 可执行声明式 document contract，不继承七阶段文档矩阵', async () => {
    expect(await h.initLegacyWorkflow('compact-run', THREE_STEP_GOVERNED_WF)).toBe(0)
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
    const initCode = await h.initLegacyWorkflow('bound-docs', THREE_STEP_GOVERNED_WF)
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

  test('openspec: true 的自定义 workflow（无契约）：不建文档账本，留 tasks.md 与步骤产出账本；仍写 openspec_contract 的 YAML 按 E1 拒绝', async () => {
    await seedWorkflow('bare-governed', TWO_STEP_WF.replace(/^name: \S+\n/, 'name: bare-governed\nopenspec: true\n'))
    expect(await h.run(['init', 'bare', '--preset', 'full', '--workflow', 'bare-governed']), h.err.join('\n')).toBe(0)
    // 走 OpenSpec 与有没有文档契约无关：openspec: true 只决定 tasks.md 与规格校验 / 应用 / 归档，文档由离开步骤时的观察记录。
    await expect(h.readIn('bare', '.pipeline-documents.json')).rejects.toThrow()
    expect(await h.readIn('bare', 'tasks.md')).toContain('- [ ]')
    expect(JSON.parse(await h.readIn('bare', '.pipeline-step-outputs.json')).visits).toMatchObject([{ step: 'intake', exit: null }])
    expect(await h.run(['document', 'status', 'bare'])).toBe(0)

    await seedWorkflow('old-contract', TWO_STEP_WF.replace(/^name: \S+\n/, 'name: old-contract\nopenspec_contract: required\n'))
    expect(await h.run(['init', 'old', '--preset', 'full', '--workflow', 'old-contract'])).toBe(1)
    expect(h.err.join('\n')).toContain('openspec_contract 已移除——改为顶层 openspec: true，或在分支（tracks.<id>）下写 spec: openspec')
    expect(h.err.join('\n')).not.toContain('document_contract')
    await expect(h.read('old')).rejects.toThrow()
  })

  test('--workflow 指向不存在的文件：exit 1，不落盘任何 change 目录（先校验后创建，不留半成品）', async () => {
    const code = await h.run(['init', 'demo', '--preset', 'full', '--workflow', 'ghost'])
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
    const code = await h.run(['init', 'demo', '--preset', 'full', '--workflow', 'broken'])
    expect(code).toBe(1)
    expect(h.err.join('\n')).toContain('does-not-exist')
    await expect(h.read('demo')).rejects.toThrow()
  })

  test('端到端链式验证：init --workflow 创建的 change 立即可被 internal-skill-gate 消费，不需要任何手工改写状态文件', async () => {
    await seedWorkflow('onboarding', TWO_STEP_WF)
    expect(await h.run(['init', 'demo', '--preset', 'full', '--workflow', 'onboarding'])).toBe(0)
    // internal-skill-gate 对 skills:[] 的 step 一律放行（opt-in 语义）——只是验证它能读到正确
    // 的 workflow/phase 组合并找到 step，而不是报 "step 不在 workflow 里"。
    const code = await h.run(['internal-skill-gate', 'demo', 'anything'])
    expect(code).toBe(0)
    expect(h.err.join('\n')).not.toContain('不在 workflow')
  })

  test('端到端链式验证：init --workflow 创建的 change 立即可被 transition 真推进（真实 event 名，无需手改 phase）', async () => {
    await seedWorkflow('onboarding', TWO_STEP_WF)
    expect(await h.run(['init', 'demo', '--preset', 'full', '--workflow', 'onboarding'])).toBe(0)
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
    const code = await h.run(['init', 'demo', '--preset', 'full', '--workflow', 'ghost-agent'])
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
    expect(await h.run(['init', 'demo', '--preset', 'full', '--workflow', 'reviewed'])).toBe(0)
    const lock = JSON.parse(await h.readIn('demo', '.pipeline-frozen/lock.json'))
    expect(lock).toMatchObject({ version: 1, agents: [{ name: 'security', source: 'builtin' }] })
    expect(lock.agents[0].digest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(await h.readIn('demo', '.pipeline-frozen/agents/security.md')).toContain('name: security')
  })
})

/**
 * 轨道解析（计划 Task 3）：`init` 只经 loadWorkflow + resolveTrack 解析轨道，旧工作流名给出替代命令，
 * 旧 `.pipeline/tracks.yaml` 只提示一行、不读取。default 用一份目标形态的覆盖文件（lite / pm / frontend /
 * backend，没有 chat / free）——模板改写前（计划 Task 6）用它代替真文件。
 */
describe('init × 轨道只认工作流分支', () => {
  let h: Harness

  beforeEach(async () => {
    h = await freshHarness()
    await mkdir(join(h.cwd, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(h.cwd, '.pipeline', 'workflows', 'default.yaml'), serializeWorkflow(targetDefaultWorkflow()), 'utf8')
  })

  afterEach(async () => {
    await rm(h.cwd, { recursive: true, force: true })
  })

  const created = async (name: string): Promise<boolean> =>
    lstat(join(h.cwd, 'openspec', 'changes', name)).then(() => true, () => false)

  test.each(['standard', 'simple'])('--workflow %s 已退役：exit 1，给出 default 的 lite 轨道命令，不建 change', async (workflow) => {
    expect(await h.run(['init', 'x', '--workflow', workflow, '--preset', 'full'])).toBe(1)
    expect(h.err.join('\n')).toContain('--workflow default --track lite')
    expect(await created('x')).toBe(false)
  })

  test('--workflow default --track free：default 里没有的轨道 → exit 1，列出可选轨道，不建 change', async () => {
    expect(await h.run(['init', 'x', '--workflow', 'default', '--track', 'free', '--preset', 'full'])).toBe(1)
    expect(h.err.join('\n')).toContain('lite, pm, frontend, backend')
    expect(await created('x')).toBe(false)
  })

  test('--track chat 同样拒', async () => {
    expect(await h.run(['init', 'x', '--track', 'chat', '--preset', 'full'])).toBe(1)
    expect(h.err.join('\n')).toContain('lite, pm, frontend, backend')
    expect(await created('x')).toBe(false)
  })

  /** 退役入口的报错与替代提示同一口径：「X 已退役；改用：…」，与 `--workflow standard|simple` 的提示一致。 */
  test.each(['standard', 'simple'])('--track %s 已退役：列出可选轨道，并给出 default 的 lite 轨道命令', async (track) => {
    expect(await h.run(['init', 'x', '--track', track, '--preset', 'full'])).toBe(1)
    const err = h.err.join('\n')
    expect(err).toContain('lite, pm, frontend, backend')
    expect(err).toContain(`轨道 '${track}' 已退役；改用：tenon init <名字> --workflow default --track lite`)
    expect(await created('x')).toBe(false)
  })

  test.each(['chat', 'free'])('--track %s 已退役：没有等价轨道，提示从可选轨道里选，纯讨论不用建任务', async (track) => {
    expect(await h.run(['init', 'x', '--track', track, '--preset', 'full'])).toBe(1)
    const err = h.err.join('\n')
    expect(err).toContain('lite, pm, frontend, backend')
    expect(err).toContain(`轨道 '${track}' 已退役`)
    expect(err).not.toContain('--track lite')
    expect(await created('x')).toBe(false)
  })

  test('没退役过的未知轨道只列出可选轨道，不说「已退役」', async () => {
    expect(await h.run(['init', 'x', '--track', 'nonsense', '--preset', 'full'])).toBe(1)
    expect(h.err.join('\n')).toContain('lite, pm, frontend, backend')
    expect(h.err.join('\n')).not.toContain('已退役')
  })

  test('--workflow design-system --preset full 不带 --track 成功：平铺工作流的唯一隐式轨道', async () => {
    expect(await h.run(['init', 'x', '--workflow', 'design-system', '--preset', 'full']), h.err.join('\n')).toBe(0)
    const content = await h.read('x')
    expect(content).toMatch(/^workflow: design-system$/m)
    expect(content).toMatch(/^track: design-system$/m)
    expect(content).toMatch(/^phase: direction$/m)
  })

  test('平铺工作流写了别的轨道名 → exit 1 并提示不用写 --track', async () => {
    expect(await h.run(['init', 'x', '--workflow', 'design-system', '--track', 'free', '--preset', 'full'])).toBe(1)
    expect(h.err.join('\n')).toContain('不用写 --track')
    expect(await created('x')).toBe(false)
  })

  /** `--domain`：轻量任务创建时记下领域轨道，之后升级为重型任务时 `escalate.then` 直接用它。 */
  test('--track lite --domain backend：领域记进任务状态，tenon get 读得到', async () => {
    expect(await h.run(['init', 'x', '--track', 'lite', '--domain', 'backend', '--preset', 'full']), h.err.join('\n')).toBe(0)
    expect(await h.read('x')).toMatch(/^domain: backend$/m)
    expect(await h.run(['get', 'x', 'domain'])).toBe(0)
    expect(h.out.join('\n')).toBe('backend')
  })

  test('不给 --domain：状态文件里没有 domain 这一行，tenon get 读到空', async () => {
    expect(await h.run(['init', 'x', '--track', 'lite', '--preset', 'full']), h.err.join('\n')).toBe(0)
    expect(await h.read('x')).not.toContain('domain')
    expect(await h.run(['get', 'x', 'domain'])).toBe(0)
    expect(h.out.join('\n')).toBe('')
  })

  test.each(['lite', 'nope'])('--domain %s（等于本任务轨道 / 工作流里没有）：exit 1，列出可选轨道，不建 change', async (domain) => {
    expect(await h.run(['init', 'x', '--track', 'lite', '--domain', domain, '--preset', 'full'])).toBe(1)
    expect(h.err.join('\n')).toContain(`--domain '${domain}'`)
    expect(h.err.join('\n')).toContain('pm, frontend, backend')
    expect(await created('x')).toBe(false)
  })

  test('平铺工作流带 --domain：没有别的轨道可记，exit 1，不建 change', async () => {
    expect(await h.run(['init', 'x', '--workflow', 'design-system', '--domain', 'backend', '--preset', 'full'])).toBe(1)
    expect(h.err.join('\n')).toContain('没有可记的领域，不用写 --domain')
    expect(await created('x')).toBe(false)
  })

  test('有分支的工作流不带 --track（非交互）：exit 1，缺省项里列出可选轨道', async () => {
    expect(await h.run(['init', 'x', '--preset', 'full'])).toBe(1)
    expect(h.err.join('\n')).toContain('--track（lite|pm|frontend|backend）')
    expect(await created('x')).toBe(false)
  })

  test('项目含 .pipeline/tracks.yaml 时 init 成功（不读取它，写坏也无妨），stderr 只有一行迁移提示', async () => {
    await writeFile(join(h.cwd, '.pipeline', 'tracks.yaml'), 'version: [broken\n', 'utf8')
    expect(await h.run(['init', 'x', '--track', 'backend', '--preset', 'full']), h.err.join('\n')).toBe(0)
    expect(h.err.filter((line) => line.includes('tracks.yaml 已不再读取'))).toHaveLength(1)
    expect(await created('x')).toBe(true)
  })
})
