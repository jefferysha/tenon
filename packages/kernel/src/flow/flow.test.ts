/**
 * T3 · kernel/flow 测试 —— manifest 加载 / 转换合法性矩阵 / guard lite 子集 / review_phases 单一真相源锚。
 * 语义参考：老仓 workflow-plugin skills/pipeline/manifest.yaml + scripts/state-transition.sh +
 * scripts/manifest.py:_DEFAULT_TRANSITIONS + scripts/pipeline-guard.sh（只读 oracle）。
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FIELD_ORDER, LIST_FIELDS, PHASES, IllegalTransitionError } from '../types.js'
import type { FieldName, ManifestData, Phase, PipelineState } from '../types.js'
import { createFlowEngine, loadManifest, ManifestError } from './index.js'

/** 仓库根 templates/manifest.yaml（相对本文件定位，不依赖 cwd） */
const TEMPLATE_MANIFEST = fileURLToPath(new URL('../../../../templates/manifest.yaml', import.meta.url))

/** 全字段空态（列表字段 = []，其余 = 空串），按需 override */
function makeState(overrides: Partial<Record<FieldName, string | string[]>> = {}): PipelineState {
  const fields = {} as Record<FieldName, string | string[]>
  for (const f of FIELD_ORDER) {
    fields[f] = (LIST_FIELDS as readonly string[]).includes(f) ? [] : ''
  }
  Object.assign(fields, overrides)
  return { fields, opaqueTail: '' }
}

/** 合法边全集（8 条）：前向 6 + verify→build 回退 + archive 终态自环 */
const LEGAL_EDGES: ReadonlyArray<readonly [Phase, Phase]> = [
  ['open', 'explore'],
  ['explore', 'spec'],
  ['spec', 'build'],
  ['build', 'verify'],
  ['build', 'spec'],
  ['verify', 'ship'],
  ['verify', 'build'],
  ['ship', 'archive'],
  ['archive', 'archive'],
]

function isLegal(from: Phase, to: Phase): boolean {
  return LEGAL_EDGES.some(([f, t]) => f === from && t === to)
}

const clockAt = (ts: string) => () => ts

describe('loadManifest(templates/manifest.yaml)', () => {
  it('phases = 7 相位且保持声明顺序', () => {
    const m = loadManifest(TEMPLATE_MANIFEST)
    expect(m.phases).toEqual(['open', 'explore', 'spec', 'build', 'verify', 'ship', 'archive'])
  })

  it('transitions 含需求回退、build⇄verify 双向与 archive 终态自环', () => {
    const m = loadManifest(TEMPLATE_MANIFEST)
    expect(m.transitions.build).toEqual(['verify', 'spec'])
    expect(m.transitions.verify).toEqual(['ship', 'build'])
    expect(m.transitions.archive).toEqual(['archive'])
    expect(m.transitions.open).toEqual(['explore'])
    expect(m.transitions.explore).toEqual(['spec'])
    expect(m.transitions.spec).toEqual(['build'])
    expect(m.transitions.ship).toEqual(['archive'])
  })

  it('reviewPhases 来自 manifest 数据（默认 explore/spec/verify）', () => {
    const m = loadManifest(TEMPLATE_MANIFEST)
    expect(m.reviewPhases).toEqual(['explore', 'spec', 'verify'])
  })

  it('文件不存在 → throw', () => {
    expect(() => loadManifest('/nonexistent/manifest.yaml')).toThrow()
  })

  it('未知相位名 → ManifestError（fail-loud）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flow-manifest-'))
    const p = join(dir, 'manifest.yaml')
    writeFileSync(p, 'phases:\n  - open\n  - bogus\ntransitions:\n  open: [open]\n  bogus: []\nreview_phases: []\n')
    expect(() => loadManifest(p)).toThrow(ManifestError)
  })

  it('transition 指向未声明相位 → ManifestError', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flow-manifest-'))
    const p = join(dir, 'manifest.yaml')
    writeFileSync(p, 'phases:\n  - open\ntransitions:\n  open: [ship]\nreview_phases: []\n')
    expect(() => loadManifest(p)).toThrow(ManifestError)
  })

  it('缺 review_phases 键 → ManifestError（绝不静默丢 review-gate，对齐老内核 fail-loud）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flow-manifest-'))
    const p = join(dir, 'manifest.yaml')
    writeFileSync(p, 'phases:\n  - open\ntransitions:\n  open: []\n')
    expect(() => loadManifest(p)).toThrow(ManifestError)
  })

  it('缺 transitions 某相位条目 → ManifestError（fail-loud 防漏边）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flow-manifest-'))
    const p = join(dir, 'manifest.yaml')
    writeFileSync(p, 'phases:\n  - open\n  - explore\ntransitions:\n  open: [explore]\nreview_phases: []\n')
    expect(() => loadManifest(p)).toThrow(ManifestError)
  })
})

