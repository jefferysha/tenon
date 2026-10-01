import { describe, expect, it } from 'vitest'
import { BUILTIN_TRACK_DEFINITIONS, type TrackDefinition } from '@tenon/kernel'
import { applyRouterDraft, previewTrackRouting, scoreRouterPatternWithGrep } from './routerPreview.js'

function track(input: {
  id: string
  pattern?: string
  priority?: number
  enabled?: boolean
  builtin?: boolean
  excludePattern?: string
}): TrackDefinition {
  return {
    id: input.id,
    label: input.id,
    builtin: input.builtin ?? false,
    workflow: { default: 'default', allowed: '*' },
    policyProfile: {
      reviewSeed: 'pending',
      automationEligible: true,
      coverageProfile: 'backend',
      routing: input.enabled === false
        ? { enabled: false }
        : {
            enabled: true,
            pattern: input.pattern ?? input.id,
            ...(input.excludePattern === undefined ? {} : { excludePattern: input.excludePattern }),
            priority: input.priority ?? 0,
          },
      skills: { matrix: true, profile: input.id },
    },
  }
}

describe('Router preview —— 与 hooks/router.sh 的 grep/tie-break 真语义一致', () => {
  it('生产 scorer 真执行 grep -ciE：忽略大小写，按命中行数而非 occurrence 计分', async () => {
    await expect(scoreRouterPatternWithGrep('fix|bug', 'FIX bug bug\nnope\nfix')).resolves.toBe(2)
  })

  it('非法 ERE fail-loud，不把 grep exit=2 伪装成零分', async () => {
    await expect(scoreRouterPatternWithGrep('[', 'anything')).rejects.toThrow(/grep.*exit 2/i)
  })

  it('先比 score，再比 priority，最终并列保持 registry order', async () => {
    const rows = [
      track({ id: 'first', pattern: 'ship', priority: 9 }),
      track({ id: 'second', pattern: 'ship', priority: 10 }),
      track({ id: 'third', pattern: 'ship', priority: 10 }),
    ]
    const result = await previewTrackRouting('ship this', rows, async () => 1)
    expect(result.winner?.track.id).toBe('second')
    expect(result.candidates.map((candidate) => candidate.order)).toEqual([0, 1, 2])
  })

  it('exclusion-first：正向和否决同时命中时 simple 归零，完整 Track 接管', async () => {
    const result = await previewTrackRouting('修复 API 文案 typo', [
      track({ id: 'simple', pattern: 'typo|文案', excludePattern: 'API', priority: 1000 }),
      track({ id: 'backend', pattern: '修复|API', priority: 200 }),
    ])
    expect(result.winner?.track.id).toBe('backend')
    expect(result.candidates.find((candidate) => candidate.track.id === 'simple')).toMatchObject({
      score: 0,
      excluded: true,
    })
  })

  it('快速修复不再被前置抑制，交给 simple 风险分类', async () => {
    const result = await previewTrackRouting('快速修复 React 组件 typo', [
      track({ id: 'simple', pattern: '快速修复|typo', priority: 1000 }),
    ])
    expect(result.suppressed_reason).toBeNull()
    expect(result.winner?.track.id).toBe('simple')
  })

  it('内建 simple 仅接受带具体目标的局部改动；缺目标、跨模块和依赖升级全部 fail-closed', async () => {
    await expect(previewTrackRouting('修改 README.md 中的 typo', BUILTIN_TRACK_DEFINITIONS))
      .resolves.toMatchObject({ winner: { track: { id: 'simple' } } })
    for (const prompt of [
      '帮我微调一下',
      '新目标：修改多模块中的同一处 typo',
      '把 React 版本号从 18 升级到 19',
    ]) {
      const result = await previewTrackRouting(prompt, BUILTIN_TRACK_DEFINITIONS)
      expect(result.winner?.track.id, prompt).not.toBe('simple')
      expect(result.candidates.find((candidate) => candidate.track.id === 'simple')?.score, prompt).toBe(0)
    }
  })

  it('routing disabled 不参与赢家；零分时无赢家', async () => {
    const rows = [track({ id: 'disabled', enabled: false }), track({ id: 'enabled' })]
    const result = await previewTrackRouting('unmatched', rows, async () => 0)
    expect(result.winner).toBeNull()
    expect(result.candidates).toMatchObject([
      { score: 0, routable: false },
      { score: 0, routable: true },
    ])
  })

  it('实际 hook 会抑制的讨论型 prompt 明确返回 suppression，仍保留候选分数供手选', async () => {
    const result = await previewTrackRouting('为什么 backend 会失败', [track({ id: 'backend' })], async () => 3)
    expect(result.suppressed_reason).toBe('discussion')
    expect(result.winner).toBeNull()
    expect(result.candidates[0]?.score).toBe(3)
  })
})

describe('Router preview draft override', () => {
  it('用未保存 custom Track 草稿替换同 id 候选且保持 registry order', () => {
    const current = [track({ id: 'first' }), track({ id: 'qa', pattern: 'old' })]
    const draft = track({ id: 'qa', pattern: 'new', priority: 999 })
    const next = applyRouterDraft(current, draft)
    expect(next).toHaveLength(2)
    expect(next[1]).toMatchObject({ id: 'qa', policyProfile: { routing: { pattern: 'new', priority: 999 } } })
  })

  it('新 custom Track 草稿追加到候选；内建 Track policy 草稿拒绝', () => {
    const builtin = track({ id: 'frontend', builtin: true })
    expect(applyRouterDraft([builtin], track({ id: 'qa' }))).toHaveLength(2)
    expect(() => applyRouterDraft([builtin], { ...builtin, policyProfile: track({ id: 'qa' }).policyProfile }))
      .toThrow(/内建 Track/)
  })
})

describe('Router preview · standard 通道（真 grep、内建 registry，与 hooks/router.sh 同一决策）', () => {
  const winnerOf = async (prompt: string): Promise<string | null> =>
    (await previewTrackRouting(prompt, BUILTIN_TRACK_DEFINITIONS)).winner?.track.id ?? null

  it.each([
    // 审计里漏判的四个例子：实现类请求默认进 standard。
    ['add a subtract function to src/add.js', 'standard'],
    ['refactor the add module', 'standard'],
    ['给 src/add.js 加一个减法函数', 'standard'],
    ['重构 add 模块', 'standard'],
    ['Please fix the null check in parseConfig', 'standard'],
    ['帮我实现一个 React 组件，做个响应式页面 UI', 'standard'],
    // 错字级仍归 simple，调研 / 产品归 pm。
    ['fix a typo in README.md', 'simple'],
    ['做一个竞品调研并写 PRD', 'pm'],
    // 重型信号不进 standard：回到 default 的领域轨；没有领域轨认领的回落 backend。
    ['迁移数据库 schema 并更新 API', 'backend'],
    ['新增用户登录鉴权', 'backend'],
    // 名词里的 add / 纯问答不是实现类请求。
    ['the add function returns the wrong value', null],
    ['what is the add module', null],
  ])('%s → %s', async (prompt, expected) => {
    expect(await winnerOf(prompt)).toBe(expected)
  })
})
