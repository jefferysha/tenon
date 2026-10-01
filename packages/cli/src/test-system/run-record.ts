/**
 * 一次 `tenon test run` 的记录装配：机器画像、只有整次运行才知道的原因（候选代码指纹取不到 / 运行期间代码变了 /
 * flaky 总数超限）、以及最终的记录草稿（链字段与摘要由 appendTestRunRecordV2 在锁内补齐）。
 */
import {
  TEST_RUN_V2_SCHEMA, catalogSuitesDigest, fileRefMatches, machineProfile, readMachineProfileInput, testPolicyDigest,
  type MachineProfile, type RecordActor, type ServiceRunV2, type StepTestPolicyIR, type SuiteReason, type SuiteRunV2, type TestCatalog,
  type TestHostKind, type TestPlan, type TestRunRecordV2, type TestRunRecordV2Draft,
} from '@tenon/kernel'

/** 画像口径取自目录的 `profile:`（缺省细口径）；同一份目录在每台机器上用同一口径，基线才可比。 */
export function machineOf(catalog: TestCatalog, env: NodeJS.ProcessEnv): MachineProfile {
  const values = Object.fromEntries(catalog.profiles_env.map((name) => [name, env[name]]))
  return machineProfile(readMachineProfileInput(process.version, values), catalog.profile ?? 'fine')
}

function withReason(run: SuiteRunV2, reason: SuiteReason, fails: boolean): SuiteRunV2 {
  if (run.reasons.some((existing) => existing.code === reason.code)) return run
  return { ...run, reasons: [...run.reasons, reason], result: fails ? 'fail' : run.result }
}

/** 候选取不到 → 记录无法绑定代码，整次判失败；运行前后指纹不同 → 只记提示；flaky 超限 → 有 flaky 的套件判失败。 */
export function applyRunLevelReasons(
  runs: readonly SuiteRunV2[],
  input: {
    readonly candidateBefore: string | null
    readonly candidateAfter: string | null
    readonly policy: StepTestPolicyIR
    readonly plan: TestPlan | undefined
  },
): SuiteRunV2[] {
  const limit = input.policy.flaky
  const flakyTotal = runs.reduce((sum, run) => sum + run.totals.flaky, 0)
  const registered = (input.plan?.files ?? []).map((file) => file.path)
  return runs.map((run) => {
    let next = run
    if (input.candidateAfter === null) next = withReason(next, { code: 'candidate-unavailable' }, true)
    else if (input.candidateBefore !== null && input.candidateBefore !== input.candidateAfter) next = withReason(next, { code: 'workspace-changed' }, false)
    if (limit !== undefined && next.totals.flaky > 0) {
      const newFlaky = limit.fail_on_new && next.cases.some((item) => item.status === 'flaky'
        && registered.some((path) => fileRefMatches(path, item.file) || fileRefMatches(item.file, path)))
      if (flakyTotal > limit.max || newFlaky) {
        next = withReason(next, { code: 'flaky-over-limit', detail: newFlaky ? '本任务新增的用例不稳定（重试后才通过）' : `flaky 用例共 ${flakyTotal} 个，超过上限 ${limit.max}` }, true)
      }
    }
    return next
  })
}

export function draftOf(input: {
  readonly runId: string
  readonly change: string
  readonly workflowRunId: string
  readonly workflow: string
  readonly track: string
  readonly step: string
  readonly workflowFingerprint: string
  readonly candidate: string | null
  readonly catalog: TestCatalog
  readonly planDigest: string | null
  readonly policy: StepTestPolicyIR | undefined
  readonly profile: MachineProfile
  readonly services: readonly ServiceRunV2[]
  readonly suites: readonly SuiteRunV2[]
  readonly actor: RecordActor
  readonly host: { readonly kind: TestHostKind; readonly sandbox: string | null }
  readonly gitHead: string | null
  readonly startedAt: string
  readonly finishedAt: string
  /** 实测耗时（时钟可被注入，时间戳相减不可靠）。 */
  readonly durationMs: number
}): TestRunRecordV2Draft {
  return {
    schema: TEST_RUN_V2_SCHEMA,
    run_id: input.runId,
    change: input.change,
    workflow_run_id: input.workflowRunId,
    workflow: input.workflow,
    track: input.track,
    step: input.step,
    bindings: {
      candidate: input.candidate,
      workflow_fingerprint: input.workflowFingerprint,
      catalog_digest: input.suites.length === 0 ? null : catalogSuitesDigest(input.catalog, input.suites.map((run) => run.suite)),
      plan_digest: input.planDigest,
      policy_digest: input.policy === undefined ? null : testPolicyDigest(input.policy),
    },
    machine_profile: input.profile.id,
    machine_label: input.profile.label,
    services: input.services,
    suites: input.suites,
    result: input.suites.every((run) => run.result === 'pass') ? 'pass' : 'fail',
    actor: input.actor,
    host: input.host,
    git_head: input.gitHead,
    started_at: input.startedAt,
    finished_at: input.finishedAt,
    duration_ms: Math.max(0, Math.round(input.durationMs)),
  }
}

/** 判定套件时用的记录外壳（画像与 run-id 供基准比较用），不落盘。 */
export function evaluationShell(draft: TestRunRecordV2Draft): TestRunRecordV2 {
  return { ...draft, prev_digest: null, digest: `sha256:${'0'.repeat(64)}` }
}
