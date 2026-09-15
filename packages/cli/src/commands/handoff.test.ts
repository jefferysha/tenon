/**
 * handoff 命令 —— mock 层快速分支回归（TEST-REALITY.md：真实对位在 handoff.integration.test.ts）。
 * 覆盖 dispatch / text·json 输出 / 无文档 / 非法名 / 状态缺失 / --phase 覆写，
 * 文档经注入 fake HandoffFs（避免 fs——真 fs 面在 integration）。
 */
import { describe, expect, test, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_LEDGER_CONTEXT_BUNDLE_BUDGET_BYTES,
  compileLedgerContextBundle,
  type CompiledLedgerContextBundle,
  type CompileLedgerContextBundleInput,
} from '@tenon/kernel'
import { makeDeps, mockState } from '../test-support.js'
import {
  cmdHandoff,
  type HandoffFs,
  type LedgerContextBundleCompiler,
} from './handoff.js'

const zhLocale = async () => 'zh-CN' as const
const enLocale = async () => 'en' as const

function fakeFs(map: Record<string, string>): HandoffFs {
  return {
    exists: (p) => Object.prototype.hasOwnProperty.call(map, p),
    readText: (p) => map[p],
  }
}

const DESIGN = [
  '# Design Doc',
  'Background prose paragraph one that is pure narrative filler dropped on compression.',
  'Background prose paragraph two repeating scaffolding and carrying no useful signal.',
  'Background prose paragraph three padding the doc with words downstream never reads.',
  '## Decisions',
  'We decided to compress upstream docs at phase handoff.',
  'Decision: keep the compressor deterministic and zero-LLM.',
  '## Constraints',
  '- The kernel MUST stay zero-dependency.',
  '- 禁止引入通用 yaml 解析器。',
  '## Tasks',
  '- [x] wrote compressor',
  '- [ ] wire handoff into transition',
].join('\n')

const PLAN = [
  '# Plan',
  'Filler narrative that pads the plan without any decision or actionable content here.',
  'Another filler paragraph repeating template boilerplate with zero downstream signal.',
  'Decision: implement build before verify handoff.',
  '- [ ] implement cmdHandoff CLI shell',
].join('\n')

const VR = [
  '# Verification Report',
  'Long prose describing the verification narrative that downstream ship phase can skip.',
  'More narrative filler padding the report body with words nobody needs to re-read now.',
  'Conclusion: all three gates pass and the build SHA matches HEAD.',
  '- [ ] archive after ship',
].join('\n')

describe('dispatch / 校验', () => {
  test('非法 change 名 → stderr + exit 1、不读 store', async () => {
    const deps = makeDeps()
    expect(await cmdHandoff(deps, 'bad/../x', {}, fakeFs({}))).toBe(1)
    expect(deps.errLines.join('\n')).toContain('change-name')
    expect(deps.store.read.calls).toHaveLength(0)
  })

  test('缺 name → exit 1', async () => {
    const deps = makeDeps()
    expect(await cmdHandoff(deps, undefined, {}, fakeFs({}))).toBe(1)
  })

  test('状态文件缺失（read 抛）→ exit 1、ERROR', async () => {
    const deps = makeDeps({ states: {} })
    expect(await cmdHandoff(deps, 'chg', {}, fakeFs({}))).toBe(1)
    expect(deps.errLines.join('\n')).toContain('ERROR')
  })
})