describe('FlowEngine · 转换合法性矩阵（7×7 全边）', () => {
  const engine = createFlowEngine(loadManifest(TEMPLATE_MANIFEST))

  for (const from of PHASES) {
    for (const to of PHASES) {
      if (isLegal(from, to)) {
        it(`合法：${from} -> ${to}`, () => {
          const r = engine.transition(makeState({ phase: from }), to, clockAt('2026-07-06T00:00:00Z'))
          expect(r.from).toBe(from)
          expect(r.to).toBe(to)
          expect(r.state.fields.phase).toBe(to)
        })
      } else {
        it(`非法：${from} -> ${to} throws IllegalTransitionError`, () => {
          expect(() => engine.transition(makeState({ phase: from }), to)).toThrow(IllegalTransitionError)
        })
      }
    }
  }

  it('legalTransitions 与矩阵一致', () => {
    for (const from of PHASES) {
      const expected = LEGAL_EDGES.filter(([f]) => f === from).map(([, t]) => t)
      expect(engine.legalTransitions(from)).toEqual(expected)
    }
  })

  it('state.fields.phase 非法值 → IllegalTransitionError', () => {
    expect(() => engine.transition(makeState({ phase: 'wat' }), 'explore')).toThrow(IllegalTransitionError)
  })

  it('IllegalTransitionError 携带 from/to', () => {
    try {
      engine.transition(makeState({ phase: 'open' }), 'ship')
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(IllegalTransitionError)
      expect((e as IllegalTransitionError).from).toBe('open')
      expect((e as IllegalTransitionError).to).toBe('ship')
    }
  })
})

