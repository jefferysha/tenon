/**
 * 基准基线 v2：按目录套件 × 机器画像存放（进 git，团队共享），不同画像互不比较。
 * 每个指标记中位数、p95、样本数与离散度（MAD）；历史新的在前、≤20 条，与文件的 git 历史一起构成留痕。
 * 只经 `tenon test baseline` 更新，且需要一次通过的运行。解码闭集：多键、缺键、类型不符一律视为损坏。
 */
import { mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { atomicReplaceFile } from '../state/atomic-publish.js'
import { TENON_PROJECT_DIR } from '../users/user-paths.js'
import { decodeRecordActor, type RecordActor } from '../users/user.js'
import { appendTestAudit, testAuditEntry, type TestAuditOutcome } from './audit.js'
import { BASELINES_DIR, MACHINE_PROFILE_ID_RE, TEST_SYSTEM_DIR } from './paths.js'
import { METRIC_NAME_RE, SUITE_ID_RE } from './vocabulary.js'

export const TEST_BASELINE_V2_SCHEMA = 'tenon-test-baseline-v2'
export const BASELINE_V2_HISTORY_LIMIT = 20

export interface BaselineMetricV2 {
  readonly median: number
  readonly p95: number
  readonly mad: number
  readonly samples: number
  readonly better: 'lower' | 'higher'
  readonly unit?: string
}

export interface BaselineEntryV2 {
  readonly metrics: Readonly<Record<string, BaselineMetricV2>>
  readonly source: { readonly change: string; readonly run_id: string; readonly commit: string | null }
  readonly actor: RecordActor
  readonly updated_at: string
}

export interface TestBaselineV2 extends BaselineEntryV2 {
  readonly schema: typeof TEST_BASELINE_V2_SCHEMA
  readonly suite: string
  readonly profile: string
  readonly profile_label: string
  readonly history: readonly BaselineEntryV2[]
}

class Corrupt extends Error {}

function bad(): never {
  throw new Corrupt('corrupt')
}

function object(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) bad()
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) if (!keys.includes(key) && !optional.includes(key)) bad()
  for (const key of keys) if (!Object.hasOwn(record, key)) bad()
  return record
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value === '') bad()
  return value
}

function finite(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) bad()
  return value
}

function metric(value: unknown): BaselineMetricV2 {
  const item = object(value, ['median', 'p95', 'mad', 'samples', 'better'], ['unit'])
  if (item.better !== 'lower' && item.better !== 'higher') bad()
  const samples = finite(item.samples)
  if (!Number.isInteger(samples) || samples < 1) bad()
  return {
    median: finite(item.median),
    p95: finite(item.p95),
    mad: finite(item.mad),
    samples,
    better: item.better,
    ...(item.unit === undefined ? {} : { unit: text(item.unit) }),
  }
}

function entry(value: unknown, extra: readonly string[] = []): BaselineEntryV2 {
  const item = object(value, ['metrics', 'source', 'actor', 'updated_at', ...extra])
  if (typeof item.metrics !== 'object' || item.metrics === null || Array.isArray(item.metrics)) bad()
  const metrics: Record<string, BaselineMetricV2> = {}
  for (const [name, raw] of Object.entries(item.metrics)) {
    if (!METRIC_NAME_RE.test(name)) bad()
    metrics[name] = metric(raw)
  }
  const source = object(item.source, ['change', 'run_id', 'commit'])
  const actor = decodeRecordActor(item.actor)
  if (actor === undefined || actor === null) bad()
  return {
    metrics,
    source: { change: text(source.change), run_id: text(source.run_id), commit: source.commit === null ? null : text(source.commit) },
    actor,
    updated_at: text(item.updated_at),
  }
}

export function decodeTestBaselineV2(value: unknown): TestBaselineV2 | undefined {
  try {
    const keys = ['schema', 'suite', 'profile', 'profile_label', 'history']
    const item = object(value, ['metrics', 'source', 'actor', 'updated_at', ...keys])
    if (item.schema !== TEST_BASELINE_V2_SCHEMA) bad()
    const suite = text(item.suite)
    const profile = text(item.profile)
    if (!SUITE_ID_RE.test(suite) || !MACHINE_PROFILE_ID_RE.test(profile)) bad()
    if (!Array.isArray(item.history) || item.history.length > BASELINE_V2_HISTORY_LIMIT) bad()
    return {
      schema: TEST_BASELINE_V2_SCHEMA,
      suite,
      profile,
      profile_label: text(item.profile_label),
      ...entry(item, keys),
      history: item.history.map((raw: unknown) => entry(raw)),
    }
  } catch (error) {
    if (error instanceof Corrupt) return undefined
    throw error
  }
}

export type BaselineReadResult =
  | { readonly state: 'missing' }
  | { readonly state: 'corrupt' }
  | { readonly state: 'ok'; readonly baseline: TestBaselineV2 }

export async function readTestBaselineV2(path: string): Promise<BaselineReadResult> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing' }
    return { state: 'corrupt' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { state: 'corrupt' }
  }
  const baseline = decodeTestBaselineV2(parsed)
  return baseline === undefined ? { state: 'corrupt' } : { state: 'ok', baseline }
}

const CHANGE_NAME_RE = /^[A-Za-z0-9_-]{1,128}$/

/**
 * 只供 `tenon test baseline` 调用：整份原子替换。落盘之后在来源 change 的历史里留一行
 * `test:baseline-update`（基线本身进 git、自带来源与历史；这一行让 change 的时间线也看得到）。
 * 路径不在 `<repo>/.tenon/tests/baselines/` 下、或来源 change 已不在 `openspec/changes/` 下时返回 `skipped`。
 */
export async function writeTestBaselineV2(
  path: string,
  baseline: TestBaselineV2,
): Promise<TestAuditOutcome | 'skipped'> {
  if (decodeTestBaselineV2(JSON.parse(JSON.stringify(baseline))) === undefined) {
    throw new Error('writeTestBaselineV2: 基线形状非法，拒绝写入')
  }
  await mkdir(dirname(path), { recursive: true })
  await atomicReplaceFile(path, `${JSON.stringify(baseline, null, 2)}\n`)
  const marker = `/${TENON_PROJECT_DIR}/${TEST_SYSTEM_DIR}/${BASELINES_DIR}/`
  const at = path.lastIndexOf(marker)
  if (at < 0 || !CHANGE_NAME_RE.test(baseline.source.change)) return 'skipped'
  const changeDir = join(path.slice(0, at), 'openspec', 'changes', baseline.source.change)
  if (!(await stat(changeDir).then((entry) => entry.isDirectory(), () => false))) return 'skipped'
  return appendTestAudit(changeDir, testAuditEntry('baseline-update', {
    suite: baseline.suite, profile: baseline.profile, run: baseline.source.run_id, commit: baseline.source.commit ?? undefined,
  }, { ts: baseline.updated_at, actor: baseline.actor }))
}

/** 新基线：上一份的当前值压进历史（新的在前，截断到上限）。 */
export function nextBaselineV2(
  previous: TestBaselineV2 | undefined,
  next: Omit<TestBaselineV2, 'schema' | 'history'>,
): TestBaselineV2 {
  const history = previous === undefined
    ? []
    : [
        { metrics: previous.metrics, source: previous.source, actor: previous.actor, updated_at: previous.updated_at },
        ...previous.history,
      ].slice(0, BASELINE_V2_HISTORY_LIMIT)
  return { schema: TEST_BASELINE_V2_SCHEMA, ...next, history }
}
