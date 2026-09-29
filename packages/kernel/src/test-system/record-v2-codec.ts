/**
 * 运行记录 v2 的闭集解码：附加键、缺键、类型不符、超长文本一律判损坏（返回 undefined），
 * 门禁据此把整条链视为被改动。解码不校验摘要与链——那是 record-chain.ts 的职责。
 */
import { isWorkspaceBaseline } from '../workspace/fingerprint.js'
import { decodeRecordActor } from '../users/user.js'
import { TEST_RUN_ID_RE, type TestHostKind, type TestRunLog } from '../test-evidence/types.js'
import { MACHINE_PROFILE_ID_RE } from './paths.js'
import {
  ARTIFACT_MEDIA, CASE_STATUSES, SERVICE_EXITS, SUITE_REASON_CODES, TEST_RUN_V2_SCHEMA,
  type ArtifactIndexEntry, type BenchmarkMetricResult, type CaseResultV2, type CaseTotals, type CoverageResult,
  type RecordBindings, type ServiceRunV2, type SuiteReason, type SuiteRunV2, type TestRunRecordV2,
} from './record-v2-types.js'
import { COVERAGE_METRICS, isReportFormat, isRunScope, isTestKind, isTestRunner } from './vocabulary.js'

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/
const FINGERPRINT_RE = /^[a-f0-9]{64}$/
const HOST_KINDS: ReadonlySet<string> = new Set<TestHostKind>(['claude-code', 'codex', 'terminal'])
const REASONS: ReadonlySet<string> = new Set<string>(SUITE_REASON_CODES)
const STATUSES: ReadonlySet<string> = new Set<string>(CASE_STATUSES)
const MEDIA: ReadonlySet<string> = new Set<string>(ARTIFACT_MEDIA)
const EXITS: ReadonlySet<string> = new Set<string>(SERVICE_EXITS)
const MAX_TEXT = 4096
const MAX_LONG_TEXT = 65536

class Corrupt extends Error {}

function bad(): never {
  throw new Corrupt('corrupt')
}

function object(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) bad()
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) if (!required.includes(key) && !optional.includes(key)) bad()
  for (const key of required) if (!Object.hasOwn(record, key)) bad()
  return record
}

function text(value: unknown, max = MAX_TEXT): string {
  if (typeof value !== 'string' || value === '' || value.length > max) bad()
  return value
}

function nullableText(value: unknown, max = MAX_TEXT): string | null {
  return value === null ? null : text(value, max)
}

function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) bad()
  return value
}

function finite(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) bad()
  return value
}

function list<T>(value: unknown, each: (item: unknown) => T): T[] {
  if (!Array.isArray(value)) bad()
  return value.map(each)
}

function digest(value: unknown): string {
  const raw = text(value)
  if (!DIGEST_RE.test(raw)) bad()
  return raw
}

function nullableDigest(value: unknown): string | null {
  return value === null ? null : digest(value)
}

function reason(value: unknown): SuiteReason {
  const item = object(value, ['code'], ['detail'])
  const code = text(item.code)
  if (!REASONS.has(code)) bad()
  return {
    code: code as SuiteReason['code'],
    ...(item.detail === undefined ? {} : { detail: text(item.detail, 2000) }),
  }
}

function caseResult(value: unknown): CaseResultV2 {
  const item = object(
    value,
    ['id', 'file', 'name', 'suite_path', 'project', 'status', 'duration_ms', 'attempts', 'artifacts'],
    ['line', 'failure'],
  )
  const status = text(item.status)
  if (!STATUSES.has(status)) bad()
  let failure: CaseResultV2['failure']
  if (item.failure !== undefined) {
    const raw = object(item.failure, ['message'], ['stack', 'expected', 'actual'])
    failure = {
      message: text(raw.message, MAX_LONG_TEXT),
      ...(raw.stack === undefined ? {} : { stack: text(raw.stack, MAX_LONG_TEXT) }),
      ...(raw.expected === undefined ? {} : { expected: text(raw.expected, MAX_LONG_TEXT) }),
      ...(raw.actual === undefined ? {} : { actual: text(raw.actual, MAX_LONG_TEXT) }),
    }
  }
  const attempts = count(item.attempts)
  if (attempts < 1) bad()
  return {
    id: text(item.id),
    file: text(item.file),
    ...(item.line === undefined ? {} : { line: count(item.line) }),
    name: text(item.name),
    suite_path: list(item.suite_path, (segment) => text(segment)),
    project: nullableText(item.project, 128),
    status: status as CaseResultV2['status'],
    duration_ms: count(item.duration_ms),
    attempts,
    ...(failure === undefined ? {} : { failure }),
    artifacts: list(item.artifacts, (path) => text(path)),
  }
}

