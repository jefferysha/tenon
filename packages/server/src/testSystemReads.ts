/**
 * 测试体系的只读装配：项目目录 / 已知失败 / 基线 / 任务计划 / v2 运行记录。全部只读，读的是项目测试目录、
 * 任务的测试计划文件与各用户按任务存放的运行记录，不写任何文件。损坏或不认识的文件降级成显式状态
 * （invalid / corrupt / trusted:false），不冒充「没有」。
 *
 * 目录扫描一律用 Dirent 判类型（符号链接不跟随）、按数量封顶；记录文件 ≤16 MiB，与哈希链读取口径一致。
 */
import { lstat, readFile, readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import {
  MACHINE_PROFILE_ID_RE, SUITE_ID_RE, TENON_PROJECT_DIR, baselineV2Path, catalogSuite, declaresRecordV2,
  decodeTestRunRecordV2, formatCatalogIssues, knownFailureExpired, listRecordDirectory, loadCatalogInput,
  parseKnownFailures, readTestBaselineV2, readTestPlanState, testRunArtifactsDir, testRunRecordsDir,
  testSystemPaths, verifyRecordChain, type CatalogInput, type TestCatalog, type TestRunRecordV2,
} from '@tenon/kernel'
import {
  artifactDto, baselineDto, caseDto, catalogServiceDto, catalogSuiteDto, coverageDto, knownFailureDto, planBriefDto, planDto,
  recordSummaryDto, totalsDto,
} from './testSystemDto.js'
import {
  MAX_DTO_CASES, type BaselineDto, type CatalogDto, type KnownFailuresDto, type PlanBriefDto, type PlanDto, type RecordDetailDto,
  type RecordSummaryDto, type ServiceRunDto, type SuiteLatestDto, type SuiteRunDto,
} from './testSystemDtoTypes.js'

const MAX_TEXT_BYTES = 1024 * 1024
const MAX_RECORD_BYTES = 16 * 1024 * 1024
const MAX_USERS = 50
const MAX_CHANGES_PER_USER = 200
const MAX_RECENT_RECORDS = 40
const MAX_BASELINE_PROFILES = 50
const MAX_ARTIFACT_ENTRIES = 1000
const PRESENCE_BATCH = 64
export const MAX_RECORD_RUNS = 50

async function readBoundedText(path: string): Promise<{ state: 'missing' } | { state: 'invalid'; reason: string } | { state: 'ok'; text: string }> {
  try {
    const entry = await lstat(path)
    if (!entry.isFile()) return { state: 'invalid', reason: '不是普通文件' }
    if (entry.size > MAX_TEXT_BYTES) return { state: 'invalid', reason: '超过 1 MiB' }
    return { state: 'ok', text: await readFile(path, 'utf8') }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing' }
    return { state: 'invalid', reason: '无法读取' }
  }
}

export function catalogView(input: CatalogInput): CatalogDto {
  if (input.state === 'missing') return { state: 'missing' }
  if (input.state === 'invalid') return { state: 'invalid', issues: input.issues }
  return {
    state: 'ok',
    suites: input.catalog.suites.map(catalogSuiteDto),
    services: input.catalog.services.map(catalogServiceDto),
  }
}

export async function readKnownFailuresView(readRoot: string, today: string): Promise<KnownFailuresDto> {
  const file = await readBoundedText(testSystemPaths(readRoot).knownFailures)
  if (file.state === 'missing') return { state: 'missing' }
  if (file.state === 'invalid') return { state: 'invalid', issues: [`known-failures.yaml：${file.reason}`] }
  const parsed = parseKnownFailures(file.text)
  if (!parsed.ok) return { state: 'invalid', issues: formatCatalogIssues(parsed.issues, 'known-failures.yaml') }
  return { state: 'ok', entries: parsed.entries.map((entry) => knownFailureDto(entry, knownFailureExpired(entry, today))) }
}

async function directoryNames(dir: string, limit: number): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .slice(0, limit)
  } catch {
    return []
  }
}

async function userSlugsOf(readRoot: string): Promise<string[]> {
  return directoryNames(join(readRoot, TENON_PROJECT_DIR, 'users'), MAX_USERS)
}

async function readRecordFile(path: string): Promise<TestRunRecordV2 | undefined> {
  try {
    const entry = await lstat(path)
    if (!entry.isFile() || entry.size > MAX_RECORD_BYTES) return undefined
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    return declaresRecordV2(value) ? decodeTestRunRecordV2(value) : undefined
  } catch {
    return undefined
  }
}

interface RecordLocator {
  readonly user: string
  readonly change: string
  readonly runId: string
}

