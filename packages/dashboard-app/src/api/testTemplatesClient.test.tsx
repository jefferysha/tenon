import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from './transport'
import { decodeTemplate, fetchTestTemplates } from './testTemplatesClient'

const GOOD = {
  id: 'benchmark', label: '基准', source: 'builtin', yaml: 'ignored',
  definition: {
    id: 'benchmark', label: '基准', command: 'npm run bench', cwd: 'a', timeout_s: 60, scope: 'full', metrics_path: 'm.json',
    pass: { exit_code: 0, metrics: [{ name: 'p95', max: 1, better: 'lower' }] },
    inputs: [{ kind: 'env', name: 'X' }],
    outputs: [{ path: 'out', kind: 'metrics', required: true }],
  },
}

function stub(body: unknown, status = 200) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(body), { status }))
}

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof ApiError) return error
    throw error
  }
  throw new Error('expected rejection')
}

afterEach(() => vi.restoreAllMocks())

describe('测试模板客户端', () => {
  it('解出模板，只保留展示需要的字段（不带 yaml）', async () => {
    stub({ ok: true, directions: [GOOD] })
    const templates = await fetchTestTemplates()
    expect(templates).toHaveLength(1)
    expect(templates[0]).not.toHaveProperty('yaml')
    expect(templates[0]?.definition).toEqual(GOOD.definition)
  })

  it('形状不合整份拒绝：缺命令、id 与外层不一致、未知来源、字段类型错、子项非法', () => {
    const bad = (edit: (draft: Record<string, unknown>) => void): unknown => {
      const draft = JSON.parse(JSON.stringify(GOOD)) as Record<string, unknown>
      edit(draft)
      return draft
    }
    const def = (draft: Record<string, unknown>): Record<string, unknown> => draft.definition as Record<string, unknown>
    expect(decodeTemplate(GOOD)).not.toBeNull()
    expect(decodeTemplate(bad((d) => { delete def(d).command }))).toBeNull()
    expect(decodeTemplate(bad((d) => { def(d).command = '' }))).toBeNull()
    expect(decodeTemplate(bad((d) => { def(d).id = 'other' }))).toBeNull()
    expect(decodeTemplate(bad((d) => { d.source = 'remote' }))).toBeNull()
    expect(decodeTemplate(bad((d) => { def(d).timeout_s = '60' }))).toBeNull()
    expect(decodeTemplate(bad((d) => { def(d).timeout_s = 1.5 }))).toBeNull()
    expect(decodeTemplate(bad((d) => { def(d).scope = 'some' }))).toBeNull()
    expect(decodeTemplate(bad((d) => { def(d).cwd = 3 }))).toBeNull()
    expect(decodeTemplate(bad((d) => { (def(d).pass as Record<string, unknown>).exit_code = 'x' }))).toBeNull()
    expect(decodeTemplate(bad((d) => { (def(d).pass as { metrics: unknown[] }).metrics = [{ name: '' }] }))).toBeNull()
    expect(decodeTemplate(bad((d) => { def(d).inputs = [{ kind: 'weird' }] }))).toBeNull()
    expect(decodeTemplate(bad((d) => { def(d).outputs = [{ path: '' }] }))).toBeNull()
    expect(decodeTemplate(null)).toBeNull()
  })

  it('响应里任一条不合都拒绝整个列表；ok 缺失、非 JSON、HTTP 错误、网络失败各有状态', async () => {
    stub({ ok: true, directions: [GOOD, { id: 'x' }] })
    expect((await failure(fetchTestTemplates())).message).toBe('invalid response')
    stub({ directions: [] })
    expect((await failure(fetchTestTemplates())).message).toBe('invalid response')
    stub({ ok: false, error: '库不可读' }, 500)
    expect(await failure(fetchTestTemplates())).toMatchObject({ status: 500, message: '库不可读', hasServerDetail: true })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('<html>', { status: 502 }))
    expect((await failure(fetchTestTemplates())).status).toBe(502)
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('offline'))
    expect((await failure(fetchTestTemplates())).message).toBe('network error')
    const abort = new DOMException('aborted', 'AbortError')
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(abort)
    await expect(fetchTestTemplates()).rejects.toBe(abort)
  })
})
