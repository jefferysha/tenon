import { describe, expect, test } from 'vitest'
import { BUILTIN_TRACK_DEFINITIONS, QuoteGateError } from '@tenon/kernel'
import type { FieldName, PipelineState, TrackDefinition, TrackRegistry } from '@tenon/kernel'
import { cmdCas, cmdGet, cmdSet, cmdSetMany } from './fields.js'
import { FIXED_CLOCK, makeDeps, mockLegacyDefaultState, mockState, spy } from '../test-support.js'

/**
 * 旁路测试用的自定义轨 registry（R2）：makeDeps 缺省 loadRegistry 只有内建 Track（allowed='*'
 * 恒放行，无法证明「最终组合校验」真的拦得住旁路）。这里直接构造一条 allowed 受限的额外 track，
 * 经 deps.loadRegistry 覆写注入——registry 的消费方（requireTrack/assertWorkflowAllowed）只读
 * ordered/byId/workflow.allowed，与「从 tracks.yaml load 出来的 project-file registry」同构。
 */
function customTrack(id: string, allowed: '*' | readonly string[], defaultWorkflow = 'default'): TrackDefinition {
  return {
    id,
    label: id,
    builtin: false,
    workflow: { default: defaultWorkflow, allowed },
    policyProfile: {
      reviewSeed: 'pending',
      automationEligible: true,
      coverageProfile: 'none',
      routing: { enabled: false },
      skills: { matrix: false, profile: '_all' },
    },
  }
}

function registryWith(extra: TrackDefinition): TrackRegistry {
  const ordered = [...BUILTIN_TRACK_DEFINITIONS, extra]
  return {
    ordered,
    byId: new Map(ordered.map((t) => [t.id, t])),
    revision: 'test-rev',
    source: 'project-file',
  }
}

describe('get —— stdout 裸值 / exit 契约（CONTRACT §3）', () => {
  test('输出裸值一行、无尾空格，exit 0', async () => {
    const deps = makeDeps({ state: mockState({ phase: 'build' }) })
    const code = await cmdGet(deps, 'demo', 'phase')
    expect(code).toBe(0)
    expect(deps.outLines).toEqual(['build'])
    expect(deps.errLines).toEqual([])
  })

  test('change 定位在 <cwd>/openspec/changes/<name>（经 store.read）', async () => {
    const deps = makeDeps({ state: mockState({ phase: 'open' }) })
    await cmdGet(deps, 'demo', 'phase')
    expect(deps.store.read.calls[0]?.[0]).toBe('/repo/openspec/changes/demo')
  })

  test('列表字段输出逗号连接', async () => {
    const deps = makeDeps({ state: mockState({ depends_on: ['a', 'b'] }) })
    const code = await cmdGet(deps, 'demo', 'depends_on')
    expect(code).toBe(0)
    expect(deps.outLines).toEqual(['a,b'])
  })

  test('空串值输出空行，exit 0', async () => {
    const deps = makeDeps({ state: mockState() })
    const code = await cmdGet(deps, 'demo', 'plan')
    expect(code).toBe(0)
    expect(deps.outLines).toEqual([''])
  })

  test('未知字段：空行 + exit 0（老内核 yaml_get grep 语义，oracle 实测回写）', async () => {
    const deps = makeDeps()
    const code = await cmdGet(deps, 'demo', 'nope')
    expect(code).toBe(0)
    expect(deps.outLines).toEqual([''])
  })

  test('字段缺失（state 无该键）：空行 + exit 0', async () => {
    const st = mockState()
    delete (st.fields as Partial<Record<FieldName, string | string[]>>).plan
    const deps = makeDeps({ state: st })
    const code = await cmdGet(deps, 'demo', 'plan')
    expect(code).toBe(0)
    expect(deps.outLines).toEqual([''])
  })

  test('状态文件缺失（read 抛错）exit 1', async () => {
    const deps = makeDeps()
    deps.store.read = spy(async (_d: string): Promise<PipelineState> => {
      throw new Error('ENOENT')
    })
    const code = await cmdGet(deps, 'demo', 'phase')
    expect(code).toBe(1)
  })

  test('非法 change 名 exit 1', async () => {
    const deps = makeDeps()
    const code = await cmdGet(deps, 'bad/../name', 'phase')
    expect(code).toBe(1)
    expect(deps.store.get.calls).toHaveLength(0)
  })
})

