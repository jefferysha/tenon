import { describe, expect, it } from 'vitest'
import {
  decodeTestRunRecordV2, parseTestCatalog, testPlanApprovalFreeDigest, testPlanDigest,
  type StepTestPolicyIR, type TestCatalog, type TestPlan,
} from '@tenon/kernel'
import { fixtureCase, fixtureSuiteRun } from '@tenon/kernel/test-system/test-support'
import { applyRunLevelReasons, draftOf, evaluationShell, machineOf } from './run-record.js'

const POLICY: StepTestPolicyIR = {
  plan: 'optional', kinds: [], run: ['unit'], run_if_registered: [], scope: 'changed', files: 'any', scenarios: 'off',
  benchmark: { require_baseline: false }, browsers: [],
}
const PLAN: TestPlan = {
  schema: 'tenon-test-plan/v1', change: 'demo', suites: [{ suite: 'unit', scope: 'full' }], files: [{ path: 'src/new.test.ts', suite: 'unit' }], cases: [], waivers: [],
}
const parsed = parseTestCatalog('schema: tenon-test-catalog/v1\nprofiles_env: [CI]\nsuites:\n  - { id: unit, kind: unit, runner: vitest, command: x, report: { format: vitest-json, path: test-results/v.json } }\n')
if (!parsed.ok) throw new Error('fixture catalog')
const CATALOG: TestCatalog = parsed.catalog

describe('applyRunLevelReasons', () => {
  const clean = fixtureSuiteRun({ suite: 'unit' })
  const input = { candidateBefore: 'workspace:sha256:' + 'a'.repeat(64), candidateAfter: 'workspace:sha256:' + 'a'.repeat(64), policy: POLICY, plan: PLAN }

  it('指纹前后一致 → 不加原因', () => {
    expect(applyRunLevelReasons([clean], input)).toEqual([clean])
  })

  it('候选取不到 → candidate-unavailable 并判失败；前后指纹不同 → 只记 workspace-changed 提示', () => {
    expect(applyRunLevelReasons([clean], { ...input, candidateAfter: null })[0]).toMatchObject({ result: 'fail', reasons: [{ code: 'candidate-unavailable' }] })
    expect(applyRunLevelReasons([clean], { ...input, candidateAfter: 'workspace:sha256:' + 'b'.repeat(64) })[0]).toMatchObject({ result: 'pass', reasons: [{ code: 'workspace-changed' }] })
  })

  it('flaky 总数超上限 → 有 flaky 的套件判失败；新登记文件里的 flaky（fail_on_new）单独判失败', () => {
    const flaky = fixtureSuiteRun({ suite: 'unit', cases: [fixtureCase({ file: 'src/old.test.ts', name: 'a', status: 'flaky' })] })
    const fresh = fixtureSuiteRun({ suite: 'web', cases: [fixtureCase({ file: 'src/new.test.ts', name: 'b', status: 'flaky' })] })
    const limited = { ...POLICY, flaky: { max: 2, fail_on_new: true } }
    const runs = applyRunLevelReasons([flaky, fresh], { ...input, policy: limited })
    expect(runs.map((run) => [run.suite, run.result])).toEqual([['unit', 'pass'], ['web', 'fail']])
    expect(runs[1]?.reasons[0]).toMatchObject({ code: 'flaky-over-limit', detail: expect.stringContaining('新增') })
    const over = applyRunLevelReasons([flaky, fresh], { ...input, policy: { ...POLICY, flaky: { max: 1, fail_on_new: false } } })
    expect(over.map((run) => run.result)).toEqual(['fail', 'fail'])
    expect(applyRunLevelReasons([flaky], { ...input, policy: { ...POLICY, flaky: { max: 5, fail_on_new: false } } })[0]?.result).toBe('pass')
  })
})

