import { useEffect } from 'react'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WbStepDef, WbWorkflowDef } from '../api/governanceTypes'
import { I18nProvider } from '../i18n'
import { suggestedName, useWorkflowCreate, workflowNameError, type CreateState } from '../workbench/useWorkflowCreate'
import { TooltipProvider } from '@/components/ui/tooltip'
import { NewWorkflowDialog } from './NewWorkflowDialog'

function stage(id: string, label: string, next: string | null): WbStepDef {
  return { id, label, gate: null, skills: [{ id: `${id}-skill` }], inputs: [], outputs: [], guards: [], transitions: next === null ? [] : [{ event: `${id}-complete`, to: next }] }
}

const DEFAULT: WbWorkflowDef = { name: 'default', openspec: true, steps: [stage('open', '立项', 'build'), stage('build', '实现', 'ship'), stage('ship', '交付', null)] }
const SIMPLE: WbWorkflowDef = { name: 'simple', steps: [stage('change', 'Change', 'verify'), stage('verify', 'Verify', null)] }
const FLOW: WbWorkflowDef = {
  name: 'flow',
  steps: [],
  tracks: { alpha: { label: '甲', steps: [stage('a1', '一', 'a2'), stage('a2', '二', null)] } },
}

interface Posted { url: string; body: Record<string, unknown> }

function stubApi(options: { post?: (url: string) => Response } = {}): Posted[] {
  const posted: Posted[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posted.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> })
      return options.post?.(url) ?? new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    const defs: Record<string, WbWorkflowDef> = { default: DEFAULT, simple: SIMPLE, flow: FLOW }
    const match = /^\/api\/workflows\/([^?]+)\?root=/u.exec(url)
    const def = match === null ? undefined : defs[decodeURIComponent(match[1] ?? '')]
    if (def !== undefined) return new Response(JSON.stringify({ ...def, source: 'builtin' }), { status: 200 })
    return new Response(JSON.stringify({ ok: false, error: 'workflow 不存在' }), { status: 404 })
  }))
  return posted
}

function Harness({ current = 'default', names = ['flow'], onCreated = vi.fn(), expose }: {
  current?: string | null
  names?: string[]
  onCreated?: (root: string, name: string) => void
  expose?: (create: CreateState) => void
}): JSX.Element {
  const create = useWorkflowCreate({ root: '/repo', names, hasToken: true, current, blocked: false, onCreated })
  expose?.(create)
  const { openCreate } = create
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 挂载即打开一次
  useEffect(() => { openCreate() }, [])
  return <NewWorkflowDialog create={create} />
}

function renderDialog(props: Parameters<typeof Harness>[0] = {}): void {
  render(<I18nProvider><TooltipProvider><Harness {...props} /></TooltipProvider></I18nProvider>)
}

const stages = (): string[] => within(screen.getByTestId('wb-workflow-preview-stages')).getAllByRole('listitem').map((item) => item.textContent ?? '')

// Radix Switch 用 ResizeObserver 量滑块尺寸；jsdom 没有它。
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} })
  ;(window as unknown as { __TENON_DASHBOARD_TOKEN__?: string }).__TENON_DASHBOARD_TOKEN__ = 'test-token'
})
afterEach(() => { vi.unstubAllGlobals() })

