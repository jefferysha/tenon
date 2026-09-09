import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WbSkillEntry, WbTrackDefinition } from '../api/client'
import { I18nProvider, useT } from '../i18n'
import {
  LaneMandatorySkills,
  TrackSelector,
  invalidateMandatoryConfig,
  useMandatorySkills,
  type MandatoryState,
} from './mandatorySkills'

/**
 * mandatorySkills.test（P1 任务 B，契约 p1-contract.md §4.7~§4.12 + §4.6 的 chips 一半）——
 * default workflow「阶段 × 轨道」manifest 强制技能矩阵：数据面（useMandatorySkills）与画布内
 * 展示/编辑面（LaneMandatorySkills / TrackSelector）。
 *
 * 本文件的守门重心是**诚实门**（契约 §0.6）：写入口只许出现在真写得进去的格子上。三条只读
 * 理由（_all 回退 / archive / capable===false）各有专门用例，任何一条被放开都会在这里红。
 * 其次是**非乐观写回**（契约 §3-B2）：这条路径「等响应才动集合、失败时集合压根没被动过」，
 * 与 useHooksConfig 的乐观+回滚是两套范式——用例里刻意在 POST 未落地的那一刻就断言集合原样，
 * 有人把它改成乐观更新，那一行立刻红。
 *
 * fixture 的技能名一律取真实长名（superpowers:test-driven-development 等），零截断断言才有牙。
 */

// 「阶段.轨道」矩阵 fixture（一个 phase 顶一组边界，避免用例间互相污染）：
//   build   → 三个 server 授权 profile 键齐全 → 可写格（× / + 都在）
//   spec    → 只有 pm/frontend 键 → 切 track 换集合 + backend 缺键的真空集
//   open    → 只有 _all 通配集 → 三轨都走 _all 回退 → 只读格
//   archive → 即便有 per-track 键，写端点也拒 archive → 只读格
const CONFIG_BODY = {
  ok: true,
  generated_at: '2026-07-15T00:00:00Z',
  revision: 'tracks-r5-fixture',
  source: 'project-file',
  mandatory_skills_writable_profiles: ['pm', 'frontend', 'backend'],
  tracks: [
    {
      id: 'chat',
      label: 'Chat',
      builtin: true,
      workflow: { default: 'default', allowed: '*' },
      policyProfile: {
        reviewSeed: 'pending',
        automationEligible: false,
        coverageProfile: 'none',
        routing: { enabled: false },
        skills: { matrix: false, profile: '_all' },
      },
    },
    {
      id: 'pm',
      label: 'Product',
      builtin: true,
      workflow: { default: 'default', allowed: '*' },
      policyProfile: {
        reviewSeed: 'skipped',
        automationEligible: true,
        coverageProfile: 'pm',
        routing: { enabled: true, pattern: '(product|roadmap)', priority: 100 },
        skills: { matrix: true, profile: 'pm' },
      },
    },
    {
      id: 'frontend',
      label: 'Frontend',
      builtin: true,
      workflow: { default: 'default', allowed: '*' },
      policyProfile: {
        reviewSeed: 'pending',
        automationEligible: true,
        coverageProfile: 'frontend',
        routing: { enabled: true, pattern: '(ui|css)', priority: 300 },
        skills: { matrix: true, profile: 'frontend' },
      },
    },
    {
      id: 'backend',
      label: 'Backend',
      builtin: true,
      workflow: { default: 'default', allowed: '*' },
      policyProfile: {
        reviewSeed: 'pending',
        automationEligible: true,
        coverageProfile: 'backend',
        routing: { enabled: true, pattern: '(api|db)', priority: 200 },
        skills: { matrix: true, profile: 'backend' },
      },
    },
    {
      id: 'qa',
      label: 'Quality',
      builtin: false,
      workflow: { default: 'quality-flow', allowed: ['quality-flow'] },
      policyProfile: {
        reviewSeed: 'pending',
        automationEligible: true,
        coverageProfile: 'backend',
        routing: { enabled: true, pattern: '(qa|test)', priority: 250 },
        skills: { matrix: true, profile: 'frontend' },
      },
    },
    {
      id: 'observer',
      label: 'Observer',
      builtin: false,
      workflow: { default: 'default', allowed: '*' },
      policyProfile: {
        reviewSeed: 'pending',
        automationEligible: false,
        coverageProfile: 'none',
        routing: { enabled: false },
        skills: { matrix: false, profile: '_all' },
      },
    },
  ],
  mandatory_skills: {
    'build.pm': ['prototype|huashu-design', 'frontend-design'],
    'build.frontend': ['superpowers:test-driven-development', 'web-design-guidelines'],
    'build.backend': ['superpowers:writing-plans'],
    // qa 继承 frontend profile；这条同名键即便存在也不得被消费。
    'build.qa': ['must-not-be-used'],
    'spec.pm': ['superpowers:brainstorming'],
    'spec.frontend': ['superpowers:writing-plans'],
    'open._all': ['opsx:propose|openspec-propose'],
    'archive.pm': ['superpowers:finishing-a-development-branch'],
  },
}

const REGISTRY: { skills: WbSkillEntry[] } = {
  skills: [
    { name: 'superpowers:test-driven-development', installed: true, source: 'local-plugin' },
    { name: 'web-design-guidelines', installed: true, source: 'local-plugin' },
    { name: 'improve-codebase-architecture', installed: true, source: 'user' },
    {
      name: 'superpowers:verification-before-completion',
      installed: false,
      source: 'external-marketplace',
      installCmd: 'claude plugin install superpowers',
    },
  ],
}

type PostBody = { phase: string; track: string; skills: string[]; root?: string }

let configResponse: () => Response | Promise<Response>
let registryResponse: () => Response
let postResponse: (body: PostBody) => Response | Promise<Response>

function fetchMock(): ReturnType<typeof vi.fn> {
  return global.fetch as unknown as ReturnType<typeof vi.fn>
}
function postCalls(): unknown[][] {
  return fetchMock().mock.calls.filter(([, o]) => (o as RequestInit | undefined)?.method === 'POST')
}
function postBodyOf(i: number): PostBody {
  return JSON.parse(String((postCalls()[i]![1] as RequestInit).body)) as PostBody
}

