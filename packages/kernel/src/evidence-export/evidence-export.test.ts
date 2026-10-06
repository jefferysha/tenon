import { describe, expect, it } from 'vitest'
import { buildAgentTrace, AGENT_TRACE_MAX_FILES, AGENT_TRACE_MAX_RANGES } from './agent-trace.js'
import { deterministicUuid, linesToRanges } from './ids.js'
import { decodeEvidenceNote, mergeEvidenceNote, serializeEvidenceNote } from './note.js'
import { buildOtelTrace } from './otel.js'
import { evidenceNoteEntry, trailerArguments, trailerLines } from './trailer.js'
import type { EvidenceBundle } from './types.js'

const HEAD = `sha256:${'a'.repeat(64)}`
const COMMIT = 'c'.repeat(40)
const TOTALS = { cases: 2, pass: 2, fail: 0, skip: 0, flaky: 0, known_fail: 0 }

function bundle(overrides: Partial<EvidenceBundle> = {}): EvidenceBundle {
  return {
    tenon: '0.2.0', change: 'demo', workflow: 'default', track: 'backend', phase: 'verify', owner: 'a-at-x.io',
    created_at: '2026-07-07T00:00:00Z', evidence_at: '2026-07-07T00:11:00Z', commit: COMMIT,
    chain: { user: 'a-at-x.io', head: HEAD, records: 1 }, last_result: 'pass', plan_digest: `sha256:${'b'.repeat(64)}`,
    records: [{
      run_id: 'r1', step: 'build', started_at: '2026-07-07T00:10:00Z', finished_at: '2026-07-07T00:11:00Z', result: 'pass', digest: HEAD,
      suites: [{ suite: 'unit', kind: 'unit', scope: 'full', result: 'pass', duration_ms: 900, totals: TOTALS, coverage_lines: 91.5 }],
    }],
    agents: [
      { run_id: 'a1', agent: 'code-review', role: 'reviewer', step: 'build', result: 'fail', findings: 2, started_at: '2026-07-07T00:12:00Z', finished_at: '2026-07-07T00:13:00Z', host: 'codex' },
      { run_id: 'a2', agent: 'impl', role: 'executor', step: 'unknown-step', result: null, findings: 0, started_at: '2026-07-07T00:01:00Z', finished_at: null, host: null },
    ],
    steps: [
      { step: 'open', entered_at: '2026-07-07T00:00:00Z', left_at: '2026-07-07T00:05:00Z' },
      { step: 'build', entered_at: '2026-07-07T00:05:00Z', left_at: null },
    ],
    files: [{ path: 'src/a.ts', ranges: [{ start_line: 1, end_line: 3 }] }, { path: 'src/gone.ts', ranges: [] }],
    files_truncated: false,
    ...overrides,
  }
}

