/** 目录 / 基线 / 计划 / v2 运行记录响应的严格解码。 */
import type {
  BaselineHistoryEntry, BaselineMetric, CaseStatus, CatalogService, CatalogSuite, KnownFailure, KnownFailuresView,
  RecordDetail, RecordListResponse, RecordSummary, RunArtifact, RunCase, RunMetric, RunService, SuiteBaseline,
  SuiteBaselinesResponse, SuiteLatest, SuiteRun, TestCatalogResponse, TestCatalogView, TestMetricSpec, TestPlanView,
} from './testSystemTypes'
import { readCoverage, readTotals } from './testPolicyDecoders'
import { arr, bool, guard, int, maybe, nnum, nstr, num, oneOf, opt, rec, str, strs } from './strictReader'

function readMetricSpec(value: unknown): TestMetricSpec {
  const item = rec(value)
  return {
    name: str(item.name),
    ...maybe('unit', opt(item.unit, str)),
    better: oneOf(item.better, ['lower', 'higher']),
    ...maybe('maxRegressionPct', opt(item.maxRegressionPct, num)),
    ...maybe('max', opt(item.max, num)),
    ...maybe('min', opt(item.min, num)),
  }
}

function readSuite(value: unknown): CatalogSuite {
  const item = rec(value)
  const report = rec(item.report)
  return {
    id: str(item.id),
    ...maybe('label', opt(item.label, str)),
    kind: str(item.kind),
    runner: str(item.runner),
    command: str(item.command),
    cwd: str(item.cwd),
    timeoutS: int(item.timeoutS),
    report: { format: str(report.format), ...maybe('path', opt(report.path, str)) },
    ...maybe('coverage', opt(item.coverage, (raw) => {
      const coverage = rec(raw)
      return { format: str(coverage.format), path: str(coverage.path) }
    })),
    services: strs(item.services),
    retries: int(item.retries),
    parallel: bool(item.parallel),
    tags: strs(item.tags),
    browsers: strs(item.browsers),
    ...maybe('benchmark', opt(item.benchmark, (raw) => {
      const bench = rec(raw)
      return { runs: int(bench.runs), warmup: int(bench.warmup), metrics: arr(bench.metrics, readMetricSpec) }
    })),
  }
}

function readService(value: unknown): CatalogService {
  const item = rec(value)
  const ready = rec(item.ready)
  const kind = oneOf(ready.kind, ['url', 'port', 'log'])
  return {
    id: str(item.id), start: str(item.start), cwd: str(item.cwd),
    ready: { kind, value: kind === 'port' ? num(ready.value) : str(ready.value), timeoutS: int(ready.timeoutS) },
    stop: str(item.stop),
  }
}

function readCatalog(value: unknown): TestCatalogView {
  const item = rec(value)
  const state = oneOf(item.state, ['missing', 'invalid', 'ok'])
  if (state === 'missing') return { state }
  if (state === 'invalid') return { state, issues: strs(item.issues) }
  return { state, suites: arr(item.suites, readSuite), services: arr(item.services, readService) }
}

function readKnown(value: unknown): KnownFailure {
  const item = rec(value)
  return {
    suite: str(item.suite), test: str(item.test), reason: str(item.reason),
    ...maybe('link', opt(item.link, str)),
    expires: str(item.expires), addedBy: str(item.addedBy), expired: bool(item.expired),
  }
}

function readKnownFailures(value: unknown): KnownFailuresView {
  const item = rec(value)
  const state = oneOf(item.state, ['missing', 'invalid', 'ok'])
  if (state === 'missing') return { state }
  if (state === 'invalid') return { state, issues: strs(item.issues) }
  return { state, entries: arr(item.entries, readKnown) }
}

function readLatest(value: unknown): SuiteLatest {
  const item = rec(value)
  return {
    suite: str(item.suite), runId: str(item.runId), change: str(item.change), user: str(item.user),
    finishedAt: str(item.finishedAt), result: oneOf(item.result, ['pass', 'fail']), totals: readTotals(item.totals),
  }
}

