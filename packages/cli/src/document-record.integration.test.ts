import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { compileEffectiveWorkflowPlan, evaluateDocumentEvidence, parseWorkflow, readSkillInvocationEvidence } from '@tenon/kernel'
import { FIXED_CLOCK, freshHarness, type Harness } from './integration-harness.js'

/** Changes in this file run the built-in default workflow. */
function defaultDocumentPolicy() {
  const policy = compileEffectiveWorkflowPlan('default').documentPolicy
  if (policy === undefined) throw new Error('built-in default workflow must be document-governed')
  return policy
}

describe('document record canonical invocation binding', () => {
  let h: Harness

  afterEach(async () => {
    if (h) await rm(h.cwd, { recursive: true, force: true })
  })

  test('同 clock 的两个 delta-spec 各自绑定其 canonical path 和 digest', async () => {
    h = await freshHarness()
    const name = 'same-clock-deltas'
    expect(await h.run(['init', name, '--track', 'backend', '--preset', 'full'])).toBe(0)
    await h.seedArtifact(name, 'phase', 'spec')
    const changeDir = join(h.cwd, 'openspec', 'changes', name)

    for (const [capability, toolUse] of [['cap-a', 'tool-a'], ['cap-b', 'tool-b']] as const) {
      const path = `openspec/changes/${name}/specs/${capability}/spec.md`
      await mkdir(dirname(join(h.cwd, path)), { recursive: true })
      await writeFile(join(h.cwd, path), `# ${capability}\n`, 'utf8')
      await appendFile(join(changeDir, '.pipeline-history.jsonl'), `${JSON.stringify({
        ts: FIXED_CLOCK, kind: 'tool', raw: 'Skill: openspec-propose',
      })}\n`, 'utf8')
      expect(await h.run([
        'internal-native-skill-receipt', name, 'openspec-propose',
        'same-clock-session', toolUse, FIXED_CLOCK,
      ])).toBe(0)
      expect(await h.run([
        'document', 'record', name, 'delta-spec', path, '--producer', 'openspec-propose',
      ])).toBe(0)
    }

    const evidence = await readSkillInvocationEvidence(changeDir)
    expect(evidence.state).toBe('ready')
    expect(evidence.items).toHaveLength(2)
    expect(evidence.items.every((item) => item.status === 'completed')).toBe(true)
    expect(evidence.items.flatMap((item) => item.artifacts.map((artifact) => artifact.ref)).sort()).toEqual([
      `openspec/changes/${name}/specs/cap-a/spec.md`,
      `openspec/changes/${name}/specs/cap-b/spec.md`,
    ])
  })

  test('Skill 回执只封存确认、不写台账：加载技能时还没有产出，init 脚手架不能冒充产出', async () => {
    h = await freshHarness()
    const name = 'receipt-only'
    expect(await h.run(['init', name, '--track', 'backend', '--preset', 'full'])).toBe(0)
    const changeDir = join(h.cwd, 'openspec', 'changes', name)
    await appendFile(join(changeDir, '.pipeline-history.jsonl'), `${JSON.stringify({
      ts: FIXED_CLOCK, kind: 'tool', raw: 'Skill: openspec-propose',
    })}\n`, 'utf8')
    expect(await h.run([
      'internal-native-skill-receipt', name, 'openspec-propose', 'receipt-session', 'tool-1', FIXED_CLOCK,
    ]), h.err.join('\n')).toBe(0)
    const ledger = JSON.parse(await h.readIn(name, '.pipeline-documents.json')) as { records: unknown[] }
    expect(ledger.records).toEqual([])
    const report = await evaluateDocumentEvidence(h.cwd, changeDir, 'open', { recordKinds: ['proposal'], readKinds: [] }, defaultDocumentPolicy())
    expect(report.pass).toBe(false)
  })

  test('docs/ 下的设计稿：document record 过门禁；同内容再登记、改内容后再登记都仍过门禁', async () => {
    h = await freshHarness()
    const name = 'docs-design'
    expect(await h.run(['init', name, '--track', 'backend', '--preset', 'full'])).toBe(0)
    await h.seedArtifact(name, 'phase', 'explore')
    const changeDir = join(h.cwd, 'openspec', 'changes', name)
    const path = `docs/superpowers/specs/${name}-design.md`
    const gateBlockers = async () => (await evaluateDocumentEvidence(h.cwd, changeDir, 'explore', {
      recordKinds: ['superpower-design'], readKinds: [],
    }, defaultDocumentPolicy())).blockers
    const skillReceipt = async (toolUse: string) => {
      await appendFile(join(changeDir, '.pipeline-history.jsonl'), `${JSON.stringify({
        ts: FIXED_CLOCK, kind: 'tool', raw: 'Skill: brainstorming',
      })}\n`, 'utf8')
      expect(await h.run(['internal-native-skill-receipt', name, 'brainstorming', 'docs-session', toolUse, FIXED_CLOCK]), h.err.join('\n')).toBe(0)
    }
    const record = async () => h.run(['document', 'record', name, 'superpower-design', path, '--producer', 'brainstorming'])

    await mkdir(dirname(join(h.cwd, path)), { recursive: true })
    await writeFile(join(h.cwd, path), '# design v1\n', 'utf8')
    await skillReceipt('tool-1')
    expect(await record(), h.err.join('\n')).toBe(0)
    expect(await gateBlockers()).toEqual([])
    expect(await record(), h.err.join('\n')).toBe(0)
    expect(await gateBlockers()).toEqual([])

    await writeFile(join(h.cwd, path), '# design v2\n', 'utf8')
    await skillReceipt('tool-2')
    expect(await record(), h.err.join('\n')).toBe(0)
    expect(await gateBlockers()).toEqual([])
  })

  /** D7：骨架还没写完的文档不是证据——占位符在，登记就拒，并指出位置。 */
  test('scaffold 之后原样登记被拒并指出占位行；写成真内容后才登记得上', async () => {
    h = await freshHarness()
    const name = 'unfilled'
    expect(await h.run(['init', name, '--track', 'backend', '--preset', 'full'])).toBe(0)
    const changeDir = join(h.cwd, 'openspec', 'changes', name)
    const path = `openspec/changes/${name}/proposal.md`
    expect(await h.run(['document', 'scaffold', name, 'proposal'])).toBe(0)
    await appendFile(join(changeDir, '.pipeline-history.jsonl'), `${JSON.stringify({
      ts: FIXED_CLOCK, kind: 'tool', raw: 'Skill: openspec-propose',
    })}\n`, 'utf8')
    expect(await h.run([
      'internal-native-skill-receipt', name, 'openspec-propose', 'unfilled-session', 'tool-u', FIXED_CLOCK,
    ]), h.err.join('\n')).toBe(0)
    const record = () => h.run(['document', 'record', name, 'proposal', path, '--producer', 'openspec-propose'])
    expect(await record()).toBe(1)
    const err = h.err.join('\n')
    expect(err).toContain("document 'proposal' 仍含 5 处未替换的骨架占位符")
    expect(err).toMatch(new RegExp(`${path}:\\d+: > \\[待填写:open\\]`))
    const ledger = JSON.parse(await h.readIn(name, '.pipeline-documents.json')) as { records: unknown[] }
    expect(ledger.records).toEqual([])

    await writeFile(join(h.cwd, path), '# 提案\n\n## Why\n\n登录要支持邮箱。\n', 'utf8')
    expect(await record(), h.err.join('\n')).toBe(0)
  })

  test('Claude Code 报告的带命名空间技能 tenon:openspec-propose 能封存回执并登记文档', async () => {
    h = await freshHarness()
    const name = 'namespaced-skill'
    expect(await h.run(['init', name, '--track', 'backend', '--preset', 'full'])).toBe(0)
    const changeDir = join(h.cwd, 'openspec', 'changes', name)
    const path = `openspec/changes/${name}/proposal.md`
    await writeFile(join(h.cwd, path), '# proposal\n', 'utf8')
    await appendFile(join(changeDir, '.pipeline-history.jsonl'), `${JSON.stringify({
      ts: FIXED_CLOCK, kind: 'tool', raw: 'Skill: tenon:openspec-propose',
    })}\n`, 'utf8')
    expect(await h.run([
      'internal-native-skill-receipt', name, 'tenon:openspec-propose', 'namespaced-session', 'tool-ns', FIXED_CLOCK,
    ]), h.err.join('\n')).toBe(0)
    expect(await h.run([
      'document', 'record', name, 'proposal', path, '--producer', 'openspec-propose',
    ]), h.err.join('\n')).toBe(0)
    const report = await evaluateDocumentEvidence(h.cwd, changeDir, 'open', { recordKinds: ['proposal'], readKinds: [] }, defaultDocumentPolicy())
    expect(report.blockers).toEqual([])
    expect(await h.run([
      'internal-native-skill-receipt', name, 'tenon:bad id', 'namespaced-session', 'tool-bad', FIXED_CLOCK,
    ])).toBe(1)
  })

  test('项目文档 design-md：produce 阶段登记 DESIGN.md 过门禁；其它路径被拒', async () => {
    h = await freshHarness()
    const workflow = [
      'name: design-flow', 'openspec: true', 'document_contract:', '  version: v1', '  slots:',
      '    - kind: design-md', '      owner_step: design', '      producers: [hue]', '  reads: []',
      'steps:',
      '  - id: design', '    label: 设计', '    gate: null', '    skills:', '      - id: hue',
      '    inputs: []', '    outputs: []', '    guards: []', '    transitions:', '      - event: design-complete', '        to: done',
      '  - id: done', '    label: 完结', '    gate: null', '    skills: []',
      '    inputs: []', '    outputs: []', '    guards: []', '    transitions: []', '',
    ].join('\n')
    await mkdir(join(h.cwd, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(h.cwd, '.pipeline', 'workflows', 'design-flow.yaml'), workflow, 'utf8')
    const name = 'design-doc'
    expect(await h.run(['init', name, '--track', 'backend', '--preset', 'full', '--workflow', 'design-flow']), h.err.join('\n')).toBe(0)
    const changeDir = join(h.cwd, 'openspec', 'changes', name)
    await writeFile(join(h.cwd, 'DESIGN.md'), '# Design system\n', 'utf8')
    await mkdir(join(h.cwd, 'docs'), { recursive: true })
    await writeFile(join(h.cwd, 'docs', 'DESIGN.md'), '# Design system\n', 'utf8')
    await appendFile(join(changeDir, '.pipeline-history.jsonl'), `${JSON.stringify({
      ts: FIXED_CLOCK, kind: 'tool', raw: 'Skill: hue',
    })}\n`, 'utf8')
    expect(await h.run(['internal-native-skill-receipt', name, 'hue', 'design-session', 'tool-hue', FIXED_CLOCK]), h.err.join('\n')).toBe(0)
    expect(await h.run(['document', 'record', name, 'design-md', 'docs/DESIGN.md', '--producer', 'hue'])).toBe(1)
    expect(h.err.join('\n')).toContain("document 'design-md' 的路径必须是 DESIGN.md")
    expect(await h.run(['document', 'record', name, 'design-md', 'DESIGN.md', '--producer', 'hue']), h.err.join('\n')).toBe(0)
    const policy = compileEffectiveWorkflowPlan('design-flow', parseWorkflow(workflow)).documentPolicy
    if (policy === undefined) throw new Error('expected document-v1 policy')
    expect((await evaluateDocumentEvidence(h.cwd, changeDir, 'design', {}, policy)).blockers).toEqual([])
  })

  /**
   * D2（acceptance run，frontend 的 ship）：`design-md` 在 default 里只以 `role: require` 和
   * `role: update` 出现，从没被声明为任何一步的产出，所以 `document scaffold` 永远拒；而登记它
   * 要的 `hue` 也不在 ship 的 skills 里。`next` 从前偏偏在那一步发 scaffold-document design-md，
   * 两条命令都执行不了。这里钉住两条拒绝，以及那次失败的 scaffold 不会碰到既有的 DESIGN.md。
   */
  test('frontend ship 的 design-md：scaffold 与 hue 登记都被拒，既有 DESIGN.md 一个字节不动', async () => {
    h = await freshHarness()
    const name = 'shipdesign'
    expect(await h.run(['init', name, '--track', 'frontend', '--preset', 'full']), h.err.join('\n')).toBe(0)
    await h.seedArtifact(name, 'phase', 'ship')
    const designMd = join(h.cwd, 'DESIGN.md')
    const before = await readFile(designMd, 'utf8')

    expect(await h.run(['document', 'scaffold', name, 'design-md'])).toBe(1)
    expect(h.err.join('\n')).toContain("document kind 'design-md' 未在 workflow 'default' 的 contract 中声明")
    expect(await readFile(designMd, 'utf8')).toBe(before)

    expect(await h.run(['document', 'record', name, 'design-md', 'DESIGN.md', '--producer', 'hue'])).toBe(1)
    expect(h.err.join('\n')).toContain("lacks exact host confirmation for document producer 'hue'")

    // 于是这一步的 next 一条 design-md 动作都不发：它是「可以改」，不是「必须产出」。
    expect(await h.run(['status', name, '--json']), h.err.join('\n')).toBe(0)
    const step = (JSON.parse(h.out.join('\n')) as {
      step: { documents: { updates: readonly { kind: string; status: string }[] }; next: readonly { action: string }[] }
    }).step
    expect(step.documents.updates.some((doc) => doc.kind === 'design-md' && doc.status === 'missing')).toBe(true)
    expect(step.next.some((action) => JSON.stringify(action).includes('design-md'))).toBe(false)
  })
})
