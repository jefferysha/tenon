import { describe, expect, it } from 'vitest'
import { decodeWorkflowDefinition } from './governanceSchema'
import type { WbWorkflowDef } from './governanceTypes'
import { cloneWorkflowDef, definitionForWrite } from '../workbench/workbenchDefinition'
const step = {
  id: 'open',
  label: 'Open',
  gate: null,
  skills: [],
  inputs: [],
  outputs: [],
  guards: [],
  transitions: [],
}

const guards = [
  ['tasks-at-least', { type: 'tasks-at-least', n: 1 }],
  ['nonempty-output', { type: 'nonempty-output' }],
  ['field-nonempty', { type: 'field-nonempty', field: 'plan' }],
  ['file-exists', { type: 'file-exists', path: { kind: 'field', field: 'plan' } }],
  ['field-equals', { type: 'field-equals', field: 'verify_result', value: 'pass' }],
  ['field-in', { type: 'field-in', field: 'phase_status', values: ['ready'] }],
  ['full-direct-override', { type: 'full-direct-override' }],
  ['build-head-unchanged', { type: 'build-head-unchanged', field: 'build_sha' }],
  ['spec-migration-applied', { type: 'spec-migration-applied' }],
] as const

function decodeWithGuard(guard: unknown) {
  return decodeWorkflowDefinition({
    name: 'guard-contract',
    steps: [{ ...step, guards: [guard] }],
  })
}

