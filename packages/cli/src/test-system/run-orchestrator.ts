/**
 * 一次批量运行的编排（应用层）：占用套件的运行中标记 → 启动依赖服务并等就绪 → 并发跑 parallel 套件、再依次跑其余套件 →
 * 回收服务（无论成败）→ 补上整次运行才知道的原因 → 追加记录 v2（哈希链）→ 清理旧产物。
 * 命令层只负责参数、打印与退出码；这里不打印（除了启动前的 announce 回调）。
 */
import {
  appendTestRunRecordV2, baselineV2Path, claimRunningMarker, ensureTestEvidenceDirs, listRecordDirectory, pruneTestArtifacts,
  readTestBaselineV2, releaseRunningMarker, testRunArtifactsDir, testRunRecordsDir, testRunningMarkerPath,
  changedLinesSinceChangeStart, changeStartOfFields, testPlanApprovalFreeDigest,
  type AppendResult, type KnownFailure, type MachineProfile, type ServiceRunV2, type StepIR, type SuiteReason, type SuiteRunV2,
  type TestBaselineV2, type TestCatalog, type TestPlanState,
} from '@tenon/kernel'
import type { CliDeps } from '../deps.js'
import { detectHostEnvironment } from '../hostKind.js'
import { str } from '../render.js'
import type { TestCommandContext } from '../commands/test-context.js'
import { candidateOf, newRunId } from '../commands/test-run.js'
import { changedFilesFor } from '../testEvidenceContext.js'
import type { ExecContext, RunItem, SuiteOutcome } from './exec-types.js'
import { applyRunLevelReasons, draftOf, evaluationShell, machineOf } from './run-record.js'
import { serviceRecord, startService, stopService, type RunningService } from './services.js'
import { executeSuite } from './suite-exec.js'

export const KEEP_RUNS = 10

export class RunBusyError extends Error {}

export interface RunInput {
  readonly deps: CliDeps
  readonly context: TestCommandContext
  readonly change: string
  readonly step: StepIR
  readonly catalog: TestCatalog
  readonly planState: TestPlanState
  readonly knownFailures: readonly KnownFailure[]
  readonly items: readonly RunItem[]
  /** 运行前（服务启动之前）回调，命令层在此打印将要执行的命令。 */
  readonly announce: (runId: string) => void
}

export interface RunResult {
  readonly runId: string
  readonly runDir: string
  readonly appended: AppendResult
  readonly outcomes: readonly SuiteOutcome[]
  readonly services: readonly ServiceRunV2[]
  readonly profile: MachineProfile
}

function defaultPolicy(): NonNullable<StepIR['test_policy']> {
  return {
    plan: 'optional', kinds: [], run: [], run_if_registered: [], scope: 'changed', files: 'any',
    scenarios: 'off', benchmark: { require_baseline: false }, browsers: [],
  }
}

async function claimMarkers(input: RunInput, runId: string, runningDir: string, startedAt: string, startedMs: number): Promise<string[]> {
  const claimed: string[] = []
  for (const item of input.items) {
    const marker = testRunningMarkerPath(input.deps.cwd, input.context.slug, input.change, `suite-${item.suite.id}`)
    const benchmark = item.suite.benchmark
    const attempts = item.suite.retries + (benchmark === undefined ? 1 : 2 * (benchmark.runs + benchmark.warmup) + 1)
    const claim = await claimRunningMarker(marker, runningDir, {
      run_id: runId, pid: process.pid, started_at: startedAt,
      deadline_at: new Date(startedMs + item.suite.timeout_s * 1000 * attempts).toISOString(),
    }, Date.now())
    if (!claim.claimed) {
      for (const held of claimed) await releaseRunningMarker(held)
      throw new RunBusyError(`套件 '${item.suite.id}' 正在运行（run ${claim.held.run_id}，开始于 ${claim.held.started_at}）`)
    }
    claimed.push(marker)
  }
  return claimed
}

async function startServices(
  input: RunInput, runDir: string, env: NodeJS.ProcessEnv, running: RunningService[],
): Promise<ReadonlyMap<string, SuiteReason>> {
  const failures = new Map<string, SuiteReason>()
  const needed = [...new Set(input.items.flatMap((item) => item.suite.services))]
  for (const id of needed) {
    const service = input.catalog.services.find((entry) => entry.id === id)
    if (service === undefined) continue
    const started = await startService(service, { repoRoot: input.deps.cwd, logPath: `${runDir}/services/${id}.log`, env })
    running.push(started.running)
    if (!started.start.ok) failures.set(id, { code: 'service-not-ready', detail: `服务 ${id}：${started.start.failure ?? '未就绪'}`.slice(0, 1900) })
  }
  return failures
}

