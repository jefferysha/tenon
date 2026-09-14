import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { evaluateDocumentEvidence, readSkillInvocationEvidence } from '@tenon/kernel'
import { FIXED_CLOCK, freshHarness, type Harness } from './integration-harness.js'

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
    const report = await evaluateDocumentEvidence(h.cwd, changeDir, 'open', { recordKinds: ['proposal'], readKinds: [] })
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
    })).blockers
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
})
