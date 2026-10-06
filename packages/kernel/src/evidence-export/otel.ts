/**
 * EvidenceBundle → OTLP/JSON 的 span 树（OpenTelemetry GenAI semantic conventions 的 span 形态），只产出 JSON，不联网导出。
 *
 *   invoke_workflow <workflow>            任务（根）
 *   ├─ tenon.step <id>                    步骤停留（来自历史里的转换）
 *   │   ├─ invoke_agent <agent>           agent 运行（执行者 / 评审者）
 *   │   └─ execute_tool tenon.test.<s>    一次测试运行里的一个套件
 *
 * GenAI 约定定义的是 gen_ai.* 属性；Tenon 自己的属性一律 `tenon.` 前缀，不借用 gen_ai.* 的名字。
 * traceId / spanId 由 (任务, 链头) 确定，重复导出得到同一棵树。
 */
import { sha256Hex } from '../sha256.js'
import type { EvidenceAgentRun, EvidenceBundle, EvidenceRecordSummary } from './types.js'

export const OTEL_SCOPE_NAME = 'tenon.evidence'
export const SPAN_KIND_INTERNAL = 1
export const STATUS_OK = 1
export const STATUS_ERROR = 2

export type OtlpAnyValue =
  | { readonly stringValue: string }
  | { readonly intValue: string }
  | { readonly doubleValue: number }
  | { readonly boolValue: boolean }
export interface OtlpAttribute { readonly key: string; readonly value: OtlpAnyValue }
export interface OtlpSpan {
  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId?: string
  readonly name: string
  readonly kind: number
  readonly startTimeUnixNano: string
  readonly endTimeUnixNano: string
  readonly attributes: readonly OtlpAttribute[]
  readonly status: { readonly code: number; readonly message?: string }
}
export interface OtlpExport {
  readonly resourceSpans: readonly [{
    readonly resource: { readonly attributes: readonly OtlpAttribute[] }
    readonly scopeSpans: readonly [{
      readonly scope: { readonly name: string; readonly version: string }
      readonly spans: readonly OtlpSpan[]
    }]
  }]
}

type AttrValue = string | number | boolean

function attribute(key: string, value: AttrValue): OtlpAttribute {
  if (typeof value === 'string') return { key, value: { stringValue: value } }
  if (typeof value === 'boolean') return { key, value: { boolValue: value } }
  return { key, value: Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value } }
}

function attributes(entries: Readonly<Record<string, AttrValue | undefined>>): readonly OtlpAttribute[] {
  return Object.entries(entries).flatMap(([key, value]) => (value === undefined ? [] : [attribute(key, value)]))
}

function nanos(iso: string, fallback: bigint): bigint {
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? BigInt(ms) * 1_000_000n : fallback
}

const PROVIDER_OF_HOST: Readonly<Record<string, string>> = { claude: 'anthropic', 'claude-code': 'anthropic', codex: 'openai' }

function agentSpan(run: EvidenceAgentRun, base: Omit<OtlpSpan, 'name' | 'attributes' | 'status' | 'startTimeUnixNano' | 'endTimeUnixNano' | 'kind'>, fallback: bigint): OtlpSpan {
  const start = nanos(run.started_at, fallback)
  const end = run.finished_at === null ? start : nanos(run.finished_at, start)
  const failed = run.result === 'fail' || run.result === 'failed'
  const provider = run.host === null ? undefined : PROVIDER_OF_HOST[run.host]
  return {
    ...base,
    name: `invoke_agent ${run.agent}`,
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: start.toString(),
    endTimeUnixNano: (end < start ? start : end).toString(),
    attributes: attributes({
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.name': run.agent,
      'gen_ai.provider.name': provider,
      'tenon.agent.role': run.role,
      'tenon.agent.result': run.result ?? 'running',
      'tenon.agent.findings': run.findings,
      'tenon.agent.run_id': run.run_id,
      'tenon.step.id': run.step,
      'error.type': failed ? 'agent_failed' : undefined,
    }),
    status: failed ? { code: STATUS_ERROR, message: `agent ${run.agent} ${run.result ?? ''}`.trim() } : { code: STATUS_OK },
  }
}