describe('ids', () => {
  it('确定性 UUID：同种子同值，版本位 5，格式合法', () => {
    expect(deterministicUuid('a')).toBe(deterministicUuid('a'))
    expect(deterministicUuid('a')).not.toBe(deterministicUuid('b'))
    expect(deterministicUuid('a')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
  })

  it('行号 → 连续区间：去重、排序、丢弃非法行号', () => {
    expect(linesToRanges([5, 1, 2, 3, 3, 9, 0, -1, 1.5])).toEqual([
      { start_line: 1, end_line: 3 }, { start_line: 5, end_line: 5 }, { start_line: 9, end_line: 9 },
    ])
    expect(linesToRanges([])).toEqual([])
  })
})

describe('buildAgentTrace', () => {
  it('只收有新增行的文件；贡献者缺省 unknown；证据指针与 vcs 修订写进记录', () => {
    const record = buildAgentTrace(bundle(), { contributor: 'unknown' })
    expect(record).toMatchObject({ version: '0.1', vcs: { type: 'git', revision: COMMIT }, tool: { name: 'tenon', version: '0.2.0' }, timestamp: '2026-07-07T00:11:00Z' })
    expect(record.files).toHaveLength(1)
    expect(record.files[0]?.conversations[0]).toMatchObject({
      contributor: { type: 'unknown' }, ranges: [{ start_line: 1, end_line: 3 }],
      related: [{ type: 'tenon-evidence', url: `tenon:evidence/demo?head=${HEAD}` }],
    })
    expect(record.metadata['dev.tenon']).toMatchObject({ change: 'demo', evidence: { chain_head: HEAD, records: 1, last_result: 'pass', last_run: 'r1' }, truncated: false })
  })

  it('显式断言才写 ai 与模型；模型截到 250；id 对同一证据稳定，换提交就变', () => {
    const asserted = buildAgentTrace(bundle(), { contributor: 'ai', model: `anthropic/${'m'.repeat(400)}` })
    expect(asserted.files[0]?.conversations[0]?.contributor.type).toBe('ai')
    expect(asserted.files[0]?.conversations[0]?.contributor.model_id).toHaveLength(250)
    expect(buildAgentTrace(bundle(), { contributor: 'unknown' }).id).toBe(buildAgentTrace(bundle(), { contributor: 'ai' }).id)
    expect(buildAgentTrace(bundle({ commit: 'd'.repeat(40) }), { contributor: 'unknown' }).id).not.toBe(buildAgentTrace(bundle(), { contributor: 'unknown' }).id)
  })

  it('超过上限被截断并在 metadata 里标明', () => {
    const many = Array.from({ length: AGENT_TRACE_MAX_FILES + 1 }, (_, index) => ({ path: `f${index}.ts`, ranges: [{ start_line: 1, end_line: 1 }] }))
    const record = buildAgentTrace(bundle({ files: many }), { contributor: 'unknown' })
    expect(record.files).toHaveLength(AGENT_TRACE_MAX_FILES)
    expect(record.metadata['dev.tenon'].truncated).toBe(true)
    const ranges = Array.from({ length: AGENT_TRACE_MAX_RANGES + 1 }, (_, index) => ({ start_line: index * 2 + 1, end_line: index * 2 + 1 }))
    const wide = buildAgentTrace(bundle({ files: [{ path: 'wide.ts', ranges }] }), { contributor: 'unknown' })
    expect(wide.files[0]?.conversations[0]?.ranges).toHaveLength(AGENT_TRACE_MAX_RANGES)
    expect(wide.metadata['dev.tenon'].truncated).toBe(true)
  })
})

describe('buildOtelTrace', () => {
  const spans = buildOtelTrace(bundle()).resourceSpans[0].scopeSpans[0].spans
  const byName = (name: string) => spans.find((span) => span.name === name)
  const attr = (name: string, key: string) => Object.values(byName(name)?.attributes.find((item) => item.key === key)?.value ?? {})[0]

  it('任务 → 步骤 → agent 运行 / 测试套件运行；找不到步骤的挂在任务下', () => {
    const root = byName('invoke_workflow default')
    expect(root?.parentSpanId).toBeUndefined()
    const build = byName('tenon.step build')
    expect(build?.parentSpanId).toBe(root?.spanId)
    expect(byName('execute_tool tenon.test.unit')?.parentSpanId).toBe(build?.spanId)
    expect(byName('invoke_agent code-review')?.parentSpanId).toBe(build?.spanId)
    expect(byName('invoke_agent impl')?.parentSpanId).toBe(root?.spanId)
  })

  it('GenAI 属性：operation / agent / provider（宿主 codex → openai，未知宿主省略）/ tool；失败带 error.type 与 ERROR 状态', () => {
    expect(attr('invoke_agent code-review', 'gen_ai.operation.name')).toBe('invoke_agent')
    expect(attr('invoke_agent code-review', 'gen_ai.agent.name')).toBe('code-review')
    expect(attr('invoke_agent code-review', 'gen_ai.provider.name')).toBe('openai')
    expect(attr('invoke_agent code-review', 'error.type')).toBe('agent_failed')
    expect(byName('invoke_agent code-review')?.status.code).toBe(2)
    expect(attr('invoke_agent impl', 'gen_ai.provider.name')).toBeUndefined()
    expect(attr('execute_tool tenon.test.unit', 'gen_ai.tool.call.id')).toBe('r1/unit')
    expect(attr('execute_tool tenon.test.unit', 'tenon.test.coverage_lines')).toBe(91.5)
    expect(attr('invoke_workflow default', 'gen_ai.workflow.name')).toBe('default')
    expect(attr('invoke_workflow default', 'tenon.change')).toBe('demo')
  })

  it('时间与标识：root 覆盖全部 span，end ≥ start，id 十六进制且重复导出相同；全部通过时根状态 OK', () => {
    const root = byName('invoke_workflow default')
    for (const span of spans) {
      expect(BigInt(span.endTimeUnixNano) >= BigInt(span.startTimeUnixNano)).toBe(true)
      expect(BigInt(span.startTimeUnixNano) >= BigInt(root?.startTimeUnixNano ?? 0)).toBe(true)
      expect(BigInt(span.endTimeUnixNano) <= BigInt(root?.endTimeUnixNano ?? 0)).toBe(true)
      expect(span.spanId).toMatch(/^[0-9a-f]{16}$/u)
      expect(span.traceId).toMatch(/^[0-9a-f]{32}$/u)
    }
    expect(buildOtelTrace(bundle()).resourceSpans[0].scopeSpans[0].spans.map((span) => span.spanId)).toEqual(spans.map((span) => span.spanId))
    expect(root?.status.code).toBe(1)
    expect(buildOtelTrace(bundle({ last_result: 'fail' })).resourceSpans[0].scopeSpans[0].spans[0]?.status.code).toBe(2)
  })

  it('没有任何时间戳时退回证据时刻，不产生 NaN', () => {
    const bare = buildOtelTrace(bundle({ created_at: null, steps: [], records: [], agents: [] })).resourceSpans[0].scopeSpans[0].spans
    expect(bare).toHaveLength(1)
    expect(bare[0]?.startTimeUnixNano).toBe(String(BigInt(Date.parse('2026-07-07T00:11:00Z')) * 1_000_000n))
  })

  it('时间戳只由证据决定：Agent Trace、git notes 条目与 OTel 对同一份证据逐字节相同', () => {
    const first = bundle()
    const again = bundle({ steps: [...first.steps] })
    expect(JSON.stringify(buildAgentTrace(first, { contributor: 'unknown' }))).toBe(JSON.stringify(buildAgentTrace(again, { contributor: 'unknown' })))
    expect(JSON.stringify(evidenceNoteEntry(first, { anchor: true }))).toBe(JSON.stringify(evidenceNoteEntry(again, { anchor: true })))
    expect(evidenceNoteEntry(first, { anchor: false }).created_at).toBe('2026-07-07T00:11:00Z')
    expect(JSON.stringify(buildOtelTrace(first))).toBe(JSON.stringify(buildOtelTrace(again)))
  })
})

describe('证据 note', () => {
  it('条目由 bundle 派生；--anchor 才带 anchor；序列化后能解码回来', () => {
    const plain = evidenceNoteEntry(bundle(), { anchor: false })
    expect(plain).toMatchObject({ change: 'demo', user: 'a-at-x.io', last_result: 'pass', chain: { head: HEAD, records: 1, last_run: 'r1' } })
    expect(plain.anchor).toBeUndefined()
    const anchored = evidenceNoteEntry(bundle(), { anchor: true })
    expect(anchored.anchor).toEqual({ kind: 'chain-head', head: HEAD })
    const note = mergeEvidenceNote(undefined, anchored)
    expect(decodeEvidenceNote(serializeEvidenceNote(note))).toEqual(note)
  })

  it('同 (任务, 用户) 的条目被替换，其余保留且排序稳定', () => {
    const first = mergeEvidenceNote(undefined, evidenceNoteEntry(bundle({ change: 'b' }), { anchor: false }))
    const second = mergeEvidenceNote(first, evidenceNoteEntry(bundle({ change: 'a' }), { anchor: false }))
    expect(second.changes.map((item) => item.change)).toEqual(['a', 'b'])
    const replaced = mergeEvidenceNote(second, evidenceNoteEntry(bundle({ change: 'a' }), { anchor: true }))
    expect(replaced.changes).toHaveLength(2)
    expect(replaced.changes[0]?.anchor).toBeDefined()
  })

  it('不认识的正文整体判无效：非 JSON、别的 schema、形状不对、摘要不合法', () => {
    expect(decodeEvidenceNote('hello')).toBeUndefined()
    expect(decodeEvidenceNote('{"schema":"other","changes":[]}')).toBeUndefined()
    expect(decodeEvidenceNote('{"schema":"tenon-evidence-note/v1","changes":[{"change":"x"}]}')).toBeUndefined()
    const entry = evidenceNoteEntry(bundle(), { anchor: true })
    const bad = JSON.stringify({ schema: 'tenon-evidence-note/v1', changes: [{ ...entry, anchor: { kind: 'chain-head', head: 'sha256:short' } }] })
    expect(decodeEvidenceNote(bad)).toBeUndefined()
  })
})

describe('尾注', () => {
  it('两行：Tenon-Change 与 Tenon-Evidence（链头摘要）；git interpret-trailers 的参数形式', () => {
    expect(trailerLines(bundle())).toEqual(['Tenon-Change: demo', `Tenon-Evidence: ${HEAD}`])
    expect(trailerArguments(bundle())).toEqual(['--trailer', 'Tenon-Change: demo', '--trailer', `Tenon-Evidence: ${HEAD}`])
  })
})