function totals(value: unknown): CaseTotals {
  const item = object(value, ['cases', 'pass', 'fail', 'skip', 'flaky', 'known_fail'])
  const result = {
    cases: count(item.cases), pass: count(item.pass), fail: count(item.fail),
    skip: count(item.skip), flaky: count(item.flaky), known_fail: count(item.known_fail),
  }
  if (result.pass + result.fail + result.skip + result.flaky + result.known_fail !== result.cases) bad()
  return result
}

function artifact(value: unknown): ArtifactIndexEntry {
  const item = object(value, ['path', 'bytes', 'digest', 'media'], ['entry'])
  const media = text(item.media)
  if (!MEDIA.has(media)) bad()
  const path = text(item.path)
  if (path.startsWith('/') || path.split('/').includes('..')) bad()
  if (item.entry !== undefined && item.entry !== true) bad()
  return {
    path, bytes: count(item.bytes), digest: digest(item.digest), media: media as ArtifactIndexEntry['media'],
    ...(item.entry === true ? { entry: true as const } : {}),
  }
}

function coverage(value: unknown): CoverageResult | null {
  if (value === null) return null
  const item = object(value, [], COVERAGE_METRICS)
  const out: Record<string, number> = {}
  for (const key of COVERAGE_METRICS) {
    if (item[key] === undefined) continue
    const pct = finite(item[key])
    if (pct < 0 || pct > 100) bad()
    out[key] = pct
  }
  return out
}

function metric(value: unknown): BenchmarkMetricResult {
  const item = object(value, ['name', 'better', 'samples', 'median', 'p95', 'mad'], ['unit'])
  if (item.better !== 'lower' && item.better !== 'higher') bad()
  return {
    name: text(item.name, 128),
    ...(item.unit === undefined ? {} : { unit: text(item.unit, 32) }),
    better: item.better,
    samples: list(item.samples, finite),
    median: finite(item.median),
    p95: finite(item.p95),
    mad: finite(item.mad),
  }
}

function log(value: unknown): TestRunLog {
  const item = object(value, ['artifact', 'bytes_total', 'bytes_kept', 'truncated', 'digest'])
  if (typeof item.truncated !== 'boolean') bad()
  return {
    artifact: text(item.artifact),
    bytes_total: count(item.bytes_total),
    bytes_kept: count(item.bytes_kept),
    truncated: item.truncated,
    digest: digest(item.digest),
  }
}

function suite(value: unknown): SuiteRunV2 {
  const item = object(value, [
    'suite', 'origin', 'kind', 'runner', 'scope', 'selection', 'command', 'cwd', 'exit_code', 'signal', 'duration_ms',
    'result', 'reasons', 'totals', 'cases', 'projects', 'coverage', 'metrics', 'artifacts', 'report', 'log',
  ])
  if (item.origin !== 'catalog' && item.origin !== 'step') bad()
  if (!isTestKind(item.kind) || !isTestRunner(item.runner) || !isRunScope(item.scope)) bad()
  if (item.result !== 'pass' && item.result !== 'fail') bad()
  const report = object(item.report, ['format', 'path', 'digest'])
  if (!isReportFormat(report.format)) bad()
  const suiteId = text(item.suite, 128)
  if ((item.origin === 'step') !== suiteId.startsWith('step:')) bad()
  return {
    suite: suiteId,
    origin: item.origin,
    kind: item.kind,
    runner: item.runner,
    scope: item.scope,
    selection: list(item.selection, (entry) => text(entry, 2000)),
    command: text(item.command, 2000),
    cwd: text(item.cwd),
    exit_code: item.exit_code === null ? null : count(item.exit_code),
    signal: nullableText(item.signal, 32),
    duration_ms: count(item.duration_ms),
    result: item.result,
    reasons: list(item.reasons, reason),
    totals: totals(item.totals),
    cases: list(item.cases, caseResult),
    projects: list(item.projects, (project) => text(project, 128)),
    coverage: coverage(item.coverage),
    metrics: list(item.metrics, metric),
    artifacts: list(item.artifacts, artifact),
    report: { format: report.format, path: nullableText(report.path), digest: nullableDigest(report.digest) },
    log: log(item.log),
  }
}

