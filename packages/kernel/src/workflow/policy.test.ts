import { describe, expect, it } from 'vitest'
import { compileWorkflow } from './compile.js'
import {
  canUseWorkflowRecommendedDefault,
  evaluateWorkflowAction,
  workflowPolicyPermissionLayer,
} from './policy.js'
import type { WorkflowDef } from './types.js'

const STEP = {
  id: 'build', label: 'Build', gate: null,
  skills: [], inputs: [], outputs: [], guards: [], transitions: [],
} as const

function definition(overrides: Record<string, unknown> = {}): WorkflowDef {
  return { name: 'policy-test', steps: [STEP], ...overrides } as WorkflowDef
}

describe('workflow policy compilation', () => {
  it('projects safe independent defaults for legacy definitions', () => {
    const ir = compileWorkflow(definition())

    expect(ir.decomposition).toEqual({
      version: 'v1', mode: 'off', target: 'work-items', strategy: 'balanced',
      max_items: 16, max_depth: 2, auto_when: [], ask_when: [],
    })
    expect(ir.interaction).toEqual({ version: 'v1', mode: 'interactive' })
    expect(Object.isFrozen(ir.decomposition)).toBe(true)
    expect(Object.isFrozen(ir.decomposition.auto_when)).toBe(true)
    expect(Object.isFrozen(ir.interaction)).toBe(true)
  })

  it('normalizes and freezes the complete closed policy without coupling the modes', () => {
    const ir = compileWorkflow(definition({
      decomposition: {
        version: 'v1', mode: 'auto-safe', target: 'child-pipelines', strategy: 'depth-first',
        max_items: 4, max_depth: 3,
        auto_when: ['context-budget-risk', 'independent-work-items'],
        ask_when: ['hard-boundary', 'missing-authorization'],
      },
      interaction: { version: 'v1', mode: 'recommended-defaults' },
    }))

    expect(ir.decomposition.mode).toBe('auto-safe')
    expect(ir.decomposition.target).toBe('child-pipelines')
    expect(ir.interaction.mode).toBe('recommended-defaults')
  })

  it.each([
    ['unknown workflow key', { decomposition: { version: 'v1', mode: 'off', surprise: true } }],
    ['missing version', { decomposition: { mode: 'off' } }],
    ['unknown version', { decomposition: { version: 'v2', mode: 'off' } }],
    ['unknown mode', { decomposition: { version: 'v1', mode: 'everything' } }],
    ['unknown target', { decomposition: { version: 'v1', mode: 'off', target: 'threads' } }],
    ['unknown strategy', { decomposition: { version: 'v1', mode: 'off', strategy: 'random' } }],
    ['low max_items', { decomposition: { version: 'v1', mode: 'off', max_items: 0 } }],
    ['high max_items', { decomposition: { version: 'v1', mode: 'off', max_items: 33 } }],
    ['low max_depth', { decomposition: { version: 'v1', mode: 'off', max_depth: -1 } }],
    ['high max_depth', { decomposition: { version: 'v1', mode: 'off', max_depth: 5 } }],
    ['duplicate condition', { decomposition: { version: 'v1', mode: 'off', auto_when: ['context-budget-risk', 'context-budget-risk'] } }],
    ['unknown condition', { decomposition: { version: 'v1', mode: 'off', ask_when: ['ask-always'] } }],
    ['unknown interaction key', { interaction: { version: 'v1', mode: 'interactive', surprise: true } }],
    ['unknown interaction mode', { interaction: { version: 'v1', mode: 'silent' } }],
    ['已删除的 reviewBudget', { reviewBudget: { version: 'v1', max_attempts: 2 } }],
  ])('rejects %s', (_label, overrides) => {
    expect(() => compileWorkflow(definition(overrides))).toThrow()
  })

  it.each([
    ['an explicit undefined item', [undefined]],
    ['a sparse item', new Array(1)],
  ])('rejects %s in condition arrays instead of defaulting to the first enum', (_label, auto_when) => {
    expect(() => compileWorkflow(definition({
      decomposition: { version: 'v1', mode: 'auto-safe', auto_when },
    }))).toThrow()
  })
})