describe('text 输出 —— 压缩摘要 + 压缩率', () => {
  const deps = () =>
    makeDeps({ state: mockState({ phase: 'build', design_doc: 'docs/design.md', plan: 'openspec/changes/chg/plan.md' }) })
  const fs = fakeFs({
    '/repo/docs/design.md': DESIGN,
    '/repo/openspec/changes/chg/plan.md': PLAN,
  })

  test('header + 压缩率行 + 逐文档摘要（决策/约束保留，样板去除）', async () => {
    const d = deps()
    expect(await cmdHandoff(d, 'chg', {}, fs, zhLocale)).toBe(0)
    const out = d.outLines.join('\n')
    expect(out).toContain('# 交接摘要: chg（阶段 build）')
    expect(out).toMatch(/# 压缩率: \d+%（\d+ → \d+ 字符，2 份文档）/)
    // 关键决策/约束保留
    expect(out).toContain('We decided to compress upstream docs at phase handoff.')
    expect(out).toContain('The kernel MUST stay zero-dependency.')
    expect(out).toContain('禁止引入通用 yaml 解析器。')
    expect(out).toContain('- [ ] wire handoff into transition')
    // 样板正文去除
    expect(out).not.toContain('Background prose paragraph')
    expect(out).not.toContain('template boilerplate')
  })

  test('无文档（字段未设）→ 提示行 + exit 0', async () => {
    const d = makeDeps({ state: mockState({ phase: 'build' }) })
    expect(await cmdHandoff(d, 'chg', {}, fakeFs({}), zhLocale)).toBe(0)
    expect(d.outLines.join('\n')).toContain('当前阶段没有可交接文档')
    expect(d.errLines.join('\n')).toContain('无可压缩产出文档')
  })

  test('显式 en Change 保留英文输出', async () => {
    const state = mockState({ phase: 'build', design_doc: 'docs/design.md' })
    const d = makeDeps({ state })
    expect(await cmdHandoff(d, 'chg', {}, fakeFs({ '/repo/docs/design.md': DESIGN }), enLocale)).toBe(0)
    const out = d.outLines.join('\n')
    expect(out).toContain('# Handoff: chg (phase build)')
    expect(out).toContain('# Compression:')
    expect(out).toContain('## Decisions (2)')
  })
})

describe('--json 输出 —— 结构化信封', () => {
  test('change/phase/aggregate/docs 结构 + 压缩率数值 + 决策数组', async () => {
    const d = makeDeps({ state: mockState({ phase: 'build', design_doc: 'docs/design.md' }) })
    const fs = fakeFs({ '/repo/docs/design.md': DESIGN })
    expect(await cmdHandoff(d, 'chg', { json: true }, fs, zhLocale)).toBe(1 - 1) // 0
    expect(d.outLines).toHaveLength(1)
    const env = JSON.parse(d.outLines[0]!)
    expect(env.change).toBe('chg')
    expect(env.phase).toBe('build')
    expect(typeof env.aggregate.ratio).toBe('number')
    expect(env.aggregate.originalChars).toBeGreaterThan(env.aggregate.compressedChars)
    expect(env.docs).toHaveLength(1)
    expect(env.docs[0].path).toBe('docs/design.md')
    expect(env.docs[0].decisions).toContain('We decided to compress upstream docs at phase handoff.')
    expect(env.docs[0].constraints).toContain('The kernel MUST stay zero-dependency.')
    expect(env.docs[0].openTodos).toContain('wire handoff into transition')
    expect(env.docs[0].doneTodoCount).toBe(1)
    expect(typeof env.docs[0].summary).toBe('string')
  })
})

describe('--phase 覆写 —— 压不同相位的产出', () => {
  test('phase=build 的 change，--phase verify 压 verification_report', async () => {
    const d = makeDeps({ state: mockState({ phase: 'build', verification_report: 'reports/vr.md' }) })
    const fs = fakeFs({ '/repo/reports/vr.md': VR })
    expect(await cmdHandoff(d, 'chg', { phase: 'verify', json: true }, fs, zhLocale)).toBe(0)
    const env = JSON.parse(d.outLines[0]!)
    expect(env.phase).toBe('verify')
    expect(env.docs).toHaveLength(1)
    expect(env.docs[0].path).toBe('reports/vr.md')
    expect(env.docs[0].decisions).toContain('Conclusion: all three gates pass and the build SHA matches HEAD.')
  })
})

describe('--bundle —— 共享 ledger compiler 适配', () => {
  const compiled: CompiledLedgerContextBundle = {
    bundle: {
      schemaVersion: 'context-bundle/v1',
      change: 'chg',
      from: 'spec',
      to: 'build',
      tier: 'strong',
      inputs: [],
      budget: { maxBytes: DEFAULT_LEDGER_CONTEXT_BUNDLE_BUDGET_BYTES, usedBytes: 0 },
      aggregateDigest: `sha256:${'a'.repeat(64)}`,
    },
    preview: {
      change: 'chg',
      from: 'spec',
      to: 'build',
      tier: 'strong',
      inputs: [],
      documentCount: 0,
      budget: { maxBytes: DEFAULT_LEDGER_CONTEXT_BUNDLE_BUDGET_BYTES, usedBytes: 0 },
    },
  }

  test('只透传 root/change/from/target/policy/budget/fs（policy = change 的文档策略），并保持 context-bundle/v1 输出', async () => {
    const d = makeDeps({ state: mockState({ phase: 'spec' }) })
    const fs = fakeFs({})
    const calls: CompileLedgerContextBundleInput[] = []
    const compiler: LedgerContextBundleCompiler = async (input) => {
      calls.push(input)
      return compiled
    }

    expect(await cmdHandoff(
      d,
      'chg',
      { bundle: true, target: 'build', budgetBytes: 4096, json: true },
      fs,
      zhLocale,
      compiler,
    )).toBe(0)
    expect(calls).toEqual([{
      root: '/repo',
      change: 'chg',
      from: 'spec',
      target: 'build',
      policy: expect.objectContaining({ id: 'openspec-v1', steps: ['open', 'explore', 'spec', 'build', 'verify', 'ship', 'archive'] }),
      budgetBytes: 4096,
      fs,
    }])
    expect(JSON.parse(d.outLines[0]!)).toEqual(compiled.bundle)
    expect(d.errLines).toEqual([])
  })

  test('CLI 不提供 budget 时由共享服务应用 120000 默认值', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-cli-bundle-empty-'))
    try {
      const d = makeDeps({ cwd: root, state: mockState({ phase: 'archive' }) })
      expect(await cmdHandoff(
        d,
        'chg',
        { bundle: true, target: 'open', json: true },
      )).toBe(0)
      expect(JSON.parse(d.outLines[0]!).budget).toEqual({
        maxBytes: 120_000,
        usedBytes: 0,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('legacy non-bundle handoff 不调用共享编译器', async () => {
    const d = makeDeps({ state: mockState({ phase: 'build' }) })
    const compiler = vi.fn<typeof compileLedgerContextBundle>()
    expect(await cmdHandoff(d, 'chg', {}, fakeFs({}), zhLocale, compiler)).toBe(0)
    expect(compiler).not.toHaveBeenCalled()
  })

  test('workflow 未开启 openspec：--bundle exit 1 并说明原因，不调用编译器（E18）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-cli-bundle-ungoverned-'))
    try {
      await mkdir(join(root, '.pipeline', 'workflows'), { recursive: true })
      await writeFile(join(root, '.pipeline', 'workflows', 'plain.yaml'), [
        'name: plain', 'steps:', '  - id: one', '    label: 一', '    gate: null', '    skills: []',
        '    inputs: []', '    outputs: []', '    guards: []', '    transitions: []', '',
      ].join('\n'), 'utf8')
      const d = makeDeps({ cwd: root, state: mockState({ workflow: 'plain', phase: 'one' }) })
      const compiler = vi.fn<typeof compileLedgerContextBundle>()
      expect(await cmdHandoff(d, 'chg', { bundle: true, target: 'one', json: true }, undefined, zhLocale, compiler)).toBe(1)
      expect(d.errLines).toEqual(["ERROR: workflow 'plain' 未开启 openspec，--bundle 不适用"])
      expect(compiler).not.toHaveBeenCalled()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
