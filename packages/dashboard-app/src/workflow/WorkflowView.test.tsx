import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WbStepDef, WbWorkflowDef } from '../api/governanceTypes'
import { I18nProvider } from '../i18n'
import { TooltipProvider } from '@/components/ui/tooltip'
import { WorkflowView } from './WorkflowView'

vi.mock('@xyflow/react', () => import('./reactFlowTestDouble'))
vi.mock('@xyflow/react/dist/style.css', () => ({}))

function stage(id: string, label: string, next: string | null): WbStepDef {
  return { id, label, gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: next === null ? [] : [{ event: `${id}-complete`, to: next }] }
}

const FLOW: WbWorkflowDef = {
  name: 'flow',
  steps: [],
  tracks: {
    alpha: { label: '甲', steps: [stage('a1', '一', 'a2'), stage('a2', '二', null)] },
    beta: { label: '乙', steps: [stage('b1', '起', 'b2'), stage('b2', '承', 'b3'), stage('b3', '转', null)] },
  },
}

const DEFAULT: WbWorkflowDef = { name: 'default', steps: [stage('open', '立项', 'build'), stage('build', '实现', null)] }
const SIMPLE: WbWorkflowDef = { name: 'simple', steps: [stage('change', 'Change', 'verify'), stage('verify', 'Verify', null)] }

type Handler = (url: string, init?: RequestInit) => Response | undefined

