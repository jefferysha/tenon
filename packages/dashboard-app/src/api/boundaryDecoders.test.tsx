import { describe, expect, it } from 'vitest'
import { decodeSessionLinks, decodeTraceTimeline } from './auditDecoders'
import { decodeHooksConfig, decodeRouterPreview } from './governanceDecoders'
import { decodeLoopsSnapshot } from './loopDecoder'
import { decodeSnapshot } from './snapshotDecoder'
import { selectProgress } from '../model/progressModel'
import { workflowRulesFromSnapshot } from '../model/workflowModel'
import type { WorkflowDecompositionPolicySnapshot, WorkflowPolicyRulesSnapshot } from '../types'

describe('API bounded-context response decoders', () => {
  const validTraceTimeline = () => {
    const warnings: string[] = []
    return {
    generated_at: '2026-07-29T00:00:00.000Z',
    outbound: 'local-only',
    content: 'metadata-only',
    session: {
      id: 'sess-a',
      client: 'claude',
      proxy_mode: 'reverse',
      status: 'complete',
      started_at: '2026-07-29T00:00:00.000Z',
      updated_at: '2026-07-29T00:00:02.000Z',
    },
    total_count: 2,
    returned_count: 2,
    skipped_count: 0,
    truncated: false,
    integrity: 'complete',
    warnings,
    summary: {
      success_count: 1,
      error_count: 1,
      unknown_count: 0,
      total_duration_ms: 1600,
      input_tokens: 12,
      output_tokens: 8,
      cached_input_tokens: 0,
    },
    entries: [
      {
        sequence: 1,
        request_id: 'req-1',
        turn: 1,
        timestamp: '2026-07-29T00:00:01.000Z',
        duration_ms: 400,
        transport: 'sse',
        method: 'POST',
        path: '/v1/messages',
        status_code: 200,
        outcome: 'success',
        model: 'claude-sonnet-4',
        input_tokens: 12,
        output_tokens: 8,
        cached_input_tokens: 0,
        stream_event_count: 3,
      },
      {
        sequence: 2,
        request_id: null,
        turn: null,
        timestamp: null,
        duration_ms: 1200,
        transport: null,
        method: null,
        path: null,
        status_code: 429,
        outcome: 'error',
        model: null,
        input_tokens: null,
        output_tokens: null,
        cached_input_tokens: null,
        stream_event_count: null,
      },
    ],
    }
  }

  const validRules = {
    executionModel: 'step-graph',
    steps: ['open', 'done'],
    transitions: { open: [{ event: 'finish', to: 'done' }], done: [] },
    gateByStep: { open: null, done: null },
    labelByStep: { open: '开始', done: '完成' },
    outputsByStep: { open: ['result'], done: [] },
  }
  const validSnapshot = () => ({
    version: '1',
    generated_at: 'now',
    capabilities: { snapshot: true },
    project_count: 1,
    change_count: 1,
    projects: [{
      root: '/repo',
      ok: true,
      changes: [{
        name: 'demo',
        path: '/repo/openspec/changes/demo',
        phase: 'open',
        phase_status: 'in_progress',
        track: 'backend',
        preset: 'full',
        archived: 'false',
        updated_at: 'now',
        fields: {},
        owner: null,
        creator: null,
        workflowPlanFingerprint: 'a'.repeat(64),
        workflowRules: structuredClone(validRules),
        workflowExecution: {
          readinessByTransition: {
            open: {
              finish: {
                ready: false,
                blockers: [{
                  kind: 'guard-failed',
                  guardType: 'field-nonempty',
                  field: 'result',
                  actual: '',
                }],
              },
            },
            done: {},
          },
        },
      }],
    }],
  })

  it('preserves configured/frozen/effective/drift workflow policy diagnostics', () => {
    const snapshot = validSnapshot()
    const decomposition: WorkflowDecompositionPolicySnapshot = {
      version: 'v1', mode: 'off', target: 'work-items', strategy: 'balanced',
      max_items: 16, max_depth: 2, auto_when: [], ask_when: [],
    }
    const policy: WorkflowPolicyRulesSnapshot = {
      schema: 'workflow-policy/v1',
      configured: {
        status: 'available', workflowFingerprint: 'a'.repeat(64),
        decomposition, interaction: { version: 'v1', mode: 'interactive' },
      },
      frozen: {
        workflowFingerprint: 'a'.repeat(64), decomposition,
        interaction: { version: 'v1', mode: 'interactive' },
        workflowCeiling: { status: 'valid', grants: [] },
      },
      effective: { status: 'unavailable', reason: 'authority-input-unavailable' },
      drift: { status: 'current', fingerprintChanged: false, policyChanged: false },
    }
    const workflowRules = snapshot.projects[0].changes[0].workflowRules as
      typeof snapshot.projects[0]['changes'][number]['workflowRules'] & {
        policy?: WorkflowPolicyRulesSnapshot
      }
    workflowRules.policy = policy

    expect(decodeSnapshot(snapshot)?.projects[0]?.changes[0]?.workflowRules.policy)
      .toEqual(policy)
    policy.effective = {
      status: 'hard-blocked', grants: [], denials: [],
    } as never
    expect(decodeSnapshot(snapshot)).toBeNull()
  })

  it('rejects Hook config keyword strings outside the shared empty-or-ASCII-token contract', () => {
    const base = {
      hooks: [],
      matrix: {},
    }
    expect(decodeHooksConfig({ ...base, prompt_skip_keyword: '' })?.promptSkipKeyword).toBe('')
    expect(decodeHooksConfig({ ...base, prompt_skip_keyword: 'skip_Tenon-2' })?.promptSkipKeyword)
      .toBe('skip_Tenon-2')
    for (const invalid of ['bad value', '-leading', 'a'.repeat(33), '中文']) {
      expect(decodeHooksConfig({ ...base, prompt_skip_keyword: invalid })).toBeNull()
    }
  })

  it('keeps skillRuns when well-formed and fails closed on a malformed skill entry', () => {
    const good = validSnapshot()
    const runs = [{ stepId: 'open', skills: [{ id: 'tenon-open', status: 'running', wave: 0 }, { id: 'openspec-propose', status: 'idle', wave: 1 }] }]
    Object.assign(good.projects[0]!.changes[0]!, { skillRuns: runs })
    expect(decodeSnapshot(good)?.projects[0]?.changes[0]?.skillRuns).toEqual(runs)
    const bad = validSnapshot()
    Object.assign(bad.projects[0]!.changes[0]!, { skillRuns: [{ stepId: 'open', skills: [{ id: 'tenon-open', status: 'failed', wave: 0 }] }] })
    expect(decodeSnapshot(bad)).toBeNull()
    const legacy = validSnapshot()
    expect(decodeSnapshot(legacy)?.projects[0]?.changes[0]?.skillRuns).toBeUndefined()
  })

  it('keeps agentRuns when well-formed and fails closed on an unknown state', () => {
    const view = {
      agent: 'security', role: 'reviewer', required: true, blockAt: 'high',
      dependsOn: ['builder'], readsTests: ['unit'], state: 'stale', result: 'pass',
      findings: 2, blocking: 0, runId: 'r1', reportPath: 'openspec/changes/x/.pipeline-agent-reports/r1.md',
      actor: { id: 'a@x.io', name: 'A' }, finishedAt: '2026-09-20T01:00:00Z',
    }
    const good = validSnapshot()
    const runs = [{ stepId: 'open', agents: [view] }]
    Object.assign(good.projects[0]!.changes[0]!, { agentRuns: runs })
    expect(decodeSnapshot(good)?.projects[0]?.changes[0]?.agentRuns).toEqual(runs)
    const bad = validSnapshot()
    Object.assign(bad.projects[0]!.changes[0]!, { agentRuns: [{ stepId: 'open', agents: [{ ...view, state: 'queued' }] }] })
    expect(decodeSnapshot(bad)).toBeNull()
    const legacy = validSnapshot()
    expect(decodeSnapshot(legacy)?.projects[0]?.changes[0]?.agentRuns).toBeUndefined()
  })

  it('keeps tests when well-formed and fails closed on an unknown status or malformed run', () => {
    const runSummary = {
      runId: '20260915T101530Z-ab12cd', user: 'a-at-x.io', actor: { id: 'a@x.io', name: 'A' },
      result: 'pass', exitCode: 0, durationMs: 12, finishedAt: '2026-09-15T10:15:30Z', reasons: [],
    }
    const tests = [{
      stepId: 'open',
      items: [
        { id: 'unit', label: '单测', direction: 'unit', required: true, status: 'passed', run: runSummary },
        { id: 'bad', direction: 'unit', required: false, status: 'missing' },
      ],
    }]
    const good = validSnapshot()
    Object.assign(good.projects[0]!.changes[0]!, { tests, testDiagnostics: ['broken.json'] })
    const decoded = decodeSnapshot(good)?.projects[0]?.changes[0]
    expect(decoded?.tests).toEqual(tests)
    expect(decoded?.testDiagnostics).toEqual(['broken.json'])

    const badStatus = validSnapshot()
    Object.assign(badStatus.projects[0]!.changes[0]!, {
      tests: [{ stepId: 'open', items: [{ id: 'unit', direction: 'unit', required: true, status: 'flaky' }] }],
    })
    expect(decodeSnapshot(badStatus)).toBeNull()

    const badRun = validSnapshot()
    Object.assign(badRun.projects[0]!.changes[0]!, {
      tests: [{
        stepId: 'open',
        items: [{ id: 'unit', direction: 'unit', required: true, status: 'passed', run: { ...runSummary, result: 'maybe' } }],
      }],
    })
    expect(decodeSnapshot(badRun)).toBeNull()

    expect(decodeSnapshot(validSnapshot())?.projects[0]?.changes[0]?.tests).toBeUndefined()
  })

  it('rejects a snapshot with a malformed nested todo item', () => {
    expect(decodeSnapshot({
      version: '1',
      generated_at: 'now',
      capabilities: { snapshot: true },
      project_count: 1,
      change_count: 1,
      projects: [{
        root: '/repo',
        ok: true,
        changes: [{
          name: 'demo',
          path: '/repo/openspec/changes/demo',
          phase: 'build',
          phase_status: 'in_progress',
          track: 'backend',
          preset: 'full',
          archived: 'false',
          updated_at: 'now',
          fields: {},
          todo: {
            hasTaskSource: true,
            stages: [{ id: 'build', label: 'Build', status: 'current', tasks: [{ text: 42, completed: false }] }],
          },
        }],
      }],
    })).toBeNull()
  })

  it('accepts an optional archived list and 未提交删除 count, and rejects malformed ones', () => {
    const withArchived = validSnapshot()
    const project = withArchived.projects[0] as Record<string, unknown>
    const archivedChange = structuredClone(withArchived.projects[0]!.changes[0]!) as Record<string, unknown>
    archivedChange.name = 'hidden'
    archivedChange.archive = {
      archivedAt: '2026-09-15T12:00:00.000Z',
      phase: 'build',
      actor: { id: 'a@x.io', name: 'A', trust: 'declared' },
    }
    project.archived = [archivedChange]
    project.uncommittedDeletions = 2
    const decoded = decodeSnapshot(withArchived)
    expect(decoded?.projects[0]?.archived?.map((row) => row.name)).toEqual(['hidden'])
    expect(decoded?.projects[0]?.archived?.[0]?.archive).toEqual({
      archivedAt: '2026-09-15T12:00:00.000Z',
      phase: 'build',
      actor: { id: 'a@x.io', name: 'A', trust: 'declared' },
    })
    expect(decoded?.projects[0]?.uncommittedDeletions).toBe(2)

    // Absence keeps an older server readable.
    const legacy = validSnapshot()
    expect(decodeSnapshot(legacy)?.projects[0]?.archived).toBeUndefined()
    expect(decodeSnapshot(legacy)?.projects[0]?.uncommittedDeletions).toBeUndefined()

    for (const broken of [
      { archived: {} },
      { archived: [{ name: 'hidden' }] },
      { uncommittedDeletions: -1 },
      { uncommittedDeletions: 1.5 },
      { uncommittedDeletions: '2' },
    ]) {
      const bad = validSnapshot()
      Object.assign(bad.projects[0] as Record<string, unknown>, broken)
      expect(decodeSnapshot(bad)).toBeNull()
    }

    const missingActor = validSnapshot()
    const row = structuredClone(archivedChange) as Record<string, unknown>
    row.archive = { archivedAt: 'now', phase: 'build', actor: { id: 'a@x.io', name: 'A' } }
    Object.assign(missingActor.projects[0] as Record<string, unknown>, { archived: [row] })
    expect(decodeSnapshot(missingActor)).toBeNull()
  })

  it('preserves strict repository identity while accepting a legacy project without it', () => {
    const current = validSnapshot()
    const currentProject = current.projects[0] as typeof current.projects[number] & {
      repository?: { id: string; label: string; workspace_kind: 'primary' | 'worktree' }
    }
    currentProject.repository = {
      id: 'b'.repeat(64),
      label: 'tenon',
      workspace_kind: 'worktree',
    }
    expect(decodeSnapshot(current)?.projects[0]?.repository).toEqual({
      id: 'b'.repeat(64),
      label: 'tenon',
      workspace_kind: 'worktree',
    })

    const legacy = validSnapshot()
    expect(decodeSnapshot(legacy)?.projects[0]?.repository).toBeUndefined()
  })

  it('accepts a POSIX repository label containing a backslash', () => {
    const snapshot = validSnapshot()
    const project = snapshot.projects[0] as typeof snapshot.projects[number] & {
      repository?: { id: string; label: string; workspace_kind: 'primary' | 'worktree' }
    }
    project.repository = {
      id: 'c'.repeat(64),
      label: 'repo\\name',
      workspace_kind: 'primary',
    }

    expect(decodeSnapshot(snapshot)?.projects[0]?.repository?.label).toBe('repo\\name')
  })

  it('preserves governed loop telemetry after validating every rendered field', () => {
    const decoded = decodeLoopsSnapshot({
      generated_at: 'now',
      rows: [{
        root: '/repo',
        id: 'daily',
        name: 'Daily',
        autonomy_level: 'L2',
        status: 'active',
        cadence: 'daily',
        goal: 'ship',
        design_doc: 'docs/design.md',
        change_prefix: null,
        risk: 'medium',
        runner: 'codex',
        human_gates: [],
        kill_criteria: [],
        allowlist: [],
        denylist: [],
        budget_decl: {
          max_runs_per_day: 2,
          max_in_flight: 1,
          on_exceed: 'skip',
          max_tokens_per_day: 1000,
        },
        readiness: { score: 90, band: 'ready' },
        budget: {
          breaker: 'ok',
          runsToday: 1,
          spentToday: 10,
          remaining: 990,
          hasBudget: true,
          maxTokensPerDay: 1000,
        },
        matched_changes: ['daily-1'],
        phases: ['build'],
        draft: false,
        template_id: 'daily',
        template_version: 1,
        workflow_id: 'default',
        skill_bundle_id: 'backend',
        ledger: {
          health: 'ok',
          rejected_records: 0,
          admission_enforced: true,
          inflight_enforced: true,
          runs_today: 1,
          in_flight: 0,
          activated_in_flight: 0,
          settled_tokens_actual: 10,
          settled_tokens_estimated: 0,
          reserved_tokens: 0,
          remaining_tokens: 990,
          last_result: 'merged',
          last_finished_at: 'now',
        },
        graduation: {
          id: 'daily',
          current: 'L2',
          recommended: 'L3',
          enforcement: 'review',
          canGraduate: true,
          blockers: [],
          demotionReason: null,
          demotionSignals: [],
          readinessScore: 90,
          readinessBand: 'ready',
          driftCount: 0,
          breaker: 'ok',
          failStreak: 0,
          runs: 5,
        },
      }],
    })
    expect(decoded?.rows[0]?.ledger?.settled_tokens_actual).toBe(10)
    expect(decoded?.rows[0]?.graduation?.recommended).toBe('L3')
    expect(decoded?.rows[0]?.template_id).toBe('daily')
  })

  it('rejects a router preview whose nested track policy is incomplete', () => {
    expect(decodeRouterPreview({
      ok: true,
      revision: '1',
      source: 'project-file',
      winner: null,
      candidates: [{
        track: { id: 'backend', label: 'Backend', builtin: true, workflow: { default: 'default', allowed: '*' } },
        order: 0,
        priority: 1,
        score: 1,
        routable: true,
        excluded: false,
      }],
      suppressed_reason: null,
    })).toBeNull()
  })

  it('rejects malformed session-link rows instead of partially trusting the envelope', () => {
    expect(decodeSessionLinks({
      links: {
        'demo@/repo': { found: true, resumeCmd: 42 },
      },
    })).toBeNull()
  })

  it('accepts the exact metadata-only trace timeline contract', () => {
    expect(decodeTraceTimeline(validTraceTimeline())).toEqual(validTraceTimeline())
  })

  it('fails closed when trace disclosure literals, enums, or nullable counters drift', () => {
    const disclosureDrift = validTraceTimeline()
    disclosureDrift.content = 'raw'
    expect(decodeTraceTimeline(disclosureDrift)).toBeNull()

    const invalidOutcome = validTraceTimeline()
    invalidOutcome.entries[0]!.outcome = 'model-success'
    expect(decodeTraceTimeline(invalidOutcome)).toBeNull()

    const invalidCounter = validTraceTimeline()
    invalidCounter.entries[0]!.input_tokens = -1
    expect(decodeTraceTimeline(invalidCounter)).toBeNull()

    const queryLeak = validTraceTimeline()
    queryLeak.entries[0]!.path = '/v1/messages?api_key=sentinel'
    expect(decodeTraceTimeline(queryLeak)).toBeNull()
  })

  it('rejects inconsistent trace window counts and unknown warning codes', () => {
    const inconsistent = validTraceTimeline()
    inconsistent.returned_count = 3
    expect(decodeTraceTimeline(inconsistent)).toBeNull()

    const unknownWarning = validTraceTimeline()
    unknownWarning.integrity = 'partial'
    unknownWarning.warnings = ['secret-leak']
    expect(decodeTraceTimeline(unknownWarning)).toBeNull()
  })

  it('rejects trace ordering, outcome, size, and integrity drift', () => {
    const unordered = validTraceTimeline()
    unordered.entries[1]!.sequence = 1
    expect(decodeTraceTimeline(unordered)).toBeNull()

    const mismatchedOutcome = validTraceTimeline()
    mismatchedOutcome.entries[0]!.outcome = 'error'
    expect(decodeTraceTimeline(mismatchedOutcome)).toBeNull()

    const informationalOutcome = validTraceTimeline()
    informationalOutcome.entries[0]!.status_code = 101
    expect(decodeTraceTimeline(informationalOutcome)).toBeNull()

    const oversized = validTraceTimeline()
    oversized.entries = Array.from({ length: 201 }, (_, index) => ({
      ...oversized.entries[0]!,
      sequence: index + 1,
    }))
    oversized.returned_count = 201
    oversized.total_count = 201
    oversized.summary.success_count = 201
    oversized.summary.error_count = 0
    expect(decodeTraceTimeline(oversized)).toBeNull()

    const impossibleIntegrity = validTraceTimeline()
    impossibleIntegrity.warnings = ['malformed-record']
    expect(decodeTraceTimeline(impossibleIntegrity)).toBeNull()
  })

  it('rejects frozen workflow graphs whose edge target is outside the step set', () => {
    const snapshot = validSnapshot()
    snapshot.projects[0].changes[0].workflowRules.transitions.open[0]!.to = 'ghost'
    expect(decodeSnapshot(snapshot)).toBeNull()
  })

  it('rejects workflow label maps missing a frozen step key', () => {
    const snapshot = validSnapshot()
    delete (snapshot.projects[0].changes[0].workflowRules.labelByStep as Record<string, string>).done

    expect(decodeSnapshot(snapshot)).toBeNull()
  })

  it('rejects transition readiness with duplicate blockers', () => {
    const snapshot = validSnapshot()
    const blocker = snapshot.projects[0].changes[0].workflowExecution
      .readinessByTransition.open.finish.blockers[0]!
    snapshot.projects[0].changes[0].workflowExecution
      .readinessByTransition.open.finish.blockers.push(structuredClone(blocker))
    expect(decodeSnapshot(snapshot)).toBeNull()
  })

  it('rejects transition readiness whose event keys drift from the frozen graph', () => {
    const snapshot = validSnapshot()
    const byEvent = snapshot.projects[0].changes[0].workflowExecution
      .readinessByTransition.open as Record<string, { ready: boolean; blockers: unknown[] }>
    delete byEvent.finish
    byEvent.ghost = { ready: true, blockers: [] }
    expect(decodeSnapshot(snapshot)).toBeNull()
  })

  it('rejects readiness that claims ready while retaining a blocker', () => {
    const snapshot = validSnapshot()
    snapshot.projects[0].changes[0].workflowExecution.readinessByTransition.open.finish.ready = true
    expect(decodeSnapshot(snapshot)).toBeNull()
  })

  it('accepts step-exit blockers (tenon status exits) and rejects unknown sources, empty messages or extra keys', () => {
    const valid = validSnapshot()
    const readiness = valid.projects[0].changes[0].workflowExecution.readinessByTransition.open as
      unknown as Record<string, { ready: boolean; blockers: unknown[] }>
    readiness.finish = {
      ready: false,
      blockers: [
        { kind: 'step-exit', source: 'skill', code: 'skill-incomplete', message: '尚未完成声明的 skill：tdd' },
        { kind: 'step-exit', source: 'tasks', code: 'tasks-incomplete', message: 'tasks.md 仍有 1 项未勾', items: ['a'] },
      ],
    }
    const decoded = decodeSnapshot(valid)
    expect(decoded?.projects[0]?.changes[0]?.workflowExecution.readinessByTransition.open?.finish?.blockers).toEqual(readiness.finish.blockers)
    for (const bad of [
      { kind: 'step-exit', source: 'ghost', code: 'x', message: 'm' },
      { kind: 'step-exit', source: 'skill', code: 'x', message: '' },
      { kind: 'step-exit', source: 'skill', code: 'x', message: 'm', leak: '/abs/path' },
      { kind: 'step-exit', source: 'tasks', code: 'x', message: 'm', items: [1] },
    ]) {
      const broken = structuredClone(valid)
      ;(broken.projects[0].changes[0].workflowExecution.readinessByTransition.open as unknown as Record<string, { ready: boolean; blockers: unknown[] }>)
        .finish = { ready: false, blockers: [bad] }
      expect(decodeSnapshot(broken)).toBeNull()
    }
  })

  it('accepts strict revision-untrusted readiness and rejects extra keys, invalid hashes, or reasons', () => {
    const valid = validSnapshot()
    const readiness = valid.projects[0].changes[0].workflowExecution.readinessByTransition.open as
      unknown as Record<string, { ready: boolean; blockers: unknown[] }>
    readiness.finish = {
      ready: false,
      blockers: [{
        kind: 'verify-build-revision-untrusted',
        code: 'verify-build-revision-untrusted',
        reason: 'revision-stale',
        remediation: 'return-to-build-and-capture-current-revision',
        stateHash: `sha256:${'a'.repeat(64)}`,
        revisionHash: `sha256:${'b'.repeat(64)}`,
      }],
    }
    expect(decodeSnapshot(valid)).not.toBeNull()

    const extra = structuredClone(valid)
    ;(extra.projects[0].changes[0].workflowExecution.readinessByTransition.open.finish.blockers[0] as Record<string, unknown>).leak = 'path'
    expect(decodeSnapshot(extra)).toBeNull()

    const malformedHash = structuredClone(valid)
    ;(malformedHash.projects[0].changes[0].workflowExecution.readinessByTransition.open.finish.blockers[0] as Record<string, unknown>).stateHash = 'sha256:' + 'a'.repeat(63)
    expect(decodeSnapshot(malformedHash)).toBeNull()

    const unknownReason = structuredClone(valid)
    ;(unknownReason.projects[0].changes[0].workflowExecution.readinessByTransition.open.finish.blockers[0] as Record<string, unknown>).reason = 'HEAD'
    expect(decodeSnapshot(unknownReason)).toBeNull()
  })

  it('accepts a strict canonical compatibility issue while preserving older omitted responses', () => {
    expect(decodeSnapshot(validSnapshot())?.projects[0]?.compatibilityIssues).toBeUndefined()
    const snapshot = validSnapshot()
    snapshot.projects[0].ok = false
    ;(snapshot.projects[0] as unknown as Record<string, unknown>).compatibilityIssues = [{
      kind: 'unsupported-canonical-version',
      change: 'future-change',
      foundVersion: 3,
      supportedVersion: 1,
      action: 'upgrade-runtime',
    }]

    expect(decodeSnapshot(snapshot)?.projects[0]?.compatibilityIssues).toEqual([{
      severity: 'blocking',
      kind: 'unsupported-canonical-version',
      change: 'future-change',
      foundVersion: 3,
      supportedVersion: 1,
      action: 'upgrade-runtime',
    }])
  })

  it('rejects projects that claim write-safe ok=true while carrying an error or compatibility issue', () => {
    const futureVersion = validSnapshot()
    ;(futureVersion.projects[0] as unknown as Record<string, unknown>).compatibilityIssues = [{
      kind: 'unsupported-canonical-version',
      change: 'future-change',
      foundVersion: 3,
      supportedVersion: 1,
      action: 'upgrade-runtime',
    }]
    expect(decodeSnapshot(futureVersion)).toBeNull()

    const corrupt = validSnapshot()
    ;(corrupt.projects[0] as unknown as Record<string, unknown>).error = 'state is unreadable'
    expect(decodeSnapshot(corrupt)).toBeNull()
  })

  it('keeps warning-only projects valid and treats missing or unknown severity as blocking', () => {
    const warning = validSnapshot()
    ;(warning.projects[0] as unknown as Record<string, unknown>).compatibilityIssues = [{ severity: 'warning', kind: 'legacy-scope-unmerged', change: 'legacy', legacyScopePath: '.pipeline-artifacts/runtime-artifacts', action: 'merge-or-remove-legacy-scope' }]
    expect(decodeSnapshot(warning)?.projects[0]?.ok).toBe(true)

    const missing = validSnapshot()
    ;(missing.projects[0] as unknown as Record<string, unknown>).compatibilityIssues = [{ kind: 'unsupported-canonical-version', change: 'future', foundVersion: 3, supportedVersion: 1, action: 'upgrade-runtime' }]
    expect(decodeSnapshot(missing)).toBeNull()

    const unknown = validSnapshot()
    ;(unknown.projects[0] as unknown as Record<string, unknown>).compatibilityIssues = [{ severity: 'future', kind: 'unsupported-canonical-version', change: 'future', foundVersion: 3, supportedVersion: 1, action: 'upgrade-runtime' }]
    expect(decodeSnapshot(unknown)).toBeNull()
  })

  it('rejects malformed, over-broad, or duplicate canonical compatibility issues', () => {
    for (const compatibilityIssues of [
      [{ kind: 'unknown', change: 'future', foundVersion: 2, supportedVersion: 1, action: 'upgrade-runtime' }],
      [{ kind: 'unsupported-canonical-version', change: '', foundVersion: 2, supportedVersion: 1, action: 'upgrade-runtime' }],
      [{ kind: 'unsupported-canonical-version', change: 'future', foundVersion: 1, supportedVersion: 1, action: 'upgrade-runtime' }],
      [{ kind: 'unsupported-canonical-version', change: 'future', foundVersion: 2.5, supportedVersion: 1, action: 'upgrade-runtime' }],
      [{ kind: 'unsupported-canonical-version', change: 'future', foundVersion: 2, supportedVersion: 1, action: 'repair-state' }],
      [{ kind: 'unsupported-canonical-version', change: 'future', foundVersion: 2, supportedVersion: 1, action: 'upgrade-runtime', path: '/private/current.json' }],
      [
        { kind: 'unsupported-canonical-version', change: 'future', foundVersion: 2, supportedVersion: 1, action: 'upgrade-runtime' },
        { kind: 'unsupported-canonical-version', change: 'future', foundVersion: 3, supportedVersion: 1, action: 'upgrade-runtime' },
      ],
    ]) {
      const snapshot = validSnapshot()
      ;(snapshot.projects[0] as unknown as Record<string, unknown>).compatibilityIssues = compatibilityIssues
      expect(decodeSnapshot(snapshot)).toBeNull()
    }
  })

  it('rejects compatibility issue arrays above the 100-item server contract', () => {
    const snapshot = validSnapshot()
    ;(snapshot.projects[0] as unknown as Record<string, unknown>).compatibilityIssues = Array.from(
      { length: 101 },
      (_, index) => ({
        kind: 'unsupported-canonical-version',
        change: `future-${index}`,
        foundVersion: 2,
        supportedVersion: 1,
        action: 'upgrade-runtime',
      }),
    )

    expect(decodeSnapshot(snapshot)).toBeNull()
  })

  it('accepts only a literal typed truncation signal paired with exactly 100 compatibility issues', () => {
    const issues = Array.from({ length: 100 }, (_, index) => ({
      kind: 'unsupported-canonical-version',
      change: `future-${String(index).padStart(3, '0')}`,
      foundVersion: 2,
      supportedVersion: 1,
      action: 'upgrade-runtime',
    }))
    const valid = validSnapshot()
    valid.projects[0].ok = false
    Object.assign(valid.projects[0], {
      compatibilityIssues: issues,
      compatibilityIssuesTruncated: true,
    })
    expect(decodeSnapshot(valid)?.projects[0]).toMatchObject({
      compatibilityIssuesTruncated: true,
    })

    for (const compatibilityIssuesTruncated of [false, 'true', 1]) {
      const malformed = structuredClone(valid)
      ;(malformed.projects[0] as unknown as Record<string, unknown>).compatibilityIssuesTruncated
        = compatibilityIssuesTruncated
      expect(decodeSnapshot(malformed)).toBeNull()
    }

    const tooShort = structuredClone(valid)
    ;((tooShort.projects[0] as unknown as Record<string, unknown>)
      .compatibilityIssues as unknown[]).pop()
    expect(decodeSnapshot(tooShort)).toBeNull()
  })

  it('decodes a strict exact-event Review Handshake while accepting an older missing field', () => {
    const legacy = decodeSnapshot(validSnapshot())
    expect(legacy).not.toBeNull()
    expect((legacy?.projects[0]?.changes[0] as unknown as {
      reviewHandshake?: unknown
    }).reviewHandshake).toBeUndefined()

    const snapshot = validSnapshot()
    ;(snapshot.projects[0].changes[0].workflowRules.gateByStep as Record<
      string,
      'review' | 'auto' | null
    >).open = 'review'
    const change = snapshot.projects[0].changes[0] as unknown as Record<string, unknown>
    change.reviewHandshake = {
      status: 'pending',
      event: 'finish',
      requestedAt: '2026-07-30T02:00:00Z',
    }
    const decoded = decodeSnapshot(snapshot)
    expect((decoded?.projects[0]?.changes[0] as unknown as {
      reviewHandshake?: unknown
    }).reviewHandshake).toEqual({
      status: 'pending',
      event: 'finish',
      requestedAt: '2026-07-30T02:00:00Z',
    })
  })

  it('accepts an explicit not-requested handshake on a non-review step', () => {
    const snapshot = validSnapshot()
    const change = snapshot.projects[0].changes[0] as unknown as Record<string, unknown>
    change.reviewHandshake = { status: 'not-requested' }

    expect(decodeSnapshot(snapshot)?.projects[0]?.changes[0]?.reviewHandshake).toEqual({
      status: 'not-requested',
    })
  })

  it('rejects malformed, unreachable, or over-broad Review Handshake objects', () => {
    for (const reviewHandshake of [
      { status: 'pending', event: 'ghost', requestedAt: '2026-07-30T02:00:00Z' },
      { status: 'pending', event: 'finish' },
      {
        status: 'approved',
        event: 'finish',
        requestedAt: '2026-07-30T02:00:00Z',
      },
      { status: 'not-requested', event: 'finish' },
      { status: 'delegated', event: 'finish', hostSession: 'secret' },
    ]) {
      const snapshot = validSnapshot()
      ;(snapshot.projects[0].changes[0].workflowRules.gateByStep as Record<
        string,
        'review' | 'auto' | null
      >).open = 'review'
      const change = snapshot.projects[0].changes[0] as unknown as Record<string, unknown>
      change.reviewHandshake = reviewHandshake
      expect(decodeSnapshot(snapshot)).toBeNull()
    }
  })

  it('rejects a Change whose phase is outside its frozen workflow steps', () => {
    const snapshot = validSnapshot()
    snapshot.projects[0].changes[0].phase = 'ghost'

    expect(decodeSnapshot(snapshot)).toBeNull()
  })

  it('rejects structurally different workflow rules sharing one fingerprint in the same project', () => {
    const snapshot = validSnapshot()
    const collision = structuredClone(snapshot.projects[0].changes[0])
    collision.name = 'collision'
    collision.workflowRules.transitions.open[0]!.event = 'complete'
    snapshot.projects[0].changes.push(collision)
    snapshot.change_count = 2

    expect(decodeSnapshot(snapshot)).toBeNull()
  })

  it('accepts track-effective required outputs that differ under one immutable plan fingerprint', () => {
    const snapshot = validSnapshot()
    const gates = snapshot.projects[0].changes[0].workflowRules.gateByStep as Record<
      string,
      'review' | 'auto' | null
    >
    gates.open = 'review'
    const pm = structuredClone(snapshot.projects[0].changes[0])
    pm.name = 'pm'
    pm.track = 'pm'
    pm.workflowExecution.readinessByTransition.open.finish = { ready: true, blockers: [] }
    snapshot.projects[0].changes.push(pm)
    snapshot.change_count = 2

    const decoded = decodeSnapshot(snapshot)
    expect(decoded).not.toBeNull()
    expect(decoded?.projects[0]?.changes.map((change) => [
      change.track,
      change.workflowExecution.readinessByTransition.open.finish,
    ])).toEqual([
      ['backend', {
        ready: false,
        blockers: [{
          kind: 'guard-failed',
          guardType: 'field-nonempty',
          field: 'result',
          actual: '',
        }],
      }],
      ['pm', { ready: true, blockers: [] }],
    ])
    const selection = selectProgress(decoded, '/repo', workflowRulesFromSnapshot(decoded))
    expect(new Map(selection.groups[0]?.rows.map((row) => [row.change.track, row.state]))).toEqual(
      new Map([['backend', 'agent'], ['pm', 'gate']]),
    )
  })
})