describe('decodeWorkflowDefinition', () => {
  it('projects legacy definitions to the safe independent policy defaults', () => {
    const decoded = decodeWorkflowDefinition({ name: 'legacy', steps: [step] })

    expect(decoded?.decomposition).toEqual({
      version: 'v1',
      mode: 'off',
      target: 'work-items',
      strategy: 'balanced',
      max_items: 16,
      max_depth: 2,
      auto_when: [],
      ask_when: [],
    })
    expect(decoded?.interaction).toEqual({ version: 'v1', mode: 'interactive' })
  })

  it('preserves the complete decomposition and interaction policy without coupling them', () => {
    const decoded = decodeWorkflowDefinition({
      name: 'policy-contract',
      decomposition: {
        version: 'v1',
        mode: 'off',
        target: 'child-pipelines',
        strategy: 'depth-first',
        max_items: 7,
        max_depth: 4,
        auto_when: ['context-budget-risk', 'independent-work-items'],
        ask_when: ['hard-boundary', 'missing-authorization'],
      },
      interaction: { version: 'v1', mode: 'afk' },
      steps: [step],
    })

    expect(decoded?.decomposition).toEqual({
      version: 'v1',
      mode: 'off',
      target: 'child-pipelines',
      strategy: 'depth-first',
      max_items: 7,
      max_depth: 4,
      auto_when: ['context-budget-risk', 'independent-work-items'],
      ask_when: ['hard-boundary', 'missing-authorization'],
    })
    expect(decoded?.interaction).toEqual({ version: 'v1', mode: 'afk' })
  })

  it('rejects the removed review budget, review lanes and skill classification keys', () => {
    expect(decodeWorkflowDefinition({
      name: 'retired-budget',
      reviewBudget: { version: 'v1', max_attempts: 3 },
      steps: [step],
    })).toBeNull()
    expect(decodeWorkflowDefinition({
      name: 'retired-lanes',
      steps: [{ ...step, reviewLanes: ['e2e'] }],
    })).toBeNull()
    expect(decodeWorkflowDefinition({
      name: 'retired-kind',
      steps: [{ ...step, skills: [{ id: 'acme-quality-gate', kind: 'review', review_lane: 'standards' }] }],
    })).toBeNull()
    expect(decodeWorkflowDefinition({
      name: 'name-is-not-a-contract',
      steps: [{ ...step, skills: [{ id: 'code-review' }] }],
    })?.steps[0]?.skills).toEqual([{ id: 'code-review' }])
  })

  it('fills omitted v1 policy fields while rejecting unknown keys, duplicate conditions, and invalid limits', () => {
    expect(decodeWorkflowDefinition({
      name: 'partial-policy',
      decomposition: { version: 'v1', mode: 'suggest' },
      interaction: { version: 'v1', mode: 'recommended-defaults' },
      steps: [step],
    })?.decomposition).toMatchObject({
      version: 'v1',
      mode: 'suggest',
      target: 'work-items',
      max_items: 16,
      max_depth: 2,
    })

    for (const decomposition of [
      { mode: 'off' },
      { version: 'v1', mode: 'auto-everything' },
      { version: 'v1', mode: 'off', max_items: 0 },
      { version: 'v1', mode: 'off', max_depth: 5 },
      { version: 'v1', mode: 'off', auto_when: ['context-budget-risk', 'context-budget-risk'] },
      { version: 'v1', mode: 'off', ask_when: ['unknown-boundary'] },
      { version: 'v1', mode: 'off', privileged: true },
    ]) {
      expect(decodeWorkflowDefinition({ name: 'invalid-policy', decomposition, steps: [step] })).toBeNull()
    }
    expect(decodeWorkflowDefinition({
      name: 'invalid-interaction',
      interaction: { version: 'v1', mode: 'afk', grants: ['production'] },
      steps: [step],
    })).toBeNull()
    expect(decodeWorkflowDefinition({
      name: 'unversioned-interaction',
      interaction: { mode: 'interactive' },
      steps: [step],
    })).toBeNull()
  })

  it('decodes the openspec switch, branch contracts and slot roles; rejects the removed openspecContract key', () => {
    const contract = {
      version: 'v1',
      slots: [
        { kind: 'tasks', ownerStep: 'one', producers: ['writer'] },
        { kind: 'design-md', ownerStep: 'one', role: 'require', producers: [] },
      ],
      reads: [],
    }
    expect(decodeWorkflowDefinition({ name: 'governed', openspec: true, documentContract: contract, steps: [step] }))
      .toMatchObject({ openspec: true, documentContract: { slots: [{ kind: 'tasks' }, { kind: 'design-md', role: 'require' }] } })
    expect(decodeWorkflowDefinition({
      name: 'branched', openspec: true, steps: [], tracks: { web: { label: '前端', documentContract: contract, steps: [step] } },
    })?.tracks?.web?.documentContract?.slots).toHaveLength(2)
    expect(decodeWorkflowDefinition({ name: 'old', openspecContract: 'required', steps: [step] })).toBeNull()
    expect(decodeWorkflowDefinition({ name: 'switch', openspec: 'yes', steps: [step] })).toBeNull()
    expect(decodeWorkflowDefinition({
      name: 'bad-role', openspec: true, steps: [step],
      documentContract: { ...contract, slots: [{ kind: 'tasks', ownerStep: 'one', role: 'read', producers: [] }] },
    })).toBeNull()
  })

  it('decodes step tests with their pass criteria, inputs and outputs; rejects closed-set violations', () => {
    const test = {
      id: 'unit', direction: 'unit', command: 'npm test', cwd: 'frontend', label: '单测',
      timeout_s: 900, required: true, keep_runs: 5, scope: 'full',
      metrics_path: 'test-results/bench.json',
      pass: { exit_code: 0, metrics: [{ name: 'p95_ms', max: 250, better: 'lower' }] },
      inputs: [
        { kind: 'document', ref: 'delta-spec' },
        { kind: 'file', path: 'frontend/fixtures' },
        { kind: 'env', name: 'DATABASE_URL' },
        { kind: 'service', name: 'postgres', url: 'postgres://localhost:5432' },
      ],
      outputs: [{ path: 'test-results/junit.xml', kind: 'report', required: true }],
    }
    expect(decodeWorkflowDefinition({ name: 'tested', steps: [{ ...step, tests: [test] }] })?.steps[0]?.tests)
      .toEqual([test])
    expect(decodeWorkflowDefinition({ name: 'empty', steps: [{ ...step, tests: [] }] })?.steps[0]?.tests).toEqual([])
    expect(decodeWorkflowDefinition({ name: 'legacy', steps: [step] })?.steps[0]?.tests).toBeUndefined()

    for (const broken of [
      { ...test, command: '' },
      { ...test, direction: '' },
      { ...test, scope: 'partial' },
      { ...test, timeout_s: 1.5 },
      { ...test, outputs: [{ path: 'x', kind: 'diagram' }] },
      { ...test, inputs: [{ kind: 'secret', name: 'TOKEN' }] },
      { ...test, pass: { metrics: [{ max: 1 }] } },
    ]) {
      expect(decodeWorkflowDefinition({ name: 'tested', steps: [{ ...step, tests: [broken] }] })).toBeNull()
    }
  })

  it('effectiveIo document slots carry role and scope; the legacy locked-only shape is rejected', () => {
    const io = (slot: Record<string, unknown>) => decodeWorkflowDefinition({
      name: 'io', steps: [step], effectiveIo: { one: { inputs: [], outputs: [slot] } },
    })
    const slot = { kind: 'document', id: 'tasks', role: 'update', scope: 'change', producers: ['writer'], consumers: [] }
    expect(io(slot)?.effectiveIo?.one?.outputs).toEqual([slot])
    expect(io({ kind: 'document', id: 'tasks', producers: ['writer'], consumers: [], locked: true })).toBeNull()
    expect(io({ ...slot, scope: 'repo' })).toBeNull()
  })

  it('accepts every canonical default-workflow guard and action used by the kernel', () => {
    const decoded = decodeWorkflowDefinition({
      name: 'default',
      openspec: true,
      steps: [{
        ...step,
        transitions: [{
          event: 'verify-fail',
          to: 'build',
          actions: [{ type: 'reset-pre-verify-review' }],
        }, {
          event: 'ship-complete',
          to: 'archive',
          guards: [{ type: 'spec-migration-applied' }],
        }],
      }],
    })

    expect(decoded?.steps[0]?.transitions).toEqual([
      {
        event: 'verify-fail',
        to: 'build',
        actions: [{ type: 'reset-pre-verify-review' }],
      },
      {
        event: 'ship-complete',
        to: 'archive',
        guards: [{ type: 'spec-migration-applied' }],
      },
    ])
  })

  it.each(guards)('%s rejects an illegal top-level data key instead of silently normalizing it', (_name, guard) => {
    expect(decodeWithGuard({ ...guard, illegal: 'must-not-disappear' })).toBeNull()
  })

  it('rejects action variants with extra keys instead of silently normalizing them', () => {
    expect(decodeWorkflowDefinition({
      name: 'action-contract',
      steps: [{
        ...step,
        transitions: [{
          event: 'done',
          to: 'open',
          actions: [{ type: 'archive-run', illegal: 'must-not-disappear' }],
        }],
      }],
    })).toBeNull()
  })

  it('requires tasks-at-least n to match the kernel non-negative integer contract', () => {
    expect(decodeWithGuard({ type: 'tasks-at-least', n: -1 })).toBeNull()
    expect(decodeWithGuard({ type: 'tasks-at-least', n: 1.5 })).toBeNull()
    expect(decodeWithGuard({ type: 'tasks-at-least', n: 0 })?.steps[0]?.guards[0]).toEqual({
      type: 'tasks-at-least',
      n: 0,
    })
  })

  it.each(guards)('%s requires an exact nested when predicate', (_name, guard) => {
    expect(decodeWithGuard({
      ...guard,
      when: { kind: 'track-in', values: ['backend'], illegal: 'must-not-disappear' },
    })).toBeNull()
  })

  it('rejects the concrete nonempty-output+n corruption and an over-broad file-exists path', () => {
    expect(decodeWithGuard({ type: 'nonempty-output', n: 2 })).toBeNull()
    expect(decodeWithGuard({
      type: 'file-exists',
      path: { kind: 'field', field: 'plan', illegal: 'must-not-disappear' },
    })).toBeNull()
  })

  it.each(guards)('%s still accepts its exact canonical key set with an exact when predicate', (_name, guard) => {
    expect(decodeWithGuard({
      ...guard,
      when: { kind: 'track-not-in', values: ['pm'] },
    })?.steps[0]?.guards[0]).toEqual({
      ...guard,
      when: { kind: 'track-not-in', values: ['pm'] },
    })
  })
})