describe('workflow action permission intersection', () => {
  const validLayer = { status: 'valid', grants: ['write-filesystem'] } as const
  const allLayers = {
    platform: validLayer,
    skill: validLayer,
    project: validLayer,
    workflow: validLayer,
    run: validLayer,
  } as const

  it('hard-blocks an unknown runtime action classification', () => {
    const input = {
      action: 'write-filesystem',
      classification: 'future-privilege',
      interactionMode: 'interactive',
      layers: allLayers,
    } as unknown as Parameters<typeof evaluateWorkflowAction>[0]

    expect(evaluateWorkflowAction(input)).toMatchObject({
      allowed: false,
      status: 'hard-blocked',
      denials: expect.arrayContaining([expect.objectContaining({
        code: 'action-classification-malformed',
      })]),
    })
  })

  it('allows only when every named layer grants the exact action', () => {
    expect(evaluateWorkflowAction({
      action: 'write-filesystem',
      classification: 'routine-reversible',
      interactionMode: 'afk',
      layers: allLayers,
    })).toMatchObject({ allowed: true, status: 'allowed', denials: [] })
  })

  it.each(['platform', 'skill', 'project', 'workflow', 'run'] as const)(
    'returns the contributing %s layer and remediation when it denies',
    (layer) => {
      const result = evaluateWorkflowAction({
        action: 'write-filesystem',
        classification: 'routine-reversible',
        interactionMode: 'interactive',
        layers: { ...allLayers, [layer]: { status: 'valid', grants: [] } },
      })
      expect(result.allowed).toBe(false)
      expect(result.status).toBe('denied')
      expect(result.denials).toContainEqual(expect.objectContaining({ layer, code: `${layer}-denied` }))
    },
  )

  it('fails closed for missing, stale, and identity-drifted authorization inputs', () => {
    const missing = evaluateWorkflowAction({
      action: 'write-filesystem', classification: 'routine-reversible', interactionMode: 'interactive',
      layers: { ...allLayers, run: { status: 'missing', grants: [] } },
    })
    const stale = evaluateWorkflowAction({
      action: 'write-filesystem', classification: 'routine-reversible', interactionMode: 'interactive',
      layers: { ...allLayers, run: { status: 'stale', grants: ['write-filesystem'] } },
    })
    const drifted = evaluateWorkflowAction({
      action: 'write-filesystem', classification: 'routine-reversible', interactionMode: 'interactive',
      layers: { ...allLayers, workflow: { status: 'fingerprint-mismatch', grants: ['write-filesystem'] } },
    })

    expect(missing).toMatchObject({ allowed: false, status: 'hard-blocked' })
    expect(stale).toMatchObject({ allowed: false, status: 'stale' })
    expect(drifted).toMatchObject({ allowed: false, status: 'stale' })
  })

  it.each([
    ['missing layer', { platform: validLayer, skill: validLayer, project: validLayer, workflow: validLayer }],
    ['non-array grants', { ...allLayers, run: { status: 'valid', grants: 'write-filesystem' } }],
    ['unknown grant', { ...allLayers, run: { status: 'valid', grants: ['future-superuser'] } }],
  ])('normalizes runtime-malformed permission facts: %s', (_label, layers) => {
    const input = {
      action: 'write-filesystem',
      classification: 'routine-reversible',
      interactionMode: 'interactive',
      layers,
    } as unknown as Parameters<typeof evaluateWorkflowAction>[0]

    expect(() => evaluateWorkflowAction(input)).not.toThrow()
    expect(evaluateWorkflowAction(input)).toMatchObject({
      allowed: false,
      status: 'hard-blocked',
      contributions: expect.arrayContaining([{ layer: 'run', status: 'malformed', granted: false }]),
      denials: expect.arrayContaining([{ layer: 'run', code: 'run-malformed', remediation: 'repair-authority-binding' }]),
    })
  })

  it.each([
    'safety-sensitive', 'cost', 'production', 'external-side-effect', 'publication',
    'credentials', 'irreversible', 'missing-authorization',
  ] as const)('requires explicit confirmation for hard boundary %s in every interaction mode', (classification) => {
    const result = evaluateWorkflowAction({
      action: 'write-filesystem', classification, interactionMode: 'afk', layers: allLayers,
    })
    expect(result).toMatchObject({ allowed: false, status: 'hard-blocked' })
    expect(result.denials).toContainEqual(expect.objectContaining({ code: 'hard-confirmation-required' }))
  })

  it('hard-blocks missing authorization even with an exact hard confirmation', () => {
    const result = evaluateWorkflowAction({
      action: 'write-filesystem',
      classification: 'missing-authorization',
      interactionMode: 'afk',
      layers: allLayers,
      authority: {
        authority_id: 'authority-1',
        workflow_run_id: 'run-1',
        workflow_fingerprint: 'a'.repeat(64),
      },
      hardConfirmation: {
        status: 'confirmed',
        authority_id: 'authority-1',
        action: 'write-filesystem',
        workflow_run_id: 'run-1',
        workflow_fingerprint: 'a'.repeat(64),
      },
    })

    expect(result).toMatchObject({ allowed: false, status: 'hard-blocked' })
    expect(result.denials).toContainEqual(expect.objectContaining({
      code: 'missing-authorization-hard-blocked',
    }))
  })

  it.each(['production', 'irreversible'] as const)(
    'allows legitimate exact confirmation for %s',
    (classification) => {
      const result = evaluateWorkflowAction({
        action: 'write-filesystem',
        classification,
        interactionMode: 'afk',
        layers: allLayers,
        authority: {
          authority_id: 'authority-1',
          workflow_run_id: 'run-1',
          workflow_fingerprint: 'a'.repeat(64),
        },
        hardConfirmation: {
          status: 'confirmed',
          authority_id: 'authority-1',
          action: 'write-filesystem',
          workflow_run_id: 'run-1',
          workflow_fingerprint: 'a'.repeat(64),
        },
      })

      expect(result).toMatchObject({ allowed: true, status: 'allowed', denials: [] })
    },
  )

  it.each([
    ['authority', { authority_id: 'other-authority' }],
    ['action', { action: 'publish-external' }],
    ['run', { workflow_run_id: 'other-run' }],
    ['workflow fingerprint', { workflow_fingerprint: 'b'.repeat(64) }],
  ])('rejects a confirmed hard-boundary receipt bound to another %s', (_label, mismatch) => {
    const hardLayer = { status: 'valid', grants: ['write-filesystem'] } as const
    const input = {
      action: 'write-filesystem',
      classification: 'production',
      interactionMode: 'afk',
      layers: {
        platform: hardLayer, skill: hardLayer, project: hardLayer,
        workflow: hardLayer, run: hardLayer,
      },
      authority: {
        authority_id: 'authority-1',
        workflow_run_id: 'run-1',
        workflow_fingerprint: 'a'.repeat(64),
      },
      hardConfirmation: {
        status: 'confirmed',
        authority_id: 'authority-1',
        action: 'write-filesystem',
        workflow_run_id: 'run-1',
        workflow_fingerprint: 'a'.repeat(64),
        ...mismatch,
      },
    } as unknown as Parameters<typeof evaluateWorkflowAction>[0]

    expect(evaluateWorkflowAction(input)).toMatchObject({ allowed: false, status: 'hard-blocked' })
  })

  it('AFK changes transport eligibility but does not grant side-effect capabilities', () => {
    const layer = workflowPolicyPermissionLayer({
      decomposition: {
        version: 'v1', mode: 'off', target: 'work-items', strategy: 'balanced',
        max_items: 16, max_depth: 2, auto_when: [], ask_when: [],
      },
      interaction: { version: 'v1', mode: 'afk' },
    })
    expect(layer.grants).toContain('enter-afk')
    expect(layer.grants).not.toContain('publish-external')
    expect(layer.grants).not.toContain('operate-production')
  })
})