describe('set —— 无输出 / 四闸拒写 exit 1', () => {
  test.each([
    ['无 receipt', mockState({ phase: 'explore' })],
    ['pending receipt', mockState({
      phase: 'explore',
      review_gate_phase: 'explore',
      review_gate_status: 'pending',
      review_gate_event: 'explore-complete',
    })],
  ])('phase 只能由 transition 修改（$0）', async (_label, state) => {
    const deps = makeDeps({ state })
    expect(await cmdSet(deps, 'demo', 'phase', 'build')).toBe(1)
    expect(deps.store.write.calls).toHaveLength(0)
    expect(deps.errLines.join('\\n')).toContain('phase')
  })

  test('成功：无 stdout，exit 0，值透传（P6 锁内 write，plan 在空 phase 非 artifact → 放行）', async () => {
    const deps = makeDeps()
    const code = await cmdSet(deps, 'demo', 'plan', 'docs/plans/p.md')
    expect(code).toBe(0)
    expect(deps.outLines).toEqual([])
    // P6：非 track/workflow 也锁内 read→write（不走 store.set，堵 TOCTOU + artifact 判定同锁）
    expect(deps.store.set.calls).toHaveLength(0)
    expect(deps.store.write.calls[0]?.[1].fields.plan).toBe('docs/plans/p.md')
  })

  test('列表字段按逗号拆成数组', async () => {
    const deps = makeDeps()
    const code = await cmdSet(deps, 'demo', 'scope', 'a, b')
    expect(code).toBe(0)
    expect(deps.store.write.calls[0]?.[1].fields.scope).toEqual(['a', 'b'])
  })

  test('列表字段空串 → 空数组（清空）', async () => {
    const deps = makeDeps()
    await cmdSet(deps, 'demo', 'depends_on', '')
    expect(deps.store.write.calls[0]?.[1].fields.depends_on).toEqual([])
  })

  test('四闸拒写（QuoteGateError）exit 1，stderr 有原因（P6：四闸在锁内 store.write→serialize 触发）', async () => {
    const deps = makeDeps()
    deps.store.write = spy(async (_d: string, _s: PipelineState): Promise<void> => {
      throw new QuoteGateError('plan', '值含「: 」')
    })
    const code = await cmdSet(deps, 'demo', 'plan', 'x: y')
    expect(code).toBe(1)
    expect(deps.outLines).toEqual([])
    expect(deps.errLines.join('\n')).toContain('quote gate')
  })

  test('未知字段 exit 1，set 不被调用', async () => {
    const deps = makeDeps()
    const code = await cmdSet(deps, 'demo', 'nope', 'v')
    expect(code).toBe(1)
    expect(deps.store.set.calls).toHaveLength(0)
  })
})

