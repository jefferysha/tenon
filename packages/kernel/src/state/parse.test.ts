import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { FIELD_ORDER, QuoteGateError, REVIEW_GATE_FIELDS, type PipelineState } from '../types.js'
import { parsePipeline, serializePipeline, unquoteScalar } from './parse.js'

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
}

function withPreVerifyReviewDefault(raw: string): string {
  return raw.replace(
    /^(automation_cause:.*)$/m,
    '$1\npre_verify_review_result: pending',
  )
}

const REAL_FIXTURES = [
  'dashboard-interaction-fixes.pipeline.yaml',
  'zz-container-e2e.pipeline.yaml',
  'dashboard-html-parity-restore.pipeline.yaml',
  'synthetic-lists.pipeline.yaml',
] as const

describe('unquoteScalar（单层去引号）', () => {
  it('剥一对双引号', () => expect(unquoteScalar('"abc"')).toBe('abc'))
  it('剥一对单引号', () => expect(unquoteScalar("'abc'")).toBe('abc'))
  it('空引号对 → 空串', () => expect(unquoteScalar('""')).toBe(''))
  it('只剥一层，不递归', () => expect(unquoteScalar('""abc""')).toBe('"abc"'))
  it('首尾异种引号不剥', () => expect(unquoteScalar('"abc\'')).toBe('"abc\''))
  it('单字符引号不剥（长度<2）', () => expect(unquoteScalar('"')).toBe('"'))
  it('无引号原样', () => expect(unquoteScalar('abc')).toBe('abc'))
})

describe('parsePipeline（窄解析器）', () => {
  it('解析真实 fixture 的标量字段（含去引号）', () => {
    const state = parsePipeline(fixture('dashboard-interaction-fixes.pipeline.yaml'))
    expect(state.fields.track).toBe('frontend')
    expect(state.fields.created_by).toBe('Host Dev')
    expect(state.fields.phase).toBe('ship')
    expect(state.fields.automation_queued_at).toBe('')
    expect(state.fields.automation_attempts).toBe('0')
    expect(state.fields.pre_verify_review_result).toBe('pending')
    expect(state.fields.pr_url).toBe(
      'draft（未推送，留 afk-full-pipeline-autodrive 分支待整体确认；草稿见 pr-draft.md）',
    )
  })

  it('历史区/未知字段全部进 opaqueTail（读跳过）', () => {
    const state = parsePipeline(fixture('dashboard-interaction-fixes.pipeline.yaml'))
    expect(state.opaqueTail.startsWith('pipeline_mode: human\n')).toBe(true)
    expect(state.opaqueTail).toContain('tools_history:')
    expect(state.opaqueTail).toContain('transitions_history:')
    expect(state.opaqueTail).toContain('prompts_history:')
    expect(state.opaqueTail.endsWith('coverage_confirmed_by: Host Dev\n')).toBe(true)
  })

  it('无历史区时 opaqueTail 为空串', () => {
    const state = parsePipeline(fixture('channel-adapter-worker-guard-oldschema.pipeline.yaml'))
    expect(state.opaqueTail).toBe('')
  })

  it('老 schema 缺字段 → 读为空串（容忍）', () => {
    const state = parsePipeline(fixture('channel-adapter-worker-guard-oldschema.pipeline.yaml'))
    expect(state.fields.track).toBe('backend')
    expect(state.fields.automation).toBe('')
    expect(state.fields.automation_queued_at).toBe('')
    expect(state.fields.depends_on).toBe('channel-supervisor-process')
  })

  it('老文件缺 automation_cause 行 → 读为空串（F-b 末尾追加，容忍不变），写回补 automation_cause: ""', () => {
    const state = parsePipeline(fixture('channel-adapter-worker-guard-oldschema.pipeline.yaml'))
    expect(state.fields.automation_cause).toBe('')
    expect(serializePipeline(state)).toContain('\nautomation_cause: ""\n')
  })

  it('列表字段：块序列 → string[]，空列表 [] → []，flat 标量保持 string', () => {
    const state = parsePipeline(fixture('synthetic-lists.pipeline.yaml'))
    expect(state.fields.scope).toEqual(['packages/kernel', 'packages/cli'])
    expect(state.fields.related_files).toEqual(['packages/kernel/src/state/store.ts'])
    expect(state.fields.spec_scope).toEqual([])
    expect(state.fields.depends_on).toBe('channel-core-event-kernel,channel-supervisor-process')
  })

  it('列表字段 flat null 读为字符串 "null"（不误判成列表）', () => {
    const state = parsePipeline(fixture('zz-container-e2e.pipeline.yaml'))
    expect(state.fields.scope).toBe('null')
    expect(state.fields.related_files).toBe('null')
  })
})

