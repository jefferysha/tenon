import { useEffect } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WbStepDef, WbWorkflowDef } from '../api/governanceTypes'
import { I18nProvider } from '../i18n'
import { IMPORT_SOURCE, suggestedName, trackPreviews, useWorkflowCreate, workflowNameError, type CreateState } from '../workbench/useWorkflowCreate'
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

const MULTI: WbWorkflowDef = {
  name: 'multi',
  openspec: true,
  steps: [],
  tracks: {
    chat: { steps: [stage('c1', '对话', null)] },
    simple: { label: '简单任务', steps: [stage('s1', '实现', 's2'), stage('s2', '验证', null)] },
    frontend: { label: '前端', steps: [stage('f1', '设计', 'f2'), stage('f2', '实现', 'f3'), stage('f3', '验收', null)] },
    backend: { label: '后端', steps: [stage('b1', '接口', 'b2'), stage('b2', '实现', null)] },
    pm: { label: 'a-really-long-track-name-that-must-truncate-instead-of-wrapping', steps: [stage('p1', '调研', null)] },
  },
}

const STEP = (id: string, label: string, transitions = 'transitions: []'): string => `      - id: ${id}
        label: ${label}
        gate: null
        skills: []
        inputs: []
        outputs: []
        guards: []
        ${transitions}`

const IMPORT_YAML = `name: shared-flow
tracks:
  alpha:
    label: 甲
    steps:
${STEP('a1', '起草')}
${STEP('a2', '交付')}
  beta:
    steps:
${STEP('b1', '单步')}
`
const IMPORT_SINGLE = `name: solo
steps:
${STEP('only', '唯一').replace(/^ {4}/gm, '')}
`

interface Posted { url: string; body: Record<string, unknown> }
interface Put { url: string; text: string; type: string | null }

