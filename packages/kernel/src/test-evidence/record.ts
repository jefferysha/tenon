/**
 * 测试记录 / 基准 / 运行中标记的读写。记录不可变：独占 link 发布，同一 run-id 绝不覆盖。
 * 解码是闭集的，任何附加键或类型不符都判为损坏（返回 undefined），门禁据此把该测试视为未运行。
 */
import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicLinkPublish, atomicReplaceFile } from '../state/atomic-publish.js'
import { decodeRecordActor } from '../users/user.js'
import { isWorkspaceBaseline } from '../workspace/fingerprint.js'
import type { TestOutputKind } from '../workflow/types.js'
import {
  BASELINE_HISTORY_LIMIT, RUNNING_MARKER_GRACE_MS, TEST_BASELINE_SCHEMA, TEST_RUN_ID_RE, TEST_RUN_SCHEMA,
  TEST_RUN_REASON_CODES, type TestBaselineEntry, type TestBaselineV1, type TestHostKind,
  type TestInputRecord, type TestMetricRecord, type TestOutputRecord, type TestRunLog, type TestRunReason,
  type TestRunReasonCode, type TestRunRecordV1, type TestRunningMarker,
} from './types.js'

const OUTPUT_KINDS: ReadonlySet<string> = new Set<TestOutputKind>([
  'report', 'coverage', 'metrics', 'trace', 'screenshot', 'log', 'other',
])
const HOST_KINDS: ReadonlySet<string> = new Set<TestHostKind>(['claude-code', 'codex', 'terminal'])
const REASONS: ReadonlySet<string> = new Set<string>(TEST_RUN_REASON_CODES)
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/
const RECORD_KEYS = [
  'schema', 'run_id', 'change', 'workflow_run_id', 'workflow', 'workflow_fingerprint', 'track', 'step',
  'step_visit', 'test_id', 'test_digest', 'direction', 'label', 'command', 'cwd', 'timeout_s', 'required',
  'actor', 'host', 'candidate_before', 'candidate', 'git_head', 'build_sha', 'started_at', 'finished_at',
  'duration_ms', 'exit_code', 'signal', 'result', 'reasons', 'inputs', 'outputs', 'metrics', 'log',
] as const
const BASELINE_ENTRY_KEYS = ['command', 'cwd', 'metrics', 'source', 'actor', 'updated_at'] as const

class Corrupt extends Error {}

function bad(): never {
  throw new Corrupt('corrupt')
}

function record(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) bad()
  const entries = value as Record<string, unknown>
  for (const key of Object.keys(entries)) if (!allowed.includes(key)) bad()
  return entries
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value === '') bad()
  return value
}

function optionalText(value: unknown): string | null {
  if (value === null) return null
  return text(value)
}

function flag(value: unknown): boolean {
  if (typeof value !== 'boolean') bad()
  return value
}

function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) bad()
  return value
}

function finite(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) bad()
  return value
}

function list(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) bad()
  return value
}

function candidate(value: unknown): string | null {
  if (value === null) return null
  const raw = text(value)
  if (!isWorkspaceBaseline(raw)) bad()
  return raw
}

function digest(value: unknown): string {
  const raw = text(value)
  if (!DIGEST_RE.test(raw)) bad()
  return raw
}

function actor(value: unknown): TestRunRecordV1['actor'] {
  const decoded = decodeRecordActor(value)
  if (decoded === undefined || decoded === null) bad()
  return decoded
}

/** 指标是开放映射（名字由被测命令决定），只校验值是有限数字。 */
function numberMap(value: unknown): Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) bad()
  const out: Record<string, number> = {}
  for (const [name, item] of Object.entries(value)) out[name] = finite(item)
  return out
}

function reason(value: unknown): TestRunReason {
  const item = record(value, ['code', 'detail'])
  if (!REASONS.has(text(item.code))) bad()
  const code = item.code as TestRunReasonCode
  if (item.detail === undefined) return { code }
  const detail = text(item.detail)
  if (detail.length > 200) bad()
  return { code, detail }
}

function input(value: unknown): TestInputRecord {
  const kind = (value as Record<string, unknown> | null)?.kind
  if (kind === 'document') {
    const item = record(value, ['kind', 'ref', 'present', 'entries'])
    return {
      kind: 'document',
      ref: text(item.ref),
      present: flag(item.present),
      entries: list(item.entries).map((entry) => {
        const nested = record(entry, ['path', 'digest'])
        return { path: text(nested.path), digest: digest(nested.digest) }
      }),
    }
  }
  if (kind === 'file') {
    const item = record(value, ['kind', 'path', 'present', 'digest', 'files'])
    return {
      kind: 'file',
      path: text(item.path),
      present: flag(item.present),
      digest: item.digest === null ? null : digest(item.digest),
      files: count(item.files),
    }
  }
  if (kind === 'env') {
    const item = record(value, ['kind', 'name', 'present', 'digest'])
    return {
      kind: 'env',
      name: text(item.name),
      present: flag(item.present),
      digest: item.digest === null ? null : digest(item.digest),
    }
  }
  if (kind === 'service') {
    const item = record(value, ['kind', 'name', 'url'])
    const name = text(item.name)
    return item.url === undefined ? { kind: 'service', name } : { kind: 'service', name, url: text(item.url) }
  }
  return bad()
}