describe('decodeWorkflowDefinition · 步骤 agents', () => {
  const withAgents = (agents: unknown) => decodeWorkflowDefinition({
    name: 'agents', steps: [{ ...step, agents }],
  })

  it('执行者与评审者按原样解出；缺省不补键', () => {
    const decoded = withAgents({
      executors: [{ agent: 'builder' }],
      reviewers: [{ agent: 'security', required: false, block_at: 'medium', reads_tests: ['unit'] }],
    })
    expect(decoded?.steps[0]?.agents).toEqual({
      executors: [{ agent: 'builder' }],
      reviewers: [{ agent: 'security', required: false, block_at: 'medium', reads_tests: ['unit'] }],
    })
    expect(decodeWorkflowDefinition({ name: 'bare', steps: [step] })?.steps[0]?.agents).toBeUndefined()
  })

  it('评审者的执行宿主 host（codex | claude | any）原样解出并写回；写错值、放在执行者上整份作废', () => {
    for (const host of ['codex', 'claude', 'any']) {
      const reviewers = [{ agent: 'security', required: true, block_at: 'high', host }]
      const decoded = withAgents({ reviewers })
      expect(decoded?.steps[0]?.agents).toEqual({ executors: [], reviewers })
      const written = JSON.parse(JSON.stringify(definitionForWrite(decoded as WbWorkflowDef))) as WbWorkflowDef
      expect(written.steps[0]?.agents?.reviewers).toEqual(reviewers)
    }
    expect(withAgents({ reviewers: [{ agent: 'security', required: true, block_at: 'high', host: 'gemini' }] })).toBeNull()
    expect(withAgents({ reviewers: [{ agent: 'security', required: true, block_at: 'high', host: 3 }] })).toBeNull()
    expect(withAgents({ executors: [{ agent: 'builder', host: 'codex' }] })).toBeNull()
  })

  it('未知字段、非法阻断级别、缺 required 都整份作废', () => {
    expect(withAgents({ executors: [{ agent: 'builder', lane: 'x' }], reviewers: [] })).toBeNull()
    expect(withAgents({ executors: [], reviewers: [{ agent: 'a', required: true, block_at: 'fatal' }] })).toBeNull()
    expect(withAgents({ executors: [], reviewers: [{ agent: 'a', block_at: 'high' }] })).toBeNull()
    expect(withAgents({ executors: [], reviewers: [], extra: [] })).toBeNull()
  })
})