describe('draftOf', () => {
  it('绑定候选、目录（只取本次运行的套件）、计划与策略摘要；结果由套件汇总；写出的记录能通过解码', () => {
    const profile = machineOf(CATALOG, { CI: 'true' })
    expect(profile.id).toMatch(/^[a-z0-9-]+-[a-f0-9]{8}$/)
    expect(machineOf(CATALOG, { CI: 'true' }).id).toBe(profile.id)
    expect(machineOf(CATALOG, { CI: undefined }).id).not.toBe(profile.id)
    const pass = fixtureSuiteRun({ suite: 'unit' })
    const draft = draftOf({
      runId: '20260929T100000Z-abcdef', change: 'demo', workflowRunId: 'run-1', workflow: 'default', track: 'chat', step: 'build',
      workflowFingerprint: 'f'.repeat(64), candidate: 'workspace:sha256:' + 'c'.repeat(64), catalog: CATALOG, planDigest: `sha256:${'d'.repeat(64)}`,
      policy: POLICY, profile, services: [], suites: [pass, { ...pass, suite: 'other', result: 'fail' }],
      actor: { id: 'a@x.io', name: 'A', trust: 'declared' }, host: { kind: 'terminal', sandbox: null }, gitHead: null,
      startedAt: '2026-09-29T10:00:00Z', finishedAt: '2026-09-29T10:00:05Z', durationMs: 4999.6,
    })
    expect(draft.result).toBe('fail')
    expect(draft.duration_ms).toBe(5000)
    expect(draft.bindings).toMatchObject({ candidate: 'workspace:sha256:' + 'c'.repeat(64), policy_digest: expect.stringMatching(/^sha256:/), plan_digest: `sha256:${'d'.repeat(64)}` })
    expect(decodeTestRunRecordV2({ ...draft, prev_digest: null, digest: `sha256:${'0'.repeat(64)}` })).toBeDefined()
    const shell = evaluationShell({ ...draft, suites: [], services: [] })
    expect(shell).toMatchObject({ machine_profile: profile.id, prev_digest: null })
  })

  it('目录的 profile: coarse 选粗口径：id 不含 CPU 型号与内存，仍随 profiles_env 的取值变化', () => {
    const coarseParsed = parseTestCatalog('schema: tenon-test-catalog/v1\nprofile: coarse\nprofiles_env: [CI]\nsuites: []\n')
    if (!coarseParsed.ok) throw new Error('fixture catalog')
    const coarse = machineOf(coarseParsed.catalog, { CI: 'true' })
    expect(coarse.mode).toBe('coarse')
    expect(coarse.label).toMatch(/^[a-z0-9]+-[a-z0-9]+-\d+c-node\d+$/u)
    expect(machineOf(coarseParsed.catalog, { CI: 'true' }).id).toBe(coarse.id)
    expect(machineOf(coarseParsed.catalog, {}).id).not.toBe(coarse.id)
    const fine = machineOf(CATALOG, { CI: 'true' })
    expect(fine.mode).toBe('fine')
    expect(fine.id).not.toBe(coarse.id)
  })

  it('没有套件（评估外壳）时目录摘要为 null', () => {
    const profile = machineOf(CATALOG, {})
    const draft = draftOf({
      runId: '20260929T100000Z-abcdef', change: 'demo', workflowRunId: 'run-1', workflow: 'default', track: 'chat', step: 'build',
      workflowFingerprint: 'f'.repeat(64), candidate: null, catalog: CATALOG, planDigest: null, policy: undefined, profile, services: [], suites: [],
      actor: { id: 'a@x.io', name: 'A', trust: 'declared' }, host: { kind: 'terminal', sandbox: null }, gitHead: null,
      startedAt: '2026-09-29T10:00:00Z', finishedAt: '2026-09-29T10:00:00Z', durationMs: 0,
    })
    expect(draft.bindings).toMatchObject({ catalog_digest: null, plan_digest: null, policy_digest: null, candidate: null })
  })
})

describe('记录绑定的计划摘要（kernel testPlanApprovalFreeDigest）', () => {
  const withWaiver = (approvedBy: string | null, reason = '纯文案改动'): TestPlan => ({
    ...PLAN, waivers: [{ kind: 'benchmark', reason, approved_by: approvedBy }],
  })

  it('批准位不进摘要：评审批准豁免不会让批准之前的运行过期', () => {
    expect(testPlanApprovalFreeDigest(withWaiver('reviewer@x.io'))).toBe(testPlanApprovalFreeDigest(withWaiver(null)))
    expect(testPlanApprovalFreeDigest(withWaiver(null))).toBe(testPlanDigest(withWaiver(null)))
  })

  it('计划别的任何变化——新增豁免、改豁免理由、加套件——摘要照常变化', () => {
    const base = testPlanApprovalFreeDigest(withWaiver(null))
    expect(testPlanApprovalFreeDigest(PLAN)).not.toBe(base)
    expect(testPlanApprovalFreeDigest(withWaiver(null, '换了原因'))).not.toBe(base)
    expect(testPlanApprovalFreeDigest({ ...withWaiver(null), suites: [...PLAN.suites, { suite: 'web', scope: 'full' }] })).not.toBe(base)
  })
})