function output(value: unknown): TestOutputRecord {
  const item = record(value, ['path', 'kind', 'required', 'present', 'digest', 'bytes', 'files', 'artifact'])
  if (!OUTPUT_KINDS.has(text(item.kind))) bad()
  return {
    path: text(item.path),
    kind: item.kind as TestOutputKind,
    required: flag(item.required),
    present: flag(item.present),
    digest: item.digest === null ? null : digest(item.digest),
    bytes: count(item.bytes),
    files: count(item.files),
    artifact: item.artifact === null ? null : text(item.artifact),
  }
}

function metric(value: unknown): TestMetricRecord {
  const item = record(value, ['name', 'value', 'baseline', 'delta_pct', 'max', 'min', 'max_regression_pct', 'better', 'ok'])
  if (item.better !== 'lower' && item.better !== 'higher') bad()
  return {
    name: text(item.name),
    value: item.value === null ? null : finite(item.value),
    baseline: item.baseline === null ? null : finite(item.baseline),
    delta_pct: item.delta_pct === null ? null : finite(item.delta_pct),
    ...(item.max === undefined ? {} : { max: finite(item.max) }),
    ...(item.min === undefined ? {} : { min: finite(item.min) }),
    ...(item.max_regression_pct === undefined ? {} : { max_regression_pct: finite(item.max_regression_pct) }),
    better: item.better,
    ok: flag(item.ok),
  }
}

function log(value: unknown): TestRunLog {
  const item = record(value, ['artifact', 'bytes_total', 'bytes_kept', 'truncated', 'digest'])
  return {
    artifact: text(item.artifact),
    bytes_total: count(item.bytes_total),
    bytes_kept: count(item.bytes_kept),
    truncated: flag(item.truncated),
    digest: digest(item.digest),
  }
}

function decodeRun(value: unknown): TestRunRecordV1 {
  const item = record(value, RECORD_KEYS)
  if (item.schema !== TEST_RUN_SCHEMA) bad()
  if (!TEST_RUN_ID_RE.test(text(item.run_id))) bad()
  if (!/^[a-f0-9]{64}$/.test(text(item.workflow_fingerprint))) bad()
  if (item.result !== 'pass' && item.result !== 'fail') bad()
  const visit = record(item.step_visit, ['run_id', 'transition_sequence'])
  const host = record(item.host, ['kind', 'sandbox'])
  if (!HOST_KINDS.has(text(host.kind))) bad()
  return {
    schema: TEST_RUN_SCHEMA,
    run_id: item.run_id as string,
    change: text(item.change),
    workflow_run_id: text(item.workflow_run_id),
    workflow: text(item.workflow),
    workflow_fingerprint: item.workflow_fingerprint as string,
    track: typeof item.track === 'string' ? item.track : bad(),
    step: text(item.step),
    step_visit: { run_id: text(visit.run_id), transition_sequence: count(visit.transition_sequence) },
    test_id: text(item.test_id),
    test_digest: digest(item.test_digest),
    direction: text(item.direction),
    ...(item.label === undefined ? {} : { label: text(item.label) }),
    command: text(item.command),
    cwd: text(item.cwd),
    timeout_s: count(item.timeout_s),
    required: flag(item.required),
    actor: actor(item.actor),
    host: { kind: host.kind as TestHostKind, sandbox: optionalText(host.sandbox) },
    candidate_before: candidate(item.candidate_before),
    candidate: candidate(item.candidate),
    git_head: optionalText(item.git_head),
    build_sha: optionalText(item.build_sha),
    started_at: text(item.started_at),
    finished_at: text(item.finished_at),
    duration_ms: count(item.duration_ms),
    exit_code: item.exit_code === null ? null : count(item.exit_code),
    signal: optionalText(item.signal),
    result: item.result,
    reasons: list(item.reasons).map(reason),
    inputs: list(item.inputs).map(input),
    outputs: list(item.outputs).map(output),
    metrics: list(item.metrics).map(metric),
    log: log(item.log),
  }
}

export function decodeTestRunRecord(value: unknown): TestRunRecordV1 | undefined {
  try {
    return decodeRun(value)
  } catch (error) {
    if (error instanceof Corrupt) return undefined
    throw error
  }
}

function baselineEntry(value: unknown, allowed: readonly string[]): TestBaselineEntry {
  const item = record(value, allowed)
  const source = record(item.source, ['change', 'run_id'])
  return {
    command: text(item.command),
    cwd: text(item.cwd),
    metrics: numberMap(item.metrics),
    source: { change: text(source.change), run_id: text(source.run_id) },
    actor: actor(item.actor),
    updated_at: text(item.updated_at),
  }
}