describe('新建工作流：起点 · 名称 · OpenSpec · 预览', () => {
  it('起点是 空白 + default + simple + 已有工作流；默认从当前工作流复制，右侧预览它的阶段，名称预填 <源>-copy', async () => {
    stubApi()
    renderDialog()
    const sources = within(screen.getByTestId('wb-workflow-sources')).getAllByRole('radio')
    expect(sources.map((item) => item.textContent)).toEqual(['空白', 'default', 'simple', 'flow'])
    expect(screen.getByTestId('wb-workflow-source-default')).toHaveAttribute('aria-checked', 'true')
    await waitFor(() => expect(stages()).toEqual(['1立项', '2实现', '3交付']))
    expect(screen.getByTestId('wb-workflow-preview-count')).toHaveTextContent('3')
    expect(screen.getByTestId('wb-workflow-name')).toHaveValue('default-copy')
    expect(screen.getByRole('switch', { name: 'OpenSpec' })).toHaveAttribute('aria-checked', 'true')
  })

  it('换起点：simple 预览两段、OpenSpec 跟随关闭；空白只有一个阶段、名称清空；轨道工作流预览第一条轨道', async () => {
    const user = userEvent.setup()
    stubApi()
    renderDialog()
    await waitFor(() => expect(stages()).toHaveLength(3))
    await user.click(screen.getByTestId('wb-workflow-source-simple'))
    await waitFor(() => expect(stages()).toEqual(['1Change', '2Verify']))
    expect(screen.getByTestId('wb-workflow-name')).toHaveValue('simple-copy')
    expect(screen.getByRole('switch', { name: 'OpenSpec' })).toHaveAttribute('aria-checked', 'false')
    await user.click(screen.getByTestId('wb-workflow-source-flow'))
    await waitFor(() => expect(stages()).toEqual(['1一', '2二']))
    await user.click(screen.getByTestId('wb-workflow-source-blank'))
    expect(stages()).toEqual(['1阶段 1'])
    expect(screen.getByTestId('wb-workflow-name')).toHaveValue('')
    expect(screen.getByTestId('wb-workflow-create-submit')).toBeDisabled()
  })

  it('起点列表支持方向键；用户改过名字后换起点不再覆盖名称', async () => {
    const user = userEvent.setup()
    stubApi()
    renderDialog()
    const name = screen.getByTestId('wb-workflow-name')
    await user.clear(name)
    await user.type(name, 'mine')
    screen.getByTestId('wb-workflow-source-default').focus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByTestId('wb-workflow-source-simple')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('wb-workflow-source-simple')).toHaveFocus()
    expect(name).toHaveValue('mine')
  })

  it('校验在名称下方即时显示：非法字符、与内建 / 已有重名；有错时不能提交', async () => {
    const user = userEvent.setup()
    stubApi()
    renderDialog()
    const name = screen.getByTestId('wb-workflow-name')
    await user.clear(name)
    await user.type(name, 'bad name')
    expect(screen.getByTestId('wb-workflow-name-field-error')).toHaveTextContent('只能用字母、数字、- 与 _')
    expect(name).toHaveAttribute('aria-invalid', 'true')
    expect(name).toHaveAttribute('aria-describedby', 'wb-workflow-name-error')
    expect(screen.getByTestId('wb-workflow-create-submit')).toBeDisabled()
    await user.clear(name)
    await user.type(name, 'flow')
    expect(screen.getByTestId('wb-workflow-name-field-error')).toHaveTextContent('名称已存在')
    await user.clear(name)
    await user.type(name, 'simple')
    expect(screen.getByTestId('wb-workflow-name-field-error')).toHaveTextContent('名称已存在')
    await user.clear(name)
    await user.type(name, '前端-v2')
    expect(screen.queryByTestId('wb-workflow-name-field-error')).toBeNull()
    await waitFor(() => expect(screen.getByTestId('wb-workflow-create-submit')).toBeEnabled())
  })

  it('Enter 提交：POST 起点副本（改名、带 root、OpenSpec 按开关），成功后关闭并回调', async () => {
    const user = userEvent.setup()
    const posted = stubApi()
    const onCreated = vi.fn()
    renderDialog({ onCreated })
    await waitFor(() => expect(stages()).toHaveLength(3))
    await user.click(screen.getByRole('switch', { name: 'OpenSpec' }))
    const name = screen.getByTestId('wb-workflow-name')
    await user.clear(name)
    await user.type(name, 'team{Enter}')
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('/repo', 'team'))
    expect(posted).toHaveLength(1)
    expect(posted[0]?.url).toBe('/api/workflows/team')
    expect(posted[0]?.body).toMatchObject({ name: 'team', root: '/repo' })
    expect(posted[0]?.body.openspec).not.toBe(true)
    expect((posted[0]?.body.steps as WbStepDef[]).map((step) => step.id)).toEqual(['open', 'build', 'ship'])
    expect(screen.queryByTestId('wb-workflow-create')).toBeNull()
  })

  it('空白起点：提交一个阶段的定义', async () => {
    const user = userEvent.setup()
    const posted = stubApi()
    renderDialog()
    await user.click(screen.getByTestId('wb-workflow-source-blank'))
    await user.type(screen.getByTestId('wb-workflow-name'), 'fresh')
    await user.click(screen.getByTestId('wb-workflow-create-submit'))
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]?.body).toMatchObject({ name: 'fresh', steps: [{ id: 'stage-1', label: '阶段 1' }] })
  })

  it('服务端拒绝：错误原文显示在按钮旁，对话框保持打开', async () => {
    const user = userEvent.setup()
    stubApi({ post: () => new Response(JSON.stringify({ ok: false, errors: ['steps[0].id 重复'] }), { status: 400 }) })
    renderDialog()
    await waitFor(() => expect(stages()).toHaveLength(3))
    await user.click(screen.getByTestId('wb-workflow-create-submit'))
    expect(await screen.findByTestId('wb-workflow-create-errors')).toHaveTextContent('steps[0].id 重复')
    expect(screen.getByTestId('wb-workflow-create')).toBeInTheDocument()
  })

  it('起点读取失败：预览显示错误，不能提交', async () => {
    stubApi()
    renderDialog({ current: 'ghost' })
    expect(await screen.findByTestId('wb-workflow-preview-error')).toBeInTheDocument()
    expect(screen.getByTestId('wb-workflow-create-submit')).toBeDisabled()
  })

  it('未改动时 Esc 直接关闭；改过任一字段后 Esc 先确认', async () => {
    const user = userEvent.setup()
    stubApi()
    let latest: CreateState | null = null
    renderDialog({ expose: (create) => { latest = create } })
    await waitFor(() => expect(stages()).toHaveLength(3))
    await user.keyboard('{Escape}')
    expect(screen.queryByTestId('wb-workflow-create')).toBeNull()
    act(() => { (latest as CreateState | null)?.openCreate() })
    await user.click(await screen.findByTestId('wb-workflow-source-simple'))
    await user.keyboard('{Escape}')
    expect(await screen.findByTestId('wb-workflow-create-discard')).toBeInTheDocument()
    await user.click(screen.getByTestId('wb-workflow-create-discard-keep'))
    expect(screen.getByTestId('wb-workflow-create')).toBeInTheDocument()
    await user.click(screen.getByTestId('wb-workflow-create-cancel'))
    await user.click(await screen.findByTestId('wb-workflow-create-discard-confirm'))
    expect(screen.queryByTestId('wb-workflow-create')).toBeNull()
  })

  it('OpenSpec 开关是带可访问名称的共享 Switch；起点行单行截断带全名', async () => {
    stubApi()
    renderDialog({ names: ['a-really-long-workflow-name-that-must-truncate'] })
    await waitFor(() => expect(stages()).toHaveLength(3))
    const toggle = screen.getByRole('switch', { name: 'OpenSpec' })
    expect(toggle).toHaveAttribute('data-slot', 'switch')
    const row = screen.getByTestId('wb-workflow-source-a-really-long-workflow-name-that-must-truncate')
    expect(row.className).toContain('whitespace-nowrap')
    expect(row.querySelector('span')?.className).toContain('truncate')
    expect(row).toHaveAttribute('title', 'a-really-long-workflow-name-that-must-truncate')
    expect(screen.getByRole('button', { name: '起点 说明' })).toBeInTheDocument()
  })
})

describe('纯函数', () => {
  it('suggestedName：空白不预填；占用则递增后缀', () => {
    expect(suggestedName(null, new Set())).toBe('')
    expect(suggestedName('default', new Set(['default-copy']))).toBe('default-copy-2')
  })

  it('workflowNameError：空不报；非法 / 重名分别报', () => {
    expect(workflowNameError('  ', [])).toBeNull()
    expect(workflowNameError('a.b', [])).toBe('invalid')
    expect(workflowNameError('default', [])).toBe('duplicate')
    expect(workflowNameError('mine', ['mine'])).toBe('duplicate')
    expect(workflowNameError('前端_1', [])).toBeNull()
  })
})
