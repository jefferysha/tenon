/**
 * 轨道设置：新建轨道时选「规范」（OpenSpec / 无）与填「关键词」，或在左栏 ⋯ → 轨道设置里改已有轨道；改动进草稿，
 * 保存条的「保存」走 POST /api/workflows/:name，请求体里分支带 spec 与 route.keywords，其余 route 项原样保留。
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WbStepDef, WbWorkflowDef } from '../api/governanceTypes'
import { I18nProvider } from '../i18n'
import { TooltipProvider } from '@/components/ui/tooltip'
import { WorkflowView } from './WorkflowView'

vi.mock('@xyflow/react', () => import('./reactFlowTestDouble'))
vi.mock('@xyflow/react/dist/style.css', () => ({}))

function stage(id: string, label: string, next: string | null): WbStepDef {
  return { id, label, gate: 'auto', skills: [], inputs: [], outputs: [], guards: [], transitions: next === null ? [] : [{ event: `${id}-complete`, to: next }] }
}

const CONTRACT = { version: 'v1' as const, slots: [{ kind: 'proposal', ownerStep: 'a1', producers: [] }], reads: [] }
const ROUTE = { keywords: ['甲'], exclude: ['乙'], priority: 300, fallback: true }

const GOVERNED: WbWorkflowDef = {
  name: 'flow',
  openspec: true,
  steps: [],
  tracks: {
    alpha: { label: '甲', route: ROUTE, documentContract: CONTRACT, steps: [stage('a1', '一', 'a2'), stage('a2', '二', null)] },
    lite: { label: '轻', spec: 'none', steps: [stage('l1', '做', null)] },
  },
}

let posted: WbWorkflowDef | undefined

function stubApi(def: WbWorkflowDef = GOVERNED): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/workflows?root=') return new Response(JSON.stringify({ names: ['flow'], default: { source: 'builtin' } }), { status: 200 })
    if (url === '/api/workflows/flow?root=') return new Response(JSON.stringify(def), { status: 200 })
    if (url === '/api/workflows/default?root=') return new Response(JSON.stringify({ name: 'default', source: 'builtin', steps: [stage('open', '立项', null)] }), { status: 200 })
    if (init?.method === 'POST' && url === '/api/workflows/flow') {
      posted = JSON.parse(String(init.body)) as WbWorkflowDef
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    if (url === '/api/agents') return new Response(JSON.stringify({ agents: [] }), { status: 200 })
    return new Response(JSON.stringify({ ok: false, error: { code: 'not_found' } }), { status: 404 })
  }))
}

/** 等到定义加载完（有阶段了）再返回：加载前左栏会先画一个「没有轨道」的新建入口，点它不是点「+」。 */
async function mount(firstStep = 'a1'): Promise<void> {
  window.history.replaceState(null, '', `/?view=workbench&wf=flow&track=alpha&step=${firstStep}`)
  render(<I18nProvider><TooltipProvider><WorkflowView root="" /></TooltipProvider></I18nProvider>)
  await screen.findByTestId(`wb-step-${firstStep}`)
}

async function openTrackSettings(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByTestId('wb-wf-menu'))
  await user.click(await screen.findByTestId('wb-wf-menu-track-settings'))
}

beforeEach(() => {
  posted = undefined
  ;(window as unknown as { __TENON_DASHBOARD_TOKEN__?: string }).__TENON_DASHBOARD_TOKEN__ = 'test-token'
  stubApi()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.history.replaceState(null, '', '/')
})

describe('WorkflowView · 新建轨道带规范与关键词', () => {
  it('选「无」并填关键词，保存的请求体里新分支有 spec: none 与 route.keywords，没有文档契约', async () => {
    const user = userEvent.setup()
    await mount()
    await user.click(screen.getByTestId('wb-track-new'))
    expect(screen.getByTestId('track-dialog-spec-openspec')).toHaveAttribute('aria-checked', 'true')
    await user.click(screen.getByTestId('track-dialog-spec-none'))
    await user.type(screen.getByTestId('track-dialog-id'), 'quick')
    await user.type(screen.getByTestId('track-dialog-keywords'), '修复, typo')
    await user.click(screen.getByTestId('track-dialog-submit'))
    expect(screen.queryByTestId('track-dialog')).toBeNull()
    await user.click(screen.getByTestId('wb-save'))
    await waitFor(() => expect(posted).toBeDefined())
    expect(posted?.tracks?.quick?.spec).toBe('none')
    expect(posted?.tracks?.quick?.route?.keywords).toEqual(['修复', 'typo'])
    expect(posted?.tracks?.quick).not.toHaveProperty('documentContract')
    // 来源分支（当前轨道）不受影响。
    expect(posted?.tracks?.alpha).toEqual(GOVERNED.tracks?.alpha)
  })

  it('保持缺省（OpenSpec、无关键词）：新分支不写 spec 也不写 route，旧文件的形状不变', async () => {
    const user = userEvent.setup()
    await mount()
    await user.click(screen.getByTestId('wb-track-new'))
    await user.type(screen.getByTestId('track-dialog-id'), 'plain{Enter}')
    await user.click(screen.getByTestId('wb-save'))
    await waitFor(() => expect(posted).toBeDefined())
    expect(posted?.tracks?.plain).not.toHaveProperty('spec')
    expect(posted?.tracks?.plain).not.toHaveProperty('route')
    expect(posted?.tracks?.plain?.documentContract).toEqual(CONTRACT)
  })

  it('从规范为「无」的轨道上新建：缺省选中「无」，新分支显式写 spec: none（顶层是 OpenSpec）', async () => {
    const user = userEvent.setup()
    window.history.replaceState(null, '', '/?view=workbench&wf=flow&track=lite&step=l1')
    render(<I18nProvider><TooltipProvider><WorkflowView root="" /></TooltipProvider></I18nProvider>)
    await screen.findByTestId('wb-step-l1')
    await user.click(screen.getByTestId('wb-track-new'))
    expect(screen.getByTestId('track-dialog-spec-none')).toHaveAttribute('aria-checked', 'true')
    await user.type(screen.getByTestId('track-dialog-id'), 'quick2{Enter}')
    await user.click(screen.getByTestId('wb-save'))
    await waitFor(() => expect(posted).toBeDefined())
    expect(posted?.tracks?.quick2?.spec).toBe('none')
  })
})