describe('serializePipeline（严格 FIELD_ORDER 全量写回）', () => {
  for (const name of REAL_FIXTURES) {
    it(`read→write 精确升级 pre-Verify 默认值，其余逐字节等价: ${name}`, () => {
      const raw = fixture(name)
      expect(serializePipeline(parsePipeline(raw))).toBe(withPreVerifyReviewDefault(raw))
    })
  }

  it('老 schema 读后写回 → 归一化为既有字段；空 review receipt 不扰动兼容投影', () => {
    const out = serializePipeline(parsePipeline(fixture('channel-adapter-worker-guard-oldschema.pipeline.yaml')))
    const keys = out
      .split('\n')
      .filter((l) => /^[a-z_]+:/.test(l))
      .map((l) => l.split(':')[0])
    expect(keys).toEqual(FIELD_ORDER.filter((field) => !REVIEW_GATE_FIELDS.includes(field as typeof REVIEW_GATE_FIELDS[number])))
    expect(out).toContain('automation: ""\n')
    for (const field of REVIEW_GATE_FIELDS) expect(out).not.toContain(`${field}:`)
  })

  it('review receipt 只要有一个值便整组写出，解析后逐字段保持', () => {
    const state = parsePipeline(fixture('zz-container-e2e.pipeline.yaml'))
    state.fields.review_gate_phase = 'spec'
    state.fields.review_gate_status = 'approved'
    state.fields.review_gate_event = 'spec-complete'
    state.fields.review_requested_at = '2026-07-24T00:00:00Z'
    const out = serializePipeline(state)
    for (const field of REVIEW_GATE_FIELDS) expect(out).toContain(`${field}:`)
    expect(parsePipeline(out).fields).toMatchObject({
      review_gate_phase: 'spec',
      review_gate_status: 'approved',
      review_gate_event: 'spec-complete',
      review_requested_at: '2026-07-24T00:00:00Z',
      review_acknowledged_at: '',
      review_acknowledged_via: 'unknown',
    })
  })

  it('空串标量写为 ""，空列表写为 []', () => {
    const state = parsePipeline(fixture('synthetic-lists.pipeline.yaml'))
    const out = serializePipeline(state)
    expect(out).toContain('automation_sandbox: ""\n')
    expect(out).toContain('spec_scope: []\n')
    expect(out).toContain('scope:\n  - packages/kernel\n  - packages/cli\n')
  })
})