describe('recommended default evidence', () => {
  it('reuses the canonical PR2 question and decision contract for routine defaults', () => {
    expect(canUseWorkflowRecommendedDefault(
      { version: 'v1', mode: 'recommended-defaults' },
      {
        question_id: 'routine-question', option_ids: ['recommended', 'custom'],
        requiredness: 'routine', shown: false,
      },
      {
        question_id: 'routine-question',
        mode: 'recommended-default',
        policy: { id: 'workflow-policy', version: 'v1', rule_id: 'routine' },
        rationale_code: 'frozen-routine-default',
        selected_option_ids: ['recommended'],
      },
      { id: 'workflow-policy', version: 'v1', rule_id: 'routine' },
    )).toBe(true)
    expect(canUseWorkflowRecommendedDefault(
      { version: 'v1', mode: 'recommended-defaults' },
      {
        question_id: 'hard-question', option_ids: ['recommended'],
        requiredness: 'hard-gate', shown: false,
      },
      {
        question_id: 'hard-question',
        mode: 'recommended-default',
        policy: { id: 'workflow-policy', version: 'v1', rule_id: 'routine' },
        rationale_code: 'frozen-routine-default',
        selected_option_ids: ['recommended'],
      },
      { id: 'workflow-policy', version: 'v1', rule_id: 'routine' },
    )).toBe(false)
  })

  it.each([
    ['another question', {
      question_id: 'other-question',
      selected_option_ids: ['recommended'],
      policy: { id: 'workflow-policy', version: 'v1', rule_id: 'routine' },
    }],
    ['an option absent from the current question', {
      question_id: 'routine-question',
      selected_option_ids: ['foreign-option'],
      policy: { id: 'workflow-policy', version: 'v1', rule_id: 'routine' },
    }],
    ['an empty policy reference', {
      question_id: 'routine-question',
      selected_option_ids: ['recommended'],
      policy: { id: '', version: 'v1', rule_id: 'routine' },
    }],
  ])('rejects a recommended decision bound to %s', (_label, override) => {
    expect(canUseWorkflowRecommendedDefault(
      { version: 'v1', mode: 'recommended-defaults' },
      {
        question_id: 'routine-question', option_ids: ['recommended', 'custom'],
        requiredness: 'routine', shown: false,
      },
      {
        mode: 'recommended-default',
        rationale_code: 'frozen-routine-default',
        ...override,
      },
      { id: 'workflow-policy', version: 'v1', rule_id: 'routine' },
    )).toBe(false)
  })

  it('the authoritative evaluator denies direct recommended-default use without PR2 evidence', () => {
    const layer = { status: 'valid', grants: ['apply-recommended-default'] } as const
    const base = {
      action: 'apply-recommended-default',
      classification: 'routine-reversible',
      interactionMode: 'recommended-defaults',
      layers: { platform: layer, skill: layer, project: layer, workflow: layer, run: layer },
    } as const
    expect(evaluateWorkflowAction(base)).toMatchObject({ allowed: false, status: 'denied' })
    expect(evaluateWorkflowAction({
      ...base,
      frozenRecommendedDefaultPolicy: {
        id: 'workflow-policy', version: 'v1', rule_id: 'routine',
      },
      recommendedDefaultEvidence: {
        question: {
          question_id: 'routine-question', option_ids: ['recommended'],
          requiredness: 'routine', shown: false,
        },
        decision: {
          question_id: 'routine-question',
          mode: 'recommended-default', selected_option_ids: ['recommended'],
          policy: { id: 'workflow-policy', version: 'v1', rule_id: 'routine' },
          rationale_code: 'frozen-routine-default',
        },
      },
    })).toMatchObject({ allowed: true, status: 'allowed' })
  })

  it('rejects a decision whose policy ref differs from the frozen authorized rule', () => {
    const layer = { status: 'valid', grants: ['apply-recommended-default'] } as const
    const input = {
      action: 'apply-recommended-default',
      classification: 'routine-reversible',
      interactionMode: 'recommended-defaults',
      layers: { platform: layer, skill: layer, project: layer, workflow: layer, run: layer },
      frozenRecommendedDefaultPolicy: {
        id: 'workflow-policy', version: 'v1', rule_id: 'authorized-routine',
      },
      recommendedDefaultEvidence: {
        question: {
          question_id: 'routine-question', option_ids: ['recommended'],
          requiredness: 'routine', shown: false,
        },
        decision: {
          question_id: 'routine-question',
          mode: 'recommended-default', selected_option_ids: ['recommended'],
          policy: { id: 'workflow-policy', version: 'v1', rule_id: 'different-rule' },
          rationale_code: 'frozen-routine-default',
        },
      },
    } as const

    expect(evaluateWorkflowAction(input as unknown as Parameters<typeof evaluateWorkflowAction>[0]))
      .toMatchObject({ allowed: false })
  })
})