beforeEach(() => {
  localStorage.clear()
  // cfgCache 是模块级的（B1 的全部意义：一份缓存两处用）——不清就会串到下一条用例。
  invalidateMandatoryConfig()
  configResponse = () => new Response(JSON.stringify(CONFIG_BODY), { status: 200 })
  registryResponse = () => new Response(JSON.stringify(REGISTRY), { status: 200 })
  postResponse = ({ phase, track, skills }) =>
    new Response(JSON.stringify({ ok: true, phase, track, skills }), { status: 200 })
  global.fetch = vi.fn(async (url: string, opts?: RequestInit) => {
    if (url === '/api/config' || url.startsWith('/api/config?')) return configResponse()
    if (url === '/api/skills/registry') return registryResponse()
    if (url === '/api/config/mandatory-skills' && opts?.method === 'POST') {
      return postResponse(JSON.parse(String(opts.body)) as PostBody)
    }
    throw new Error(`unexpected fetch ${url}`)
  }) as unknown as typeof fetch
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/**
 * 宿主接线的等价物（契约 §3-B2：状态归宿主持有，多列共用一份 state）——
 * 一个 useMandatorySkills + 一个看板级 TrackSelector + N 个列内技能区。
 * `probe` 拿到 state 本体，供「在途守卫」这类只在 hook API 上可观测的用例使用。
 */
let probe: MandatoryState

function Harness({ phases, root = '/repo/default' }: { phases: string[]; root?: string }): JSX.Element {
  const state = useMandatorySkills(root)
  probe = state
  return (
    <>
      <TrackSelector state={state} />
      {phases.map((p) => (
        <LaneMandatorySkills key={p} phase={p} state={state} />
      ))}
    </>
  )
}

function LanguageHarness({ phases }: { phases: string[] }): JSX.Element {
  const { setLang } = useT()
  return <>
    <button type="button" data-testid="mandatory-language-en" onClick={() => setLang('en')}>en</button>
    <Harness phases={phases} />
  </>
}

/** 渲染并等到 config 探测落地（table===null 时各列渲染「加载中…」）。 */
async function renderMatrix(phases: string[] = ['build'], root = '/repo/default'): Promise<void> {
  render(
    <I18nProvider>
      <Harness phases={phases} root={root} />
    </I18nProvider>,
  )
  await waitFor(() => expect(screen.queryByText('加载中…')).toBeNull())
}

/** registry 是挂载即拉的第二发异步：添加入口在它落地前恒禁用，故写入口用例先等它。 */
async function waitAddReady(phase: string): Promise<void> {
  await waitFor(() => expect(screen.getByTestId(`wb-mand-add-${phase}`)).toBeEnabled())
}

describe('LaneMandatorySkills §4.7 诚实门：运行时 config/registry 不可用时不拿静态轨道冒充真值', () => {
  it('GET /api/config 非 2xx → 无 selector/矩阵写入口，明确显示运行时轨道加载失败', async () => {
    configResponse = () => new Response(JSON.stringify({ ok: false, error: 'config 数据端未装' }), { status: 404 })
    await renderMatrix(['build'])

    expect(screen.queryByTestId('wb-track-tabs')).toBeNull()
    expect(screen.queryByTestId('wb-mand-add-build')).toBeNull()
    expect(screen.queryByTestId('wb-mand-chip-build-prototype|huashu-design')).toBeNull()
    expect(screen.getByTestId('wb-track-load-error')).toHaveTextContent('运行时轨道配置加载失败')
    expect(screen.getByTestId('wb-mand-unavailable-build')).toHaveTextContent('运行时轨道配置不可用')
    configResponse = () => new Response(JSON.stringify(CONFIG_BODY), { status: 200 })
    fireEvent.click(screen.getByTestId('wb-track-retry'))
    expect(await screen.findByTestId('wb-track-tabs')).toBeInTheDocument()
  })

  it('capable=false → 不渲染假 ×/+，因此不会发 POST', async () => {
    configResponse = () => new Response('boom', { status: 500 })
    await renderMatrix(['build'])
    expect(screen.queryByTestId('wb-mand-rm-build-frontend-design')).toBeNull()
    expect(screen.queryByTestId('wb-mand-add-build')).toBeNull()
    expect(postCalls()).toHaveLength(0)
  })

  it('/api/config 抛异常（网络断）→ fail-soft 错误态，不白屏也不退回手抄轨道', async () => {
    configResponse = () => {
      throw new Error('network down')
    }
    await renderMatrix(['build'])
    expect(screen.getByTestId('wb-track-load-error')).toBeInTheDocument()
    expect(screen.queryByTestId('wb-track-pm')).toBeNull()
    expect(screen.queryByTestId('wb-mand-add-build')).toBeNull()
  })

  it.each([
    ['ok:false', { ...CONFIG_BODY, ok: false }],
    ['revision 缺失', { ...CONFIG_BODY, revision: undefined }],
    ['source 越界', { ...CONFIG_BODY, source: 'unknown-source' }],
    ['generated_at 非时间戳', { ...CONFIG_BODY, generated_at: 'not-a-date' }],
    ['写能力缺失', { ...CONFIG_BODY, mandatory_skills_writable_profiles: undefined }],
    [
      'mandatory key 畸形',
      { ...CONFIG_BODY, mandatory_skills: { ...CONFIG_BODY.mandatory_skills, 'build..pm': ['skill-x'] } },
    ],
    [
      'skill alternative 畸形',
      { ...CONFIG_BODY, mandatory_skills: { ...CONFIG_BODY.mandatory_skills, 'build.pm': ['skill-a||skill-b'] } },
    ],
  ])('HTTP 200 但整包 %s → fail-closed，不开放 selector/POST', async (_label, body) => {
    configResponse = () => new Response(JSON.stringify(body), { status: 200 })
    await renderMatrix(['build'])
    expect(screen.getByTestId('wb-track-load-error')).toBeInTheDocument()
    expect(screen.queryByTestId('wb-track-tabs')).toBeNull()
    expect(screen.queryByTestId('wb-mand-add-build')).toBeNull()
    expect(postCalls()).toHaveLength(0)
  })

  it.each([
    ['负 priority', { enabled: true, pattern: 'qa', priority: -1 }],
    ['非法正则', { enabled: true, pattern: '[', priority: 1 }],
    ['空排除规则', { enabled: true, pattern: 'qa', excludePattern: '', priority: 1 }],
    ['非法排除正则', { enabled: true, pattern: 'qa', excludePattern: '[', priority: 1 }],
    ['disabled 携带 pattern', { enabled: false, pattern: 'qa' }],
    ['disabled 携带 excludePattern', { enabled: false, excludePattern: 'api' }],
  ])('effective track 的 routing %s → 整包 fail-closed', async (_label, routing) => {
    const tracks = CONFIG_BODY.tracks.map((track) => track.id === 'qa'
      ? { ...track, policyProfile: { ...track.policyProfile, routing } }
      : track)
    configResponse = () => new Response(JSON.stringify({ ...CONFIG_BODY, tracks }), { status: 200 })
    await renderMatrix(['build'])
    expect(screen.getByTestId('wb-track-load-error')).toBeInTheDocument()
  })

  it('routing priority=-0 → 拒绝；JSON 原文保留负零，不能被 stringify 偷转 +0', async () => {
    const raw = JSON.stringify(CONFIG_BODY).replace('"priority":250', '"priority":-0')
    configResponse = () => new Response(raw, { status: 200 })
    await renderMatrix(['build'])
    expect(screen.getByTestId('wb-track-load-error')).toBeInTheDocument()
  })

  it('workflow.allowed 数组不含 default → 拒绝整份 effective registry', async () => {
    const tracks = CONFIG_BODY.tracks.map((track) => track.id === 'qa'
      ? { ...track, workflow: { default: 'quality-flow', allowed: ['other-flow'] } }
      : track)
    configResponse = () => new Response(JSON.stringify({ ...CONFIG_BODY, tracks }), { status: 200 })
    await renderMatrix(['build'])
    expect(screen.getByTestId('wb-track-load-error')).toBeInTheDocument()
  })

  it('kernel 允许的非空纯空白 routing pattern 仍是合法快照，不被 trim 过度拒绝', async () => {
    const tracks = CONFIG_BODY.tracks.map((track) => track.id === 'qa'
      ? { ...track, policyProfile: { ...track.policyProfile, routing: { enabled: true, pattern: '   ', priority: 1 } } }
      : track)
    configResponse = () => new Response(JSON.stringify({ ...CONFIG_BODY, tracks }), { status: 200 })
    await renderMatrix(['build'])
    expect(screen.getByTestId('wb-track-qa')).toBeInTheDocument()
  })

  it('server canonical token `foo/bar` 合法；不得因内容定位层的路径规则误杀 config token', async () => {
    configResponse = () => new Response(JSON.stringify({
      ...CONFIG_BODY,
      mandatory_skills: { ...CONFIG_BODY.mandatory_skills, 'build.pm': ['foo/bar'] },
    }), { status: 200 })
    await renderMatrix(['build'])
    expect(screen.getByTestId('wb-mand-chip-build-foo/bar')).toBeInTheDocument()
  })

  it.each([
    ['含逗号', ['foo,bar']],
    ['超过 128 字符', [`a${'x'.repeat(128)}`]],
    ['超过 50 项', Array.from({ length: 51 }, (_, index) => `skill-${index}`)],
  ])('server canonical token/list 边界：%s → GET 整包 fail-closed', async (_label, skills) => {
    configResponse = () => new Response(JSON.stringify({
      ...CONFIG_BODY,
      mandatory_skills: { ...CONFIG_BODY.mandatory_skills, 'build.pm': skills },
    }), { status: 200 })
    await renderMatrix(['build'])
    expect(screen.getByTestId('wb-track-load-error')).toBeInTheDocument()
  })

  it('registry 未就绪（GET /api/skills/registry 非 2xx）→ 添加入口禁用 + 「技能库未就绪」说明（× 仍可用）', async () => {
    registryResponse = () => new Response(JSON.stringify({ ok: false, error: '技能库炸了' }), { status: 500 })
    await renderMatrix(['build'])
    await waitFor(() => expect(screen.getByTestId('wb-mand-note-build')).toHaveTextContent('技能库未就绪，暂不能添加'))
    const add = screen.getByTestId('wb-mand-add-build')
    expect(add).toBeDisabled()
    expect(add).toHaveAttribute('title', '技能库未就绪，暂不能添加')
    // 移除不依赖 registry（不需要候选池），仍可写
    expect(screen.getByTestId('wb-mand-rm-build-prototype|huashu-design')).toBeEnabled()
  })
})

describe('LaneMandatorySkills §4.8 诚实门：_all 通配集 / archive → 无 ×/+ 入口', () => {
  it('per-track 键缺失、展示的是 _all 的值 → 无 ×、无 +，说明「改不到 _all」', async () => {
    await renderMatrix(['open'])
    // 值照常展示（不藏数据），但结构上就不该有写入口：server 未授予 _all 写能力，
    // 在展示 _all 值的格子上给 ×，用户以为在改 _all，实际是给该 track 悄悄建覆盖键。
    expect(screen.getByTestId('wb-mand-chip-open-opsx:propose|openspec-propose')).toBeInTheDocument()
    expect(screen.queryByTestId('wb-mand-rm-open-opsx:propose|openspec-propose')).toBeNull()
    expect(screen.queryByTestId('wb-mand-add-open')).toBeNull()
    expect(screen.getByTestId('wb-mand-note-open')).toHaveTextContent('沿用所有轨道共用的默认 Skill')
  })

  it('_all 回退在三个 track 上都成立（切到 frontend/backend 仍只读）', async () => {
    await renderMatrix(['open'])
    for (const tr of ['frontend', 'backend']) {
      fireEvent.click(screen.getByTestId(`wb-track-${tr}`))
      expect(screen.getByTestId('wb-mand-chip-open-opsx:propose|openspec-propose')).toBeInTheDocument()
      expect(screen.queryByTestId('wb-mand-add-open')).toBeNull()
    }
  })

  it('archive：即便 per-track 键存在也不给 ×/+（前端与 server 双侧拒写）', async () => {
    await renderMatrix(['archive'])
    expect(screen.getByTestId('wb-mand-chip-archive-superpowers:finishing-a-development-branch')).toBeInTheDocument()
    expect(screen.queryByTestId('wb-mand-rm-archive-superpowers:finishing-a-development-branch')).toBeNull()
    expect(screen.queryByTestId('wb-mand-add-archive')).toBeNull()
    expect(screen.getByTestId('wb-mand-note-archive')).toHaveTextContent('archive 无强制技能（写端点拒 archive）')
  })

  it('对照组：per-track 键存在的可写格（build.pm）× 与 + 都在、可点、无只读说明', async () => {
    await renderMatrix(['build'])
    await waitAddReady('build')
    expect(screen.getByTestId('wb-mand-rm-build-prototype|huashu-design')).toBeEnabled()
    expect(screen.getByTestId('wb-mand-add-build')).toBeEnabled()
    expect(screen.queryByTestId('wb-mand-note-build')).toBeNull()
  })

  it('两键皆无（集合真的是空）→ 空集合只读；不把不存在的 profile 列冒充可编辑列', async () => {
    await renderMatrix(['spec'])
    fireEvent.click(screen.getByTestId('wb-track-backend')) // spec.backend 与 spec._all 都不存在
    expect(within(screen.getByTestId('wb-mand-spec')).getByText('（空）')).toBeInTheDocument()
    expect(screen.queryByTestId('wb-mand-add-spec')).toBeNull()
    expect(screen.getByTestId('wb-mand-note-spec')).toHaveTextContent('当前轨道尚未设置默认 Skill')
  })
})

describe('useMandatorySkills §4.9 写回非乐观（等响应才动集合；失败时集合压根没被动过）', () => {
  it('移除 → POST body {phase,track,skills} 正确；成功后就地 merge，不重新 GET /api/config', async () => {
    await renderMatrix(['build'])
    fireEvent.click(screen.getByTestId('wb-track-frontend'))
    await waitAddReady('build')

    fireEvent.click(screen.getByTestId('wb-mand-rm-build-superpowers:test-driven-development'))
    // 非乐观：POST 还没落地的这一刻，集合必须原样——乐观更新会在这里就把 chip 拿掉
    expect(screen.getByTestId('wb-mand-chip-build-superpowers:test-driven-development')).toBeInTheDocument()

    await waitFor(() =>
      expect(screen.queryByTestId('wb-mand-chip-build-superpowers:test-driven-development')).toBeNull(),
    )
    expect(postCalls()).toHaveLength(1)
    expect(postCalls()[0]![0]).toBe('/api/config/mandatory-skills')
    expect(postBodyOf(0)).toEqual({
      phase: 'build',
      track: 'frontend',
      skills: ['web-design-guidelines'],
      root: '/repo/default',
    })
    // 成功后就地 merge，不重新拉一遍矩阵（GET /api/config 全程只有挂载那一发）
    expect(fetchMock().mock.calls.filter(([u]) => u === '/api/config?root=%2Frepo%2Fdefault')).toHaveLength(1)
    expect(screen.getByTestId('wb-mand-chip-build-web-design-guidelines')).toBeInTheDocument()
    expect(screen.queryByTestId('wb-mand-err-build')).toBeNull()
  })

  it('添加：候选面板选技能 → POST body 追加在末尾；成功后新 chip 就地出现、面板收起', async () => {
    await renderMatrix(['build'])
    fireEvent.click(screen.getByTestId('wb-track-frontend'))
    await waitAddReady('build')

    fireEvent.click(screen.getByTestId('wb-mand-add-build'))
    // 候选池排除已在集合里的（superpowers:test-driven-development 已是强制项）
    expect(screen.queryByTestId('wb-mand-opt-build-superpowers:test-driven-development')).toBeNull()
    fireEvent.click(screen.getByTestId('wb-mand-opt-build-improve-codebase-architecture'))

    await waitFor(() => expect(screen.getByTestId('wb-mand-chip-build-improve-codebase-architecture')).toBeInTheDocument())
    expect(postBodyOf(0)).toEqual({
      phase: 'build',
      track: 'frontend',
      skills: ['superpowers:test-driven-development', 'web-design-guidelines', 'improve-codebase-architecture'],
      root: '/repo/default',
    })
    expect(screen.queryByTestId('wb-mand-pop-build')).toBeNull()
  })

  it('成功体带 skills 时以响应体为准（server 规范化后的集合才是真相，本地值只是回落）', async () => {
    postResponse = () => new Response(JSON.stringify({
      ok: true,
      phase: 'build',
      track: 'frontend',
      skills: ['server-normalized-skill'],
    }), { status: 200 })
    await renderMatrix(['build'])
    fireEvent.click(screen.getByTestId('wb-track-frontend'))
    await waitAddReady('build')

    fireEvent.click(screen.getByTestId('wb-mand-rm-build-web-design-guidelines'))
    await waitFor(() => expect(screen.getByTestId('wb-mand-chip-build-server-normalized-skill')).toBeInTheDocument())
    // 本地算出来的 ['superpowers:test-driven-development'] 被响应体整体取代
    expect(screen.queryByTestId('wb-mand-chip-build-superpowers:test-driven-development')).toBeNull()
  })

  it.each([
    ['错误 phase', { ok: true, phase: 'spec', track: 'frontend', skills: ['server-normalized-skill'] }],
    ['错误 track', { ok: true, phase: 'build', track: 'backend', skills: ['server-normalized-skill'] }],
    ['额外字段', { ok: true, phase: 'build', track: 'frontend', skills: ['server-normalized-skill'], extra: true }],
  ])('HTTP 200 成功体%s时拒绝写入请求 cell/cache', async (_label, responseBody) => {
    postResponse = () => new Response(JSON.stringify(responseBody), { status: 200 })
    await renderMatrix(['build'])
    fireEvent.click(screen.getByTestId('wb-track-frontend'))
    await waitAddReady('build')

    fireEvent.click(screen.getByTestId('wb-mand-rm-build-web-design-guidelines'))

    await waitFor(() => expect(screen.getByTestId('wb-mand-err-build')).toHaveTextContent('服务端响应格式无效'))
    expect(screen.getByTestId('wb-mand-chip-build-superpowers:test-driven-development')).toBeInTheDocument()
    expect(screen.getByTestId('wb-mand-chip-build-web-design-guidelines')).toBeInTheDocument()
    expect(screen.queryByTestId('wb-mand-chip-build-server-normalized-skill')).toBeNull()
  })

  it('POST 失败（500 + error 原文）→ 集合保持原值不变（不是回滚：它压根没被改过）+ 错误原文可见', async () => {
    postResponse = () => new Response(JSON.stringify({ ok: false, error: 'manifest 只读' }), { status: 500 })
    await renderMatrix(['build'])
    fireEvent.click(screen.getByTestId('wb-track-frontend'))
    await waitAddReady('build')

    fireEvent.click(screen.getByTestId('wb-mand-rm-build-superpowers:test-driven-development'))
    // 在途即断言：全程没有「先删掉再回滚」这一下闪烁
    expect(screen.getByTestId('wb-mand-chip-build-superpowers:test-driven-development')).toBeInTheDocument()

    await waitFor(() => expect(screen.getByTestId('wb-mand-err-build')).toHaveTextContent('manifest 只读'))
    // 落地后集合仍逐字等于原值
    expect(screen.getByTestId('wb-mand-chip-build-superpowers:test-driven-development')).toBeInTheDocument()
    expect(screen.getByTestId('wb-mand-chip-build-web-design-guidelines')).toBeInTheDocument()
    // 失败不该顺手把矩阵重拉一遍（缓存里那份从未被动过）
    expect(fetchMock().mock.calls.filter(([u]) => u === '/api/config?root=%2Frepo%2Fdefault')).toHaveLength(1)
  })

  it('HTTP 200 但响应 ok:false → 不推进集合/缓存，显示 server 原文，绝不伪造保存成功', async () => {
    postResponse = () => new Response(JSON.stringify({ ok: false, error: 'revision 已变化' }), { status: 200 })
    await renderMatrix(['build'])
    await waitAddReady('build')
    fireEvent.click(screen.getByTestId('wb-mand-rm-build-frontend-design'))
    await waitFor(() => expect(screen.getByTestId('wb-mand-err-build')).toHaveTextContent('revision 已变化'))
    expect(screen.getByTestId('wb-mand-chip-build-frontend-design')).toBeInTheDocument()
  })

  it('HTTP 200 ok:true 但回读 skills 含逗号 → 拒绝响应，不推进集合/cache', async () => {
    postResponse = () => new Response(JSON.stringify({
      ok: true,
      phase: 'build',
      track: 'pm',
      skills: ['foo,bar'],
    }), { status: 200 })
    await renderMatrix(['build'])
    await waitAddReady('build')
    fireEvent.click(screen.getByTestId('wb-mand-rm-build-frontend-design'))
    await waitFor(() => expect(screen.getByTestId('wb-mand-err-build')).toHaveTextContent('服务端响应格式无效'))
    expect(screen.getByTestId('wb-mand-chip-build-frontend-design')).toBeInTheDocument()
  })

  it('错误信封字段类型畸形时按无效响应处理，不把对象渲染成 React child', async () => {
    postResponse = () => new Response(JSON.stringify({ ok: false, error: {} }), { status: 500 })
    await renderMatrix(['build'])
    await waitAddReady('build')

    fireEvent.click(screen.getByTestId('wb-mand-rm-build-frontend-design'))

    await waitFor(() => expect(screen.getByTestId('wb-mand-err-build')).toHaveTextContent('服务端响应格式无效'))
    expect(screen.getByTestId('wb-mand-chip-build-frontend-design')).toBeInTheDocument()
  })

  it('保存响应晚到且期间切为英文时，按当前语言显示失败，不回写发起时的中文文案', async () => {
    let release!: (response: Response) => void
    postResponse = () => new Promise<Response>((resolve) => { release = resolve })
    render(<I18nProvider><LanguageHarness phases={['build']} /></I18nProvider>)
    await waitFor(() => expect(screen.queryByText('加载中…')).toBeNull())
    await waitAddReady('build')

    fireEvent.click(screen.getByTestId('wb-mand-rm-build-frontend-design'))
    fireEvent.click(screen.getByTestId('mandatory-language-en'))
    release(new Response(JSON.stringify({ ok: false, error: '后端中文错误' }), { status: 500 }))

    const error = await screen.findByTestId('wb-mand-err-build')
    expect(error).toHaveTextContent('Save failed (500)')
    expect(error.textContent).not.toMatch(/[\u3400-\u9fff]/u)
  })

  it('root A 的 POST 晚到时只推进 A cache，绝不覆盖已切换到 root B 的 UI/cache', async () => {
    let releaseA!: (response: Response) => void
    postResponse = () => new Promise<Response>((resolve) => { releaseA = resolve })
    const view = render(
      <I18nProvider>
        <Harness phases={['build']} root="/repo-a" />
      </I18nProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('wb-mand-chip-build-frontend-design')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('wb-mand-rm-build-frontend-design'))

    const bodyB = {
      ...CONFIG_BODY,
      mandatory_skills: { ...CONFIG_BODY.mandatory_skills, 'build.pm': ['b-only'] },
    }
    configResponse = () => new Response(JSON.stringify(bodyB), { status: 200 })
    view.rerender(
      <I18nProvider>
        <Harness phases={['build']} root="/repo-b" />
      </I18nProvider>,
    )
    await screen.findByTestId('wb-mand-chip-build-b-only')
    releaseA(new Response(JSON.stringify({
      ok: true,
      phase: 'build',
      track: 'pm',
      skills: ['a-after-save'],
    }), { status: 200 }))
    await act(async () => { await Promise.resolve() })
    expect(screen.getByTestId('wb-mand-chip-build-b-only')).toBeInTheDocument()
    expect(screen.queryByTestId('wb-mand-chip-build-a-after-save')).toBeNull()

    view.unmount()
    const bView = render(
      <I18nProvider>
        <Harness phases={['build']} root="/repo-b" />
      </I18nProvider>,
    )
    expect(await screen.findByTestId('wb-mand-chip-build-b-only')).toBeInTheDocument()
    bView.unmount()
    render(
      <I18nProvider>
        <Harness phases={['build']} root="/repo-a" />
      </I18nProvider>,
    )
    expect(await screen.findByTestId('wb-mand-chip-build-a-after-save')).toBeInTheDocument()
  })

  it('失败体无 error 字段（非 JSON 信封）→ 回落 i18n「保存失败（{status}）」，仍是可见的错误原文', async () => {
    postResponse = () => new Response('boom', { status: 503 })
    await renderMatrix(['build'])
    await waitAddReady('build')
    fireEvent.click(screen.getByTestId('wb-mand-rm-build-frontend-design'))
    await waitFor(() => expect(screen.getByTestId('wb-mand-err-build')).toHaveTextContent('保存失败（503）'))
    expect(screen.getByTestId('wb-mand-chip-build-frontend-design')).toBeInTheDocument()
  })

  it('saveError 只挂在真出错那一列（矩阵级单值不该让所有列同时挂同一条红字）', async () => {
    postResponse = () => new Response(JSON.stringify({ ok: false, error: 'manifest 只读' }), { status: 500 })
    await renderMatrix(['build', 'spec'])
    await waitAddReady('build')
    fireEvent.click(screen.getByTestId('wb-mand-rm-build-frontend-design'))
    await waitFor(() => expect(screen.getByTestId('wb-mand-err-build')).toBeInTheDocument())
    expect(screen.queryByTestId('wb-mand-err-spec')).toBeNull()
  })
})

describe('useMandatorySkills §4.10 savingKey：同 cell 在途时该列控件禁用', () => {
  it('POST 在途 → 本列 ×/+ 全禁用，邻列（另一个 cell）不受牵连；响应回来即恢复', async () => {
    let release!: (r: Response) => void
    postResponse = () => new Promise<Response>((resolve) => (release = resolve))
    await renderMatrix(['build', 'spec'])
    await waitAddReady('build')
    await waitAddReady('spec')

    fireEvent.click(screen.getByTestId('wb-mand-rm-build-prototype|huashu-design'))
    // savingKey='build.pm' 同步落地（setSavingKey 在 await 之前）
    expect(screen.getByTestId('wb-mand-add-build')).toBeDisabled()
    expect(screen.getByTestId('wb-mand-rm-build-frontend-design')).toBeDisabled()
    // 在途是 cell 级而非矩阵级：spec.pm 那格照常可写
    expect(screen.getByTestId('wb-mand-add-spec')).toBeEnabled()
    expect(screen.getByTestId('wb-mand-rm-spec-superpowers:brainstorming')).toBeEnabled()

    release(new Response(JSON.stringify({
      ok: true,
      phase: 'build',
      track: 'pm',
      skills: ['frontend-design'],
    }), { status: 200 }))
    await waitFor(() => expect(screen.getByTestId('wb-mand-add-build')).toBeEnabled())
    expect(screen.queryByTestId('wb-mand-chip-build-prototype|huashu-design')).toBeNull()
  })

  it('不同 cell 并发各自保留 busy/token，任一迟到结果不能覆盖另一操作', async () => {
    const releases = new Map<string, (response: Response) => void>()
    postResponse = (body) => new Promise<Response>((resolve) => {
      releases.set(body.phase, resolve)
    })
    await renderMatrix(['build', 'spec'])
    await waitAddReady('build')
    await waitAddReady('spec')

    act(() => probe.setSkills('build', ['frontend-design']))
    act(() => probe.setSkills('spec', []))
    expect(screen.getByTestId('wb-mand-add-build')).toBeDisabled()
    expect(screen.getByTestId('wb-mand-add-spec')).toBeDisabled()

    releases.get('spec')?.(new Response(JSON.stringify({
      ok: true,
      phase: 'spec',
      track: 'pm',
      skills: [],
    }), { status: 200 }))
    await waitFor(() => expect(screen.getByTestId('wb-mand-add-spec')).toBeEnabled())
    expect(screen.getByTestId('wb-mand-add-build')).toBeDisabled()

    releases.get('build')?.(new Response(JSON.stringify({ ok: false, error: 'build failed' }), { status: 409 }))
    await waitFor(() => expect(screen.getByTestId('wb-mand-err-build')).toHaveTextContent('build failed'))
    expect(screen.queryByTestId('wb-mand-err-spec')).toBeNull()
    expect(screen.getByTestId('wb-mand-add-build')).toBeEnabled()
  })

  it('在途守卫：同 cell 二次 setSkills 直接 no-op，不叠发第二个 POST', async () => {
    let release!: (r: Response) => void
    postResponse = () => new Promise<Response>((resolve) => (release = resolve))
    await renderMatrix(['build'])
    await waitAddReady('build')

    act(() => probe.setSkills('build', ['frontend-design']))
    expect(postCalls()).toHaveLength(1)
    // 同 cell 在途 → 整体 no-op（savingKeyRef 同步读，不等 render）
    act(() => probe.setSkills('build', ['prototype|huashu-design']))
    act(() => probe.setSkills('build', []))
    expect(postCalls()).toHaveLength(1)

    release(new Response(JSON.stringify({
      ok: true,
      phase: 'build',
      track: 'pm',
      skills: ['frontend-design'],
    }), { status: 200 }))
    await waitFor(() => expect(screen.getByTestId('wb-mand-add-build')).toBeEnabled())
    // 在途结束后同 cell 可以再写
    act(() => probe.setSkills('build', ['frontend-design', 'improve-codebase-architecture']))
    expect(postCalls()).toHaveLength(2)
    await act(async () => {
      release(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    })
    await waitFor(() => expect(screen.getByTestId('wb-mand-add-build')).toBeEnabled())
  })

  it('savingKey 命中本 cell → 控件禁用；指向别的 cell → 本列不受影响（纯渲染契约）', () => {
    const base: MandatoryState = {
      root: '/repo/default',
      revision: CONFIG_BODY.revision,
      table: { 'build.pm': ['prototype|huashu-design'] },
      capable: true,
      tracks: CONFIG_BODY.tracks as WbTrackDefinition[],
      matrixTracks: (CONFIG_BODY.tracks as WbTrackDefinition[]).filter((track) => track.policyProfile.skills.matrix),
      writableProfiles: CONFIG_BODY.mandatory_skills_writable_profiles,
      configError: null,
      track: 'pm',
      setTrack: vi.fn(),
      savingKey: null,
      saveError: null,
      setSkills: vi.fn(),
      registry: REGISTRY.skills,
      reloadConfig: vi.fn(),
    }
    const { rerender } = render(
      <I18nProvider>
        <LaneMandatorySkills phase="build" state={{ ...base, savingKey: 'build.pm' }} />
      </I18nProvider>,
    )
    expect(screen.getByTestId('wb-mand-add-build')).toBeDisabled()
    expect(screen.getByTestId('wb-mand-rm-build-prototype|huashu-design')).toBeDisabled()

    // 在途的是别的格子（同阶段不同 track / 同 track 不同阶段）→ 本列照常可写
    for (const key of ['build.frontend', 'spec.pm']) {
      rerender(
        <I18nProvider>
          <LaneMandatorySkills phase="build" state={{ ...base, savingKey: key }} />
        </I18nProvider>,
      )
      expect(screen.getByTestId('wb-mand-add-build')).toBeEnabled()
      expect(screen.getByTestId('wb-mand-rm-build-prototype|huashu-design')).toBeEnabled()
    }
  })
})

describe('LaneMandatorySkills §4.11 调用链展示', () => {
  it('不展示“必备集合/可并行”术语，改用阶段入口连接 Skill 节点', async () => {
    await renderMatrix(['build'])
    const chain = screen.getByTestId('wb-mand-parallel-build')
    expect(chain).toHaveTextContent('阶段开始')
    expect(chain).not.toHaveTextContent('必备集合')
    expect(chain).not.toHaveTextContent('可并行')
    expect(chain.querySelectorAll('[data-skill-node]')).toHaveLength(2)
  })

  it('chips 展示真实解析后的 Skill 名称；兼容候选只显示实际采用的一项', async () => {
    await renderMatrix(['build'])
    const zone = screen.getByTestId('wb-mand-build')
    expect(zone.querySelectorAll('[data-skn]')).toHaveLength(0)
    const alternative = screen.getByTestId('wb-mand-chip-build-prototype|huashu-design')
    expect(alternative.textContent).not.toContain('|')
    expect(alternative).toHaveTextContent('prototype')
    expect(alternative).not.toHaveTextContent('快速原型验证')
  })

  it('只读格也用同一调用链，不出现实现术语', async () => {
    await renderMatrix(['open', 'archive'])
    expect(screen.getByTestId('wb-mand-open')).not.toHaveTextContent('可并行')
    expect(screen.getByTestId('wb-mand-archive')).not.toHaveTextContent('必备集合')
    expect(screen.getByTestId('wb-mand-open').querySelectorAll('[data-skn]')).toHaveLength(0)
    expect(screen.getByTestId('wb-mand-archive').querySelectorAll('[data-skn]')).toHaveLength(0)
  })
})

describe('TrackSelector §4.12 看板级轨道镜头（切 track → 各列集合跟着换）', () => {
  it('轨道帮助按钮会展开项目级配置说明', async () => {
    await renderMatrix(['build'])
    const help = screen.getByRole('button', { name: '运行轨道说明' })
    expect(help).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(help)
    expect(help).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('help-popover-content')).toHaveTextContent('轨道是项目级运行配置')
  })

  it('运行时 registry 未返回前显示加载态，不先闪出任何手抄轨道', async () => {
    let release!: (value: Response) => void
    configResponse = () => new Promise<Response>((resolve) => (release = resolve))
    render(
      <I18nProvider>
        <Harness phases={['build']} />
      </I18nProvider>,
    )
    expect(screen.getByTestId('wb-track-loading')).toHaveTextContent('正在加载运行时轨道配置')
    expect(screen.queryByTestId('wb-track-pm')).toBeNull()
    release(new Response(JSON.stringify(CONFIG_BODY), { status: 200 }))
    await waitFor(() => expect(screen.getByTestId('wb-track-pm')).toBeInTheDocument())
  })

  it('selector 来自 effective registry：自定义 qa 出现，matrix=false 的 chat/free/observer 不作为矩阵列', async () => {
    await renderMatrix(['build', 'spec'])
    const tabs = screen.getByTestId('wb-track-tabs')
    expect(tabs).toHaveAttribute('role', 'radiogroup')
    expect(within(tabs).getAllByRole('radio')).toHaveLength(4)
    expect(screen.getByTestId('wb-track-pm')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('wb-track-qa')).toHaveTextContent('Quality')
    expect(screen.getByTestId('wb-track-qa')).toHaveAttribute('title', 'Quality · 沿用 前端 轨道技能')
    expect(screen.queryByTestId('wb-track-chat')).toBeNull()
    expect(screen.queryByTestId('wb-track-observer')).toBeNull()
  })

  it('中文 tooltip 本地化内建 candidate 与 inherited track，自定义名称保持原值', async () => {
    await renderMatrix(['build'])
    expect(screen.getByTestId('wb-track-pm')).toHaveAttribute('title', '产品')
    expect(screen.getByTestId('wb-track-qa')).toHaveAttribute('title', 'Quality · 沿用 前端 轨道技能')
    expect(screen.getByTestId('wb-track-qa')).not.toHaveAttribute('title', expect.stringContaining('Frontend'))
  })

  it('English tooltip 本地化 inherited built-in track 且不混入中文', async () => {
    localStorage.setItem('tenon-dashboard-lang', 'en')
    const tracks = CONFIG_BODY.tracks.map((track) => track.id === 'frontend' ? { ...track, label: '前端原始值' } : track)
    configResponse = () => new Response(JSON.stringify({ ...CONFIG_BODY, tracks }), { status: 200 })
    await renderMatrix(['build'])
    expect(screen.getByTestId('wb-track-qa')).toHaveAttribute('title', 'Quality · Uses Skills from the Frontend track')
    expect(screen.getByTestId('wb-track-qa').getAttribute('title')).not.toMatch(/[\u3400-\u9fff]/u)
  })

  it('轨道滑块不用锁图标制造噪音', async () => {
    await renderMatrix(['build'])
    expect(screen.getByTestId('wb-track-pm').querySelector('svg')).toBeNull()
    expect(screen.getByTestId('wb-track-frontend').querySelector('svg')).toBeNull()
    expect(screen.getByTestId('wb-track-backend').querySelector('svg')).toBeNull()
    expect(screen.getByTestId('wb-track-qa').querySelector('svg')).toBeNull()
  })

  it('系统轨道进入 radio 可访问名称；radio 只用 aria-checked，不混入 toggle 的 aria-pressed', async () => {
    await renderMatrix(['build'])
    const pm = screen.getByTestId('wb-track-pm')
    expect(pm).toHaveAccessibleName(/系统轨道 产品/)
    expect(pm).toHaveAttribute('aria-checked', 'true')
    expect(pm).not.toHaveAttribute('aria-pressed')
    expect(screen.getByTestId('wb-track-qa')).not.toHaveAccessibleName(/系统轨道/)
  })

  it('继承 profile 的 qa 列只读，并消费 frontend profile；即使 build.qa 存在也不读错键', async () => {
    await renderMatrix(['build'])
    fireEvent.click(screen.getByTestId('wb-track-qa'))
    expect(screen.getByTestId('wb-track-qa')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('wb-mand-chip-build-superpowers:test-driven-development')).toBeInTheDocument()
    expect(screen.queryByTestId('wb-mand-chip-build-must-not-be-used')).toBeNull()
    expect(screen.queryByTestId('wb-mand-add-build')).toBeNull()
    expect(screen.getByTestId('wb-mand-note-build')).toHaveTextContent('沿用“Frontend”轨道的默认 Skill')
  })

  it('自定义轨即使 profile===id，也必须等 server 显式授予写能力；未授权时零 ×/+、零 POST', async () => {
    const tracks = CONFIG_BODY.tracks.map((track) =>
      track.id === 'qa'
        ? { ...track, policyProfile: { ...track.policyProfile, skills: { matrix: true, profile: 'qa' } } }
        : track,
    )
    configResponse = () => new Response(JSON.stringify({ ...CONFIG_BODY, tracks }), { status: 200 })
    await renderMatrix(['build'])
    fireEvent.click(screen.getByTestId('wb-track-qa'))
    expect(screen.getByTestId('wb-mand-chip-build-must-not-be-used')).toBeInTheDocument()
    expect(screen.queryByTestId('wb-mand-add-build')).toBeNull()
    expect(screen.queryByTestId('wb-mand-rm-build-must-not-be-used')).toBeNull()
    expect(screen.getByTestId('wb-mand-note-build')).toHaveTextContent('当前配置仅供查看')
    act(() => probe.setSkills('build', []))
    expect(postCalls()).toHaveLength(0)
  })

  it('键盘 Arrow/Home/End 在动态轨道间循环，并维护 roving tabindex 与焦点', async () => {
    await renderMatrix(['build'])
    const pm = screen.getByTestId('wb-track-pm')
    pm.focus()
    fireEvent.keyDown(pm, { key: 'ArrowLeft' })
    expect(screen.getByTestId('wb-track-qa')).toHaveFocus()
    expect(screen.getByTestId('wb-track-qa')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('wb-track-qa')).toHaveAttribute('tabindex', '0')
    expect(pm).toHaveAttribute('tabindex', '-1')

    fireEvent.keyDown(screen.getByTestId('wb-track-qa'), { key: 'Home' })
    expect(pm).toHaveFocus()
    fireEvent.keyDown(pm, { key: 'End' })
    expect(screen.getByTestId('wb-track-qa')).toHaveFocus()
  })

  it('registry 空数组 → 明确无可用轨道，不渲染空 radiogroup', async () => {
    configResponse = () => new Response(JSON.stringify({
      ...CONFIG_BODY,
      tracks: [],
      mandatory_skills_writable_profiles: [],
    }), { status: 200 })
    await renderMatrix(['build'])
    expect(screen.queryByTestId('wb-track-tabs')).toBeNull()
    expect(screen.getByTestId('wb-track-empty')).toHaveTextContent('没有可用于技能矩阵的轨道')
    expect(screen.getByTestId('wb-mand-unavailable-build')).toBeInTheDocument()
  })

  it('config 请求带项目 root，动态 registry 不跨项目偷用全局缓存', async () => {
    await renderMatrix(['build'], '/repo with space')
    expect(fetchMock()).toHaveBeenCalledWith('/api/config?root=%2Frepo%20with%20space', {
      headers: { Accept: 'application/json' },
    })
  })

  it('A→B 快切且 A 后返回：旧项目响应不得覆盖 B；两个 root 各有独立请求', async () => {
    let releaseA!: (response: Response) => void
    let releaseB!: (response: Response) => void
    global.fetch = vi.fn((url: string) => {
      if (url === '/api/config?root=%2Frepo-a') {
        return new Promise<Response>((resolve) => { releaseA = resolve })
      }
      if (url === '/api/config?root=%2Frepo-b') {
        return new Promise<Response>((resolve) => { releaseB = resolve })
      }
      if (url === '/api/skills/registry') return Promise.resolve(registryResponse())
      throw new Error(`unexpected fetch ${url}`)
    }) as unknown as typeof fetch

    const view = render(
      <I18nProvider>
        <Harness phases={['build']} root="/repo-a" />
      </I18nProvider>,
    )
    await waitFor(() => expect(fetchMock()).toHaveBeenCalledWith('/api/config?root=%2Frepo-a', expect.anything()))
    view.rerender(
      <I18nProvider>
        <Harness phases={['build']} root="/repo-b" />
      </I18nProvider>,
    )
    await waitFor(() => expect(fetchMock()).toHaveBeenCalledWith('/api/config?root=%2Frepo-b', expect.anything()))
    const bodyB = {
      ...CONFIG_BODY,
      tracks: CONFIG_BODY.tracks.map((track) => track.id === 'qa' ? { ...track, label: 'B Quality' } : track),
    }
    releaseB(new Response(JSON.stringify(bodyB), { status: 200 }))
    await waitFor(() => expect(screen.getByTestId('wb-track-qa')).toHaveAttribute('title', 'B Quality · 沿用 前端 轨道技能'))
    releaseA(new Response(JSON.stringify(CONFIG_BODY), { status: 200 }))
    await act(async () => { await Promise.resolve() })
    expect(screen.getByTestId('wb-track-qa')).toHaveAttribute('title', 'B Quality · 沿用 前端 轨道技能')
    expect(fetchMock().mock.calls.filter(([url]) => String(url).startsWith('/api/config?root=')).map(([url]) => url))
      .toEqual(['/api/config?root=%2Frepo-a', '/api/config?root=%2Frepo-b'])
  })

  it('切 frontend → 两列集合同时换成 frontend 的值（一份 state 供全矩阵，不是每列各自一份）', async () => {
    await renderMatrix(['build', 'spec'])
    expect(screen.getByTestId('wb-mand-chip-build-prototype|huashu-design')).toBeInTheDocument()
    expect(screen.getByTestId('wb-mand-chip-spec-superpowers:brainstorming')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('wb-track-frontend'))
    expect(screen.getByTestId('wb-track-frontend')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('wb-track-pm')).toHaveAttribute('aria-checked', 'false')
    // 两列一起换
    expect(screen.getByTestId('wb-mand-chip-build-superpowers:test-driven-development')).toBeInTheDocument()
    expect(screen.getByTestId('wb-mand-chip-spec-superpowers:writing-plans')).toBeInTheDocument()
    // 旧 track 的集合不残留
    expect(screen.queryByTestId('wb-mand-chip-build-prototype|huashu-design')).toBeNull()
    expect(screen.queryByTestId('wb-mand-chip-spec-superpowers:brainstorming')).toBeNull()
  })

  it('切 backend → build 换 backend 集合；spec.backend 缺键且无 _all → 「（空）」（不借 pm 的值谎报）', async () => {
    await renderMatrix(['build', 'spec'])
    fireEvent.click(screen.getByTestId('wb-track-backend'))
    expect(screen.getByTestId('wb-track-backend')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('wb-mand-chip-build-superpowers:writing-plans')).toBeInTheDocument()
    expect(screen.queryByTestId('wb-mand-chip-build-superpowers:test-driven-development')).toBeNull()
    expect(within(screen.getByTestId('wb-mand-spec')).getByText('（空）')).toBeInTheDocument()
  })

  it('切回 pm → 集合原样回来（track 是镜头，不改数据）', async () => {
    await renderMatrix(['build'])
    fireEvent.click(screen.getByTestId('wb-track-backend'))
    fireEvent.click(screen.getByTestId('wb-track-pm'))
    expect(screen.getByTestId('wb-mand-chip-build-prototype|huashu-design')).toBeInTheDocument()
    expect(screen.getByTestId('wb-mand-chip-build-frontend-design')).toBeInTheDocument()
  })

  it('写回跟着当前 track 走：切 backend 后写的是 build.backend 这个键', async () => {
    await renderMatrix(['build'])
    fireEvent.click(screen.getByTestId('wb-track-backend'))
    await waitAddReady('build')
    fireEvent.click(screen.getByTestId('wb-mand-rm-build-superpowers:writing-plans'))
    await waitFor(() => expect(postCalls()).toHaveLength(1))
    expect(postBodyOf(0)).toEqual({ phase: 'build', track: 'backend', skills: [], root: '/repo/default' })
  })
})

describe('TrackSettings v3 真实 CRUD', () => {
  it('有未保存 Track 草稿时，取消、Esc 与折叠入口都必须先确认丢弃', async () => {
    await renderMatrix(['build'])
    const toggle = screen.getByTestId('wb-track-settings-toggle')
    fireEvent.click(toggle)
    fireEvent.click(screen.getByTestId('wb-track-edit-qa'))
    const editor = screen.getByTestId('wb-track-editor')
    fireEvent.change(within(editor).getByLabelText('显示名称'), { target: { value: 'QA draft' } })

    fireEvent.click(within(editor).getByRole('button', { name: '关闭' }))
    expect(screen.getByTestId('wb-track-unsaved-draft')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '继续编辑' }))
    expect(within(screen.getByTestId('wb-track-editor')).getByLabelText('显示名称')).toHaveValue('QA draft')

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByTestId('wb-track-unsaved-draft')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '继续编辑' }))
    fireEvent.click(toggle)
    expect(screen.getByTestId('wb-track-unsaved-draft')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '丢弃并离开' }))
    await waitFor(() => expect(screen.queryByTestId('wb-track-settings-panel')).toBeNull())
  })

  it('未保存 Track 草稿阻止直接新建或编辑另一轨道，确认丢弃后才切换', async () => {
    await renderMatrix(['build'])
    fireEvent.click(screen.getByTestId('wb-track-settings-toggle'))
    fireEvent.click(screen.getByTestId('wb-track-edit-qa'))
    fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: 'QA draft' } })

    fireEvent.click(screen.getByTestId('wb-track-create'))
    expect(screen.getByTestId('wb-track-unsaved-draft')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '继续编辑' }))
    expect(within(screen.getByTestId('wb-track-editor')).getByLabelText('轨道 ID')).toHaveValue('qa')
    expect(screen.getByLabelText('显示名称')).toHaveValue('QA draft')

    fireEvent.click(screen.getByTestId('wb-track-edit-frontend'))
    expect(screen.getByTestId('wb-track-unsaved-draft')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '丢弃并离开' }))
    expect(within(screen.getByTestId('wb-track-editor')).getByLabelText('轨道 ID')).toHaveValue('frontend')
  })

  it('所有可编辑 input/select 都有稳定 name，非认证配置文本禁用浏览器自动填充', async () => {
    await renderMatrix(['build'])
    fireEvent.click(screen.getByTestId('wb-track-settings-toggle'))
    fireEvent.click(screen.getByTestId('wb-track-create'))
    const editor = screen.getByTestId('wb-track-editor')
    const controls = Array.from(editor.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select'))
    expect(controls.length).toBeGreaterThan(0)
    for (const control of controls) expect(control.name).not.toBe('')
    for (const input of Array.from(editor.querySelectorAll<HTMLInputElement>('input:not([type="checkbox"])'))) {
      expect(input).toHaveAttribute('autocomplete', 'off')
    }
  })

  it('English 自定义轨编辑器的 Policy template accessible name 不含中文', async () => {
    localStorage.setItem('tenon-dashboard-lang', 'en')
    await renderMatrix(['build'])
    fireEvent.click(screen.getByTestId('wb-track-settings-toggle'))
    fireEvent.click(screen.getByTestId('wb-track-edit-qa'))
    const editor = screen.getByTestId('wb-track-editor')
    expect(within(editor).getByLabelText('Policy template')).toBeInTheDocument()
    expect(within(editor).queryByLabelText('Policy 模板')).toBeNull()
  })

  it('列出完整轨道：不注入默认 Skill 的轨道仍在设置里，系统轨道与沿用关系可见', async () => {
    await renderMatrix(['build'])
    fireEvent.click(screen.getByTestId('wb-track-settings-toggle'))
    const panel = screen.getByTestId('wb-track-settings-panel')
    expect(panel.parentElement).toBe(document.body)
    expect(within(panel).getByRole('dialog', { name: '工作轨道' })).toBeInTheDocument()
    expect(within(panel).getAllByTestId(/^wb-track-setting-/)).toHaveLength(CONFIG_BODY.tracks.length)
    expect(screen.getByTestId('wb-track-setting-chat').querySelector('svg')).not.toBeNull()
    expect(screen.getByTestId('wb-track-setting-chat')).toHaveTextContent('不注入默认 Skill')
    expect(screen.getByTestId('wb-track-setting-observer')).toHaveTextContent('不注入默认 Skill')
    expect(screen.getByTestId('wb-track-setting-qa')).toHaveTextContent('沿用“前端”轨道')
  })

  it('设置面板使用中文任务语言，不把 workflow/routing/skills 原始字段当主界面', async () => {
    await renderMatrix(['build'])
    fireEvent.click(screen.getByTestId('wb-track-settings-toggle'))
    const panel = screen.getByTestId('wb-track-settings-panel')
    expect(panel).toHaveTextContent('工作轨道')
    expect(panel).toHaveTextContent('适用流程')
    expect(panel).toHaveTextContent('默认技能')
    expect(panel).not.toHaveTextContent('Track 设置')
    expect(panel).not.toHaveTextContent('workflow')
    expect(panel).not.toHaveTextContent('routing')
  })

  it('新建 Track 在必填身份为空或非法时禁用保存，填写有效值后才允许提交', async () => {
    await renderMatrix(['build'])
    fireEvent.click(screen.getByTestId('wb-track-settings-toggle'))
    fireEvent.click(screen.getByTestId('wb-track-create'))
    const editor = screen.getByTestId('wb-track-editor')
    const save = within(editor).getByTestId('wb-track-editor-save')

    expect(save).toBeDisabled()
    fireEvent.change(within(editor).getByLabelText('轨道 ID'), { target: { value: 'INVALID ID' } })
    fireEvent.change(within(editor).getByLabelText('显示名称'), { target: { value: 'Release' } })
    expect(save).toBeDisabled()

    fireEvent.change(within(editor).getByLabelText('轨道 ID'), { target: { value: 'release' } })
    expect(save).toBeEnabled()
  })

  it('新建自定义 Track：完整定义连同当前 revision 发往 POST，成功后重拉 config', async () => {
    let configReads = 0
    configResponse = () => {
      configReads += 1
      return new Response(JSON.stringify(CONFIG_BODY), { status: 200 })
    }
    const baseFetch = global.fetch
    global.fetch = vi.fn(async (url: string, opts?: RequestInit) => {
      if (url === '/api/tracks' && opts?.method === 'POST') {
        return new Response(JSON.stringify({
          ok: true,
          revision: 'next-revision',
          source: 'project-file',
          tracks: CONFIG_BODY.tracks,
        }), { status: 200 })
      }
      return baseFetch(url, opts)
    }) as unknown as typeof fetch

    await renderMatrix(['build'])
    fireEvent.click(screen.getByTestId('wb-track-settings-toggle'))
    fireEvent.click(screen.getByTestId('wb-track-create'))
    const editor = screen.getByTestId('wb-track-editor')
    fireEvent.change(within(editor).getByLabelText('轨道 ID'), { target: { value: 'release' } })
    fireEvent.change(within(editor).getByLabelText('显示名称'), { target: { value: 'Release' } })
    fireEvent.change(within(editor).getByLabelText('默认 Workflow'), { target: { value: 'default' } })
    fireEvent.change(within(editor).getByLabelText('Policy 模板'), { target: { value: 'frontend' } })
    fireEvent.click(within(editor).getByLabelText('规格完成后自动进入 AFK'))
    fireEvent.click(within(editor).getByTestId('wb-track-editor-save'))

    await waitFor(() => expect(configReads).toBeGreaterThan(1))
    const call = fetchMock().mock.calls.find(([url, opts]) => url === '/api/tracks' && (opts as RequestInit | undefined)?.method === 'POST')
    expect(call).toBeDefined()
    expect(JSON.parse(String((call?.[1] as RequestInit).body))).toMatchObject({
      root: '/repo/default',
      revision: CONFIG_BODY.revision,
      track: {
        id: 'release', label: 'Release', workflow: { default: 'default', allowed: '*' },
        policyProfile: CONFIG_BODY.tracks.find((track) => track.id === 'frontend')!.policyProfile,
      },
    })
    expect(JSON.parse(String((call?.[1] as RequestInit).body))).toMatchObject({
      track: { policyProfile: { autoEnqueueOnSpecComplete: true } },
    })
  })

  it('自定义 Track 保存前可用未保存草稿跑生产 Router 预览，展示 winner 与全候选分数', async () => {
    const baseFetch = global.fetch
    global.fetch = vi.fn(async (url: string, opts?: RequestInit) => {
      if (url === '/api/router/preview' && opts?.method === 'POST') {
        const body = JSON.parse(String(opts.body)) as { draft_track?: WbTrackDefinition }
        return new Response(JSON.stringify({
          ok: true,
          revision: CONFIG_BODY.revision,
          source: 'project-file',
          suppressed_reason: null,
          winner: { track: body.draft_track, order: 4, priority: 999, score: 2, routable: true, excluded: false },
          candidates: [
            { track: CONFIG_BODY.tracks[2], order: 2, priority: 300, score: 1, routable: true, excluded: false },
            { track: body.draft_track, order: 4, priority: 999, score: 2, routable: true, excluded: false },
          ],
        }), { status: 200 })
      }
      return baseFetch(url, opts)
    }) as unknown as typeof fetch
    await renderMatrix(['build'])
    fireEvent.click(screen.getByTestId('wb-track-settings-toggle'))
    fireEvent.click(screen.getByTestId('wb-track-edit-qa'))
    fireEvent.change(screen.getByLabelText('优先级'), { target: { value: '999' } })
    fireEvent.change(screen.getByLabelText('排除规则（可选）'), { target: { value: '(API|schema)' } })
    fireEvent.change(screen.getByTestId('wb-track-route-prompt'), { target: { value: 'test the css' } })
    fireEvent.click(screen.getByTestId('wb-track-route-preview'))
    const result = await screen.findByTestId('wb-track-route-result')
    expect(result).toHaveTextContent('Quality')
    expect(result).toHaveTextContent('得分 2')
    expect(result).toHaveTextContent('Frontend')
    const call = fetchMock().mock.calls.find(([url]) => url === '/api/router/preview')
    expect(JSON.parse(String((call?.[1] as RequestInit).body))).toMatchObject({
      root: '/repo/default',
      prompt: 'test the css',
      draft_track: {
        id: 'qa',
        policyProfile: {
          routing: {
            enabled: true,
            pattern: '(qa|test)',
            excludePattern: '(API|schema)',
            priority: 999,
          },
        },
      },
    })
  })

  it('同一项目内修改 Track 草稿会使在途 Router 预览失效，旧结果不得覆盖新草稿', async () => {
    const baseFetch = global.fetch
    let resolvePreview!: (response: Response) => void
    const previewResponse = new Promise<Response>((resolve) => { resolvePreview = resolve })
    global.fetch = vi.fn(async (url: string, opts?: RequestInit) => {
      if (url === '/api/router/preview' && opts?.method === 'POST') return previewResponse
      return baseFetch(url, opts)
    }) as unknown as typeof fetch

    await renderMatrix(['build'])
    fireEvent.click(screen.getByTestId('wb-track-settings-toggle'))
    fireEvent.click(screen.getByTestId('wb-track-edit-qa'))
    fireEvent.change(screen.getByTestId('wb-track-route-prompt'), { target: { value: 'test the css' } })
    fireEvent.click(screen.getByTestId('wb-track-route-preview'))
    fireEvent.change(screen.getByLabelText('优先级'), { target: { value: '999' } })

    await act(async () => {
      resolvePreview(new Response(JSON.stringify({
        ok: true,
        revision: CONFIG_BODY.revision,
        source: 'project-file',
        suppressed_reason: null,
        winner: { track: CONFIG_BODY.tracks[4], order: 4, priority: 250, score: 2, routable: true, excluded: false },
        candidates: [],
      }), { status: 200 }))
      await previewResponse
    })

    expect(screen.queryByTestId('wb-track-route-result')).toBeNull()
    expect(screen.getByTestId('wb-track-route-preview')).toBeEnabled()
  })

  it('English Router preview network failure uses localized copy without transport Chinese', async () => {
    localStorage.setItem('tenon-dashboard-lang', 'en')
    const baseFetch = global.fetch
    global.fetch = vi.fn(async (url: string, opts?: RequestInit) => {
      if (url === '/api/router/preview' && opts?.method === 'POST') {
        throw new Error('网络错误：连接被拒绝')
      }
      return baseFetch(url, opts)
    }) as unknown as typeof fetch

    await renderMatrix(['build'])
    fireEvent.click(screen.getByTestId('wb-track-settings-toggle'))
    fireEvent.click(screen.getByTestId('wb-track-edit-qa'))
    fireEvent.change(screen.getByTestId('wb-track-route-prompt'), { target: { value: 'test the css' } })
    fireEvent.click(screen.getByTestId('wb-track-route-preview'))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Network error')
    expect(alert.textContent).not.toMatch(/[\u3400-\u9fff]/u)
  })

  it('English Router preview malformed success is classified as an invalid response', async () => {
    localStorage.setItem('tenon-dashboard-lang', 'en')
    const baseFetch = global.fetch
    global.fetch = vi.fn(async (url: string, opts?: RequestInit) => {
      if (url === '/api/router/preview' && opts?.method === 'POST') {
        return new Response('not json', { status: 200 })
      }
      return baseFetch(url, opts)
    }) as unknown as typeof fetch

    await renderMatrix(['build'])
    fireEvent.click(screen.getByTestId('wb-track-settings-toggle'))
    fireEvent.click(screen.getByTestId('wb-track-edit-qa'))
    fireEvent.change(screen.getByTestId('wb-track-route-prompt'), { target: { value: 'test the css' } })
    fireEvent.click(screen.getByTestId('wb-track-route-preview'))

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid server response.')
  })

  it('English Track save non-JSON HTTP failure uses localized status without endpoint fallback Chinese', async () => {
    localStorage.setItem('tenon-dashboard-lang', 'en')
    const baseFetch = global.fetch
    global.fetch = vi.fn(async (url: string, opts?: RequestInit) => {
      if (url === '/api/tracks/qa' && opts?.method === 'PATCH') {
        return new Response('upstream unavailable', { status: 503 })
      }
      return baseFetch(url, opts)
    }) as unknown as typeof fetch

    await renderMatrix(['build'])
    fireEvent.click(screen.getByTestId('wb-track-settings-toggle'))
    fireEvent.click(screen.getByTestId('wb-track-edit-qa'))
    fireEvent.click(screen.getByTestId('wb-track-editor-save'))

    const alert = await screen.findByTestId('wb-track-editor-error')
    expect(alert).toHaveTextContent('Request failed (HTTP 503).')
    expect(alert.textContent).not.toMatch(/[\u3400-\u9fff]/u)
  })

  it('English Track failure suppresses server-authored reference and blocker prose', async () => {
    localStorage.setItem('tenon-dashboard-lang', 'en')
    const baseFetch = global.fetch
    global.fetch = vi.fn(async (url: string, opts?: RequestInit) => {
      if (url === '/api/tracks/qa' && opts?.method === 'PATCH') {
        return new Response(JSON.stringify({
          ok: false,
          error: '轨道仍被引用',
          references: ['生产 Change'],
          blockers: ['请先完成迁移'],
        }), { status: 409 })
      }
      return baseFetch(url, opts)
    }) as unknown as typeof fetch

    await renderMatrix(['build'])
    fireEvent.click(screen.getByTestId('wb-track-settings-toggle'))
    fireEvent.click(screen.getByTestId('wb-track-edit-qa'))
    fireEvent.click(screen.getByTestId('wb-track-editor-save'))

    const alert = await screen.findByTestId('wb-track-editor-error')
    expect(alert).toHaveTextContent('Request failed (HTTP 409).')
    expect(alert.textContent).not.toMatch(/[\u3400-\u9fff]/u)
  })

  it.each([
    ['non-JSON', () => new Response('not json', { status: 200 })],
    ['empty body', () => new Response(null, { status: 200 })],
    ['ok false', () => new Response(JSON.stringify({ ok: false, error: 'not success' }), { status: 200 })],
    ['wrong revision field', () => new Response(JSON.stringify({
      ok: true,
      revision: 42,
      source: 'project-file',
      tracks: CONFIG_BODY.tracks,
    }), { status: 200 })],
    ['missing source', () => new Response(JSON.stringify({
      ok: true,
      revision: 'next',
      tracks: CONFIG_BODY.tracks,
    }), { status: 200 })],
  ])('Track save 2xx %s fails closed, keeps the draft, and uses current-language invalid-response copy', async (_case, response) => {
    localStorage.setItem('tenon-dashboard-lang', 'en')
    const baseFetch = global.fetch
    global.fetch = vi.fn(async (url: string, opts?: RequestInit) => {
      if (url === '/api/tracks/qa' && opts?.method === 'PATCH') return response()
      return baseFetch(url, opts)
    }) as unknown as typeof fetch

    await renderMatrix(['build'])
    fireEvent.click(screen.getByTestId('wb-track-settings-toggle'))
    fireEvent.click(screen.getByTestId('wb-track-edit-qa'))
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Unsaved draft' } })
    fireEvent.click(screen.getByTestId('wb-track-editor-save'))

    expect(await screen.findByTestId('wb-track-editor-error')).toHaveTextContent('Invalid server response.')
    expect(screen.getByTestId('wb-track-editor')).toBeInTheDocument()
    expect(screen.getByLabelText('Display name')).toHaveValue('Unsaved draft')
  })

  it('Track 保存请求在途时禁止切换编辑器，响应只回写原 Track', async () => {
    const user = userEvent.setup()
    const baseFetch = global.fetch
    let releaseA!: (response: Response) => void
    const pendingA = new Promise<Response>((resolve) => { releaseA = resolve })
    global.fetch = vi.fn(async (url: string, opts?: RequestInit) => {
      if (url === '/api/tracks/qa' && opts?.method === 'PATCH') return pendingA
      return baseFetch(url, opts)
    }) as unknown as typeof fetch

    await renderMatrix(['build'])
    fireEvent.click(screen.getByTestId('wb-track-settings-toggle'))
    fireEvent.click(screen.getByTestId('wb-track-edit-qa'))
    const label = screen.getByLabelText('显示名称')
    fireEvent.change(label, { target: { value: 'Quality request' } })
    await user.click(screen.getByTestId('wb-track-editor-save'))

    const editor = screen.getByTestId('wb-track-editor')
    expect(Array.from(editor.querySelectorAll('input, select, button'))).not.toHaveLength(0)
    for (const control of editor.querySelectorAll('input, select, button')) {
      expect(control).toBeDisabled()
    }
    expect(within(editor).getByLabelText('显示名称')).toBeDisabled()
    expect(within(editor).getByLabelText('默认 Workflow')).toBeDisabled()
    expect(within(editor).getByLabelText('允许任意 Workflow')).toBeDisabled()
    expect(within(editor).getByTestId('wb-track-route-prompt')).toBeDisabled()
    expect(within(editor).getByTestId('wb-track-route-preview')).toBeDisabled()
    expect(within(editor).getByRole('button', { name: '关闭' })).toBeDisabled()
    expect(within(editor).getByTestId('wb-track-editor-delete')).toBeDisabled()
    expect(within(editor).getByTestId('wb-track-editor-save')).toBeDisabled()
    expect(screen.getByTestId('wb-track-edit-frontend')).toBeDisabled()
    expect(screen.getByLabelText('关闭轨道设置')).toBeDisabled()
    const patchCall = fetchMock().mock.calls.find(([url, opts]) => url === '/api/tracks/qa' && (opts as RequestInit | undefined)?.method === 'PATCH')
    const frozenRequestBody = String((patchCall?.[1] as RequestInit).body)
    expect(JSON.parse(frozenRequestBody)).toMatchObject({ patch: { label: 'Quality request' } })

    await user.type(label, ' blocked edit')
    await user.keyboard('{Escape}')
    await user.click(screen.getByTestId('wb-track-settings-panel'))
    await user.click(screen.getByLabelText('关闭轨道设置'))
    await user.click(screen.getByTestId('wb-track-edit-frontend'))
    expect(within(screen.getByTestId('wb-track-editor')).getByLabelText('轨道 ID')).toHaveValue('qa')
    expect(label).toHaveValue('Quality request')
    expect(String((patchCall?.[1] as RequestInit).body)).toBe(frozenRequestBody)
    expect(screen.getByTestId('wb-track-editor-save')).toBeDisabled()

    await act(async () => {
      releaseA(new Response(JSON.stringify({ ok: false, error: 'A save error' }), { status: 409 }))
      await pendingA
    })
    expect(screen.getByTestId('wb-track-editor')).toBeInTheDocument()
    expect(within(screen.getByTestId('wb-track-editor')).getByLabelText('轨道 ID')).toHaveValue('qa')
    expect(label).toBeEnabled()
    await waitFor(() => expect(screen.getByTestId('wb-track-editor-save')).toHaveFocus())
    expect(screen.getByTestId('wb-track-editor-error')).toHaveTextContent('A save error')
    fireEvent.click(screen.getByTestId('wb-track-edit-frontend'))
    expect(screen.getByTestId('wb-track-unsaved-draft')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '丢弃并离开' }))
    expect(within(screen.getByTestId('wb-track-editor')).getByLabelText('轨道 ID')).toHaveValue('frontend')
  })

  it('Track 删除请求在途时禁止切换编辑器，错误保留在原 Track', async () => {
    const baseFetch = global.fetch
    let releaseDelete!: (response: Response) => void
    const pendingDelete = new Promise<Response>((resolve) => { releaseDelete = resolve })
    global.fetch = vi.fn(async (url: string, opts?: RequestInit) => {
      if (url.startsWith('/api/tracks/qa?') && opts?.method === 'DELETE') return pendingDelete
      return baseFetch(url, opts)
    }) as unknown as typeof fetch

    await renderMatrix(['build'])
    fireEvent.click(screen.getByTestId('wb-track-settings-toggle'))
    fireEvent.click(screen.getByTestId('wb-track-edit-qa'))
    fireEvent.click(screen.getByTestId('wb-track-editor-delete'))
    fireEvent.click(screen.getByTestId('wb-track-delete-confirm'))

    fireEvent.click(screen.getByTestId('wb-track-edit-frontend'))
    expect(within(screen.getByTestId('wb-track-editor')).getByLabelText('轨道 ID')).toHaveValue('qa')
    expect(screen.getByTestId('wb-track-delete-confirm')).toBeDisabled()

    await act(async () => {
      releaseDelete(new Response(JSON.stringify({ ok: false, error: 'delete error' }), { status: 409 }))
      await pendingDelete
    })
    expect(within(screen.getByTestId('wb-track-editor')).getByLabelText('轨道 ID')).toHaveValue('qa')
    expect(screen.getByTestId('wb-track-editor-error')).toHaveTextContent('delete error')
    fireEvent.click(screen.getByTestId('wb-track-edit-frontend'))
    expect(within(screen.getByTestId('wb-track-editor')).getByLabelText('轨道 ID')).toHaveValue('frontend')
  })

  it('Track A 保存成功后重拉 authority 并推进 revision，随后 Track B 使用新 revision', async () => {
    const user = userEvent.setup()
    let configReads = 0
    let currentRevision = CONFIG_BODY.revision
    configResponse = () => {
      configReads += 1
      return new Response(JSON.stringify({ ...CONFIG_BODY, revision: currentRevision }), { status: 200 })
    }
    const baseFetch = global.fetch
    let releaseA!: (response: Response) => void
    const pendingA = new Promise<Response>((resolve) => { releaseA = resolve })
    const pendingB = new Promise<Response>(() => {})
    global.fetch = vi.fn(async (url: string, opts?: RequestInit) => {
      if (url === '/api/tracks/qa' && opts?.method === 'PATCH') return pendingA
      if (url === '/api/tracks/frontend' && opts?.method === 'PATCH') return pendingB
      return baseFetch(url, opts)
    }) as unknown as typeof fetch

    await renderMatrix(['build'])
    fireEvent.click(screen.getByTestId('wb-track-settings-toggle'))
    fireEvent.click(screen.getByTestId('wb-track-edit-qa'))
    await user.click(screen.getByTestId('wb-track-editor-save'))
    const firstPatch = fetchMock().mock.calls.find(([url, opts]) => url === '/api/tracks/qa' && (opts as RequestInit | undefined)?.method === 'PATCH')
    const frozenRequestBody = String((firstPatch?.[1] as RequestInit).body)
    await user.keyboard('{Escape}')
    await user.click(screen.getByTestId('wb-track-settings-panel'))
    await user.click(screen.getByLabelText('关闭轨道设置'))
    await user.click(screen.getByTestId('wb-track-edit-frontend'))
    expect(within(screen.getByTestId('wb-track-editor')).getByLabelText('轨道 ID')).toHaveValue('qa')
    expect(String((firstPatch?.[1] as RequestInit).body)).toBe(frozenRequestBody)

    currentRevision = 'revision-after-a'
    await act(async () => {
      releaseA(new Response(JSON.stringify({
        ok: true,
        revision: currentRevision,
        source: 'project-file',
        tracks: CONFIG_BODY.tracks,
      }), { status: 200 }))
      await pendingA
    })
    await waitFor(() => expect(configReads).toBeGreaterThan(1))
    await waitFor(() => expect(screen.queryByTestId('wb-track-editor')).toBeNull())
    expect(screen.getByTestId('wb-track-settings-panel')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('wb-track-edit-frontend'))
    expect(within(screen.getByTestId('wb-track-editor')).getByLabelText('轨道 ID')).toHaveValue('frontend')

    fireEvent.click(screen.getByTestId('wb-track-editor-save'))
    await waitFor(() => expect(fetchMock().mock.calls.some(([url, opts]) =>
      url === '/api/tracks/frontend'
      && (opts as RequestInit | undefined)?.method === 'PATCH'
      && JSON.parse(String((opts as RequestInit).body)).revision === currentRevision)).toBe(true))
  })

  it('内建轨编辑器锁住 ID/policy/delete，只 PATCH label 与 workflow', async () => {
    const baseFetch = global.fetch
    global.fetch = vi.fn(async (url: string, opts?: RequestInit) => {
      if (url === '/api/tracks/frontend' && opts?.method === 'PATCH') {
        return new Response(JSON.stringify({
          ok: true,
          revision: 'next',
          source: 'project-file',
          tracks: CONFIG_BODY.tracks,
        }), { status: 200 })
      }
      return baseFetch(url, opts)
    }) as unknown as typeof fetch
    await renderMatrix(['build'])
    fireEvent.click(screen.getByTestId('wb-track-settings-toggle'))
    fireEvent.click(screen.getByTestId('wb-track-edit-frontend'))
    const editor = screen.getByTestId('wb-track-editor')
    expect(within(editor).getByLabelText('轨道 ID')).toBeDisabled()
    expect(within(editor).queryByLabelText('Policy 模板')).toBeNull()
    expect(within(editor).queryByTestId('wb-track-editor-delete')).toBeNull()
    fireEvent.change(within(editor).getByLabelText('显示名称'), { target: { value: 'Web UI' } })
    fireEvent.click(within(editor).getByTestId('wb-track-editor-save'))
    await waitFor(() => expect(fetchMock().mock.calls.some(([url, opts]) =>
      url === '/api/tracks/frontend' && (opts as RequestInit | undefined)?.method === 'PATCH')).toBe(true))
  })

  it('删除自定义轨遇到活跃 Change 引用：409 来源展示，卡片不消失', async () => {
    const baseFetch = global.fetch
    global.fetch = vi.fn(async (url: string, opts?: RequestInit) => {
      if (url.startsWith('/api/tracks/qa?') && opts?.method === 'DELETE') {
        return new Response(JSON.stringify({
          ok: false, code: 'TRACK_REFERENCED', error: "track 'qa' 仍被引用", references: ['qa-change'],
        }), { status: 409 })
      }
      return baseFetch(url, opts)
    }) as unknown as typeof fetch
    await renderMatrix(['build'])
    fireEvent.click(screen.getByTestId('wb-track-settings-toggle'))
    fireEvent.click(screen.getByTestId('wb-track-edit-qa'))
    fireEvent.click(screen.getByTestId('wb-track-editor-delete'))
    fireEvent.click(screen.getByTestId('wb-track-delete-confirm'))
    expect(await screen.findByTestId('wb-track-editor-error')).toHaveTextContent('qa-change')
    expect(screen.getByTestId('wb-track-setting-qa')).toBeInTheDocument()
  })

  it('设置入口是可聚焦 button，开合状态用 aria-expanded 暴露给键盘/读屏', async () => {
    await renderMatrix(['build'])
    const toggle = screen.getByTestId('wb-track-settings-toggle')
    toggle.focus()
    expect(toggle).toHaveFocus()
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
  })
})

