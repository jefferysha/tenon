/**
 * 步骤策略判定（TestPolicyReport）到快照响应形状的纯转换。列表按上限截断，不让一个大任务撑爆快照。
 */
import type {
  BenchmarkMetricVerdict, StepTestPolicyIR, SuiteVerdict, TestBlocker, TestNotice, TestPolicyReport, TraceRow,
} from '@tenon/kernel'
import {
  MAX_DTO_BLOCKERS, MAX_DTO_TRACE_ROWS, type BenchmarkVerdictDto, type BlockerDto, type NoticeDto,
  type PolicyDto, type PolicyReportDto, type SuiteVerdictDto, type TraceRowDto,
} from './testSystemDtoTypes.js'
import { coverageDto, totalsDto } from './testSystemDto.js'

export function policyDto(policy: StepTestPolicyIR): PolicyDto {
  return {
    plan: policy.plan,
    kinds: policy.kinds,
    run: policy.run,
    runIfRegistered: policy.run_if_registered,
    scope: policy.scope,
    files: policy.files,
    scenarios: policy.scenarios,
    ...(policy.coverage === undefined ? {} : {
      coverage: coverageDto({
        ...(policy.coverage.lines === undefined ? {} : { lines: policy.coverage.lines }),
        ...(policy.coverage.branches === undefined ? {} : { branches: policy.coverage.branches }),
        ...(policy.coverage.functions === undefined ? {} : { functions: policy.coverage.functions }),
        ...(policy.coverage.statements === undefined ? {} : { statements: policy.coverage.statements }),
        ...(policy.coverage.changed_lines === undefined ? {} : { changed_lines: policy.coverage.changed_lines }),
      }),
    }),
    ...(policy.flaky === undefined ? {} : { flaky: { max: policy.flaky.max, failOnNew: policy.flaky.fail_on_new } }),
    requireBaseline: policy.benchmark.require_baseline,
    browsers: policy.browsers,
  }
}

function blockerDto(item: TestBlocker): BlockerDto {
  return {
    code: item.code,
    blocking: item.blocking,
    message: item.message,
    ...(item.fix === undefined ? {} : { fix: item.fix }),
    ...(item.subject === undefined ? {} : { subject: item.subject }),
  }
}

function noticeDto(item: TestNotice): NoticeDto {
  return {
    code: item.code,
    message: item.message,
    ...(item.fix === undefined ? {} : { fix: item.fix }),
    ...(item.subject === undefined ? {} : { subject: item.subject }),
  }
}

function benchmarkDto(item: BenchmarkMetricVerdict): BenchmarkVerdictDto {
  return {
    name: item.name,
    ...(item.unit === undefined ? {} : { unit: item.unit }),
    better: item.better,
    median: item.summary?.median ?? null,
    p95: item.summary?.p95 ?? null,
    baseline: item.baseline,
    deltaPct: item.delta_pct,
    failed: item.failed,
    baselineMissing: item.baselineMissing,
    noisy: item.noisy,
    details: item.details,
  }
}

function verdictDto(item: SuiteVerdict): SuiteVerdictDto {
  return {
    suite: item.suite,
    origin: item.origin,
    kind: item.kind,
    ...(item.label === undefined ? {} : { label: item.label }),
    reason: item.reason,
    state: item.state,
    ...(item.run_id === undefined ? {} : { runId: item.run_id }),
    ...(item.finished_at === undefined ? {} : { finishedAt: item.finished_at }),
    ...(item.staleBecause === undefined ? {} : { staleBecause: item.staleBecause }),
    ...(item.totals === undefined ? {} : { totals: totalsDto(item.totals) }),
    ...(item.failing === undefined ? {} : { failing: item.failing }),
    ...(item.flaky === undefined ? {} : { flaky: item.flaky }),
    ...(item.coverage === undefined || item.coverage === null ? {} : { coverage: coverageDto(item.coverage) }),
    ...(item.benchmark === undefined ? {} : { benchmark: item.benchmark.map(benchmarkDto) }),
    ...(item.detail === undefined ? {} : { detail: item.detail }),
  }
}

function traceDto(row: TraceRow): TraceRowDto {
  return {
    covers: row.covers,
    kind: row.kind,
    title: row.title,
    ...(row.stage === undefined ? {} : { stage: row.stage }),
    required: row.required,
    tests: row.tests.map((test) => ({
      ref: test.ref,
      status: test.status,
      ...(test.suite === undefined ? {} : { suite: test.suite }),
      ...(test.run_id === undefined ? {} : { runId: test.run_id }),
    })),
    ...(row.waiver === undefined ? {} : { waiver: { approved: row.waiver.approved, reason: row.waiver.reason } }),
    state: row.state,
  }
}

export function policyReportDto(report: TestPolicyReport, policy: StepTestPolicyIR | undefined): PolicyReportDto {
  return {
    stepId: report.stepId,
    pass: report.pass,
    chain: report.chain,
    policy: policy === undefined ? null : policyDto(policy),
    blockers: report.blockers.slice(0, MAX_DTO_BLOCKERS).map(blockerDto),
    notices: report.notices.slice(0, MAX_DTO_BLOCKERS).map(noticeDto),
    suites: report.suites.map(verdictDto),
    trace: report.trace.slice(0, MAX_DTO_TRACE_ROWS).map(traceDto),
    files: {
      checked: report.files.checked,
      unregistered: report.files.unregistered.map((file) => ({ path: file.path, suites: file.suites })),
      orphans: report.files.orphans,
    },
    notApplicable: report.notApplicable.map((entry) => ({ kind: entry.kind, reason: entry.reason, approved: entry.approved })),
  }
}