export function decodeTestBaseline(value: unknown): TestBaselineV1 | undefined {
  try {
    const item = record(value, [...BASELINE_ENTRY_KEYS, 'schema', 'test_id', 'history'])
    if (item.schema !== TEST_BASELINE_SCHEMA) bad()
    const history = list(item.history).map((entry) => baselineEntry(entry, BASELINE_ENTRY_KEYS))
    if (history.length > BASELINE_HISTORY_LIMIT) bad()
    return {
      schema: TEST_BASELINE_SCHEMA,
      test_id: text(item.test_id),
      ...baselineEntry(item, [...BASELINE_ENTRY_KEYS, 'schema', 'test_id', 'history']),
      history,
    }
  } catch (error) {
    if (error instanceof Corrupt) return undefined
    throw error
  }
}

export function decodeRunningMarker(value: unknown): TestRunningMarker | undefined {
  try {
    const item = record(value, ['run_id', 'pid', 'started_at', 'deadline_at'])
    if (!TEST_RUN_ID_RE.test(text(item.run_id))) bad()
    return {
      run_id: item.run_id as string,
      pid: count(item.pid),
      started_at: text(item.started_at),
      deadline_at: text(item.deadline_at),
    }
  } catch (error) {
    if (error instanceof Corrupt) return undefined
    throw error
  }
}

async function readJson(path: string): Promise<unknown> {
  const raw = await readFile(path, 'utf8')
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

export async function readTestRunRecord(path: string): Promise<TestRunRecordV1 | undefined> {
  try {
    return decodeTestRunRecord(await readJson(path))
  } catch {
    return undefined
  }
}

/** 不可变发布：同一 run-id 已存在即失败（原生 EEXIST），绝不覆盖。 */
export async function publishTestRunRecord(path: string, dir: string, runRecord: TestRunRecordV1): Promise<void> {
  await mkdir(dir, { recursive: true })
  await atomicLinkPublish(dir, '.test-run', path, `${JSON.stringify(runRecord, null, 2)}\n`)
}

export async function readTestBaseline(path: string): Promise<TestBaselineV1 | undefined> {
  try {
    return decodeTestBaseline(await readJson(path))
  } catch {
    return undefined
  }
}

export async function writeTestBaseline(path: string, dir: string, baseline: TestBaselineV1): Promise<void> {
  await mkdir(dir, { recursive: true })
  await atomicReplaceFile(path, `${JSON.stringify(baseline, null, 2)}\n`)
}

export function nextBaseline(
  previous: TestBaselineV1 | undefined,
  next: Omit<TestBaselineV1, 'schema' | 'history'>,
): TestBaselineV1 {
  const history = previous === undefined
    ? []
    : [
        {
          command: previous.command, cwd: previous.cwd, metrics: previous.metrics,
          source: previous.source, actor: previous.actor, updated_at: previous.updated_at,
        },
        ...previous.history,
      ].slice(0, BASELINE_HISTORY_LIMIT)
  return { schema: TEST_BASELINE_SCHEMA, ...next, history }
}

/** 独占创建运行中标记；已存在且未过期时返回既有标记，过期则回收。 */
export async function claimRunningMarker(
  path: string,
  dir: string,
  marker: TestRunningMarker,
  now: number,
): Promise<{ readonly claimed: true } | { readonly claimed: false; readonly held: TestRunningMarker }> {
  await mkdir(dir, { recursive: true })
  const content = `${JSON.stringify(marker)}\n`
  try {
    await writeFile(path, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    return { claimed: true }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const held = decodeRunningMarker(await readJson(path).catch(() => undefined))
  if (held !== undefined) {
    const deadline = Date.parse(held.deadline_at)
    if (Number.isFinite(deadline) && deadline + RUNNING_MARKER_GRACE_MS > now) return { claimed: false, held }
  }
  await rm(path, { force: true })
  await writeFile(path, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  return { claimed: true }
}

export async function readRunningMarker(path: string): Promise<TestRunningMarker | undefined> {
  try {
    return decodeRunningMarker(await readJson(path))
  } catch {
    return undefined
  }
}

export async function releaseRunningMarker(path: string): Promise<void> {
  await rm(path, { force: true })
}

/**
 * 保留最后 keepRuns 个 run 目录，更早的删除；摘要永不删除（R13、D18）。
 * 调用方按时间升序给出 run id（listTestRuns 的顺序），本函数不自己猜时间序。
 */
export function selectArtifactDirsToPrune(runIdsOldestFirst: readonly string[], keepRuns: number): readonly string[] {
  const extra = runIdsOldestFirst.length - keepRuns
  return extra <= 0 ? [] : runIdsOldestFirst.slice(0, extra)
}

export async function pruneTestArtifacts(
  artifactsDir: string,
  runIdsOfTest: readonly string[],
  keepRuns: number,
): Promise<readonly string[]> {
  const present = new Set<string>()
  try {
    for (const entry of await readdir(artifactsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) present.add(entry.name)
    }
  } catch {
    return []
  }
  const removed: string[] = []
  for (const runId of selectArtifactDirsToPrune(runIdsOfTest.filter((id) => present.has(id)), keepRuns)) {
    const dir = join(artifactsDir, runId)
    if (!(await lstat(dir).then((entry) => entry.isDirectory(), () => false))) continue
    await rm(dir, { recursive: true, force: true })
    removed.push(runId)
  }
  return removed
}