export const decodeCatalogResponse = guard((value: unknown): TestCatalogResponse => {
  const body = rec(value)
  return { catalog: readCatalog(body.catalog), knownFailures: readKnownFailures(body.knownFailures), latest: arr(body.latest, readLatest) }
})

function readBaselineMetric(value: unknown): BaselineMetric {
  const item = rec(value)
  return {
    median: num(item.median), p95: num(item.p95), mad: num(item.mad), samples: int(item.samples),
    better: oneOf(item.better, ['lower', 'higher']), ...maybe('unit', opt(item.unit, str)),
  }
}

function readMetricMap(value: unknown): Record<string, BaselineMetric> {
  const out: Record<string, BaselineMetric> = {}
  for (const [name, metric] of Object.entries(rec(value))) out[name] = readBaselineMetric(metric)
  return out
}

function readHistoryEntry(value: unknown): BaselineHistoryEntry {
  const item = rec(value)
  return { updatedAt: str(item.updatedAt), metrics: readMetricMap(item.metrics) }
}

function readBaseline(value: unknown): SuiteBaseline {
  const item = rec(value)
  const source = rec(item.source)
  return {
    profile: str(item.profile), profileLabel: str(item.profileLabel),
    updatedAt: str(item.updatedAt), metrics: readMetricMap(item.metrics),
    source: { change: str(source.change), runId: str(source.runId), commit: nstr(source.commit) },
    history: arr(item.history, readHistoryEntry),
  }
}

export const decodeBaselinesResponse = guard((value: unknown): SuiteBaselinesResponse => {
  const body = rec(value)
  return { suite: str(body.suite), baselines: arr(body.baselines, readBaseline), corrupt: strs(body.corrupt) }
})

export const decodePlanResponse = guard((value: unknown): TestPlanView => {
  const item = rec(rec(value).plan)
  const state = oneOf(item.state, ['missing', 'tampered', 'ok'])
  if (state === 'missing') return { state }
  if (state === 'tampered') return { state, reason: str(item.reason) }
  return {
    state,
    suites: arr(item.suites, (raw) => {
      const suite = rec(raw)
      return { suite: str(suite.suite), kind: nstr(suite.kind), scope: str(suite.scope), ...maybe('pattern', opt(suite.pattern, str)) }
    }),
    files: arr(item.files, (raw) => {
      const file = rec(raw)
      return { path: str(file.path), ...maybe('suite', opt(file.suite, str)), ...maybe('kind', opt(file.kind, str)) }
    }),
    cases: arr(item.cases, (raw) => {
      const entry = rec(raw)
      return { covers: str(entry.covers), tests: strs(entry.tests) }
    }),
    waivers: arr(item.waivers, (raw) => {
      const waiver = rec(raw)
      return {
        ...maybe('kind', opt(waiver.kind, str)), ...maybe('covers', opt(waiver.covers, str)),
        reason: str(waiver.reason), approvedBy: nstr(waiver.approvedBy),
      }
    }),
  }
})

function readSummary(value: unknown): RecordSummary {
  const item = rec(value)
  const actor = rec(item.actor)
  return {
    user: str(item.user), trusted: bool(item.trusted), runId: str(item.runId), step: str(item.step),
    result: oneOf(item.result, ['pass', 'fail']), startedAt: str(item.startedAt), finishedAt: str(item.finishedAt),
    durationMs: num(item.durationMs), machineLabel: str(item.machineLabel),
    actor: { id: str(actor.id), name: str(actor.name) },
    suites: arr(item.suites, (raw) => {
      const suite = rec(raw)
      return {
        suite: str(suite.suite), kind: str(suite.kind), scope: str(suite.scope),
        result: oneOf(suite.result, ['pass', 'fail']), totals: readTotals(suite.totals),
        coverage: suite.coverage === null ? null : readCoverage(suite.coverage),
      }
    }),
  }
}

export const decodeRecordListResponse = guard((value: unknown): RecordListResponse => {
  const body = rec(value)
  return {
    users: arr(body.users, (raw) => {
      const user = rec(raw)
      return { user: str(user.user), chain: oneOf(user.chain, ['empty', 'intact', 'broken']), ...maybe('reason', opt(user.reason, str)) }
    }),
    runs: arr(body.runs, readSummary),
  }
})