describe('decodeWorkflowDefinition · 步骤 test_policy', () => {
  const FULL = {
    plan: 'required',
    kinds: ['unit', 'playwright'],
    run: ['unit', 'regression'],
    run_if_registered: ['benchmark'],
    scope: 'full',
    files: 'registered',
    scenarios: 'passing',
    coverage: { lines: 80, branches: 70, changed_lines: 90 },
    flaky: { max: 2, fail_on_new: true },
    benchmark: { require_baseline: true },
    browsers: ['chromium', 'Mobile Chrome'],
  }
  const withPolicy = (policy: unknown) => decodeWorkflowDefinition({
    name: 'policy', steps: [{ ...step, test_policy: policy }],
  })

  it('每个键原样解出，写回前整形后逐字相同（保存不丢策略）', () => {
    const decoded = withPolicy(FULL)
    expect(decoded?.steps[0]?.test_policy).toEqual(FULL)
    const written = JSON.parse(JSON.stringify(definitionForWrite(decoded as WbWorkflowDef))) as WbWorkflowDef
    expect(written.steps[0]?.test_policy).toEqual(FULL)
  })

  it('integrity: block 与 notice 原样解出并写回；写错值整份作废', () => {
    for (const integrity of ['block', 'notice']) {
      const decoded = withPolicy({ run: ['unit'], integrity })
      expect(decoded?.steps[0]?.test_policy).toEqual({ run: ['unit'], integrity })
      const written = JSON.parse(JSON.stringify(definitionForWrite(decoded as WbWorkflowDef))) as WbWorkflowDef
      expect(written.steps[0]?.test_policy).toEqual({ run: ['unit'], integrity })
    }
    expect(withPolicy({ integrity: 'off' })).toBeNull()
    expect(withPolicy({ integrity: true })).toBeNull()
  })

  it('track 分支里的步骤同样保留策略；缺省不补键', () => {
    const decoded = decodeWorkflowDefinition({
      name: 'branches', steps: [],
      tracks: { backend: { steps: [{ ...step, test_policy: { run: ['unit'] } }, step] } },
    })
    expect(decoded?.tracks?.backend?.steps[0]?.test_policy).toEqual({ run: ['unit'] })
    expect(decoded?.tracks?.backend?.steps[1]).not.toHaveProperty('test_policy')
    expect(decodeWorkflowDefinition({ name: 'bare', steps: [step] })?.steps[0]).not.toHaveProperty('test_policy')
  })

  it('未知键、未知种类、越界数字、错误取值整份作废', () => {
    expect(withPolicy({ ...FULL, lane: 'x' })).toBeNull()
    expect(withPolicy({ kinds: ['unit', 'nope'] })).toBeNull()
    expect(withPolicy({ run: ['unit', 'unit'] })).toBeNull()
    expect(withPolicy({ coverage: { lines: 101 } })).toBeNull()
    expect(withPolicy({ coverage: {} })).toBeNull()
    expect(withPolicy({ coverage: { statements_pct: 1 } })).toBeNull()
    expect(withPolicy({ flaky: { max: -1 } })).toBeNull()
    expect(withPolicy({ flaky: { max: 1.5 } })).toBeNull()
    expect(withPolicy({ flaky: { max: 1, extra: true } })).toBeNull()
    expect(withPolicy({ benchmark: { require_baseline: 'yes' } })).toBeNull()
    expect(withPolicy({ benchmark: {} })).toBeNull()
    expect(withPolicy({ scope: 'known' })).toBeNull()
    expect(withPolicy({ files: 'all' })).toBeNull()
    expect(withPolicy({ scenarios: 'strict' })).toBeNull()
    expect(withPolicy({ plan: 'never' })).toBeNull()
    expect(withPolicy({ browsers: [''] })).toBeNull()
    expect(withPolicy('unit')).toBeNull()
    expect(withPolicy(null)).toBeNull()
  })
})

