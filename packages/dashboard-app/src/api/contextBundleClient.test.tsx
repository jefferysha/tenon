import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ContextBundlePreviewApiError,
  fetchContextBundlePreview,
} from './contextBundleClient'

afterEach(() => {
  vi.restoreAllMocks()
})

const input = {
  kind: 'proposal',
  path: 'openspec/changes/demo/proposal.md',
  digest: `sha256:${'a'.repeat(64)}`,
  reason: '定义目标、范围、非目标与验收信号',
  reasonCode: 'context-bundle.reason.proposal',
  mode: 'full',
  sourceBytes: 901,
  materializedBytes: 901,
} as const

function successBody() {
  return {
    ok: true,
    preview: {
      schemaVersion: 'context-bundle-preview/v1',
      sideEffects: 'none',
      change: 'demo',
      from: 'build',
      to: 'verify',
      tier: 'strong',
      documentCount: 1,
      inputs: [{ ...input }],
      budget: { maxBytes: 120000, usedBytes: 901, fits: true },
      aggregateDigest: `sha256:${'b'.repeat(64)}`,
    },
  }
}

describe('fetchContextBundlePreview', () => {
  it('显式编码 root/change/target/budgetBytes，并严格解码成功 metadata', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(successBody()), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const preview = await fetchContextBundlePreview({
      root: '/repo with space',
      change: 'demo',
      target: 'verify',
      budgetBytes: 120000,
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/context-bundle/preview?root=%2Frepo+with+space&change=demo&target=verify&budgetBytes=120000',
      expect.objectContaining({ headers: { Accept: 'application/json' } }),
    )
    expect(preview.inputs[0]).toEqual(input)
    expect(preview).not.toHaveProperty('content')
    expect(preview.inputs[0]).not.toHaveProperty('content')
  })

  it('观察模式预览的交接输入（kind handoff）带来源步骤与来源技能，照样解出', async () => {
    const handoff = {
      kind: 'handoff',
      path: 'docs/superpowers/specs/demo-design.md',
      digest: `sha256:${'c'.repeat(64)}`,
      reason: '直接上游的产出',
      reasonCode: 'context-bundle.reason.handoff',
      mode: 'full',
      sourceBytes: 120,
      materializedBytes: 120,
      fromStep: 'explore',
      skill: null,
    } as const
    const body = successBody()
    body.preview.inputs = [{ ...handoff }] as unknown as typeof body.preview.inputs
    body.preview.budget = { maxBytes: 120000, usedBytes: 120, fits: true }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })))

    const preview = await fetchContextBundlePreview({ root: '/repo', change: 'demo', target: 'verify', budgetBytes: 120000 })

    expect(preview.inputs[0]).toEqual(handoff)
  })

  it.each([
    ['handoff 缺来源步骤', { fromStep: undefined }],
    ['handoff 的来源技能不是字符串或 null', { skill: 3 }],
    ['handoff 带了契约模式的原因码', { reasonCode: 'context-bundle.reason.proposal' }],
    ['契约模式的 kind 带了交接原因码', { kind: 'proposal' }],
    ['契约模式的 kind 带了来源步骤', { kind: 'proposal', reasonCode: 'context-bundle.reason.proposal' }],
  ])('拒绝 %s 的 wire response', async (_label, patch) => {
    const body = successBody()
    body.preview.inputs = [{
      kind: 'handoff', path: 'docs/a.md', digest: `sha256:${'c'.repeat(64)}`, reason: '直接上游的产出',
      reasonCode: 'context-bundle.reason.handoff', mode: 'full', sourceBytes: 120, materializedBytes: 120,
      fromStep: 'explore', skill: 'brainstorming', ...patch,
    }] as unknown as typeof body.preview.inputs
    body.preview.budget = { maxBytes: 120000, usedBytes: 120, fits: true }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })))

    await expect(fetchContextBundlePreview({
      root: '/repo', change: 'demo', target: 'verify', budgetBytes: 120000,
    })).rejects.toMatchObject({ code: 'CONTEXT_BUNDLE_INVALID_RESPONSE' })
  })

  it('422 保留稳定 code、repairAction 与不含正文的 safe preview', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: false,
      code: 'CONTEXT_BUNDLE_BUDGET_EXCEEDED',
      error: 'required=901 available=100',
      repairAction: 'Increase budgetBytes.',
      preview: {
        ...successBody().preview,
        budget: { maxBytes: 100, usedBytes: 901, fits: false },
        aggregateDigest: undefined,
      },
    }), { status: 422 })))

    const error = await fetchContextBundlePreview({
      root: '/repo',
      change: 'demo',
      target: 'verify',
      budgetBytes: 100,
    }).catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(ContextBundlePreviewApiError)
    expect(error).toMatchObject({
      status: 422,
      code: 'CONTEXT_BUNDLE_BUDGET_EXCEEDED',
      repairAction: 'Increase budgetBytes.',
    })
    expect((error as ContextBundlePreviewApiError).preview?.budget).toEqual({
      maxBytes: 100,
      usedBytes: 901,
      fits: false,
    })
    expect((error as ContextBundlePreviewApiError).preview).not.toHaveProperty('aggregateDigest')
  })

  it('拒绝形状错误的 200，不把未知协议当成功', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, preview: { content: 'secret' } }), { status: 200 }),
    ))

    await expect(fetchContextBundlePreview({
      root: '/repo',
      change: 'demo',
      target: 'verify',
      budgetBytes: 120000,
    })).rejects.toThrow('Context Bundle 预览响应形状无效')
  })

  it.each([
    ['top-level content', (body: ReturnType<typeof successBody>) => {
      Object.assign(body, { content: '# secret' })
    }],
    ['input content', (body: ReturnType<typeof successBody>) => {
      Object.assign(body.preview.inputs[0]!, { content: '# secret' })
    }],
    ['absolute input path', (body: ReturnType<typeof successBody>) => {
      Object.assign(body.preview.inputs[0]!, { path: '/private/secret.md' })
    }],
    ['traversal input path', (body: ReturnType<typeof successBody>) => {
      Object.assign(body.preview.inputs[0]!, { path: '../secret.md' })
    }],
    ['unknown kind', (body: ReturnType<typeof successBody>) => {
      Object.assign(body.preview.inputs[0]!, { kind: 'unknown' })
    }],
    ['oversized reason', (body: ReturnType<typeof successBody>) => {
      Object.assign(body.preview.inputs[0]!, { reason: 'x'.repeat(257) })
    }],
    ['UI-coupled reason code', (body: ReturnType<typeof successBody>) => {
      Object.assign(body.preview.inputs[0]!, { reasonCode: 'progress.bundle_reason_proposal' })
    }],
    ['invalid digest', (body: ReturnType<typeof successBody>) => {
      body.preview.inputs[0]!.digest = 'sha256:not-a-digest'
    }],
    ['inconsistent budget', (body: ReturnType<typeof successBody>) => {
      body.preview.budget = { maxBytes: 100, usedBytes: 901, fits: true }
    }],
  ])('拒绝 %s 的 wire response', async (_label, mutate) => {
    const body = successBody()
    mutate(body)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), { status: 200 }),
    ))

    await expect(fetchContextBundlePreview({
      root: '/repo',
      change: 'demo',
      target: 'verify',
      budgetBytes: 120000,
    })).rejects.toMatchObject({ code: 'CONTEXT_BUNDLE_INVALID_RESPONSE' })
  })

  it.each([
    ['change', (body: ReturnType<typeof successBody>) => {
      Object.assign(body.preview, { change: 'another-change' })
    }],
    ['target', (body: ReturnType<typeof successBody>) => {
      Object.assign(body.preview, { to: 'ship' })
    }],
    ['budget', (body: ReturnType<typeof successBody>) => {
      body.preview.budget = { maxBytes: 120001, usedBytes: 901, fits: true }
    }],
  ])('拒绝回显未绑定当前请求的 %s', async (_label, mutate) => {
    const body = successBody()
    mutate(body)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), { status: 200 }),
    ))

    await expect(fetchContextBundlePreview({
      root: '/repo',
      change: 'demo',
      target: 'verify',
      budgetBytes: 120000,
    })).rejects.toMatchObject({ code: 'CONTEXT_BUNDLE_INVALID_RESPONSE' })
  })

  it('保留 registered-root guard 的既有无 code 错误信封', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: 'root 未注册或信任锚已变化' }), { status: 403 }),
    ))

    const error = await fetchContextBundlePreview({
      root: '/repo',
      change: 'demo',
      target: 'verify',
      budgetBytes: 120000,
    }).catch((reason: unknown) => reason)

    expect(error).toMatchObject({
      code: 'CONTEXT_BUNDLE_REQUEST_FAILED',
      message: 'root 未注册或信任锚已变化',
      status: 403,
    })
  })

  it.each([
    [409, 'CONTEXT_BUNDLE_BUDGET_EXCEEDED', true],
    [500, 'CONTEXT_BUNDLE_BUDGET_EXCEEDED', true],
    [422, 'CONTEXT_BUNDLE_BUDGET_EXCEEDED', false],
    [422, 'CONTEXT_BUNDLE_DOCUMENT_STALE', false],
    [409, 'CONTEXT_BUNDLE_DOCUMENT_STALE', true],
  ])('拒绝 status=%s code=%s preview=%s 的非法组合', async (status, code, withPreview) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: false,
      code,
      error: 'mismatched contract',
      ...(withPreview
        ? {
            preview: {
              ...successBody().preview,
              inputs: [{
                ...successBody().preview.inputs[0]!,
                materializedBytes: 120001,
              }],
              budget: { maxBytes: 120000, usedBytes: 120001, fits: false },
              aggregateDigest: undefined,
            },
          }
        : {}),
    }), { status })))

    await expect(fetchContextBundlePreview({
      root: '/repo',
      change: 'demo',
      target: 'verify',
      budgetBytes: 120000,
    })).rejects.toMatchObject({ code: 'CONTEXT_BUNDLE_INVALID_RESPONSE' })
  })

  it('把 AbortSignal 传给 fetch，供组件取消在途请求', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(successBody()), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()

    await fetchContextBundlePreview({
      root: '/repo',
      change: 'demo',
      target: 'verify',
      budgetBytes: 120000,
      signal: controller.signal,
    })

    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).signal).toBe(controller.signal)
  })
})