export async function executeRun(input: RunInput): Promise<RunResult> {
  const { deps, context, change, step, catalog } = input
  const startedAt = deps.clock()
  const startedMs = Date.now()
  const runId = newRunId(startedAt)
  const paths = await ensureTestEvidenceDirs(deps.cwd, context.slug, change, runId)
  const runDir = testRunArtifactsDir(deps.cwd, context.slug, change, runId)
  const workflowRunId = context.state.runMetadata?.runId ?? ''
  const claimed = await claimMarkers(input, runId, paths.runningDir, startedAt, startedMs)
  const controller = new AbortController()
  const onSignal = (): void => controller.abort()
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  const running: RunningService[] = []
  try {
    input.announce(runId)
    const profile = machineOf(catalog, process.env)
    const host = detectHostEnvironment(process.env)
    const head = deps.gitHeadSha === undefined ? null : await deps.gitHeadSha().catch(() => null)
    const gitHead = head === null || head === '' ? null : head
    const candidateBefore = await candidateOf(deps, change)
    // 记录绑定的计划摘要：豁免的批准位一律当作未批准来算（评审确认只写批准位，不该让批准之前的运行过期）。
    const planDigest = input.planState.state === 'ok' ? testPlanApprovalFreeDigest(input.planState.plan) : null
    const base = {
      runId, change, workflowRunId, workflow: context.plan.id, track: str(context.state.fields.track), step: step.id,
      workflowFingerprint: context.plan.workflowFingerprint, catalog, planDigest, policy: step.test_policy, profile,
      actor: context.actor, host, gitHead, startedAt,
    }
    const policy = step.test_policy ?? defaultPolicy()
    const plan = input.planState.state === 'ok' ? input.planState.plan : undefined
    const changedFiles = await changedFilesFor(deps, change)().catch(() => undefined)
    const baselines = new Map<string, TestBaselineV2 | undefined>()
    let lines: ReadonlyMap<string, ReadonlySet<number>> | undefined
    let linesRead = false
    const exec: ExecContext = {
      repoRoot: deps.cwd, runId, runDir, change,
      env: { ...process.env, TENON_CHANGE_NAME: change, TENON_TEST_RUN_ID: runId, TENON_TEST_ARTIFACTS: runDir, TENON_BASE_BRANCH: str(context.state.fields.base_branch) },
      plan, policy, knownFailures: input.knownFailures, today: startedAt.slice(0, 10), changedFiles,
      changedLines: async () => {
        if (!linesRead) {
          linesRead = true
          lines = await changedLinesSinceChangeStart(deps.cwd, changeStartOfFields(context.state.fields)).catch(() => undefined)
        }
        return lines
      },
      baseline: async (suiteId) => {
        if (!baselines.has(suiteId)) {
          const read = await readTestBaselineV2(baselineV2Path(deps.cwd, suiteId, profile.id))
          baselines.set(suiteId, read.state === 'ok' ? read.baseline : undefined)
        }
        return baselines.get(suiteId)
      },
      evalRecord: evaluationShell(draftOf({ ...base, candidate: candidateBefore, services: [], suites: [], finishedAt: startedAt, durationMs: 0 })),
      budget: { used: 0 }, signal: controller.signal, sandbox: host.sandbox,
    }
    const failures = await startServices(input, runDir, exec.env, running)
    const outcomes = new Map<string, SuiteOutcome>()
    const one = async (item: RunItem): Promise<void> => {
      const blocked: SuiteReason | undefined = controller.signal.aborted
        ? { code: 'interrupted', detail: '未开始：运行被中断' }
        : item.suite.services.map((id) => failures.get(id)).find((reason) => reason !== undefined)
      outcomes.set(item.suite.id, await executeSuite(exec, item, blocked))
    }
    await Promise.all(input.items.filter((item) => item.suite.parallel).map(one))
    for (const item of input.items.filter((entry) => !entry.suite.parallel)) await one(item)
    await Promise.all(running.map((service) => stopService(service)))

    const ordered = input.items.flatMap((item) => outcomes.get(item.suite.id) ?? [])
    const candidateAfter = await candidateOf(deps, change)
    const runs: SuiteRunV2[] = applyRunLevelReasons(ordered.map((outcome) => outcome.run), { candidateBefore, candidateAfter, policy, plan })
    const services = running.map((service) => serviceRecord(service, `services/${service.service.id}.log`))
    const draft = draftOf({ ...base, candidate: candidateAfter, services, suites: runs, finishedAt: deps.clock(), durationMs: Date.now() - startedMs })
    const appended = await appendTestRunRecordV2(deps.cwd, context.slug, draft)
    const listing = await listRecordDirectory(testRunRecordsDir(deps.cwd, context.slug, change))
    await pruneTestArtifacts(paths.artifactsDir, listing.records.map((entry) => entry.record.run_id).sort(), KEEP_RUNS)
    return { runId, runDir, appended, outcomes: ordered, services, profile }
  } finally {
    await Promise.all(running.map((service) => stopService(service).catch(() => undefined)))
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
    for (const marker of claimed) await releaseRunningMarker(marker)
  }
}