const CASE_STATUS: readonly CaseStatus[] = ['pass', 'fail', 'skip', 'flaky', 'known-fail']
const MEDIA: readonly RunArtifact['media'][] = ['image', 'video', 'trace', 'html', 'json', 'text', 'other']

function readCase(value: unknown): RunCase {
  const item = rec(value)
  return {
    file: str(item.file), ...maybe('line', opt(item.line, int)), name: str(item.name),
    suitePath: strs(item.suitePath), project: nstr(item.project), status: oneOf(item.status, CASE_STATUS),
    durationMs: num(item.durationMs), attempts: int(item.attempts),
    ...maybe('failure', opt(item.failure, (raw) => {
      const failure = rec(raw)
      return {
        message: str(failure.message), ...maybe('stack', opt(failure.stack, str)),
        ...maybe('expected', opt(failure.expected, str)), ...maybe('actual', opt(failure.actual, str)),
      }
    })),
    artifacts: strs(item.artifacts),
  }
}

function readRunMetric(value: unknown): RunMetric {
  const item = rec(value)
  return {
    name: str(item.name), ...maybe('unit', opt(item.unit, str)), better: oneOf(item.better, ['lower', 'higher']),
    median: num(item.median), p95: num(item.p95), mad: num(item.mad), samples: int(item.samples),
  }
}

function readArtifact(value: unknown): RunArtifact {
  const item = rec(value)
  return {
    path: str(item.path), bytes: int(item.bytes), media: oneOf(item.media, MEDIA),
    entry: bool(item.entry), present: bool(item.present),
  }
}

function readSuiteRun(value: unknown): SuiteRun {
  const item = rec(value)
  const log = rec(item.log)
  return {
    suite: str(item.suite), origin: oneOf(item.origin, ['catalog', 'step']), kind: str(item.kind),
    runner: str(item.runner), scope: str(item.scope), command: str(item.command), cwd: str(item.cwd),
    exitCode: nnum(item.exitCode), signal: nstr(item.signal), durationMs: num(item.durationMs),
    result: oneOf(item.result, ['pass', 'fail']),
    reasons: arr(item.reasons, (raw) => {
      const reason = rec(raw)
      return { code: str(reason.code), ...maybe('detail', opt(reason.detail, str)) }
    }),
    totals: readTotals(item.totals),
    cases: arr(item.cases, readCase), casesTruncated: bool(item.casesTruncated),
    projects: strs(item.projects),
    coverage: item.coverage === null ? null : readCoverage(item.coverage),
    metrics: arr(item.metrics, readRunMetric),
    artifacts: arr(item.artifacts, readArtifact), artifactsTruncated: bool(item.artifactsTruncated),
    log: {
      artifact: str(log.artifact), bytesTotal: int(log.bytesTotal), bytesKept: int(log.bytesKept),
      truncated: bool(log.truncated), present: bool(log.present),
    },
  }
}

function readRunService(value: unknown): RunService {
  const item = rec(value)
  return {
    id: str(item.id), readyMs: nnum(item.readyMs), exit: str(item.exit), log: nstr(item.log),
    logPresent: bool(item.logPresent), leaked: int(item.leaked),
  }
}

export const decodeRecordResponse = guard((value: unknown): RecordDetail => {
  const item = rec(rec(value).record)
  const actor = rec(item.actor)
  return {
    user: str(item.user), trusted: bool(item.trusted), runId: str(item.runId), change: str(item.change),
    step: str(item.step), workflow: str(item.workflow), track: str(item.track),
    result: oneOf(item.result, ['pass', 'fail']), startedAt: str(item.startedAt), finishedAt: str(item.finishedAt),
    durationMs: num(item.durationMs), machineProfile: str(item.machineProfile), machineLabel: str(item.machineLabel),
    artifactsDir: str(item.artifactsDir),
    actor: { id: str(actor.id), name: str(actor.name) },
    services: arr(item.services, readRunService),
    suites: arr(item.suites, readSuiteRun),
  }
})