function suiteSpans(
  record: EvidenceRecordSummary,
  ids: (key: string) => string,
  parent: string,
  traceId: string,
  fallback: bigint,
): readonly OtlpSpan[] {
  const start = nanos(record.started_at, fallback)
  const end = nanos(record.finished_at, start)
  return record.suites.map((suite) => {
    const failed = suite.result === 'fail'
    return {
      traceId, spanId: ids(`test\0${record.run_id}\0${suite.suite}`), parentSpanId: parent,
      name: `execute_tool tenon.test.${suite.suite}`,
      kind: SPAN_KIND_INTERNAL,
      startTimeUnixNano: start.toString(),
      endTimeUnixNano: (end < start ? start : end).toString(),
      attributes: attributes({
        'gen_ai.operation.name': 'execute_tool',
        'gen_ai.tool.name': `tenon.test.${suite.suite}`,
        'gen_ai.tool.type': 'function',
        'gen_ai.tool.call.id': `${record.run_id}/${suite.suite}`,
        'tenon.test.run_id': record.run_id,
        'tenon.test.kind': suite.kind,
        'tenon.test.scope': suite.scope,
        'tenon.test.result': suite.result,
        'tenon.test.cases': suite.totals.cases,
        'tenon.test.pass': suite.totals.pass,
        'tenon.test.fail': suite.totals.fail,
        'tenon.test.skip': suite.totals.skip,
        'tenon.test.flaky': suite.totals.flaky,
        'tenon.test.duration_ms': suite.duration_ms,
        'tenon.test.coverage_lines': suite.coverage_lines ?? undefined,
        'tenon.step.id': record.step,
        'error.type': failed ? 'test_failed' : undefined,
      }),
      status: failed ? { code: STATUS_ERROR, message: `suite ${suite.suite} failed` } : { code: STATUS_OK },
    }
  })
}

export function buildOtelTrace(bundle: EvidenceBundle): OtlpExport {
  const traceId = sha256Hex(`tenon-trace\0${bundle.change}\0${bundle.chain.head}`).slice(0, 32)
  const spanId = (key: string): string => sha256Hex(`${traceId}\0${key}`).slice(0, 16)
  const times = [
    bundle.created_at, ...bundle.steps.flatMap((step) => [step.entered_at, step.left_at]),
    ...bundle.records.flatMap((record) => [record.started_at, record.finished_at]),
    ...bundle.agents.flatMap((run) => [run.started_at, run.finished_at]),
  ].flatMap((value) => {
    const parsed = value === null ? Number.NaN : Date.parse(value)
    return Number.isFinite(parsed) ? [BigInt(parsed) * 1_000_000n] : []
  })
  const zero = nanos(bundle.evidence_at, 0n)
  const rootStart = times.length === 0 ? zero : times.reduce((min, value) => (value < min ? value : min))
  const rootEnd = times.length === 0 ? zero : times.reduce((max, value) => (value > max ? value : max))
  const rootId = spanId('workflow')
  const spans: OtlpSpan[] = [{
    traceId, spanId: rootId,
    name: `invoke_workflow ${bundle.workflow}`,
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: rootStart.toString(),
    endTimeUnixNano: rootEnd.toString(),
    attributes: attributes({
      'gen_ai.operation.name': 'invoke_workflow',
      'gen_ai.workflow.name': bundle.workflow,
      'tenon.change': bundle.change,
      'tenon.track': bundle.track,
      'tenon.phase': bundle.phase,
      'tenon.evidence.chain_head': bundle.chain.head,
      'tenon.evidence.records': bundle.chain.records,
      'tenon.evidence.last_result': bundle.last_result,
      'vcs.ref.head.revision': bundle.commit,
    }),
    status: bundle.last_result === 'fail' ? { code: STATUS_ERROR, message: 'latest test run failed' } : { code: STATUS_OK },
  }]
  const stepSpanIds = new Map<string, string>()
  for (const [index, step] of bundle.steps.entries()) {
    const id = spanId(`step\0${index}\0${step.step}`)
    stepSpanIds.set(step.step, id)
    const start = nanos(step.entered_at, rootStart)
    const end = step.left_at === null ? rootEnd : nanos(step.left_at, rootEnd)
    spans.push({
      traceId, spanId: id, parentSpanId: rootId, name: `tenon.step ${step.step}`, kind: SPAN_KIND_INTERNAL,
      startTimeUnixNano: start.toString(), endTimeUnixNano: (end < start ? start : end).toString(),
      attributes: attributes({ 'tenon.step.id': step.step }), status: { code: STATUS_OK },
    })
  }
  const parentOf = (step: string): string => stepSpanIds.get(step) ?? rootId
  for (const run of bundle.agents) {
    spans.push(agentSpan(run, { traceId, spanId: spanId(`agent\0${run.run_id}`), parentSpanId: parentOf(run.step) }, rootStart))
  }
  for (const record of bundle.records) spans.push(...suiteSpans(record, spanId, parentOf(record.step), traceId, rootStart))
  return {
    resourceSpans: [{
      resource: { attributes: attributes({ 'service.name': 'tenon', 'service.version': bundle.tenon }) },
      scopeSpans: [{ scope: { name: OTEL_SCOPE_NAME, version: bundle.tenon }, spans }],
    }],
  }
}
