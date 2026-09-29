/**
 * 目录 / 已知失败 / 基线 / 计划 / v2 运行记录到 HTTP 响应形状的纯转换（kernel snake_case → camelCase）。
 */
import type {
  ArtifactIndexEntry, CaseResultV2, CatalogService, CatalogSuite, KnownFailure, SuiteRunV2, TestBaselineV2,
  TestPlan, TestRunRecordV2,
} from '@tenon/kernel'
import type {
  ArtifactDto, BaselineDto, BaselineMetricDto, CaseDto, CatalogServiceDto, CatalogSuiteDto, CoverageDto,
  KnownFailureDto, PlanBriefDto, PlanDto, RecordSummaryDto, TotalsDto,
} from './testSystemDtoTypes.js'

export function totalsDto(value: SuiteRunV2['totals']): TotalsDto {
  return { cases: value.cases, pass: value.pass, fail: value.fail, skip: value.skip, flaky: value.flaky, knownFail: value.known_fail }
}

export function coverageDto(value: NonNullable<SuiteRunV2['coverage']>): CoverageDto {
  return {
    ...(value.lines === undefined ? {} : { lines: value.lines }),
    ...(value.branches === undefined ? {} : { branches: value.branches }),
    ...(value.functions === undefined ? {} : { functions: value.functions }),
    ...(value.statements === undefined ? {} : { statements: value.statements }),
    ...(value.changed_lines === undefined ? {} : { changedLines: value.changed_lines }),
  }
}

export function catalogSuiteDto(suite: CatalogSuite): CatalogSuiteDto {
  return {
    id: suite.id,
    ...(suite.label === undefined ? {} : { label: suite.label }),
    kind: suite.kind,
    runner: suite.runner,
    command: suite.command,
    cwd: suite.cwd,
    timeoutS: suite.timeout_s,
    report: { format: suite.report.format, ...(suite.report.path === undefined ? {} : { path: suite.report.path }) },
    ...(suite.coverage === undefined ? {} : { coverage: { format: suite.coverage.format, path: suite.coverage.path } }),
    services: suite.services,
    retries: suite.retries,
    parallel: suite.parallel,
    tags: suite.tags,
    browsers: suite.browsers,
    ...(suite.benchmark === undefined ? {} : {
      benchmark: {
        runs: suite.benchmark.runs,
        warmup: suite.benchmark.warmup,
        metrics: suite.benchmark.metrics.map((metric) => ({
          name: metric.name,
          ...(metric.unit === undefined ? {} : { unit: metric.unit }),
          better: metric.better,
          ...(metric.max_regression_pct === undefined ? {} : { maxRegressionPct: metric.max_regression_pct }),
          ...(metric.max === undefined ? {} : { max: metric.max }),
          ...(metric.min === undefined ? {} : { min: metric.min }),
        })),
      },
    }),
  }
}

export function catalogServiceDto(service: CatalogService): CatalogServiceDto {
  const ready = service.ready
  return {
    id: service.id,
    start: service.start,
    cwd: service.cwd,
    ready: 'url' in ready
      ? { kind: 'url', value: ready.url, timeoutS: ready.timeout_s }
      : 'port' in ready
        ? { kind: 'port', value: ready.port, timeoutS: ready.timeout_s }
        : { kind: 'log', value: ready.log, timeoutS: ready.timeout_s },
    stop: service.stop,
  }
}

export function knownFailureDto(entry: KnownFailure, expired: boolean): KnownFailureDto {
  return {
    suite: entry.suite,
    test: entry.test,
    reason: entry.reason,
    ...(entry.link === undefined ? {} : { link: entry.link }),
    expires: entry.expires,
    addedBy: entry.added_by,
    expired,
  }
}