describe('set-many —— k=v 批量原子写', () => {
  test('包含 phase 的批量写入始终拒绝，不能借 set-many 绕过 transition', async () => {
    const deps = makeDeps({ state: mockState({
      phase: 'explore',
      review_gate_phase: 'explore',
      review_gate_status: 'pending',
      review_gate_event: 'explore-complete',
    }) })
    expect(await cmdSetMany(deps, 'demo', ['phase=build', 'plan=p.md'])).toBe(1)
    expect(deps.store.write.calls).toHaveLength(0)
    expect(deps.errLines.join('\\n')).toContain('phase')
  })

  test('成功：解析 k=v 并锁内 write，无 stdout，exit 0（P6：非 track/workflow 不走 store.setMany）', async () => {
    const deps = makeDeps()
    const code = await cmdSetMany(deps, 'demo', ['build_mode=direct', 'isolation=branch'])
    expect(code).toBe(0)
    expect(deps.outLines).toEqual([])
    expect(deps.store.setMany.calls).toHaveLength(0)
    const w = deps.store.write.calls[0]?.[1].fields
    expect(w?.build_mode).toBe('direct')
    expect(w?.isolation).toBe('branch')
  })

  test('direct 模式可显式声明 in-place：不伪称创建了 branch 或 worktree', async () => {
    const deps = makeDeps()
    const code = await cmdSetMany(deps, 'demo', ['build_mode=direct', 'isolation=in-place'])
    expect(code).toBe(0)
    const w = deps.store.write.calls[0]?.[1].fields
    expect(w?.build_mode).toBe('direct')
    expect(w?.isolation).toBe('in-place')
  })

  test('值可含 =（只在第一个 = 处切分）', async () => {
    const deps = makeDeps()
    await cmdSetMany(deps, 'demo', ['pr_url=https://x/pr?a=b'])
    expect(deps.store.write.calls[0]?.[1].fields.pr_url).toBe('https://x/pr?a=b')
  })

  test('列表字段值按逗号拆数组', async () => {
    const deps = makeDeps()
    await cmdSetMany(deps, 'demo', ['depends_on=a,b'])
    expect(deps.store.write.calls[0]?.[1].fields.depends_on).toEqual(['a', 'b'])
  })

  test('缺 = 的 kv exit 1，setMany 不被调用', async () => {
    const deps = makeDeps()
    const code = await cmdSetMany(deps, 'demo', ['noequals'])
    expect(code).toBe(1)
    expect(deps.store.setMany.calls).toHaveLength(0)
  })

  test('重复字段 exit 1，setMany 不被调用（不静默 last-wins）', async () => {
    const deps = makeDeps()
    const code = await cmdSetMany(deps, 'demo', ['build_mode=direct', 'build_mode=prototype'])
    expect(code).toBe(1)
    expect(deps.store.setMany.calls).toHaveLength(0)
    expect(deps.errLines.join('\n')).toContain('重复字段')
  })

  test('未知字段 exit 1，setMany 不被调用', async () => {
    const deps = makeDeps()
    const code = await cmdSetMany(deps, 'demo', ['nope=1'])
    expect(code).toBe(1)
    expect(deps.store.setMany.calls).toHaveLength(0)
  })

  test('四闸拒写 exit 1（P6：四闸在锁内 store.write→serialize 触发）', async () => {
    const deps = makeDeps()
    deps.store.write = spy(async (_d: string, _s: PipelineState): Promise<void> => {
      throw new QuoteGateError('plan', '值含「 #」')
    })
    const code = await cmdSetMany(deps, 'demo', ['plan=x #y'])
    expect(code).toBe(1)
  })
})

describe('history 记账 —— set/set-many/cas 成功后 best-effort 记 JSONL（BACKLOG #7）', () => {
  test('set 成功记一条 kind=set（field/to），失败路径不记', async () => {
    const deps = makeDeps()
    await cmdSet(deps, 'demo', 'plan', 'docs/plans/p.md')
    expect(deps.historyEntries).toEqual([
      ['/repo/openspec/changes/demo', { ts: FIXED_CLOCK, kind: 'set', field: 'plan', to: 'docs/plans/p.md' }],
    ])
    const deps2 = makeDeps()
    await cmdSet(deps2, 'demo', 'nope', 'v')
    expect(deps2.historyEntries).toEqual([])
  })

  test('set-many 每字段各记一条', async () => {
    const deps = makeDeps()
    await cmdSetMany(deps, 'demo', ['build_mode=direct', 'isolation=branch'])
    expect(deps.historyEntries.map(([, e]) => e)).toEqual([
      { ts: FIXED_CLOCK, kind: 'set', field: 'build_mode', to: 'direct' },
      { ts: FIXED_CLOCK, kind: 'set', field: 'isolation', to: 'branch' },
    ])
  })

  test('cas 成功记 from/to；不匹配（exit 3）不记', async () => {
    // P6：cas 锁内比对真 state（不再是恒 true 的 mockStore.cas）——expect 命中需 state 值相等
    const deps = makeDeps({ state: mockState({ automation: 'queued' }) })
    await cmdCas(deps, 'demo', 'automation', 'queued', 'scheduled')
    expect(deps.historyEntries).toEqual([
      [
        '/repo/openspec/changes/demo',
        { ts: FIXED_CLOCK, kind: 'set', field: 'automation', from: 'queued', to: 'scheduled' },
      ],
    ])
    // 真 state automation='' ≠ expect 'queued' → exit 3、不记 history
    const deps2 = makeDeps()
    await cmdCas(deps2, 'demo', 'automation', 'queued', 'scheduled')
    expect(deps2.historyEntries).toEqual([])
  })

  test('history 写失败仅 WARN，exit 仍 0', async () => {
    const deps = makeDeps()
    deps.history = {
      append: async () => {
        throw new Error('EACCES')
      },
    }
    const code = await cmdSet(deps, 'demo', 'plan', 'x')
    expect(code).toBe(0)
    expect(deps.errLines.join('\n')).toContain('WARN')
  })
})