describe('WorkflowView · 轨道设置（改已有轨道）', () => {
  it('左栏 ⋯ → 轨道设置：预填现值；改关键词保存，route 的排除词 / 优先级 / 兜底原样写回', async () => {
    const user = userEvent.setup()
    await mount()
    await openTrackSettings(user)
    expect(screen.getByRole('dialog', { name: '轨道设置' })).toBeInTheDocument()
    expect(screen.getByTestId('track-dialog-keywords')).toHaveValue('甲')
    await user.clear(screen.getByTestId('track-dialog-keywords'))
    await user.type(screen.getByTestId('track-dialog-keywords'), '甲, 子')
    await user.click(screen.getByTestId('track-dialog-submit'))
    expect(screen.getByTestId('wb-dirty').textContent).toBe('未保存 1 处')
    await user.click(screen.getByTestId('wb-save'))
    await waitFor(() => expect(posted).toBeDefined())
    expect(posted?.tracks?.alpha?.route).toEqual({ ...ROUTE, keywords: ['甲', '子'] })
    expect(posted?.tracks?.alpha?.documentContract).toEqual(CONTRACT)
    expect(posted?.tracks?.lite).toEqual(GOVERNED.tracks?.lite)
  })

  it('把已有轨道改成「无」：写 spec: none 并去掉该分支的文档契约，算 1 处改动', async () => {
    const user = userEvent.setup()
    await mount()
    await openTrackSettings(user)
    await user.click(screen.getByTestId('track-dialog-spec-none'))
    await user.click(screen.getByTestId('track-dialog-submit'))
    expect(screen.getByTestId('wb-dirty').textContent).toBe('未保存 1 处')
    await user.click(screen.getByTestId('wb-save'))
    await waitFor(() => expect(posted).toBeDefined())
    expect(posted?.tracks?.alpha?.spec).toBe('none')
    expect(posted?.tracks?.alpha).not.toHaveProperty('documentContract')
  })

  it('没改动不能保存；取消后草稿不变', async () => {
    const user = userEvent.setup()
    await mount()
    await openTrackSettings(user)
    expect(screen.getByTestId('track-dialog-submit')).toBeDisabled()
    await user.click(screen.getByTestId('track-dialog-cancel'))
    expect(screen.queryByTestId('track-dialog')).toBeNull()
    expect(screen.queryByTestId('wb-dirty')).toBeNull()
  })

  it('没有写凭证时轨道设置置灰', async () => {
    delete (window as unknown as { __TENON_DASHBOARD_TOKEN__?: string }).__TENON_DASHBOARD_TOKEN__
    const user = userEvent.setup()
    await mount()
    await user.click(screen.getByTestId('wb-wf-menu'))
    expect(await screen.findByTestId('wb-wf-menu-track-settings')).toHaveAttribute('data-disabled')
  })

  it('平铺工作流（没有轨道）的 ⋯ 里没有轨道设置', async () => {
    const user = userEvent.setup()
    stubApi({ name: 'flow', steps: [stage('s1', '一', null)] })
    window.history.replaceState(null, '', '/?view=workbench&wf=flow&step=s1')
    render(<I18nProvider><TooltipProvider><WorkflowView root="" /></TooltipProvider></I18nProvider>)
    await screen.findByTestId('wb-step-s1')
    await user.click(screen.getByTestId('wb-wf-menu'))
    await screen.findByTestId('wb-wf-menu-new')
    expect(screen.queryByTestId('wb-wf-menu-track-settings')).toBeNull()
  })
})
