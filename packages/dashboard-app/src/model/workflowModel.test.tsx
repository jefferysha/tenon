import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import {
  DEFAULT_RULES,
  rulesFromDef,
  rulesKey,
  useWorkflowRules,
  useWorkflowRulesMulti,
  invalidateWorkflowRules,
  type StepDef,
} from './workflowModel'

/** 极简自定义 workflow（demo 语境的 release-train）：draft →(approved) review →(shipped) ship */
function relDef(): { name: string; steps: StepDef[] } {
  const step = (id: string, gate: StepDef['gate'], transitions: StepDef['transitions']): StepDef => ({
    id, label: '', gate, skills: [], inputs: [], outputs: [], guards: [], transitions,
  })
  return {
    name: 'release-train',
    steps: [
      step('draft', null, [{ event: 'approved', to: 'review' }]),
      step('review', 'review', [{ event: 'shipped', to: 'ship' }]),
      step('ship', 'auto', []),
    ],
  }
}

function okJson(body: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response
}
function errJson(status: number, error: string): Response {
  return { ok: false, status, json: () => Promise.resolve({ ok: false, error }) } as unknown as Response
}

beforeEach(() => {
  invalidateWorkflowRules() // 模块级缓存跨用例清空
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('DEFAULT_RULES —— types.ts 四常量的 WorkflowRules 投影', () => {
  it('7 阶段顺序 + build 需求回退 + verify 双出口', () => {
    expect(DEFAULT_RULES.steps).toEqual(['open', 'explore', 'spec', 'build', 'verify', 'ship', 'archive'])
    expect(DEFAULT_RULES.transitions['verify']).toEqual([
      { event: 'verify-pass', to: 'ship' },
      { event: 'verify-fail', to: 'build' },
    ])
    expect(DEFAULT_RULES.transitions['build']).toEqual([
      { event: 'build-complete', to: 'verify' },
      { event: 'requirements-changed', to: 'spec' },
    ])
  })

  it('gateByStep：REVIEW_PHASES 三阶段 = review，其余 null', () => {
    expect(DEFAULT_RULES.gateByStep['explore']).toBe('review')
    expect(DEFAULT_RULES.gateByStep['spec']).toBe('review')
    expect(DEFAULT_RULES.gateByStep['verify']).toBe('review')
    expect(DEFAULT_RULES.gateByStep['open']).toBeNull()
    expect(DEFAULT_RULES.gateByStep['build']).toBeNull()
  })

  it('观察项①：DEFAULT_RULES 不带 labelByStep（default 七相走 phases.* i18n 路径，不经 label 映射）', () => {
    expect(DEFAULT_RULES.labelByStep).toBeUndefined()
  })
})

describe('rulesFromDef —— WorkflowDef → WorkflowRules 映射', () => {
  it('steps 顺序 / transitions 逐边 / gate 三态全保留', () => {
    const rules = rulesFromDef(relDef())
    expect(rules.steps).toEqual(['draft', 'review', 'ship'])
    expect(rules.transitions['draft']).toEqual([{ event: 'approved', to: 'review' }])
    expect(rules.transitions['ship']).toEqual([])
    expect(rules.gateByStep['draft']).toBeNull()
    expect(rules.gateByStep['review']).toBe('review')
    expect(rules.gateByStep['ship']).toBe('auto')
  })

  it('产出扩展面只携带不可变 outputs；按 Track 求值结果不混入 plan 规则', () => {
    const def = relDef()
    def.steps[1] = {
      ...def.steps[1]!,
      outputs: [{ field: 'release_notes', type: 'file_path' }, { field: 'changelog', type: 'string' }],
      guards: [{ type: 'nonempty-output' }],
    }
    const rules = rulesFromDef(def)
    expect(rules.outputsByStep).toEqual({ draft: [], review: ['release_notes', 'changelog'], ship: [] })
  })

  it('guard 不改变不可变 outputs 投影', () => {
    const def = relDef()
    def.steps[1] = { ...def.steps[1]!, guards: [{ type: 'tasks-at-least', n: 3 }] }
    const rules = rulesFromDef(def)
    expect(rules.outputsByStep?.['review']).toEqual([])
  })

  it('观察项①：labelByStep 覆盖全部 step；空 label 规范化为 step id', () => {
    const def = relDef()
    def.steps[0] = { ...def.steps[0]!, label: '起草' }
    def.steps[1] = { ...def.steps[1]!, label: '人工复核' }
    // steps[2] 'ship' 的 label 保持 ''（relDef 缺省）→ 该键不落，消费端回退 step id
    const rules = rulesFromDef(def)
    expect(rules.labelByStep).toEqual({ draft: '起草', review: '人工复核', ship: 'ship' })
  })
})

describe('useWorkflowRules —— default 零网络 / 自定义 fetch+缓存 / 失败进 errors', () => {
  it("names 只含 'default' → 立即返回 DEFAULT_RULES，零 fetch", async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const { result } = renderHook(() => useWorkflowRules('/repo', ['default']))
    expect(result.current.rules.get('default')).toBe(DEFAULT_RULES)
    expect(result.current.loading).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('自定义名触发一次 fetch（URL 带 root），第二次挂载命中缓存零新请求', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(okJson(relDef()))
    vi.stubGlobal('fetch', fetchSpy)
    const first = renderHook(() => useWorkflowRules('/repo', ['default', 'release-train']))
    await waitFor(() => expect(first.result.current.rules.get('release-train')).toBeDefined())
    expect(first.result.current.rules.get('release-train')!.steps).toEqual(['draft', 'review', 'ship'])
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(String(fetchSpy.mock.calls[0]![0])).toBe('/api/workflows/release-train?root=%2Frepo')

    const second = renderHook(() => useWorkflowRules('/repo', ['release-train']))
    await waitFor(() => expect(second.result.current.rules.get('release-train')).toBeDefined())
    expect(fetchSpy).toHaveBeenCalledTimes(1) // 缓存命中，无新请求
  })

  it('fetch 404 → errors 有该名字的 server 文案，rules 无 entry', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errJson(404, "workflow 'ghost' 不存在")))
    const { result } = renderHook(() => useWorkflowRules('/repo', ['ghost']))
    await waitFor(() => expect(result.current.errors.get('ghost')).toBeDefined())
    expect(result.current.errors.get('ghost')).toContain('不存在')
    expect(result.current.rules.has('ghost')).toBe(false)
    expect(result.current.loading).toBe(false)
  })

  it('invalidateWorkflowRules 后重新 fetch（编辑器保存后的失效路径）', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(okJson(relDef()))
    vi.stubGlobal('fetch', fetchSpy)
    const first = renderHook(() => useWorkflowRules('/repo', ['release-train']))
    await waitFor(() => expect(first.result.current.rules.get('release-train')).toBeDefined())
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    invalidateWorkflowRules('/repo', 'release-train')
    const second = renderHook(() => useWorkflowRules('/repo', ['release-train']))
    await waitFor(() => expect(second.result.current.rules.get('release-train')).toBeDefined())
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })
})

