import { describe, expect, test } from 'vitest'
import { compileEffectiveWorkflowPlan } from '../workflow/effective-plan.js'
import { parseWorkflow } from '../workflow/parse.js'
import { rejectOnTestEvidence, type TestEvidenceReader } from './transition-gate.js'

const PLAN = compileEffectiveWorkflowPlan('lane', parseWorkflow([
  'name: lane',
  'steps:',
  '  - id: build',
  '    label: B',
  '    gate: null',
  '    skills: []',
  '    inputs: []',
  '    outputs: []',
  '    guards: []',
  '    transitions:',
  '      - event: build-complete',
  '        to: verify',
  '      - event: scope-expanded',
  '        to: escalated',
  '  - id: verify',
  '    label: V',
  '    gate: null',
  '    skills: []',
  '    inputs: []',
  '    outputs: []',
  '    guards: []',
  '    transitions: []',
  '  - id: escalated',
  '    label: E',
  '    gate: null',
  '    skills: []',
  '    inputs: []',
  '    outputs: []',
  '    guards: []',
  '    transitions: []',
].join('\n')))

// 阻塞的判定读取器：只要被问到就说「测试没过」，用来看哪些边根本不会去问。
const failing: TestEvidenceReader = async () => ({ pass: false, blockers: ['测试 diff-risk 未通过'], items: [] })

const base = { repoRoot: '/nowhere', changeDir: '/nowhere/c', changeName: 'c', plan: PLAN, from: 'build', context: undefined, evaluate: failing }

describe('rejectOnTestEvidence 与放弃边', () => {
  test('前进边：必需测试没过就拒绝', async () => {
    expect(await rejectOnTestEvidence({ ...base, to: 'verify', event: 'build-complete' }))
      .toEqual({ kind: 'test-evidence-failed', stepId: 'build', blockers: ['测试 diff-risk 未通过'] })
  })

  test('放弃边 scope-expanded：不要求测试——任务要被放弃了，没做完的证据不该拦着它', async () => {
    expect(await rejectOnTestEvidence({ ...base, to: 'escalated', event: 'scope-expanded' })).toBeUndefined()
  })

  test('不带事件的旧调用面按普通前进边判定', async () => {
    expect(await rejectOnTestEvidence({ ...base, to: 'escalated' })).toMatchObject({ kind: 'test-evidence-failed' })
  })
})
