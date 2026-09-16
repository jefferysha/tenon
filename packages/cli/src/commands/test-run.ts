/**
 * `tenon test run <change> <test-id>` —— Tenon 真实执行声明的测试并登记结果。
 * agent 自报「通过」不产生记录，因此永远满足不了必需测试。
 *
 * exit 0 = 通过，2 = 失败（已落记录），1 = 用法或环境错误（未落记录）。
 */
import { randomBytes } from 'node:crypto'
import { lstat, mkdir, realpath } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import {
  claimRunningMarker, ensureTestEvidenceDirs, evaluateMetricCriteria, listTestRuns, publishTestRunRecord,
  pruneTestArtifacts, readMetrics, readTestBaseline, releaseRunningMarker,
  testBaselinePath, testDigest, testRunArtifactsDir, testRunRecordPath, testRunningMarkerPath,
  TEST_LOG_ARTIFACT, TEST_RUN_SCHEMA,
} from '@tenon/kernel'
import type {
  StepIR, StepTestIR, TestEvidencePaths, TestHostKind, TestRunRecordV1, TestRunReason,
} from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'
import { str } from '../render.js'
import { collectTestInputs, collectTestOutputs } from '../test-runner/collect.js'
import { classifyTestRun, SANDBOX_ESCALATION_HINT } from '../test-runner/classify.js'
import { GRACE_MS, LOG_TAIL_BYTES, MAX_LOG_BYTES, runTestProcess } from '../test-runner/process.js'
import { declaredTestIds, locateTest, resolveTestCommand, type TestCommandContext } from './test-context.js'

const FAILURE_TAIL_CHARS = 4096

/** run-id 按时间排序，且不同用户各自目录，所以只需要 6 位随机后缀防同秒碰撞。 */
function newRunId(iso: string): string {
  const stamp = new Date(iso).toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z')
  return `${stamp}-${randomBytes(3).toString('hex')}`
}

function hostOf(env: NodeJS.ProcessEnv): { readonly kind: TestHostKind; readonly sandbox: string | null } {
  const sandbox = env.CODEX_SANDBOX ?? null
  if (sandbox !== null || env.CODEX_THREAD_ID !== undefined) return { kind: 'codex', sandbox }
  if (env.CLAUDECODE === '1') return { kind: 'claude-code', sandbox }
  return { kind: 'terminal', sandbox }
}

async function candidateOf(deps: CliDeps, name: string): Promise<string | null> {
  const fingerprint = deps.workspaceFingerprint
  if (fingerprint === undefined) return null
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await fingerprint(name)
    } catch {
      // 指纹捕获与文件改动撞车可以重试一次；两次都失败记 candidate-unavailable。
    }
  }
  return null
}

async function resolvedCwd(repoRoot: string, cwd: string): Promise<string | undefined> {
  try {
    const target = await realpath(resolve(repoRoot, cwd))
    const rel = relative(await realpath(repoRoot), target)
    if (rel !== '' && (rel.startsWith('..') || rel.startsWith(sep))) return undefined
    return (await lstat(target)).isDirectory() ? target : undefined
  } catch {
    return undefined
  }
}

interface RunInput {
  readonly step: StepIR
  readonly test: StepTestIR
  readonly runId: string
  readonly paths: TestEvidencePaths
  readonly json: boolean
}

export async function cmdTestRun(
  deps: CliDeps,
  change: string,
  testId: string,
  opts: { readonly json?: boolean } = {},
): Promise<number> {
  const context = await resolveTestCommand(deps, change, { requireOwner: true })
  if (typeof context === 'number') return context
  const located = locateTest(context.plan, testId)
  if (located === undefined) {
    const ids = declaredTestIds(context.plan)
    deps.io.err(`ERROR: 未声明的测试 '${testId}'；可选：${ids.length === 0 ? '(无)' : ids.join(', ')}`)
    return 1
  }
  const { step, test } = located
  const runId = newRunId(deps.clock())
  const paths = await ensureTestEvidenceDirs(deps.cwd, context.slug, change, runId)
  const markerPath = testRunningMarkerPath(deps.cwd, context.slug, change, test.id)
  const startedAt = deps.clock()
  const claim = await claimRunningMarker(markerPath, paths.runningDir, {
    run_id: runId,
    pid: process.pid,
    started_at: startedAt,
    deadline_at: new Date(Date.parse(startedAt) + test.timeout_s * 1000).toISOString(),
  }, Date.now())
  if (!claim.claimed) {
    deps.io.err(`ERROR: 测试 '${test.id}' 正在运行（run ${claim.held.run_id}，开始于 ${claim.held.started_at}）`)
    return 1
  }
  try {
    return await execute(deps, context, { step, test, runId, paths, json: opts.json === true })
  } catch (e) {
    deps.io.err(`ERROR: 测试记录写入失败: ${errMsg(e)}`)
    return 1
  } finally {
    await releaseRunningMarker(markerPath)
  }
}

