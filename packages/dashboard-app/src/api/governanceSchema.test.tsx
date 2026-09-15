import { describe, expect, it } from 'vitest'
import { decodeWorkflowDefinition } from './governanceSchema'
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
    expect(decoded?.reviewBudget).toEqual({ version: 'v1', max_attempts: 2 })
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
      reviewBudget: { version: 'v1', max_attempts: 4 },
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
    expect(decoded?.reviewBudget).toEqual({ version: 'v1', max_attempts: 4 })
  })

  it('preserves explicit Review lanes and classifies third-party Skills without name inference', () => {
    const decoded = decodeWorkflowDefinition({
      name: 'review-contract',
      reviewBudget: { version: 'v1', max_attempts: 3 },
      steps: [{
        ...step,
        id: 'verify',
        gate: 'review',
        reviewLanes: ['standards', 'e2e'],
        skills: [
          { id: 'acme-quality-gate', kind: 'review', review_lane: 'standards' },
          { id: 'e2e-looking-work', kind: 'work' },
        ],
      }],
    })

    expect(decoded?.steps[0]).toMatchObject({
      reviewLanes: ['standards', 'e2e'],
      skills: [
        { id: 'acme-quality-gate', kind: 'review', review_lane: 'standards' },
        { id: 'e2e-looking-work', kind: 'work' },
      ],
    })
    expect(decodeWorkflowDefinition({
      name: 'undeclared-lane',
      steps: [{
        ...step,
        reviewLanes: ['e2e'],
        skills: [{ id: 'acme-quality-gate', kind: 'review', review_lane: 'standards' }],
      }],
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
    for (const reviewBudget of [
      { max_attempts: 2 },
      { version: 'v1', max_attempts: 0 },
      { version: 'v1', max_attempts: 21 },
      { version: 'v1', max_attempts: 2, infinite: true },
    ]) {
      expect(decodeWorkflowDefinition({ name: 'invalid-review-budget', reviewBudget, steps: [step] })).toBeNull()
    }
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