/** 全部用户全部任务里最新的若干条记录文件（run-id 以时间戳开头，字典序即时间序）。 */
async function recentRecordLocators(readRoot: string, limit: number): Promise<RecordLocator[]> {
  const found: RecordLocator[] = []
  for (const user of await userSlugsOf(readRoot)) {
    const testsDir = join(readRoot, TENON_PROJECT_DIR, 'users', user, 'tests')
    for (const change of await directoryNames(testsDir, MAX_CHANGES_PER_USER)) {
      try {
        for (const entry of await readdir(join(testsDir, change), { withFileTypes: true })) {
          if (entry.isFile() && entry.name.endsWith('.json')) found.push({ user, change, runId: entry.name.slice(0, -'.json'.length) })
        }
      } catch {
        // 目录读不了就当这个任务没有记录：项目级概览不为单个坏目录失败。
      }
    }
  }
  return found.sort((left, right) => (left.runId < right.runId ? 1 : left.runId > right.runId ? -1 : 0)).slice(0, limit)
}

/** 项目页的「最近结果」：每个套件在最新记录里的一次运行。 */
export async function readSuiteLatest(readRoot: string): Promise<SuiteLatestDto[]> {
  const records: Array<{ locator: RecordLocator; record: TestRunRecordV2 }> = []
  for (const locator of await recentRecordLocators(readRoot, MAX_RECENT_RECORDS)) {
    const record = await readRecordFile(join(testRunRecordsDir(readRoot, locator.user, locator.change), `${locator.runId}.json`))
    if (record !== undefined) records.push({ locator, record })
  }
  records.sort((left, right) => (left.record.finished_at < right.record.finished_at ? 1 : left.record.finished_at > right.record.finished_at ? -1 : 0))
  const latest = new Map<string, SuiteLatestDto>()
  for (const { locator, record } of records) {
    for (const run of record.suites) {
      if (latest.has(run.suite)) continue
      latest.set(run.suite, {
        suite: run.suite,
        runId: record.run_id,
        change: locator.change,
        user: locator.user,
        finishedAt: record.finished_at,
        result: run.result,
        totals: totalsDto(run.totals),
      })
    }
  }
  return [...latest.values()].sort((left, right) => (left.suite < right.suite ? -1 : 1))
}

export async function readSuiteBaselines(
  readRoot: string,
  suite: string,
): Promise<{ readonly baselines: BaselineDto[]; readonly corrupt: string[] }> {
  if (!SUITE_ID_RE.test(suite)) return { baselines: [], corrupt: [] }
  const dir = join(testSystemPaths(readRoot).baselinesDir, suite)
  let names: string[]
  try {
    names = (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name.slice(0, -'.json'.length))
      .sort()
      .slice(0, MAX_BASELINE_PROFILES)
  } catch {
    return { baselines: [], corrupt: [] }
  }
  const baselines: BaselineDto[] = []
  const corrupt: string[] = []
  for (const profile of names) {
    if (!MACHINE_PROFILE_ID_RE.test(profile)) { corrupt.push(profile); continue }
    const result = await readTestBaselineV2(baselineV2Path(readRoot, suite, profile))
    if (result.state === 'ok' && result.baseline.suite === suite && result.baseline.profile === profile) baselines.push(baselineDto(result.baseline))
    else if (result.state !== 'missing') corrupt.push(profile)
  }
  return { baselines, corrupt }
}

export function catalogOf(input: CatalogInput): TestCatalog | undefined {
  return input.state === 'ok' ? input.catalog : undefined
}

export function suiteKindOf(catalog: TestCatalog | undefined): (suite: string) => string | null {
  return (suite) => (catalog === undefined ? null : catalogSuite(catalog, suite)?.kind ?? null)
}

export async function readPlanView(readRoot: string, change: string): Promise<PlanDto> {
  const state = await readTestPlanState(join(readRoot, 'openspec', 'changes', change), change)
  if (state.state === 'missing') return { state: 'missing' }
  if (state.state === 'tampered') return { state: 'tampered', reason: state.reason }
  return planDto(state.plan, suiteKindOf(catalogOf(await loadCatalogInput(readRoot))))
}

/** 快照用的计划概要（changeDir 已由调用方解析）。 */
export async function readPlanBrief(readRoot: string, changeDir: string, change: string): Promise<PlanBriefDto> {
  const state = await readTestPlanState(changeDir, change)
  if (state.state === 'missing') return { state: 'missing' }
  if (state.state === 'tampered') return { state: 'tampered', reason: state.reason }
  return planBriefDto(state.plan, suiteKindOf(catalogOf(await loadCatalogInput(readRoot))))
}

export interface RecordListing {
  readonly users: readonly { readonly user: string; readonly chain: 'empty' | 'intact' | 'broken'; readonly reason?: string }[]
  readonly runs: readonly RecordSummaryDto[]
}