describe('cas —— 0 成功 / 3 不匹配 / 1 错误', () => {
  test('phase 只能由 transition 修改，cas 命中也拒绝', async () => {
    const deps = makeDeps({ state: mockState({
      phase: 'explore',
      review_gate_phase: 'explore',
      review_gate_status: 'pending',
      review_gate_event: 'explore-complete',
    }) })
    expect(await cmdCas(deps, 'demo', 'phase', 'explore', 'build')).toBe(1)
    expect(deps.store.write.calls).toHaveLength(0)
    expect(deps.errLines.join('\\n')).toContain('phase')
  })

  test('匹配写入：无输出，exit 0（P6：锁内比对+write，不走 store.cas）', async () => {
    const deps = makeDeps({ state: mockState({ automation: 'queued' }) })
    const code = await cmdCas(deps, 'demo', 'automation', 'queued', 'scheduled')
    expect(code).toBe(0)
    expect(deps.outLines).toEqual([])
    expect(deps.store.cas.calls).toHaveLength(0)
    expect(deps.store.write.calls[0]?.[1].fields.automation).toBe('scheduled')
  })

  test('不匹配：exit 3，无 stdout（真 state ≠ expect）', async () => {
    const deps = makeDeps() // automation='' ≠ 'queued'
    const code = await cmdCas(deps, 'demo', 'automation', 'queued', 'scheduled')
    expect(code).toBe(3)
    expect(deps.outLines).toEqual([])
    expect(deps.store.write.calls).toHaveLength(0)
  })

  test('store 错误：exit 1（P6：锁内 read 抛）', async () => {
    const deps = makeDeps({ state: mockState({ automation: 'queued' }) })
    deps.store.read = spy(async (_d: string): Promise<PipelineState> => {
      throw new Error('锁超时')
    })
    const code = await cmdCas(deps, 'demo', 'automation', 'queued', 'scheduled')
    expect(code).toBe(1)
  })

  test('未知字段 exit 1', async () => {
    const deps = makeDeps()
    const code = await cmdCas(deps, 'demo', 'nope', 'a', 'b')
    expect(code).toBe(1)
    expect(deps.store.cas.calls).toHaveLength(0)
  })
})

/**
 * track/workflow —— 动态 Track Registry 驱动校验（GOAL.md 清单 T · R2）。
 * makeDeps 的 loadRegistry 缺 tracks.yaml → 内建 Track builtin-only（allowed='*' 恒放行）。
 * R2 关 TOCTOU：track/workflow 四写入口都在 store.withLock 内 read→校验最终组合→store.write，
 * 不再走 store.set/setMany/cas（那三者各自 withLock、无法与校验同锁）。故这些用例断言「锁内落盘
 * 的最终 state」（store.write），而非旧的 store.set/cas/setMany 旁路调用。
 */