function stubApi(extra?: Handler): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const custom = extra?.(url, init)
    if (custom !== undefined) return custom
    if (url === '/api/workflows?root=') return new Response(JSON.stringify({ names: ['flow'], default: { source: 'builtin' } }), { status: 200 })
    if (url === '/api/workflows/flow?root=') return new Response(JSON.stringify(FLOW), { status: 200 })
    if (url === '/api/workflows/default?root=') return new Response(JSON.stringify({ ...DEFAULT, source: 'builtin' }), { status: 200 })
    if (url === '/api/workflows/simple?root=') return new Response(JSON.stringify({ ...SIMPLE, source: 'builtin' }), { status: 200 })
    if (url === '/api/agents') return new Response(JSON.stringify({ agents: [] }), { status: 200 })
    return new Response(JSON.stringify({ ok: false, error: { code: 'not_found' } }), { status: 404 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => {
  ;(window as unknown as { __TENON_DASHBOARD_TOKEN__?: string }).__TENON_DASHBOARD_TOKEN__ = 'test-token'
  stubApi()
})
afterEach(() => {
  vi.unstubAllGlobals()
  window.history.replaceState(null, '', '/')
})

function params(): URLSearchParams {
  return new URLSearchParams(window.location.search)
}

describe('WorkflowView · URL 记住工作流 / 轨道 / 阶段', () => {
  it('深链 ?wf=&track=&step= 直接落到那个阶段', async () => {
    window.history.replaceState(null, '', '/?view=workbench&wf=flow&track=beta&step=b2')
    render(<I18nProvider><TooltipProvider><WorkflowView root="" /></TooltipProvider></I18nProvider>)
    expect(await screen.findByTestId('wb-step-b2')).toHaveAttribute('aria-current', 'true')
    expect(screen.getByTestId('wb-track-beta')).toHaveAttribute('aria-selected', 'true')
    expect(params().get('view')).toBe('workbench')
  })

  it('深链点名的工作流不存在：落到 default，并把 URL 改成实际选择', async () => {
    window.history.replaceState(null, '', '/?view=workbench&wf=ghost&step=zz')
    render(<I18nProvider><TooltipProvider><WorkflowView root="" /></TooltipProvider></I18nProvider>)
    expect(await screen.findByTestId('wb-step-open')).toHaveAttribute('aria-current', 'true')
    await waitFor(() => expect(params().get('wf')).toBe('default'))
    expect(params().get('step')).toBe('open')
  })

  it('没有深链：有自定义工作流也打开 default', async () => {
    render(<I18nProvider><TooltipProvider><WorkflowView root="" /></TooltipProvider></I18nProvider>)
    expect(await screen.findByTestId('wb-step-open')).toBeInTheDocument()
    expect(screen.getByTestId('wb-wf-switch')).toHaveTextContent('default')
  })

  it('换轨道、选阶段都写回 URL（replace，不加历史项），外部 query 原样保留', async () => {
    const user = userEvent.setup()
    window.history.replaceState(null, '', '/?view=workbench&wf=flow&debug=1')
    const length = window.history.length
    render(<I18nProvider><TooltipProvider><WorkflowView root="" /></TooltipProvider></I18nProvider>)
    await screen.findByTestId('wb-step-a1')
    await waitFor(() => expect(params().get('wf')).toBe('flow'))
    expect(params().get('track')).toBe('alpha')
    await user.click(screen.getByTestId('wb-track-beta'))
    await user.click(await screen.findByTestId('wb-step-b3'))
    await waitFor(() => expect(params().get('step')).toBe('b3'))
    expect(params().get('track')).toBe('beta')
    expect(params().get('debug')).toBe('1')
    expect(window.history.length).toBe(length)
  })
})

describe('WorkflowView · 删除阶段', () => {
  it('左栏阶段 ⋯ → 删除阶段 → 确认框（标题点名）→ 阶段消失，保存条写出改动数', async () => {
    const user = userEvent.setup()
    window.history.replaceState(null, '', '/?view=workbench&wf=flow&track=beta&step=b2')
    render(<I18nProvider><TooltipProvider><WorkflowView root="" /></TooltipProvider></I18nProvider>)
    await user.click(await screen.findByTestId('wb-stage-menu-b2'))
    await user.click(screen.getByTestId('wb-stage-delete-b2'))
    expect(screen.getByTestId('stage-delete-dialog')).toHaveTextContent('删除「承」？')
    await user.click(screen.getByTestId('stage-delete-confirm'))
    await waitFor(() => expect(screen.queryByTestId('wb-step-b2')).toBeNull())
    expect(screen.getByTestId('wb-dirty').textContent).toMatch(/^未保存 \d+ 处$/u)
  })

  it('取消确认框不删', async () => {
    const user = userEvent.setup()
    window.history.replaceState(null, '', '/?view=workbench&wf=flow&track=beta&step=b2')
    render(<I18nProvider><TooltipProvider><WorkflowView root="" /></TooltipProvider></I18nProvider>)
    await user.click(await screen.findByTestId('wb-stage-menu-b2'))
    await user.click(screen.getByTestId('wb-stage-delete-b2'))
    await user.click(screen.getByTestId('stage-delete-cancel'))
    expect(screen.queryByTestId('stage-delete-dialog')).toBeNull()
    expect(screen.getByTestId('wb-step-b2')).toBeInTheDocument()
  })
})

describe('WorkflowView · 切换器列出全部内建', () => {
  it('切换器含 default、自定义与插件内建 simple；打开 simple 只读（没有添加阶段、不报缺凭证）', async () => {
    const user = userEvent.setup()
    render(<I18nProvider><TooltipProvider><WorkflowView root="" /></TooltipProvider></I18nProvider>)
    await screen.findByTestId('wb-step-open')
    await user.click(screen.getByTestId('wb-wf-switch'))
    expect(screen.getByTestId('wb-wf-item-default')).toBeInTheDocument()
    expect(screen.getByTestId('wb-wf-item-flow')).toBeInTheDocument()
    await user.click(screen.getByTestId('wb-wf-item-simple'))
    expect(await screen.findByTestId('wb-step-change')).toBeInTheDocument()
    expect(screen.getByTestId('wb-wf-lock')).toBeInTheDocument()
    expect(screen.queryByTestId('wb-add-stage')).toBeNull()
    expect(screen.queryByTestId('wb-no-token')).toBeNull()
    expect(screen.getByTestId('wb-lane-name-input-change')).toBeDisabled()
  })

  it('深链 ?wf=simple 直接打开内建 simple', async () => {
    window.history.replaceState(null, '', '/?view=workbench&wf=simple')
    render(<I18nProvider><TooltipProvider><WorkflowView root="" /></TooltipProvider></I18nProvider>)
    expect(await screen.findByTestId('wb-step-change')).toBeInTheDocument()
  })
})

describe('WorkflowView · 添加阶段只填名称', () => {
  it('对话框只有名称；id 由名称自动生成（slug），插在所选阶段之后', async () => {
    const user = userEvent.setup()
    window.history.replaceState(null, '', '/?view=workbench&wf=flow&track=alpha&step=a1')
    render(<I18nProvider><TooltipProvider><WorkflowView root="" /></TooltipProvider></I18nProvider>)
    await user.click(await screen.findByTestId('wb-add-stage'))
    expect(screen.queryByTestId('wb-add-stage-id')).toBeNull()
    expect(screen.getByTestId('wb-add-stage-confirm')).toBeDisabled()
    await user.type(screen.getByTestId('wb-add-stage-name'), 'Code Review')
    await user.click(screen.getByTestId('wb-add-stage-confirm'))
    expect(await screen.findByTestId('wb-step-code-review')).toHaveAttribute('aria-current', 'true')
    const order = [...screen.getByTestId('stage-list-items').querySelectorAll('[data-testid^="wb-step-"]')].map((node) => node.getAttribute('data-testid'))
    expect(order).toEqual(['wb-step-a1', 'wb-step-code-review', 'wb-step-a2'])
  })

  it('纯中文名 → stage；重名依次 -2', async () => {
    const user = userEvent.setup()
    window.history.replaceState(null, '', '/?view=workbench&wf=flow&track=alpha&step=a2')
    render(<I18nProvider><TooltipProvider><WorkflowView root="" /></TooltipProvider></I18nProvider>)
    for (const name of ['评审', '复核']) {
      await user.click(await screen.findByTestId('wb-add-stage'))
      await user.type(screen.getByTestId('wb-add-stage-name'), name)
      await user.click(screen.getByTestId('wb-add-stage-confirm'))
    }
    expect(await screen.findByTestId('wb-step-stage')).toHaveTextContent('评审')
    expect(screen.getByTestId('wb-step-stage-2')).toHaveTextContent('复核')
  })
})

describe('WorkflowView · 删除工作流', () => {
  async function openDelete(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await user.click(await screen.findByTestId('wb-wf-menu'))
    await user.click(screen.getByTestId('wb-wf-menu-delete'))
  }

  it('被任务引用：拒绝删除，逐个列出任务（与轨道），确认按钮随即置灰，不 toast', async () => {
    const user = userEvent.setup()
    const onToast = vi.fn()
    stubApi((url, init) => init?.method === 'DELETE' && url === '/api/workflows/flow?root='
      ? new Response(JSON.stringify({
        ok: false, code: 'WORKFLOW_REFERENCED', workflow: 'flow',
        references: [
          { kind: 'active-change', source: 'change:login-fix' },
          { kind: 'active-change', source: 'change:pay-v2' },
          { kind: 'track-default', source: 'track:chat' },
          { kind: 'track-allowed', source: 'track:chat' },
        ],
      }), { status: 409 })
      : undefined)
    window.history.replaceState(null, '', '/?view=workbench&wf=flow')
    render(<I18nProvider><TooltipProvider><WorkflowView root="" onToast={onToast} /></TooltipProvider></I18nProvider>)
    await openDelete(user)
    const dialog = screen.getByTestId('wb-workflow-delete-dialog')
    expect(dialog).not.toHaveTextContent('后端')
    expect(dialog).not.toHaveTextContent('Change')
    await user.click(screen.getByTestId('wb-workflow-delete-confirm'))
    const error = await screen.findByTestId('wb-workflow-delete-error')
    expect(error).toHaveTextContent('仍在使用，不能删除')
    const refs = [...screen.getByTestId('wb-workflow-delete-refs').querySelectorAll('li')].map((item) => item.textContent)
    expect(refs).toEqual(['任务 login-fix', '任务 pay-v2', '轨道 chat'])
    expect(screen.getByTestId('wb-workflow-delete-confirm')).toBeDisabled()
    expect(onToast).not.toHaveBeenCalled()
    expect(screen.getByTestId('wb-wf-switch')).toHaveTextContent('flow')
  })

  it('删除成功：关闭对话框、回到 default，并 toast', async () => {
    const user = userEvent.setup()
    const onToast = vi.fn()
    stubApi((url, init) => init?.method === 'DELETE' && url === '/api/workflows/flow?root='
      ? new Response(JSON.stringify({ ok: true }), { status: 200 })
      : undefined)
    window.history.replaceState(null, '', '/?view=workbench&wf=flow')
    render(<I18nProvider><TooltipProvider><WorkflowView root="" onToast={onToast} /></TooltipProvider></I18nProvider>)
    await openDelete(user)
    await user.click(screen.getByTestId('wb-workflow-delete-confirm'))
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('已删除 flow'))
    expect(screen.queryByTestId('wb-workflow-delete-dialog')).toBeNull()
    expect(await screen.findByTestId('wb-step-open')).toBeInTheDocument()
  })
})