describe('useWorkflowRulesMulti —— (root,wf) 聚合语境：Task 11 看板聚合的消费契约（Task 8 新增，G19③ 前半）', () => {
  it("两个 root 都只要 'default' → 零 fetch，且两个键都指向同一个 DEFAULT_RULES 引用", () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const { result } = renderHook(() =>
      useWorkflowRulesMulti([
        { root: '/a', names: ['default'] },
        { root: '/b', names: ['default'] },
      ]),
    )
    expect(result.current.rules.get(rulesKey('/a', 'default'))).toBe(DEFAULT_RULES)
    expect(result.current.rules.get(rulesKey('/b', 'default'))).toBe(DEFAULT_RULES)
    expect(result.current.loading).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('两个 root 都声明同名自定义 workflow：各自独立 fetch 一次（URL 各带正确 root），互不串缓存', async () => {
    const defA = relDef() // draft: gate=null
    const defB: { name: string; steps: StepDef[] } = {
      name: 'release-train',
      steps: [
        { id: 'draft', label: '', gate: 'review', skills: [], inputs: [], outputs: [], guards: [], transitions: [] },
      ],
    }
    const fetchSpy = vi.fn(async (url: string) => {
      if (url.includes('root=%2Fa')) return okJson(defA)
      if (url.includes('root=%2Fb')) return okJson(defB)
      throw new Error(`unexpected ${url}`)
    })
    vi.stubGlobal('fetch', fetchSpy)
    const { result } = renderHook(() =>
      useWorkflowRulesMulti([
        { root: '/a', names: ['release-train'] },
        { root: '/b', names: ['release-train'] },
      ]),
    )
    await waitFor(() => expect(result.current.rules.get(rulesKey('/a', 'release-train'))).toBeDefined())
    await waitFor(() => expect(result.current.rules.get(rulesKey('/b', 'release-train'))).toBeDefined())
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    // 互不串缓存的直接证据：同名 wf 在两个 root 下解出不同的 gate 语义
    expect(result.current.rules.get(rulesKey('/a', 'release-train'))!.gateByStep['draft']).toBeNull()
    expect(result.current.rules.get(rulesKey('/b', 'release-train'))!.gateByStep['draft']).toBe('review')
  })

  it('一个 root 的自定义 wf fetch 失败 → 只有对应键进 errors，另一 root 不受牵连', async () => {
    const defB = relDef()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('root=%2Fa')) return errJson(404, "workflow 'release-train' 不存在")
        if (url.includes('root=%2Fb')) return okJson(defB)
        throw new Error(`unexpected ${url}`)
      }),
    )
    const { result } = renderHook(() =>
      useWorkflowRulesMulti([
        { root: '/a', names: ['release-train'] },
        { root: '/b', names: ['release-train'] },
      ]),
    )
    await waitFor(() => expect(result.current.errors.get(rulesKey('/a', 'release-train'))).toBeDefined())
    await waitFor(() => expect(result.current.rules.get(rulesKey('/b', 'release-train'))).toBeDefined())
    expect(result.current.errors.get(rulesKey('/a', 'release-train'))).toContain('不存在')
    expect(result.current.rules.has(rulesKey('/a', 'release-train'))).toBe(false)
    expect(result.current.errors.has(rulesKey('/b', 'release-train'))).toBe(false)
  })

  it('内部复用同一套模块级缓存/fetchRules：useWorkflowRules 先拉过的 (root,name)，useWorkflowRulesMulti 命中缓存零新请求', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(okJson(relDef()))
    vi.stubGlobal('fetch', fetchSpy)
    const single = renderHook(() => useWorkflowRules('/repo', ['release-train']))
    await waitFor(() => expect(single.result.current.rules.get('release-train')).toBeDefined())
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    const multi = renderHook(() => useWorkflowRulesMulti([{ root: '/repo', names: ['release-train'] }]))
    await waitFor(() => expect(multi.result.current.rules.get(rulesKey('/repo', 'release-train'))).toBeDefined())
    expect(fetchSpy).toHaveBeenCalledTimes(1) // 缓存命中，零新请求——证明复用同一套 fetchRules/cache，不是各自维护一份
  })
})