describe('LaneMandatorySkills §4.6 Skill 原名优先、用途可追溯', () => {
  it('chip 显示真实 Skill 名，中文用途保留在 hover title', async () => {
    await renderMatrix(['build'])
    fireEvent.click(screen.getByTestId('wb-track-frontend'))
    const chip = screen.getByTestId('wb-mand-chip-build-superpowers:test-driven-development')
    expect(chip.textContent).toContain('superpowers:test-driven-development')
    expect(chip.textContent).not.toContain('…')
    expect(chip.textContent).not.toContain('...')
    expect(chip.title).toContain('测试驱动实现')
  })

  it('用途名称不带 truncate / text-ellipsis', async () => {
    await renderMatrix(['build'])
    fireEvent.click(screen.getByTestId('wb-track-frontend'))
    for (const id of ['superpowers:test-driven-development', 'web-design-guidelines']) {
      const chip = screen.getByTestId(`wb-mand-chip-build-${id}`)
      expect(chip.className).not.toContain('truncate')
      expect(chip.className).not.toContain('text-ellipsis')
      expect(chip.title).toContain('当前来源只提供本阶段需要的 Skill')
    }
  })

  it('整个技能区无截断，候选面板显示真实 Skill 名并在 hover 解释用途', async () => {
    await renderMatrix(['build'])
    fireEvent.click(screen.getByTestId('wb-track-frontend'))
    await waitAddReady('build')
    fireEvent.click(screen.getByTestId('wb-mand-add-build'))
    const zone = screen.getByTestId('wb-mand-build')
    expect(zone.querySelectorAll('.truncate, .text-ellipsis')).toHaveLength(0)
    const opt = screen.getByTestId('wb-mand-opt-build-superpowers:verification-before-completion')
    expect(opt.textContent).toContain('superpowers:verification-before-completion')
    expect(opt.title).toContain('完成前证据复核')
    expect(opt.textContent).toContain('未装')
    // 兜底：不得出现 +N 形态的「还有几个没显示」计数
    expect(zone.textContent).not.toMatch(/\+\d+/)
  })
})