function stubApi(options: { post?: (url: string) => Response; put?: (url: string) => Response } = {}): Posted[] & { puts: Put[] } {
  const posted = Object.assign([] as Posted[], { puts: [] as Put[] })
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      posted.puts.push({ url, text: String(init.body), type: new Headers(init.headers).get('Content-Type') })
      return options.put?.(url) ?? new Response(JSON.stringify({ ok: true, name: decodeURIComponent(/workflows\/([^/?]+)\/yaml/u.exec(url)?.[1] ?? '') }), { status: 200 })
    }
    if (init?.method === 'POST') {
      posted.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> })
      return options.post?.(url) ?? new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    const defs: Record<string, WbWorkflowDef> = { default: DEFAULT, simple: SIMPLE, flow: FLOW, multi: MULTI }
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
    expect(sources.map((item) => item.textContent)).toEqual(['空白', '导入 YAML', 'default', 'simple', 'flow'])
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

  it('每次打开都重新读起点定义（期间保存过的工作流不会按旧定义复制）', async () => {
    const user = userEvent.setup()
    stubApi()
    let latest: CreateState | null = null
    renderDialog({ expose: (create) => { latest = create } })
    await waitFor(() => expect(stages()).toHaveLength(3))
    await user.keyboard('{Escape}')
    DEFAULT.steps.push(stage('archive', '完结', null))
    try {
      act(() => { (latest as CreateState | null)?.openCreate() })
      await waitFor(() => expect(stages()).toEqual(['1立项', '2实现', '3交付', '4完结']))
    } finally {
      DEFAULT.steps.pop()
    }
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

const trackRows = (): HTMLElement[] => within(screen.getByTestId('wb-workflow-preview-tracks')).getAllByRole('radio')

describe('新建工作流：预览同时列出轨道', () => {
  it('多轨道起点：阶段列表上方按声明序一行一条列出轨道（名称 = label ?? id，行尾是阶段数），默认看第一条轨道的阶段', async () => {
    stubApi()
    renderDialog({ current: 'multi', names: ['multi'] })
    await waitFor(() => expect(trackRows()).toHaveLength(5))
    expect(trackRows().map((row) => row.textContent)).toEqual(['chat1', '简单任务2', '前端3', '后端2', 'a-really-long-track-name-that-must-truncate-instead-of-wrapping1'])
    expect(screen.getByTestId('wb-workflow-preview-track-count')).toHaveTextContent('5')
    expect(screen.getByTestId('wb-workflow-preview-track-chat')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('wb-workflow-preview-track-chat')).toHaveAttribute('aria-current', 'true')
    expect(stages()).toEqual(['1对话'])
    expect(screen.getByTestId('wb-workflow-preview-count')).toHaveTextContent('1')
  })

  it('点轨道行切换下方阶段与阶段计数；方向键在轨道间移动并即时切换', async () => {
    const user = userEvent.setup()
    stubApi()
    renderDialog({ current: 'multi', names: ['multi'] })
    await waitFor(() => expect(trackRows()).toHaveLength(5))
    await user.click(screen.getByTestId('wb-workflow-preview-track-frontend'))
    expect(stages()).toEqual(['1设计', '2实现', '3验收'])
    expect(screen.getByTestId('wb-workflow-preview-count')).toHaveTextContent('3')
    expect(screen.getByTestId('wb-workflow-preview-track-frontend')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('wb-workflow-preview-track-chat')).toHaveAttribute('aria-checked', 'false')
    await user.keyboard('{ArrowDown}')
    expect(screen.getByTestId('wb-workflow-preview-track-backend')).toHaveFocus()
    expect(stages()).toEqual(['1接口', '2实现'])
    await user.keyboard('{End}')
    expect(stages()).toEqual(['1调研'])
    await user.keyboard('{Home}')
    expect(stages()).toEqual(['1对话'])
  })

  it('换起点：无轨道的起点（simple / 空白）不出现轨道列表；再换回多轨道起点从第一条轨道开始；单轨道工作流只有一行', async () => {
    const user = userEvent.setup()
    stubApi()
    renderDialog({ current: 'multi', names: ['multi', 'flow'] })
    await waitFor(() => expect(trackRows()).toHaveLength(5))
    await user.click(screen.getByTestId('wb-workflow-preview-track-backend'))
    await user.click(screen.getByTestId('wb-workflow-source-simple'))
    await waitFor(() => expect(stages()).toEqual(['1Change', '2Verify']))
    expect(screen.queryByTestId('wb-workflow-preview-tracks')).toBeNull()
    expect(screen.queryByTestId('wb-workflow-preview-track-count')).toBeNull()
    await user.click(screen.getByTestId('wb-workflow-source-flow'))
    await waitFor(() => expect(trackRows().map((row) => row.textContent)).toEqual(['甲2']))
    await user.click(screen.getByTestId('wb-workflow-source-multi'))
    await waitFor(() => expect(trackRows()).toHaveLength(5))
    expect(screen.getByTestId('wb-workflow-preview-track-chat')).toHaveAttribute('aria-checked', 'true')
    expect(stages()).toEqual(['1对话'])
    await user.click(screen.getByTestId('wb-workflow-source-blank'))
    expect(screen.queryByTestId('wb-workflow-preview-tracks')).toBeNull()
    expect(stages()).toEqual(['1阶段 1'])
  })

  it('轨道行单行：nowrap + 名称截断带全名 title；提交的仍是起点的完整副本（含全部轨道）', async () => {
    const user = userEvent.setup()
    const posted = stubApi()
    renderDialog({ current: 'multi', names: ['multi'] })
    await waitFor(() => expect(trackRows()).toHaveLength(5))
    const long = screen.getByTestId('wb-workflow-preview-track-pm')
    expect(long.className).toContain('whitespace-nowrap')
    expect(long.querySelector('span')?.className).toContain('truncate')
    expect(long).toHaveAttribute('title', 'a-really-long-track-name-that-must-truncate-instead-of-wrapping')
    await user.click(screen.getByTestId('wb-workflow-preview-track-backend'))
    await user.click(screen.getByTestId('wb-workflow-create-submit'))
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(Object.keys(posted[0]?.body.tracks as Record<string, unknown>)).toEqual(['chat', 'simple', 'frontend', 'backend', 'pm'])
  })
})

const yamlBox = (): HTMLTextAreaElement => screen.getByTestId('wb-workflow-yaml') as HTMLTextAreaElement

/** 直接设值（user.type 会把 { 当作键盘描述符），再触发 React 的 onChange。 */
function paste(text: string): void {
  fireEvent.change(yamlBox(), { target: { value: text } })
}

describe('新建工作流：导入 YAML 起点', () => {
  it('选「导入 YAML」：左栏出现 YAML 输入与选择文件、OpenSpec 开关让位；名称不预填，预览为空，不能提交', async () => {
    const user = userEvent.setup()
    stubApi()
    renderDialog()
    await waitFor(() => expect(stages()).toHaveLength(3))
    expect(screen.getByRole('switch', { name: 'OpenSpec' })).toBeInTheDocument()
    await user.click(screen.getByTestId('wb-workflow-source-import'))
    expect(screen.getByTestId('wb-workflow-source-import')).toHaveAttribute('aria-checked', 'true')
    expect(yamlBox()).toHaveValue('')
    expect(yamlBox()).toHaveAttribute('wrap', 'off')
    expect(screen.getByTestId('wb-workflow-yaml-pick')).toHaveTextContent('选择文件')
    expect(screen.queryByRole('switch', { name: 'OpenSpec' })).toBeNull()
    expect(screen.getByTestId('wb-workflow-name')).toHaveValue('')
    expect(screen.queryByTestId('wb-workflow-preview-tracks')).toBeNull()
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
    expect(screen.getByTestId('wb-workflow-create-submit')).toBeDisabled()
    expect(screen.queryByTestId('wb-workflow-yaml-field-error')).toBeNull()
    await user.click(screen.getByTestId('wb-workflow-source-default'))
    expect(screen.queryByTestId('wb-workflow-yaml')).toBeNull()
    expect(screen.getByRole('switch', { name: 'OpenSpec' })).toBeInTheDocument()
  })

  it('粘贴 YAML：右栏列出解析出的轨道与阶段，名称预填 YAML 里的 name；点轨道看它的阶段', async () => {
    const user = userEvent.setup()
    stubApi()
    renderDialog()
    await user.click(screen.getByTestId('wb-workflow-source-import'))
    paste(IMPORT_YAML)
    expect(screen.getByTestId('wb-workflow-name')).toHaveValue('shared-flow')
    expect(trackRows().map((row) => row.textContent)).toEqual(['甲2', 'beta1'])
    expect(stages()).toEqual(['1起草', '2交付'])
    await user.click(screen.getByTestId('wb-workflow-preview-track-beta'))
    expect(stages()).toEqual(['1单步'])
    expect(screen.queryByTestId('wb-workflow-yaml-field-error')).toBeNull()
    expect(screen.getByTestId('wb-workflow-create-submit')).toBeEnabled()
  })

  it('没有轨道的 YAML 只有阶段列表；用户改过名字后再粘贴不覆盖', async () => {
    const user = userEvent.setup()
    stubApi()
    renderDialog()
    await user.click(screen.getByTestId('wb-workflow-source-import'))
    const name = screen.getByTestId('wb-workflow-name')
    await user.type(name, 'mine')
    paste(IMPORT_SINGLE)
    expect(stages()).toEqual(['1唯一'])
    expect(screen.queryByTestId('wb-workflow-preview-tracks')).toBeNull()
    expect(name).toHaveValue('mine')
  })

  it('语法错误即时显示在输入框下方（单行截断带原文），预览为空、不能提交；改对后消失', async () => {
    const user = userEvent.setup()
    stubApi()
    renderDialog()
    await user.click(screen.getByTestId('wb-workflow-source-import'))
    paste('steps:\n  - id: x\n')
    const error = screen.getByTestId('wb-workflow-yaml-field-error')
    expect(error).toHaveTextContent('第一行必须是 \'name: <name>\'')
    expect(error.className).toContain('truncate')
    expect(error).toHaveAttribute('title', error.textContent ?? '')
    expect(yamlBox()).toHaveAttribute('aria-invalid', 'true')
    expect(yamlBox()).toHaveAttribute('aria-describedby', 'wb-workflow-yaml-error')
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
    await user.type(screen.getByTestId('wb-workflow-name'), 'x')
    expect(screen.getByTestId('wb-workflow-create-submit')).toBeDisabled()
    paste(IMPORT_SINGLE)
    expect(screen.queryByTestId('wb-workflow-yaml-field-error')).toBeNull()
    expect(yamlBox()).toHaveAttribute('aria-invalid', 'false')
    expect(screen.getByTestId('wb-workflow-create-submit')).toBeEnabled()
  })

  it('选 .yaml 文件等同于粘贴', async () => {
    const user = userEvent.setup()
    stubApi()
    renderDialog()
    await user.click(screen.getByTestId('wb-workflow-source-import'))
    const input = screen.getByTestId('wb-workflow-yaml-file')
    expect(input).toHaveAttribute('accept', '.yaml,.yml,text/yaml')
    await user.upload(input, new File([IMPORT_YAML], 'flow.yaml', { type: 'text/yaml' }))
    await waitFor(() => expect(yamlBox()).toHaveValue(IMPORT_YAML))
    expect(screen.getByTestId('wb-workflow-name')).toHaveValue('shared-flow')
    expect(trackRows()).toHaveLength(2)
  })

  it('提交：PUT 原文到 /api/workflows/<名称>/yaml（text/yaml，第一行 name 改成对话框里的名称），成功后关闭并回调；不走 POST', async () => {
    const user = userEvent.setup()
    const api = stubApi()
    const onCreated = vi.fn()
    renderDialog({ onCreated })
    await user.click(screen.getByTestId('wb-workflow-source-import'))
    paste(IMPORT_YAML)
    const name = screen.getByTestId('wb-workflow-name')
    await user.clear(name)
    await user.type(name, 'renamed')
    await user.click(screen.getByTestId('wb-workflow-create-submit'))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('/repo', 'renamed'))
    expect(api).toHaveLength(0)
    expect(api.puts).toHaveLength(1)
    expect(api.puts[0]?.url).toBe('/api/workflows/renamed/yaml?root=%2Frepo')
    expect(api.puts[0]?.type).toBe('text/yaml; charset=utf-8')
    expect(api.puts[0]?.text).toBe(IMPORT_YAML.replace('name: shared-flow', 'name: renamed'))
    expect(screen.queryByTestId('wb-workflow-create')).toBeNull()
  })

  it('服务端校验不过：错误列表显示在按钮旁，对话框与输入保持不变', async () => {
    const user = userEvent.setup()
    stubApi({ put: () => new Response(JSON.stringify({ ok: false, errors: ['skills[0] 不存在', 'agent x 不在库里'] }), { status: 400 }) })
    renderDialog()
    await user.click(screen.getByTestId('wb-workflow-source-import'))
    paste(IMPORT_SINGLE)
    await user.click(screen.getByTestId('wb-workflow-create-submit'))
    const errors = await screen.findByTestId('wb-workflow-create-errors')
    expect(errors).toHaveTextContent('skills[0] 不存在')
    expect(errors).toHaveTextContent('agent x 不在库里')
    expect(screen.getByTestId('wb-workflow-create')).toBeInTheDocument()
    expect(yamlBox()).toHaveValue(IMPORT_SINGLE)
    expect(screen.getByTestId('wb-workflow-name')).toHaveValue('solo')
  })

  it('YAML 里的名字与已有工作流重名：名称字段报重名，改名后才能提交；输入过 YAML 后 Esc 先确认', async () => {
    const user = userEvent.setup()
    stubApi()
    renderDialog({ names: ['flow', 'shared-flow'] })
    await user.click(screen.getByTestId('wb-workflow-source-import'))
    paste(IMPORT_YAML)
    expect(screen.getByTestId('wb-workflow-name-field-error')).toHaveTextContent('名称已存在')
    expect(screen.getByTestId('wb-workflow-create-submit')).toBeDisabled()
    const name = screen.getByTestId('wb-workflow-name')
    await user.clear(name)
    await user.type(name, 'fresh')
    expect(screen.getByTestId('wb-workflow-create-submit')).toBeEnabled()
    await user.keyboard('{Escape}')
    expect(await screen.findByTestId('wb-workflow-create-discard')).toBeInTheDocument()
  })

  it('重新打开对话框：导入输入清空', async () => {
    const user = userEvent.setup()
    stubApi()
    let latest: CreateState | null = null
    renderDialog({ expose: (create) => { latest = create } })
    await user.click(screen.getByTestId('wb-workflow-source-import'))
    paste(IMPORT_SINGLE)
    act(() => { (latest as CreateState | null)?.close() })
    expect(screen.queryByTestId('wb-workflow-create')).toBeNull()
    act(() => { (latest as CreateState | null)?.openCreate(IMPORT_SOURCE) })
    expect(yamlBox()).toHaveValue('')
    expect(screen.getByTestId('wb-workflow-name')).toHaveValue('')
  })
})

describe('纯函数', () => {
  it('suggestedName：空白与导入不预填；占用则递增后缀', () => {
    expect(suggestedName(null, new Set())).toBe('')
    expect(suggestedName(IMPORT_SOURCE, new Set())).toBe('')
    expect(suggestedName('default', new Set(['default-copy']))).toBe('default-copy-2')
  })

  it('trackPreviews：按声明序给出每条轨道的名称（label ?? id）与阶段名；无 tracks 为空', () => {
    expect(trackPreviews(MULTI).map((track) => [track.id, track.label, track.stages.length])).toEqual([
      ['chat', 'chat', 1], ['simple', '简单任务', 2], ['frontend', '前端', 3], ['backend', '后端', 2],
      ['pm', 'a-really-long-track-name-that-must-truncate-instead-of-wrapping', 1],
    ])
    expect(trackPreviews(FLOW)).toEqual([{ id: 'alpha', label: '甲', stages: ['一', '二'] }])
    expect(trackPreviews(DEFAULT)).toEqual([])
  })

  it('workflowNameError：空不报；非法 / 重名分别报', () => {
    expect(workflowNameError('  ', [])).toBeNull()
    expect(workflowNameError('a.b', [])).toBe('invalid')
    expect(workflowNameError('default', [])).toBe('duplicate')
    expect(workflowNameError('mine', ['mine'])).toBe('duplicate')
    expect(workflowNameError('前端_1', [])).toBeNull()
  })
})