describe('set/cas/set-many track & workflow —— registry 驱动校验（R2；builtin-only 零回归）', () => {
  test('set track 合法内建轨：锁内落盘 track=frontend（不走 store.set）', async () => {
    const deps = makeDeps({ state: mockState({ track: 'chat', workflow: 'default' }) })
    const code = await cmdSet(deps, 'demo', 'track', 'frontend')
    expect(code).toBe(0)
    expect(deps.store.set.calls).toHaveLength(0)
    expect(deps.store.withLock.calls).toHaveLength(1)
    expect(deps.store.write.calls[0]?.[1].fields.track).toBe('frontend')
  })

  test('set track 未注册值：exit 1，不落盘，stderr 报未注册', async () => {
    const deps = makeDeps({ state: mockState({ track: 'chat' }) })
    const code = await cmdSet(deps, 'demo', 'track', 'devops')
    expect(code).toBe(1)
    expect(deps.store.write.calls).toHaveLength(0)
    expect(deps.store.set.calls).toHaveLength(0)
    expect(deps.errLines.join('\n')).toContain("未注册的 track 'devops'")
  })

  test('cas track 合法内建轨：expect 命中 → 锁内落盘 track=backend（不走 store.cas）', async () => {
    const deps = makeDeps({ state: mockState({ track: 'chat', workflow: 'default' }) })
    expect(await cmdCas(deps, 'demo', 'track', 'chat', 'backend')).toBe(0)
    expect(deps.store.cas.calls).toHaveLength(0)
    expect(deps.store.write.calls[0]?.[1].fields.track).toBe('backend')
  })

  test('cas track expect 不命中：exit 3，不落盘', async () => {
    const deps = makeDeps({ state: mockState({ track: 'chat' }) })
    expect(await cmdCas(deps, 'demo', 'track', 'frontend', 'backend')).toBe(3)
    expect(deps.store.write.calls).toHaveLength(0)
  })

  test('cas track 未注册新值：exit 1，不落盘（不留旁路）', async () => {
    const deps = makeDeps({ state: mockState({ track: 'chat' }) })
    expect(await cmdCas(deps, 'demo', 'track', 'chat', 'devops')).toBe(1)
    expect(deps.store.cas.calls).toHaveLength(0)
    expect(deps.store.write.calls).toHaveLength(0)
  })

  test('set workflow：内建轨 allowed=* 恒放行（读旧 track 后校验最终组合），锁内落盘', async () => {
    const deps = makeDeps({ state: mockState({ track: 'backend', workflow: 'default' }) })
    const code = await cmdSet(deps, 'demo', 'workflow', 'anything')
    expect(code).toBe(0)
    expect(deps.store.set.calls).toHaveLength(0)
    expect(deps.store.write.calls[0]?.[1].fields.workflow).toBe('anything')
  })

  test('set-many track+workflow：按最终组合校验（内建轨放行），锁内一次落盘两字段', async () => {
    const deps = makeDeps({ state: mockState({ track: 'chat', workflow: 'default' }) })
    const code = await cmdSetMany(deps, 'demo', ['track=frontend', 'workflow=default'])
    expect(code).toBe(0)
    expect(deps.store.setMany.calls).toHaveLength(0)
    const written = deps.store.write.calls[0]?.[1].fields
    expect(written?.track).toBe('frontend')
    expect(written?.workflow).toBe('default')
  })

  test('set-many track=<未注册>：exit 1，不落盘', async () => {
    const deps = makeDeps({ state: mockState({ track: 'chat' }) })
    const code = await cmdSetMany(deps, 'demo', ['track=devops'])
    expect(code).toBe(1)
    expect(deps.store.setMany.calls).toHaveLength(0)
    expect(deps.store.write.calls).toHaveLength(0)
  })

  test('set-many 不触及 track/workflow：P6 只取 change 锁（read→write），不进 registry 锁、不走 store.setMany', async () => {
    const deps = makeDeps()
    let registryLocked = false
    const origRL = deps.withRegistryLock
    deps.withRegistryLock = async (cb) => {
      registryLocked = true
      return origRL(cb)
    }
    const code = await cmdSetMany(deps, 'demo', ['build_mode=direct', 'isolation=branch'])
    expect(code).toBe(0)
    // 非 track/workflow：不触发 registry→change 锁序（runComboWrite），只在 change 锁内 read→write
    expect(registryLocked).toBe(false)
    expect(deps.store.withLock.calls).toHaveLength(1)
    expect(deps.store.setMany.calls).toHaveLength(0)
    expect(deps.store.write.calls[0]?.[1].fields.build_mode).toBe('direct')
  })
})