describe('parsePipeline/serializePipeline —— 内部提交元数据三行块（W1 第二增量，不进 FIELD_ORDER）', () => {
  it('已知字段后紧跟元数据三行 → runMetadata 真解析，opaqueTail 从第四行开始（不含元数据本身）', () => {
    const raw = fixture('zz-container-e2e.pipeline.yaml')
    const withMeta = raw.replace(
      /\n(pipeline_mode:|tools_history:|$)/,
      '\npipeline_run_id: run-42\npipeline_transition_sequence: 5\npipeline_transition_head: rec-5\n$1',
    )
    const state = parsePipeline(withMeta)
    expect(state.runMetadata).toEqual({ runId: 'run-42', transitionSequence: 5, transitionHead: 'rec-5' })
    expect(state.opaqueTail.startsWith('pipeline_run_id')).toBe(false)
  })

  it('没有元数据三行的老文件（现有全部 fixture）→ runMetadata 为 undefined，opaqueTail 逐字不变', () => {
    const state = parsePipeline(fixture('zz-container-e2e.pipeline.yaml'))
    expect(state.runMetadata).toBeUndefined()
  })

  it('serializePipeline：runMetadata 存在时，三行写在 FIELD_ORDER 字段之后、opaqueTail 之前', () => {
    const state = parsePipeline(fixture('channel-adapter-worker-guard-oldschema.pipeline.yaml'))
    state.runMetadata = { runId: 'run-9', transitionSequence: 1, transitionHead: undefined }
    const out = serializePipeline(state)
    const lines = out.split('\n')
    const archivedIdx = lines.indexOf(`archived: ${state.fields.archived === '' ? '""' : state.fields.archived}`)
    expect(archivedIdx).toBeGreaterThanOrEqual(0)
    expect(lines).toContain('pipeline_run_id: run-9')
    expect(lines).toContain('pipeline_transition_sequence: 1')
    expect(lines).toContain('pipeline_transition_head: null')
    // 元数据三行必须紧跟在最后一个实际投影的字段之后，早于 opaqueTail 内容。
    // 空 review receipt 是兼容投影的可选组，因此不能机械假定 FIELD_ORDER 尾项一定有一行。
    const lastFieldKey = [...FIELD_ORDER].reverse().find((field) =>
      lines.some((line) => line.startsWith(`${field}:`)),
    )
    expect(lastFieldKey).toBe('pre_verify_review_result')
    const metaIdx = lines.indexOf('pipeline_run_id: run-9')
    const lastFieldIdx = lines.findIndex((l) => l.startsWith(`${lastFieldKey!}:`))
    expect(metaIdx).toBe(lastFieldIdx + 1)
  })

  it('往返：解析→序列化，runMetadata 逐字段还原（含 head）', () => {
    const state = parsePipeline(fixture('zz-container-e2e.pipeline.yaml'))
    state.runMetadata = { runId: 'run-r', transitionSequence: 12, transitionHead: 'rec-12' }
    const roundTripped = parsePipeline(serializePipeline(state))
    expect(roundTripped.runMetadata).toEqual(state.runMetadata)
  })

  it('往返：runMetadata 为 undefined 时只补 pre-Verify 默认值，opaqueTail 逐字不变', () => {
    const raw = fixture('dashboard-html-parity-restore.pipeline.yaml')
    expect(serializePipeline(parsePipeline(raw))).toBe(withPreVerifyReviewDefault(raw))
  })
})

describe('四闸（QuoteGateError）', () => {
  function baseState(): PipelineState {
    return parsePipeline(fixture('zz-container-e2e.pipeline.yaml'))
  }

  it.each([
    ['冒号+空格', 'a: b'],
    ['空格+井号', 'a #b'],
    ['换行', 'a\nb'],
    ['回车', 'a\rb'],
    ['首字符双引号', '"a'],
    ['首字符单引号', "'a"],
  ])('标量值含 %s → 拒写', (_label, bad) => {
    const state = baseState()
    state.fields.plan = bad
    expect(() => serializePipeline(state)).toThrow(QuoteGateError)
  })

  it.each([
    ['冒号+空格', 'a: b'],
    ['空格+井号', 'a #b'],
    ['换行', 'a\nb'],
    ['首字符引号', '"a'],
  ])('列表项含 %s → 拒写', (_label, bad) => {
    const state = baseState()
    state.fields.scope = ['ok-item', bad]
    expect(() => serializePipeline(state)).toThrow(QuoteGateError)
  })

  it('时间戳的冒号（无空格）不触闸', () => {
    const state = baseState()
    state.fields.updated_at = '2026-07-06T12:00:00Z'
    expect(() => serializePipeline(state)).not.toThrow()
  })

  it('空串不触首引号闸（序列化为 ""）', () => {
    const state = baseState()
    state.fields.automation_last_error = ''
    expect(serializePipeline(state)).toContain('automation_last_error: ""\n')
  })
})