async function execute(deps: CliDeps, context: TestCommandContext, input: RunInput): Promise<number> {
  const { test, step, runId } = input
  const change = context.name
  const runDir = testRunArtifactsDir(deps.cwd, context.slug, change, runId)
  const logPath = join(runDir, TEST_LOG_ARTIFACT)
  await mkdir(runDir, { recursive: true })
  const candidateBefore = await candidateOf(deps, change)
  const gitHead = deps.gitHeadSha === undefined ? null : await deps.gitHeadSha().catch(() => null)
  const inputs = await collectTestInputs(deps.cwd, context.dir, test, input.paths.envKey)
  const workDir = await resolvedCwd(deps.cwd, test.cwd)
  const host = hostOf(process.env)
  const metadata = context.state.runMetadata

  const now = deps.clock()
  const outcome = workDir === undefined
    ? {
        exitCode: null, signal: null, timedOut: false, interrupted: false, startedAt: now, finishedAt: now,
        durationMs: 0, tail: '',
        log: { bytesTotal: 0, bytesKept: 0, truncated: false, sha256: `sha256:${'0'.repeat(64)}` },
      }
    : await runTestProcess({
        command: test.command,
        cwd: workDir,
        env: {
          ...process.env,
          TENON_CHANGE_NAME: change,
          TENON_TEST_ID: test.id,
          TENON_TEST_RUN_ID: runId,
          TENON_TEST_ARTIFACTS: runDir,
          TENON_BASE_BRANCH: str(context.state.fields.base_branch),
        },
        timeoutMs: test.timeout_s * 1000,
        graceMs: GRACE_MS,
        logPath,
        maxLogBytes: MAX_LOG_BYTES,
        tailBytes: LOG_TAIL_BYTES,
      })

  const outputs = workDir === undefined ? [] : await collectTestOutputs(deps.cwd, test, runDir)
  const values = test.pass.metrics.length === 0 && test.metrics_path === undefined
    ? undefined
    : await readMetrics({
        ...(test.metrics_path === undefined ? {} : { metricsPath: resolve(deps.cwd, test.metrics_path) }),
        logText: outcome.tail,
      })
  const baseline = await readTestBaseline(testBaselinePath(deps.cwd, context.slug, test.id))
  const evaluation = evaluateMetricCriteria({
    criteria: test.pass.metrics, metrics: values, baseline, command: test.command, cwd: test.cwd,
  })
  const candidate = await candidateOf(deps, change)
  const classification = classifyTestRun({
    test, outcome, outputs, metricReasons: evaluation.reasons, candidateBefore, candidate, sandbox: host.sandbox,
  })
  const reasons: readonly TestRunReason[] = workDir === undefined
    ? [
        { code: 'cwd-invalid', detail: test.cwd.slice(0, 200) },
        ...classification.reasons.filter((reason) => reason.code !== 'exit-code'),
      ]
    : classification.reasons
  const result = workDir === undefined ? 'fail' as const : classification.result

  const record: TestRunRecordV1 = {
    schema: TEST_RUN_SCHEMA,
    run_id: runId,
    change,
    workflow_run_id: metadata?.runId ?? '',
    workflow: context.plan.id,
    workflow_fingerprint: context.plan.workflowFingerprint,
    track: str(context.state.fields.track),
    step: step.id,
    step_visit: { run_id: metadata?.runId ?? '', transition_sequence: metadata?.transitionSequence ?? 0 },
    test_id: test.id,
    test_digest: testDigest(test),
    direction: test.direction,
    ...(test.label === undefined ? {} : { label: test.label }),
    command: test.command,
    cwd: test.cwd,
    timeout_s: test.timeout_s,
    required: test.required,
    actor: context.actor,
    host,
    candidate_before: candidateBefore,
    candidate,
    git_head: gitHead === null || gitHead === '' ? null : gitHead,
    build_sha: str(context.state.fields.build_sha) === '' ? null : str(context.state.fields.build_sha),
    started_at: outcome.startedAt,
    finished_at: outcome.finishedAt,
    duration_ms: outcome.durationMs,
    exit_code: outcome.exitCode,
    signal: outcome.signal,
    result,
    reasons,
    inputs,
    outputs,
    metrics: evaluation.metrics,
    log: {
      artifact: TEST_LOG_ARTIFACT,
      bytes_total: outcome.log.bytesTotal,
      bytes_kept: outcome.log.bytesKept,
      truncated: outcome.log.truncated,
      digest: outcome.log.sha256,
    },
  }
  const recordPath = testRunRecordPath(deps.cwd, context.slug, change, runId)
  await publishTestRunRecord(recordPath, input.paths.runsDir, record)
  const runsOfTest = (await listTestRuns(deps.cwd, change, { slug: context.slug, testId: test.id }))
    .map((entry) => entry.record.run_id)
  await pruneTestArtifacts(input.paths.artifactsDir, runsOfTest, test.keep_runs)

  const relativeRecord = relative(deps.cwd, recordPath)
  const relativeLog = relative(deps.cwd, logPath)
  if (input.json) {
    deps.io.out(JSON.stringify({ ...record, record_path: relativeRecord, log_path: relativeLog }, null, 2))
  } else {
    const exit = outcome.exitCode === null ? `signal ${outcome.signal ?? '?'}` : String(outcome.exitCode)
    deps.io.out(`[TEST] ${change} ${test.id} run=${runId}`)
    deps.io.out(`  command: ${test.command} (cwd=${test.cwd}, timeout=${test.timeout_s}s)`)
    deps.io.out(`  result: ${result} exit=${exit} duration=${(outcome.durationMs / 1000).toFixed(1)}s`)
    deps.io.out(`  reasons: ${reasons.map((reason) => reason.code).join(', ') || '(无)'}`)
    deps.io.out(`  record: ${relativeRecord}`)
    deps.io.out(`  log: ${relativeLog}`)
  }
  if (result === 'fail') {
    if (!input.json && outcome.tail !== '') deps.io.err(outcome.tail.slice(-FAILURE_TAIL_CHARS))
    if (classification.sandboxDenied) deps.io.err(`${SANDBOX_ESCALATION_HINT} tenon test run ${change} ${test.id}`)
    return 2
  }
  return 0
}