/**
 * 旁路关闭证明（codex R2 阻断）：自定义轨 data 的 allowed=['default']（不含 'other'）。
 * 现状（旧代码）能绕——set track 只 requireTrack（不看旧 workflow）、cas track 同样、cas workflow
 * 完全无 registry 校验，命中即写。修复后：四写入口都按最终 {track,workflow} 组合校验，命中即拒、
 * 且绝不落盘（store.write 零调用）。对照内建轨 allowed='*' 的放行由上一 describe 锚定（零回归）。
 */
describe('track/workflow 旁路关闭 —— 最终组合校验（R2；自定义轨 allowed 受限）', () => {
  test('set track：新轨 data 已注册，但 data.allowed=[other] 不含旧 workflow=other2 → 拒、不落盘', async () => {
    const deps = makeDeps({ state: mockState({ track: 'chat', workflow: 'other2' }) })
    deps.loadRegistry = () => registryWith(customTrack('data', ['other'], 'other'))
    const code = await cmdSet(deps, 'demo', 'track', 'data')
    expect(code).toBe(1); expect(deps.store.write.calls).toHaveLength(0)
    expect(deps.errLines.join('\n')).toContain("不允许绑定 workflow 'other2'")
  })
  test('set track：切到 data 且旧 workflow=other（在 allowed 内）→ 放行、落盘 track=data', async () => {
    const deps = makeDeps({ state: mockState({ track: 'chat', workflow: 'other' }) })
    deps.loadRegistry = () => registryWith(customTrack('data', ['other'], 'other'))
    expect(await cmdSet(deps, 'demo', 'track', 'data')).toBe(0)
    expect(deps.store.write.calls[0]?.[1].fields.track).toBe('data')
  })
  test('cas track：expect 命中新值 data，但最终组合 data+other2 非法 → 拒、不落盘', async () => {
    const deps = makeDeps({ state: mockState({ track: 'chat', workflow: 'other2' }) })
    deps.loadRegistry = () => registryWith(customTrack('data', ['other'], 'other'))
    expect(await cmdCas(deps, 'demo', 'track', 'chat', 'data')).toBe(1)
    expect(deps.store.write.calls).toHaveLength(0)
    expect(deps.errLines.join('\n')).toContain("不允许绑定 workflow 'other2'")
  })
  test('cas workflow：把 workflow 换成旧 track=data 的 allowed 外值 other2 → 拒、不落盘', async () => {
    const deps = makeDeps({ state: mockState({ track: 'data', workflow: 'other' }) })
    deps.loadRegistry = () => registryWith(customTrack('data', ['other'], 'other'))
    expect(await cmdCas(deps, 'demo', 'workflow', 'other', 'other2')).toBe(1)
    expect(deps.store.write.calls).toHaveLength(0)
    expect(deps.errLines.join('\n')).toContain("不允许绑定 workflow 'other2'")
  })
  test('cas workflow：expect 不命中→ exit 3', async () => {
    const deps = makeDeps({ state: mockState({ track: 'data', workflow: 'other' }) })
    deps.loadRegistry = () => registryWith(customTrack('data', ['other', 'other2'], 'other'))
    expect(await cmdCas(deps, 'demo', 'workflow', 'stale', 'other2')).toBe(3)
  })
  test('cas workflow：allowed 内值放行', async () => {
    const deps = makeDeps({ state: mockState({ track: 'data', workflow: 'other' }) })
    deps.loadRegistry = () => registryWith(customTrack('data', ['other', 'other2'], 'other'))
    expect(await cmdCas(deps, 'demo', 'workflow', 'other', 'other2')).toBe(0)
    expect(deps.store.write.calls[0]?.[1].fields.workflow).toBe('other2')
  })
  test('set workflow：旧 track=data、新 workflow=other2 不在 data.allowed → 拒、不落盘', async () => {
    const deps = makeDeps({ state: mockState({ track: 'data', workflow: 'other' }) })
    deps.loadRegistry = () => registryWith(customTrack('data', ['other'], 'other'))
    expect(await cmdSet(deps, 'demo', 'workflow', 'other2')).toBe(1)
    expect(deps.store.write.calls).toHaveLength(0)
    expect(deps.errLines.join('\n')).toContain("不允许绑定 workflow 'other2'")
  })
  test('set-many：track=data + workflow=other2 最终组合非法', async () => {
    const deps = makeDeps({ state: mockState({ track: 'chat', workflow: 'other' }) })
    deps.loadRegistry = () => registryWith(customTrack('data', ['other'], 'other'))
    expect(await cmdSetMany(deps, 'demo', ['track=data', 'workflow=other2'])).toBe(1)
    expect(deps.store.write.calls).toHaveLength(0)
  })
  test('set-many：旧 workflow=other2 单独切 track=data，本非法但同批补 workflow=other 合法', async () => {
    const deps = makeDeps({ state: mockState({ track: 'chat', workflow: 'other2' }) })
    deps.loadRegistry = () => registryWith(customTrack('data', ['other'], 'other'))
    expect(await cmdSetMany(deps, 'demo', ['track=data', 'workflow=other'])).toBe(0)
    const written = deps.store.write.calls[0]?.[1].fields
    expect(written?.track).toBe('data'); expect(written?.workflow).toBe('other')
  })
})