export function baselineDto(baseline: TestBaselineV2): BaselineDto {
  const metrics = (source: TestBaselineV2['metrics']): Record<string, BaselineMetricDto> => Object.fromEntries(
    Object.entries(source).map(([name, metric]) => [name, {
      median: metric.median, p95: metric.p95, mad: metric.mad, samples: metric.samples, better: metric.better,
      ...(metric.unit === undefined ? {} : { unit: metric.unit }),
    }]),
  )
  return {
    profile: baseline.profile,
    profileLabel: baseline.profile_label,
    updatedAt: baseline.updated_at,
    source: { change: baseline.source.change, runId: baseline.source.run_id, commit: baseline.source.commit },
    metrics: metrics(baseline.metrics),
    history: baseline.history.map((entry) => ({ updatedAt: entry.updated_at, metrics: metrics(entry.metrics) })),
  }
}

export function planDto(plan: TestPlan, kindOf: (suite: string) => string | null): Extract<PlanDto, { state: 'ok' }> {
  return {
    state: 'ok',
    suites: plan.suites.map((item) => ({
      suite: item.suite, kind: kindOf(item.suite), scope: item.scope,
      ...(item.pattern === undefined ? {} : { pattern: item.pattern }),
    })),
    files: plan.files.map((file) => ({
      path: file.path,
      ...(file.suite === undefined ? {} : { suite: file.suite }),
      ...(file.kind === undefined ? {} : { kind: file.kind }),
    })),
    cases: plan.cases.map((item) => ({ covers: item.covers, tests: item.tests })),
    waivers: plan.waivers.map((waiver) => ({
      ...(waiver.kind === undefined ? {} : { kind: waiver.kind }),
      ...(waiver.covers === undefined ? {} : { covers: waiver.covers }),
      reason: waiver.reason,
      approvedBy: waiver.approved_by,
    })),
  }
}


export function caseDto(item: CaseResultV2): CaseDto {
  return {
    file: item.file,
    ...(item.line === undefined ? {} : { line: item.line }),
    name: item.name,
    suitePath: item.suite_path,
    project: item.project,
    status: item.status,
    durationMs: item.duration_ms,
    attempts: item.attempts,
    ...(item.failure === undefined ? {} : {
      failure: {
        message: item.failure.message,
        ...(item.failure.stack === undefined ? {} : { stack: item.failure.stack }),
        ...(item.failure.expected === undefined ? {} : { expected: item.failure.expected }),
        ...(item.failure.actual === undefined ? {} : { actual: item.failure.actual }),
      },
    }),
    artifacts: item.artifacts,
  }
}

export function artifactDto(entry: ArtifactIndexEntry, present: boolean): ArtifactDto {
  return { path: entry.path, bytes: entry.bytes, media: entry.media, entry: entry.entry === true, present }
}

export function recordSummaryDto(record: TestRunRecordV2, user: string, trusted: boolean): RecordSummaryDto {
  return {
    user,
    trusted,
    runId: record.run_id,
    step: record.step,
    result: record.result,
    startedAt: record.started_at,
    finishedAt: record.finished_at,
    durationMs: record.duration_ms,
    machineLabel: record.machine_label,
    actor: { id: record.actor.id, name: record.actor.name },
    suites: record.suites.map((run) => ({
      suite: run.suite,
      kind: run.kind,
      scope: run.scope,
      result: run.result,
      totals: totalsDto(run.totals),
      coverage: run.coverage === null ? null : coverageDto(run.coverage),
    })),
  }
}

export function planBriefDto(plan: TestPlan, kindOf: (suite: string) => string | null): Extract<PlanBriefDto, { state: 'ok' }> {
  return {
    state: 'ok',
    suites: plan.suites.map((item) => ({ suite: item.suite, kind: kindOf(item.suite), scope: item.scope })),
    waivers: plan.waivers.map((waiver) => ({
      ...(waiver.kind === undefined ? {} : { kind: waiver.kind }),
      ...(waiver.covers === undefined ? {} : { covers: waiver.covers }),
      approved: waiver.approved_by !== null,
    })),
    files: plan.files.length,
    cases: plan.cases.length,
  }
}