describe('FlowEngine · transition 语义（phase / phase_status / updated_at）', () => {
  const engine = createFlowEngine(loadManifest(TEMPLATE_MANIFEST))

  it('前向转换 → phase_status=pending，updated_at=注入时钟', () => {
    const r = engine.transition(makeState({ phase: 'open' }), 'explore', clockAt('2026-07-06T01:02:03Z'))
    expect(r.state.fields.phase).toBe('explore')
    expect(r.state.fields.phase_status).toBe('pending')
    expect(r.state.fields.updated_at).toBe('2026-07-06T01:02:03Z')
  })

  it('verify→build 回退边 → phase_status=in_progress（老内核 verify-fail 语义）', () => {
    const r = engine.transition(makeState({ phase: 'verify' }), 'build', clockAt('2026-07-06T00:00:00Z'))
    expect(r.state.fields.phase_status).toBe('in_progress')
  })

  it('archive→archive 终态自环 → phase_status=done（老内核 archived 语义）', () => {
    const r = engine.transition(makeState({ phase: 'archive' }), 'archive', clockAt('2026-07-06T00:00:00Z'))
    expect(r.state.fields.phase_status).toBe('done')
  })

  it('缺省时钟 → ISO8601 UTC 秒级（无毫秒，对齐老内核 date -u +%Y-%m-%dT%H:%M:%SZ）', () => {
    const r = engine.transition(makeState({ phase: 'open' }), 'explore')
    expect(r.state.fields.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  })

  it('不改动其它字段，保留 opaqueTail，且不 mutate 输入 state', () => {
    const input = makeState({ phase: 'open', design_doc: 'docs/design.md', scope: ['a', 'b'] })
    input.opaqueTail = 'tools_history: !!binary |\n  QUJD\n'
    const r = engine.transition(input, 'explore', clockAt('2026-07-06T00:00:00Z'))
    expect(r.state.fields.design_doc).toBe('docs/design.md')
    expect(r.state.fields.scope).toEqual(['a', 'b'])
    expect(r.state.opaqueTail).toBe(input.opaqueTail)
    // 输入不被 mutate（引擎返回新 state）
    expect(input.fields.phase).toBe('open')
    expect(input.fields.updated_at).toBe('')
  })
})

describe('FlowEngine · guardCheck（lite 相位出口必填字段表）', () => {
  const engine = createFlowEngine(loadManifest(TEMPLATE_MANIFEST))

  it('open 出口：lite 无字段要求 → pass', () => {
    expect(engine.guardCheck(makeState({ phase: 'open' }))).toEqual({ pass: true, failures: [] })
  })

  it('explore 出口：design_doc 空 → fail；"null" 哨兵同空；非空 → pass', () => {
    expect(engine.guardCheck(makeState({ phase: 'explore' })).pass).toBe(false)
    expect(
      engine.guardCheck(makeState({ phase: 'explore', design_doc: 'null' })).pass,
    ).toBe(false)
    const bad = engine.guardCheck(makeState({ phase: 'explore' }))
    expect(bad.failures.some((f) => f.includes('design_doc'))).toBe(true)
    expect(
      engine.guardCheck(makeState({ phase: 'explore', design_doc: 'docs/design.md' })),
    ).toEqual({ pass: true, failures: [] })
  })

  it('spec 出口：非 PM track 需 legacy plan；PM 的文档 plan 由 OpenSpec ledger 单独治理', () => {
    expect(engine.guardCheck(makeState({ phase: 'spec', track: 'backend' })).pass).toBe(false)
    expect(engine.guardCheck(makeState({ phase: 'spec', track: 'frontend' })).pass).toBe(false)
    expect(engine.guardCheck(makeState({ phase: 'spec', track: 'pm' })).pass).toBe(true)
    expect(
      engine.guardCheck(makeState({ phase: 'spec', track: 'backend', plan: 'docs/plan.md' })).pass,
    ).toBe(true)
  })

  it('build 出口：实现参数与 pre-Verify 全量收敛必须完成；build_sha 仍由事件冻结', () => {
    const base = { phase: 'build' as const, track: 'backend' }
    const r = engine.guardCheck(makeState(base))
    expect(r.pass).toBe(false)
    expect(r.failures.some((f) => f.includes('build_mode'))).toBe(true)
    expect(r.failures.some((f) => f.includes('isolation'))).toBe(true)
    expect(r.failures.some((f) => f.includes('pre_verify_review_result'))).toBe(true)
    // build_sha 为空不阻断（老 guard 出口无此条，SHA 由 transition build-complete 自动冻结）
    expect(
      engine.guardCheck(makeState({
        ...base,
        build_mode: 'worktree',
        isolation: 'branch',
        pre_verify_review_result: 'pass',
      })),
    ).toEqual({ pass: true, failures: [] })
  })

  it('verify 出口：verification_report + branch_status=handled + verify_result=pass（手填评审字段已删除）', () => {
    const ok = {
      phase: 'verify' as const,
      verification_report: 'docs/verify.md',
      branch_status: 'handled',
      verify_result: 'pass',
    }
    // 每条轨道都只剩报告、分支状态与 verify_result；评审由步骤声明的 agents.reviewers 承担。
    for (const track of ['pm', 'backend', 'frontend', 'free'] as const) {
      expect(engine.guardCheck(makeState({ ...ok, track }))).toEqual({ pass: true, failures: [] })
    }
    // verify_result 非 pass → fail（verify→ship 需 verify_result=pass）
    expect(
      engine.guardCheck(makeState({ ...ok, track: 'pm', verify_result: 'fail' })).pass,
    ).toBe(false)
    // branch_status 非 handled → fail
    expect(
      engine.guardCheck(makeState({ ...ok, track: 'pm', branch_status: '' })).pass,
    ).toBe(false)
  })

  it('ship 出口：pm 需 prd_path；fe/be 需 pr_url', () => {
    expect(engine.guardCheck(makeState({ phase: 'ship', track: 'pm' })).pass).toBe(false)
    expect(
      engine.guardCheck(makeState({ phase: 'ship', track: 'pm', prd_path: 'docs/prd.md' })).pass,
    ).toBe(true)
    expect(engine.guardCheck(makeState({ phase: 'ship', track: 'backend' })).pass).toBe(false)
    expect(
      engine.guardCheck(makeState({ phase: 'ship', track: 'backend', pr_url: 'https://x/pr/1' })).pass,
    ).toBe(true)
    expect(engine.guardCheck(makeState({ phase: 'ship', track: 'free' })).pass).toBe(true)
  })

  it('archive 出口：verify_result=pass', () => {
    expect(engine.guardCheck(makeState({ phase: 'archive' })).pass).toBe(false)
    expect(
      engine.guardCheck(makeState({ phase: 'archive', verify_result: 'pass' })).pass,
    ).toBe(true)
  })

  it('未知 phase → fail 且报明细', () => {
    const r = engine.guardCheck(makeState({ phase: 'bogus' }))
    expect(r.pass).toBe(false)
    expect(r.failures.length).toBeGreaterThan(0)
  })
})

describe('review_phases 单一真相源回归锚（老内核 state-transition.sh:159-161 硬编码欠账的构造性修复）', () => {
  it('默认 manifest：explore/spec/verify 是 review 相位，build 不是', () => {
    const engine = createFlowEngine(loadManifest(TEMPLATE_MANIFEST))
    expect(engine.isReviewPhase('explore')).toBe(true)
    expect(engine.isReviewPhase('spec')).toBe(true)
    expect(engine.isReviewPhase('verify')).toBe(true)
    expect(engine.isReviewPhase('build')).toBe(false)
    expect(engine.isReviewPhase('open')).toBe(false)
  })

  it('改 manifest 的 review_phases → 引擎行为随之变（引擎真读数据，零硬编码）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flow-review-anchor-'))
    const p = join(dir, 'manifest.yaml')
    writeFileSync(
      p,
      [
        'phases:',
        ...PHASES.map((ph) => `  - ${ph}`),
        'transitions:',
        '  open: [explore]',
        '  explore: [spec]',
        '  spec: [build]',
        '  build: [verify]',
        '  verify: [ship, build]',
        '  ship: [archive]',
        '  archive: [archive]',
        'review_phases: [build]',
        '',
      ].join('\n'),
    )
    const engine = createFlowEngine(loadManifest(p))
    expect(engine.manifest.reviewPhases).toEqual(['build'])
    expect(engine.isReviewPhase('build')).toBe(true)
    // 老内核硬编码名单在此必须失效
    expect(engine.isReviewPhase('explore')).toBe(false)
    expect(engine.isReviewPhase('spec')).toBe(false)
    expect(engine.isReviewPhase('verify')).toBe(false)
  })

  it('手工构造 ManifestData 直接注入也生效（引擎不读文件、只读数据）', () => {
    const manifest: ManifestData = {
      phases: PHASES,
      transitions: {
        open: ['explore'],
        explore: ['spec'],
        spec: ['build'],
        build: ['verify'],
        verify: ['ship', 'build'],
        ship: ['archive'],
        archive: ['archive'],
      },
      reviewPhases: ['ship'],
    }
    const engine = createFlowEngine(manifest)
    expect(engine.isReviewPhase('ship')).toBe(true)
    expect(engine.isReviewPhase('explore')).toBe(false)
    expect(engine.manifest).toBe(manifest)
  })
})