/** 一个任务全部用户的 v2 记录（新的在前）。断链或被取代的记录照列但 trusted:false，UI 据此标「记录被改动」。 */
export async function readRecordListing(readRoot: string, change: string, suite: string | undefined): Promise<RecordListing> {
  const users: Array<RecordListing['users'][number]> = []
  const runs: Array<{ finishedAt: string; summary: RecordSummaryDto }> = []
  for (const user of await userSlugsOf(readRoot)) {
    let listing
    try {
      listing = await listRecordDirectory(testRunRecordsDir(readRoot, user, change))
    } catch {
      continue
    }
    if (listing.records.length === 0 && listing.problems.length === 0) continue
    const chain = verifyRecordChain(listing)
    users.push({ user, chain: chain.state, ...(chain.state === 'broken' ? { reason: chain.reason } : {}) })
    const trusted = new Set(chain.state === 'intact' ? chain.active.map((record) => record.run_id) : [])
    for (const { record } of listing.records) {
      if (suite !== undefined && !record.suites.some((run) => run.suite === suite)) continue
      runs.push({ finishedAt: record.finished_at, summary: recordSummaryDto(record, user, trusted.has(record.run_id)) })
    }
  }
  runs.sort((left, right) => (left.finishedAt < right.finishedAt ? 1 : left.finishedAt > right.finishedAt ? -1 : 0))
  return { users, runs: runs.slice(0, MAX_RECORD_RUNS).map((entry) => entry.summary) }
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile()
  } catch {
    return false
  }
}

/** 相对运行产物目录的路径是否仍是普通文件；路径含 `..` 或绝对路径一律视为不在。 */
async function presence(runDir: string, paths: readonly string[]): Promise<boolean[]> {
  const out: boolean[] = []
  for (let start = 0; start < paths.length; start += PRESENCE_BATCH) {
    const batch = paths.slice(start, start + PRESENCE_BATCH)
    out.push(...await Promise.all(batch.map((path) => {
      const segments = path.split('/')
      if (path === '' || path.startsWith('/') || path.includes('\\') || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return false
      return isRegularFile(join(runDir, ...segments))
    })))
  }
  return out
}

async function suiteRunDto(run: TestRunRecordV2['suites'][number], runDir: string): Promise<SuiteRunDto> {
  const indexed = run.artifacts.slice(0, MAX_ARTIFACT_ENTRIES)
  const present = await presence(runDir, [...indexed.map((entry) => entry.path), run.log.artifact])
  return {
    suite: run.suite,
    origin: run.origin,
    kind: run.kind,
    runner: run.runner,
    scope: run.scope,
    command: run.command,
    cwd: run.cwd,
    exitCode: run.exit_code,
    signal: run.signal,
    durationMs: run.duration_ms,
    result: run.result,
    reasons: run.reasons.map((reason) => ({ code: reason.code, ...(reason.detail === undefined ? {} : { detail: reason.detail }) })),
    totals: totalsDto(run.totals),
    cases: run.cases.slice(0, MAX_DTO_CASES).map(caseDto),
    casesTruncated: run.cases.length > MAX_DTO_CASES,
    projects: run.projects,
    coverage: run.coverage === null ? null : coverageDto(run.coverage),
    metrics: run.metrics.map((metric) => ({
      name: metric.name, ...(metric.unit === undefined ? {} : { unit: metric.unit }), better: metric.better,
      median: metric.median, p95: metric.p95, mad: metric.mad, samples: metric.samples.length,
    })),
    artifacts: indexed.map((entry, index) => artifactDto(entry, present[index] === true)),
    artifactsTruncated: run.artifacts.length > MAX_ARTIFACT_ENTRIES,
    log: {
      artifact: run.log.artifact, bytesTotal: run.log.bytes_total, bytesKept: run.log.bytes_kept,
      truncated: run.log.truncated, present: present[indexed.length] === true,
    },
  }
}

export type RecordDetailResult =
  | { readonly state: 'ok'; readonly detail: RecordDetailDto }
  | { readonly state: 'missing' }
  | { readonly state: 'unreadable' }

export async function readRecordDetail(readRoot: string, user: string, change: string, runId: string): Promise<RecordDetailResult> {
  let listing
  try {
    listing = await listRecordDirectory(testRunRecordsDir(readRoot, user, change))
  } catch {
    return { state: 'missing' }
  }
  const file = `${runId}.json`
  const entry = listing.records.find((candidate) => candidate.file === file)
  if (entry === undefined) return { state: listing.problems.includes(file) ? 'unreadable' : 'missing' }
  const record = entry.record
  const chain = verifyRecordChain(listing)
  const trusted = chain.state === 'intact' && chain.active.some((candidate) => candidate.run_id === record.run_id)
  const runDir = testRunArtifactsDir(readRoot, user, change, record.run_id)
  const servicePresence = await presence(runDir, record.services.map((service) => service.log ?? ''))
  const services: ServiceRunDto[] = record.services.map((service, index) => ({
    id: service.id,
    readyMs: service.ready_ms,
    exit: service.exit,
    log: service.log,
    logPresent: service.log !== null && servicePresence[index] === true,
    leaked: service.leaked_pids.length,
  }))
  return {
    state: 'ok',
    detail: {
      user,
      runId: record.run_id,
      change: record.change,
      step: record.step,
      workflow: record.workflow,
      track: record.track,
      result: record.result,
      trusted,
      startedAt: record.started_at,
      finishedAt: record.finished_at,
      durationMs: record.duration_ms,
      machineProfile: record.machine_profile,
      machineLabel: record.machine_label,
      artifactsDir: relative(readRoot, runDir).split(sep).join('/'),
      actor: { id: record.actor.id, name: record.actor.name },
      services,
      suites: await Promise.all(record.suites.map((run) => suiteRunDto(run, runDir))),
    },
  }
}