/**
 * TOCTOU 关闭锚点（codex R2 点名）：track/workflow 的「组合校验 + 条件写入」必须在同一把 store 锁
 * 内完成，杜绝「锁外校验、锁内写」之间被并发改另一半、落盘瞬间组合已非法的旁路。这里包裹 withLock/
 * read/write 记录相对时序，钉死 read（校验的输入）与 write 都夹在 lock:enter…lock:exit 之间——
 * 一旦有人把 read/校验移出锁（重新引入 TOCTOU 窗口），本用例当场红。
 */
describe('track/workflow 写入 —— 校验与落盘同锁（R2 · TOCTOU 锚点）', () => {
  test('set track：read→write 都在 store.withLock 区间内（同锁，非锁外读+锁内写）', async () => {
    const deps = makeDeps({ state: mockState({ track: 'chat', workflow: 'default' }) })
    const order: string[] = []
    const origWithLock = deps.store.withLock
    const origRead = deps.store.read
    const origWrite = deps.store.write
    deps.store.withLock = spy(async (dir: string, fn: () => Promise<unknown>): Promise<unknown> => {
      order.push('lock:enter')
      const r = await origWithLock(dir, fn)
      order.push('lock:exit')
      return r
    })
    deps.store.read = spy(async (dir: string): Promise<PipelineState> => {
      order.push('read')
      return origRead(dir)
    })
    deps.store.write = spy(async (dir: string, st: PipelineState): Promise<void> => {
      order.push('write')
      await origWrite(dir, st)
    })
    expect(await cmdSet(deps, 'demo', 'track', 'frontend')).toBe(0)
    expect(order).toEqual(['lock:enter', 'read', 'write', 'lock:exit'])
  })
})

/**
 * P6 —— set/set-many/cas 对「当前有效 artifact 字段」cutover：旧写入口拒、改走 tenon artifact
 * register（default 轨判定源 defaultArtifactsForStep，与 register 同口径 effectiveArtifactFields）。
 * custom 轨拒写 + fail-loud 在 artifact.integration.test.ts 端到端覆盖。
 */