function service(value: unknown): ServiceRunV2 {
  const item = object(value, ['id', 'ready_ms', 'exit', 'log', 'leaked_pids'])
  const exit = text(item.exit)
  if (!EXITS.has(exit)) bad()
  return {
    id: text(item.id, 48),
    ready_ms: item.ready_ms === null ? null : count(item.ready_ms),
    exit: exit as ServiceRunV2['exit'],
    log: nullableText(item.log),
    leaked_pids: list(item.leaked_pids, count),
  }
}

function bindings(value: unknown): RecordBindings {
  const item = object(value, ['candidate', 'workflow_fingerprint', 'catalog_digest', 'plan_digest', 'policy_digest'])
  const candidate = nullableText(item.candidate)
  if (candidate !== null && !isWorkspaceBaseline(candidate)) bad()
  const fingerprint = text(item.workflow_fingerprint)
  if (!FINGERPRINT_RE.test(fingerprint)) bad()
  return {
    candidate,
    workflow_fingerprint: fingerprint,
    catalog_digest: nullableDigest(item.catalog_digest),
    plan_digest: nullableDigest(item.plan_digest),
    policy_digest: nullableDigest(item.policy_digest),
  }
}

const RECORD_KEYS = [
  'schema', 'run_id', 'change', 'workflow_run_id', 'workflow', 'track', 'step', 'bindings', 'machine_profile',
  'machine_label', 'services', 'suites', 'result', 'actor', 'host', 'git_head', 'started_at', 'finished_at',
  'duration_ms', 'prev_digest', 'digest',
] as const

function decode(value: unknown): TestRunRecordV2 {
  const item = object(value, RECORD_KEYS, ['chain_reset'])
  if (item.schema !== TEST_RUN_V2_SCHEMA) bad()
  const runId = text(item.run_id)
  if (!TEST_RUN_ID_RE.test(runId)) bad()
  const profile = text(item.machine_profile)
  if (!MACHINE_PROFILE_ID_RE.test(profile)) bad()
  if (item.result !== 'pass' && item.result !== 'fail') bad()
  const reset = item.chain_reset === undefined ? undefined : object(item.chain_reset, ['superseded'])
  const host = object(item.host, ['kind', 'sandbox'])
  if (!HOST_KINDS.has(text(host.kind))) bad()
  const actor = decodeRecordActor(item.actor)
  if (actor === undefined || actor === null) bad()
  if (typeof item.track !== 'string') bad()
  const suites = list(item.suites, suite)
  if (suites.length === 0) bad()
  return {
    schema: TEST_RUN_V2_SCHEMA,
    run_id: runId,
    change: text(item.change),
    workflow_run_id: text(item.workflow_run_id),
    workflow: text(item.workflow),
    track: item.track,
    step: text(item.step),
    bindings: bindings(item.bindings),
    machine_profile: profile,
    machine_label: text(item.machine_label),
    services: list(item.services, service),
    suites,
    result: item.result,
    actor,
    host: { kind: host.kind as TestHostKind, sandbox: nullableText(host.sandbox) },
    git_head: nullableText(item.git_head),
    started_at: text(item.started_at),
    finished_at: text(item.finished_at),
    duration_ms: count(item.duration_ms),
    prev_digest: nullableDigest(item.prev_digest),
    ...(reset === undefined ? {} : { chain_reset: { superseded: list(reset.superseded, (name) => text(name, 255)) } }),
    digest: digest(item.digest),
  }
}

export function decodeTestRunRecordV2(value: unknown): TestRunRecordV2 | undefined {
  try {
    return decode(value)
  } catch (error) {
    if (error instanceof Corrupt) return undefined
    throw error
  }
}

/** 记录文件是否声明为 v2（不论内容是否合法）；用来把 v2 文件与 v1 损坏文件区分开。 */
export function declaresRecordV2(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (value as Record<string, unknown>).schema === TEST_RUN_V2_SCHEMA
}