describe('decodeWorkflowDefinition · 步骤 maxRounds（验证轮次上限）', () => {
  const withRounds = (maxRounds: unknown) => decodeWorkflowDefinition({
    name: 'rounds', steps: [{ ...step, gate: 'review', maxRounds }],
  })

  it('1 到 20 的整数原样解出，写回前整形后逐字相同（读写不丢）', () => {
    for (const maxRounds of [1, 2, 20]) {
      const decoded = withRounds(maxRounds)
      expect(decoded?.steps[0]?.maxRounds).toBe(maxRounds)
      const written = JSON.parse(JSON.stringify(definitionForWrite(decoded as WbWorkflowDef))) as WbWorkflowDef
      expect(written.steps[0]?.maxRounds).toBe(maxRounds)
    }
  })

  it('track 分支里的步骤同样保留；没声明的步骤不补键', () => {
    const decoded = decodeWorkflowDefinition({
      name: 'branches', steps: [],
      tracks: { backend: { steps: [{ ...step, gate: 'review', maxRounds: 3 }, step] } },
    })
    expect(decoded?.tracks?.backend?.steps[0]?.maxRounds).toBe(3)
    expect(decoded?.tracks?.backend?.steps[1]).not.toHaveProperty('maxRounds')
    expect(decodeWorkflowDefinition({ name: 'bare', steps: [step] })?.steps[0]).not.toHaveProperty('maxRounds')
  })

  it('复制、克隆工作流时保留上限', () => {
    const decoded = withRounds(2) as WbWorkflowDef
    expect(cloneWorkflowDef(decoded, 'copy').steps[0]?.maxRounds).toBe(2)
  })

  it('越界、小数、非数字整份作废（与服务端同一取值口径）', () => {
    for (const bad of [0, 21, 1.5, '2', null, true]) expect(withRounds(bad), String(bad)).toBeNull()
  })
})