describe('P6 —— set/set-many/cas 对当前有效 artifact 字段 cutover', () => {
  test('set design_doc（explore/frontend）→ 拒 exit 1，零落盘、零 history，stderr 指引 register', async () => {
    const deps = makeDeps({ state: mockState({ phase: 'explore', track: 'frontend' }) })
    expect(await cmdSet(deps, 'demo', 'design_doc', 'd.md')).toBe(1)
    expect(deps.store.write.calls).toHaveLength(0)
    expect(deps.historyEntries).toEqual([])
    expect(deps.errLines.join('\n')).toContain('artifact register')
  })

  test('set plan（spec/frontend）→ 拒 exit 1，零落盘', async () => {
    const deps = makeDeps({ state: mockState({ phase: 'spec', track: 'frontend' }) })
    expect(await cmdSet(deps, 'demo', 'plan', 'p.md')).toBe(1)
    expect(deps.store.write.calls).toHaveLength(0)
  })

  test('set verification_report（verify/frontend）→ 拒 exit 1', async () => {
    const deps = makeDeps({ state: mockState({ phase: 'verify', track: 'frontend' }) })
    expect(await cmdSet(deps, 'demo', 'verification_report', 'r.md')).toBe(1)
    expect(deps.store.write.calls).toHaveLength(0)
  })

  test('放行：plan（spec/pm 被 required_when 排除，不是当前有效 artifact）', async () => {
    const deps = makeDeps({ state: mockLegacyDefaultState({ phase: 'spec', track: 'pm' }) })
    expect(await cmdSet(deps, 'demo', 'plan', 'p.md')).toBe(0)
    expect(deps.store.write.calls).toHaveLength(1)
    expect(deps.store.write.calls[0]?.[1].fields.plan).toBe('p.md')
  })

  test('放行：design_doc（build 步，字段名曾在 explore 声明但当前步非 artifact）→ exit 0 落盘', async () => {
    const deps = makeDeps({ state: mockState({ phase: 'build', track: 'frontend' }) })
    expect(await cmdSet(deps, 'demo', 'design_doc', 'd.md')).toBe(0)
    expect(deps.store.write.calls[0]?.[1].fields.design_doc).toBe('d.md')
  })

  test('set-many 混合普通+artifact（explore：build_mode+design_doc）→ 整批拒、零落盘、零 history', async () => {
    const deps = makeDeps({ state: mockState({ phase: 'explore', track: 'frontend' }) })
    expect(await cmdSetMany(deps, 'demo', ['build_mode=direct', 'design_doc=d.md'])).toBe(1)
    expect(deps.store.write.calls).toHaveLength(0)
    expect(deps.historyEntries).toEqual([])
  })

  test('set-many 切出（phase=build 同批 plan=x，欲离开 spec 后改 plan）→ 当前 spec 上下文命中 → 拒', async () => {
    const deps = makeDeps({ state: mockState({ phase: 'spec', track: 'frontend' }) })
    expect(await cmdSetMany(deps, 'demo', ['phase=build', 'plan=p.md'])).toBe(1)
    expect(deps.store.write.calls).toHaveLength(0)
  })

  test('set-many 切入（phase=spec 同批 plan=x，欲进入 spec 注入 plan）→ patch 后上下文命中 → 拒', async () => {
    const deps = makeDeps({ state: mockState({ phase: 'open', track: 'frontend' }) })
    expect(await cmdSetMany(deps, 'demo', ['phase=spec', 'plan=p.md'])).toBe(1)
    expect(deps.store.write.calls).toHaveLength(0)
  })

  test('cas design_doc（explore）expect 命中 → 仍拒 exit 1（artifact 优先，零落盘）', async () => {
    const deps = makeDeps({ state: mockState({ phase: 'explore', track: 'frontend', design_doc: 'old.md' }) })
    expect(await cmdCas(deps, 'demo', 'design_doc', 'old.md', 'new.md')).toBe(1)
    expect(deps.store.write.calls).toHaveLength(0)
    expect(deps.errLines.join('\n')).toContain('artifact register')
  })

  test('cas design_doc（explore）expect 不命中 → 仍拒 exit 1（artifact 拒优先于 CAS miss 3）', async () => {
    const deps = makeDeps({ state: mockState({ phase: 'explore', track: 'frontend', design_doc: 'old.md' }) })
    expect(await cmdCas(deps, 'demo', 'design_doc', 'WRONG', 'new.md')).toBe(1)
    expect(deps.store.write.calls).toHaveLength(0)
  })

  test('放行：automation cas（非 artifact）expect 命中 → exit 0 落盘', async () => {
    const deps = makeDeps({ state: mockState({ phase: 'explore', track: 'frontend', automation: 'queued' }) })
    expect(await cmdCas(deps, 'demo', 'automation', 'queued', 'scheduled')).toBe(0)
    expect(deps.store.write.calls[0]?.[1].fields.automation).toBe('scheduled')
  })
})
