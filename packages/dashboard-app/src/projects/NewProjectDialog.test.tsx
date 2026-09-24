import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n'
import { NewProjectDialog } from './NewProjectDialog'

const TEMPLATES = [
  { source: 'builtin', category: 'common', id: 'base', title: '回复格式与目录约束', frameworks: [], digest: 'sha256:base', errors: [] },
  { source: 'builtin', category: 'frontend', id: 'typescript-react', title: 'TypeScript + React', frameworks: ['react'], digest: 'sha256:react', errors: [] },
  { source: 'builtin', category: 'state', id: 'zustand', title: 'Zustand', frameworks: ['react'], digest: 'sha256:zustand', errors: [] },
  { source: 'builtin', category: 'state', id: 'pinia', title: 'Pinia', frameworks: ['vue'], digest: 'sha256:pinia', errors: [] },
]

const VARIABLES: Record<string, { key: string; default: string | null }[]> = {
  'typescript-react': [{ key: 'component.soft', default: '200' }],
}

interface Call { url: string; init?: RequestInit }
type Reply = { ok: boolean; status?: number; json?: () => Promise<unknown>; body?: ReadableStream<Uint8Array> }
type Body = Record<string, unknown> & {
  mode: string; parent?: string; name?: string; path?: string; dry_run?: boolean; git_init?: boolean
  instructions: { text: string; targets: string[]; references?: string[]; append?: string[] } | null
}

interface StubOptions {
  detected?: string[]
  registration?: 'add' | 'already'
  git?: 'existing' | 'none'
  /** 已有目录下已存在的指令文件（文件名 → 全文）。 */
  existingFiles?: Record<string, string>
  picks?: unknown[]
  folders?: Record<string, { parent: string | null; entries: string[] }>
  listError?: { status: number; code: string }
  /** 每次 /api/projects/create/stream 的 SSE 帧（按调用次序）。 */
  streams?: string[][]
  onCreate?: (body: Body) => Reply | undefined
}

const json = (body: unknown, status = 200): Reply => ({ ok: status < 400, status, json: async () => body })

function sse(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame))
      controller.close()
    },
  })
}

const frame = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

function successFrames(root: string, steps: string[]): string[] {
  return [
    frame('plan', { steps }),
    ...steps.flatMap((id) => [frame('step', { id, state: 'running' }), frame('step', { id, state: 'done' })]),
    frame('done', { ok: true, root, git: 'init', registration: 'add', directories: [], files: [] }),
  ]
}

function dryRun(options: StubOptions, body: Body): Reply {
  const root = body.mode === 'empty' ? `${body.parent ?? ''}/${body.name ?? ''}` : body.path ?? ''
  const existing = body.mode === 'existing' ? options.existingFiles ?? {} : {}
  const git = body.mode === 'empty' ? 'init' : options.git === 'existing' ? 'existing' : body.git_init === true ? 'init' : 'none'
  const files = (body.instructions?.targets ?? []).map((id) => {
    const current = existing[id] ?? null
    const base = body.instructions?.references?.includes(id) ? '@AGENTS.md\n' : body.instructions?.text ?? ''
    const next = current !== null && body.instructions?.append?.includes(id) ? `${current}\n${base}` : base
    return { id, path: `${root}/${id}`, base_digest: current === null ? 'absent' : `sha256:${id}`, current, next }
  })
  return json({
    ok: true, root, git, registration: options.registration ?? 'add',
    directories: ((body.directories as string[] | undefined) ?? []).map((path) => ({ path, exists: false })), files,
  })
}

function stubFetch(options: StubOptions = {}) {
  const calls: Call[] = []
  const picks = [...(options.picks ?? [])]
  const streams = [...(options.streams ?? [])]
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit): Promise<Reply> => {
    calls.push({ url, init })
    const method = init?.method ?? 'GET'
    if (url === '/api/instruction-templates' && method === 'GET') {
      return json({ ok: true, sync: { id: 'instruction-templates', state: 'unchanged' }, templates: TEMPLATES })
    }
    const single = method === 'GET' ? /\/api\/instruction-templates\/builtin\/[^/]+\/([^?]+)/.exec(url) : null
    if (single) {
      const id = decodeURIComponent(single[1] ?? '')
      const row = TEMPLATES.find((candidate) => candidate.id === id)
      return json({
        ok: true, source: 'builtin', category: row?.category ?? 'common', id, text: `---\nid: ${id}\n---\n## 规则 ${id}\n`, digest: `sha256:${id}`,
        block: { title: row?.title ?? id, frameworks: row?.frameworks ?? [], directory: null, directory_label: null, catalog: [], catalog_ref: null, variables: VARIABLES[id] ?? [] },
        errors: [],
      })
    }
    if (url === '/api/host-target-detection') {
      const detected = options.detected ?? ['codex', 'claude']
      const first = detected[0] ?? null
      return json({
        schema_version: 'host-target-detection/v1', detected_hosts: detected, recommended_host: first,
        recommended_operation: first === null ? null : 'setup', reason: first === null ? 'none' : 'host-detected',
      })
    }
    if (url === '/api/fs/choose-folder') return json(picks.shift() ?? { ok: false, cancelled: true })
    if (url.startsWith('/api/fs/list')) {
      if (options.listError) return json({ ok: false, code: options.listError.code, error: 'server prose' }, options.listError.status)
      const dir = new URL(url, 'http://x').searchParams.get('dir') || '/home/me'
      const entry = options.folders?.[dir] ?? { parent: null, entries: [] }
      return json({ ok: true, dir, parent: entry.parent, home: '/home/me', entries: entry.entries.map((name) => ({ name, path: `${dir}/${name}` })), truncated: false })
    }
    if (url === '/api/instruction-templates/compose') {
      return json({ ok: true, markdown: '# shop\n\n## 前端\n', bytes: 20, directories: [{ path: 'frontend/', label: '前端工程根目录' }] })
    }
    if (url === '/api/projects/create') {
      const body = JSON.parse(String(init?.body)) as Body
      return options.onCreate?.(body) ?? dryRun(options, body)
    }
    if (url === '/api/projects/create/stream') {
      const body = JSON.parse(String(init?.body)) as Body
      return options.onCreate?.(body) ?? { ok: true, status: 200, body: sse(streams.shift() ?? successFrames('/code/shop', ['register'])) }
    }
    throw new Error(`unexpected fetch ${url}`)
  }))
  return calls
}

function renderDialog() {
  const onCreated = vi.fn()
  const onOpen = vi.fn()
  const onClose = vi.fn()
  render(<I18nProvider><NewProjectDialog onClose={onClose} onCreated={onCreated} onOpen={onOpen} /></I18nProvider>)
  return { onCreated, onOpen, onClose }
}

const bodies = (calls: Call[], url: string) => calls.filter((call) => call.url === url).map((call) => JSON.parse(String(call.init?.body)) as Body)
type User = ReturnType<typeof userEvent.setup>

async function waitNext(): Promise<HTMLElement> {
  await waitFor(() => expect(screen.getByTestId('np-next')).toBeEnabled())
  return screen.getByTestId('np-next')
}

async function pickExisting(user: User) {
  await user.click(screen.getByTestId('np-existing-choose'))
  await screen.findByTestId('np-existing-path')
}

async function pickParentAndName(user: User) {
  await user.click(await screen.findByTestId('np-mode-empty'))
  await user.click(screen.getByTestId('np-parent-choose'))
  await screen.findByTestId('np-parent-path')
  await user.type(screen.getByTestId('np-name'), 'shop')
}

async function toConfirm(user: User) {
  await user.click(await waitNext())
  await screen.findByTestId('np-templates')
  await user.click(await waitNext())
  await screen.findByTestId('np-clients')
  await user.click(await waitNext())
  return screen.findByTestId('np-confirm')
}

beforeEach(() => {
  localStorage.clear()
  ;(window as unknown as { __TENON_DASHBOARD_TOKEN__?: string }).__TENON_DASHBOARD_TOKEN__ = 'tok-abc'
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('向导：步骤、返回与键盘', () => {
  it('位置 → 模板 → 客户端 → 确认；已完成步骤可点击返回；Enter 下一步', async () => {
    const user = userEvent.setup()
    stubFetch({ picks: [{ ok: true, path: '/code/legacy' }], git: 'existing' })
    renderDialog()
    expect(screen.getByTestId('np-step-location')).toHaveAttribute('aria-current', 'step')
    expect(screen.getByTestId('np-step-templates')).toBeDisabled()
    expect(screen.getByTestId('np-next')).toBeDisabled()
    await pickExisting(user)
    expect(screen.getByTestId('np-existing-path')).toHaveAttribute('title', '/code/legacy')
    await waitNext()
    fireEvent.keyDown(screen.getByTestId('np-body'), { key: 'Enter' })
    expect(await screen.findByTestId('np-templates')).toBeInTheDocument()
    expect(screen.getByTestId('np-step-location')).toHaveAttribute('data-state', 'done')
    await user.click(screen.getByTestId('np-next'))
    await user.click(await waitNext())
    expect(await screen.findByTestId('np-confirm')).toBeInTheDocument()
    expect(screen.getByTestId('np-next')).toHaveTextContent('创建')
    await user.click(screen.getByTestId('np-step-location'))
    expect(await screen.findByTestId('np-existing-path')).toHaveTextContent('/code/legacy')
  })

  it('有输入时 Esc / 取消先二次确认；「继续编辑」留在向导，「放弃」关闭', async () => {
    const user = userEvent.setup()
    stubFetch({ picks: [{ ok: true, path: '/code/legacy' }] })
    const { onClose } = renderDialog()
    await pickExisting(user)
    await user.click(screen.getByTestId('np-cancel'))
    await user.click(await screen.findByTestId('np-discard-keep'))
    expect(onClose).not.toHaveBeenCalled()
    await user.keyboard('{Escape}')
    await user.click(await screen.findByTestId('np-discard-confirm'))
    expect(onClose).toHaveBeenCalled()
  })

  it('没有输入时取消直接关闭', async () => {
    const user = userEvent.setup()
    stubFetch()
    const { onClose } = renderDialog()
    await user.click(screen.getByTestId('np-cancel'))
    expect(onClose).toHaveBeenCalled()
  })
})

describe('位置：即时校验', () => {
  it('已登记：显示「已在列表中 · 打开」且不能下一步；「打开」切到该项目', async () => {
    const user = userEvent.setup()
    stubFetch({ picks: [{ ok: true, path: '/code/legacy' }], registration: 'already' })
    const { onOpen } = renderDialog()
    await pickExisting(user)
    expect(await screen.findByTestId('np-registered')).toHaveTextContent('已在列表中')
    expect(screen.getByTestId('np-next')).toBeDisabled()
    await user.click(screen.getByTestId('np-registered-open'))
    expect(onOpen).toHaveBeenCalledWith('/code/legacy')
  })

  it('不是 git 仓库：「初始化 git」默认开，请求带 git_init；关掉后不带', async () => {
    const user = userEvent.setup()
    const calls = stubFetch({ picks: [{ ok: true, path: '/code/legacy' }], git: 'none' })
    renderDialog()
    await pickExisting(user)
    const toggle = await screen.findByTestId('np-git-init')
    expect(toggle).toBeChecked()
    expect(bodies(calls, '/api/projects/create').at(-1)).toMatchObject({ git_init: true, dry_run: true })
    await user.click(toggle)
    await waitFor(() => expect(bodies(calls, '/api/projects/create').at(-1)?.git_init).toBeUndefined())
  })

  it('已有 AGENTS.md / CLAUDE.md：列出并标「保留」', async () => {
    const user = userEvent.setup()
    stubFetch({ picks: [{ ok: true, path: '/code/legacy' }], git: 'existing', existingFiles: { 'AGENTS.md': '# mine\n', 'CLAUDE.md': '# c\n' } })
    renderDialog()
    await pickExisting(user)
    const list = await screen.findByTestId('np-existing-files')
    expect(list).toHaveTextContent('AGENTS.md')
    expect(list).toHaveTextContent('CLAUDE.md')
    expect(list).toHaveTextContent('保留')
  })

  it('新建目录：父目录 + 文件夹名，预览最终路径；目录已存在时错误显示在名称下且不能下一步', async () => {
    const user = userEvent.setup()
    stubFetch({
      picks: [{ ok: true, path: '/code' }],
      onCreate: (body) => (body.name === 'taken' ? json({ ok: false, code: 'project-path-exists', error: 'server prose' }, 409) : undefined),
    })
    renderDialog()
    await pickParentAndName(user)
    expect(screen.getByTestId('np-final-path')).toHaveTextContent('/code/shop')
    await waitNext()
    await user.clear(screen.getByTestId('np-name'))
    await user.type(screen.getByTestId('np-name'), 'taken')
    const error = await screen.findByTestId('np-name-check-error')
    expect(error).toHaveTextContent('目录已存在')
    expect(error).not.toHaveTextContent('server prose')
    expect(screen.getByTestId('np-next')).toBeDisabled()
    await user.type(screen.getByTestId('np-name'), '/x')
    expect(screen.getByTestId('np-name-error')).toBeInTheDocument()
  })

  it('手输路径是次要入口：~ 展开为主目录，由 server 核对存在', async () => {
    const user = userEvent.setup()
    const calls = stubFetch({ folders: { '/home/me/code': { parent: '/home/me', entries: [] } } })
    renderDialog()
    await user.click(screen.getByTestId('np-existing-type'))
    await user.type(screen.getByTestId('np-existing-input'), '~/code{Enter}')
    expect(await screen.findByTestId('np-existing-path')).toHaveTextContent('/home/me/code')
    expect(calls.some((call) => call.url === `/api/fs/list?dir=${encodeURIComponent('/home/me/code')}`)).toBe(true)
    expect(screen.getByTestId('np-location')).toBeInTheDocument()
  })
})

describe('选择文件夹：原生对话框与页面内浏览器', () => {
  it('取消：什么都不变', async () => {
    const user = userEvent.setup()
    stubFetch({ picks: [{ ok: false, cancelled: true }] })
    renderDialog()
    await user.click(screen.getByTestId('np-existing-choose'))
    await waitFor(() => expect(screen.getByTestId('np-existing-choose')).toBeEnabled())
    expect(screen.queryByTestId('np-browser')).toBeNull()
    expect(screen.queryByTestId('np-existing-path')).toBeNull()
  })

  it('不可用：改用页面内浏览器逐级选择；之后不再调原生对话框', async () => {
    const user = userEvent.setup()
    const calls = stubFetch({
      picks: [{ ok: false, unavailable: true }],
      folders: {
        '/home/me': { parent: '/home', entries: ['code', 'docs'] },
        '/home/me/code': { parent: '/home/me', entries: ['shop'] },
      },
    })
    renderDialog()
    await user.click(screen.getByTestId('np-existing-choose'))
    const browser = await screen.findByTestId('np-browser')
    expect(within(browser).queryByRole('textbox')).toBeNull()
    await user.click(await within(browser).findByTestId('np-browser-entry-code'))
    expect(await within(browser).findByTestId('np-browser-entry-shop')).toBeInTheDocument()
    await user.click(within(browser).getByTestId('np-browser-up'))
    expect(await within(browser).findByTestId('np-browser-entry-docs')).toBeInTheDocument()
    await user.click(within(browser).getByTestId('np-browser-hidden'))
    await waitFor(() => expect(calls.some((call) => call.url.includes('hidden=1'))).toBe(true))
    await user.click(within(browser).getByTestId('np-browser-entry-code'))
    await within(browser).findByTestId('np-browser-entry-shop')
    await user.click(within(browser).getByTestId('np-browser-pick'))
    expect(await screen.findByTestId('np-existing-path')).toHaveTextContent('/home/me/code')
    await user.click(screen.getByTestId('np-existing-change'))
    expect(await screen.findByTestId('np-browser')).toBeInTheDocument()
    expect(calls.filter((call) => call.url === '/api/fs/choose-folder')).toHaveLength(1)
  })

  it('浏览器列目录失败：按错误码显示本地文案', async () => {
    const user = userEvent.setup()
    stubFetch({ picks: [{ ok: false, unavailable: true }], listError: { status: 403, code: 'permission-denied' } })
    renderDialog()
    await user.click(screen.getByTestId('np-existing-choose'))
    expect(await screen.findByTestId('np-browser-error')).toHaveTextContent('没有读取权限')
  })
})

describe('模板与客户端', () => {
  it('模板与库同一份（状态管理行始终在）：点行预览，预览头部加入；不匹配的状态块不能加入；变量随块提交', async () => {
    const user = userEvent.setup()
    const calls = stubFetch({ picks: [{ ok: true, path: '/code' }] })
    renderDialog()
    await pickParentAndName(user)
    await user.click(await waitNext())
    expect(await screen.findByTestId('np-cat-state')).toBeInTheDocument()
    await user.click(screen.getByTestId('np-block-builtin-state-zustand'))
    expect(await screen.findByTestId('np-template-markdown')).toHaveTextContent('规则 zustand')
    expect(screen.getByTestId('np-template-toggle')).toBeDisabled()
    await user.click(screen.getByTestId('np-block-builtin-frontend-typescript-react'))
    await screen.findByText('规则 typescript-react')
    await user.click(screen.getByTestId('np-template-toggle'))
    expect(screen.getByTestId('np-template-toggle')).toHaveTextContent('移除')
    await user.type(await screen.findByTestId('np-var-frontend-typescript-react-component.soft'), '180')
    await user.click(screen.getByTestId('np-block-builtin-state-zustand'))
    await waitFor(() => expect(screen.getByTestId('np-template-toggle')).toBeEnabled())
    await user.click(screen.getByTestId('np-next'))
    await user.click(await waitNext())
    await screen.findByTestId('np-confirm')
    expect(bodies(calls, '/api/instruction-templates/compose').at(-1)).toEqual({
      project_name: 'shop',
      selections: [{ source: 'builtin', category: 'frontend', id: 'typescript-react', values: { 'component.soft': '180' } }],
    })
  })

  it('客户端默认勾选检测到的，其余在「更多客户端」；正文只写 AGENTS.md，CLAUDE.md / GEMINI.md 写 @AGENTS.md 引用', async () => {
    const user = userEvent.setup()
    const calls = stubFetch({ picks: [{ ok: true, path: '/code/legacy' }], git: 'existing', detected: ['claude'] })
    renderDialog()
    await pickExisting(user)
    await user.click(await waitNext())
    await user.click(await waitNext())
    expect(await screen.findByTestId('np-client-claude')).toBeChecked()
    expect(screen.queryByTestId('np-client-codex')).toBeNull()
    await user.click(screen.getByTestId('np-clients-more-toggle'))
    await user.click(screen.getByTestId('np-client-gemini'))
    await user.click(screen.getByTestId('np-next'))
    const confirm = await screen.findByTestId('np-confirm')
    const plan = bodies(calls, '/api/projects/create').at(-1)
    expect(plan?.instructions).toMatchObject({ targets: ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'], references: ['CLAUDE.md', 'GEMINI.md'] })
    await user.click(within(confirm).getByTestId('np-plan-toggle-CLAUDE.md'))
    expect(within(confirm).getByTestId('np-plan-content-CLAUDE.md')).toHaveTextContent('@AGENTS.md')
  })

  it('不选模板也不选客户端：只登记，不写文件', async () => {
    const user = userEvent.setup()
    const calls = stubFetch({ picks: [{ ok: true, path: '/code/legacy' }], git: 'existing', detected: ['claude'] })
    renderDialog()
    await pickExisting(user)
    await user.click(await waitNext())
    await user.click(await waitNext())
    await user.click(await screen.findByTestId('np-client-claude'))
    await user.click(screen.getByTestId('np-next'))
    const confirm = await screen.findByTestId('np-confirm')
    expect(within(confirm).queryByTestId('np-plan-AGENTS.md')).toBeNull()
    expect(within(confirm).getByTestId('np-action-register')).toBeInTheDocument()
    expect(bodies(calls, '/api/projects/create').at(-1)?.instructions).toBeNull()
    expect(bodies(calls, '/api/projects/create').at(-1)?.clients).toBeUndefined()
  })
})

describe('确认与创建进度', () => {
  it('已有文件可选 追加 / 覆盖 / 跳过（跳过不写）；改动后自动重新预检', async () => {
    const user = userEvent.setup()
    const calls = stubFetch({ picks: [{ ok: true, path: '/code/legacy' }], git: 'existing', existingFiles: { 'AGENTS.md': '# mine\n' } })
    renderDialog()
    await pickExisting(user)
    const confirm = await toConfirm(user)
    expect(within(confirm).getByTestId('np-plan-AGENTS.md')).toHaveAttribute('data-mode', 'append')
    expect(within(confirm).getByTestId('np-plan-CLAUDE.md')).toHaveTextContent('新建')
    expect(bodies(calls, '/api/projects/create').at(-1)?.instructions).toMatchObject({ append: ['AGENTS.md', 'CLAUDE.md'] })
    const before = bodies(calls, '/api/projects/create').length
    await user.click(within(confirm).getByTestId('np-file-mode-AGENTS.md-replace'))
    await waitFor(() => expect(bodies(calls, '/api/projects/create').length).toBe(before + 1))
    expect(bodies(calls, '/api/projects/create').at(-1)?.instructions).toMatchObject({ append: ['CLAUDE.md'] })
    await user.click(await screen.findByTestId('np-file-mode-AGENTS.md-skip'))
    await user.click(await waitNext())
    await waitFor(() => expect(bodies(calls, '/api/projects/create/stream')).toHaveLength(1))
    expect(bodies(calls, '/api/projects/create/stream')[0]?.instructions).toMatchObject({ targets: ['CLAUDE.md'], references: ['CLAUDE.md'] })
  })

  it('创建：逐步显示进度，成功后直接切到该项目；回去改模板后按新内容创建', async () => {
    const user = userEvent.setup()
    const steps = ['directory', 'git', 'skeleton', 'file:AGENTS.md', 'file:CLAUDE.md', 'clients', 'register']
    const calls = stubFetch({ picks: [{ ok: true, path: '/code' }], streams: [successFrames('/code/shop', steps)] })
    const { onCreated } = renderDialog()
    await pickParentAndName(user)
    const confirm = await toConfirm(user)
    for (const id of ['directory', 'git', 'register', 'clients']) expect(within(confirm).getByTestId(`np-action-${id}`)).toBeInTheDocument()
    expect(within(confirm).getByTestId('np-action-clients')).toHaveTextContent('Claude Code, Codex')
    await user.click(screen.getByTestId('np-step-templates'))
    await user.click(await screen.findByTestId('np-block-builtin-common-base'))
    await user.click(await screen.findByTestId('np-template-toggle'))
    await user.click(screen.getByTestId('np-next'))
    await user.click(await waitNext())
    await screen.findByTestId('np-confirm')
    await user.click(await waitNext())
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('/code/shop'))
    expect(onCreated).toHaveBeenCalledTimes(1)
    expect(bodies(calls, '/api/instruction-templates/compose').at(-1)).toMatchObject({ selections: [{ id: 'base' }] })
    const stream = bodies(calls, '/api/projects/create/stream')[0]
    expect(stream).toMatchObject({ mode: 'empty', parent: '/code', name: 'shop', directories: ['frontend/'], clients: ['claude', 'codex'] })
    expect(stream?.instructions).toMatchObject({ targets: ['AGENTS.md', 'CLAUDE.md'], references: ['CLAUDE.md'] })
  })

  it('某步失败：错误原文、已回滚与重试；「返回修改」回到出错步骤，改完再创建成功', async () => {
    const user = userEvent.setup()
    const failing = [
      frame('plan', { steps: ['directory', 'git', 'register'] }),
      frame('step', { id: 'directory', state: 'running' }), frame('step', { id: 'directory', state: 'done' }),
      frame('step', { id: 'git', state: 'running' }), frame('step', { id: 'git', state: 'failed', error: 'git init: fatal: cannot init' }),
      frame('failed', { ok: false, status: 500, code: 'project-create-failed', error: '新建项目失败', step: 'git-init' }),
    ]
    stubFetch({ picks: [{ ok: true, path: '/code' }], streams: [failing, failing, successFrames('/code/shop', ['directory', 'git', 'register'])] })
    const { onCreated } = renderDialog()
    await pickParentAndName(user)
    await toConfirm(user)
    await user.click(await waitNext())
    expect(await screen.findByTestId('np-row-error-git')).toHaveTextContent('git init: fatal: cannot init')
    expect(screen.getByTestId('np-rolled-back')).toHaveTextContent('已回滚')
    expect(screen.getByTestId('np-row-register')).toHaveAttribute('data-state', 'pending')
    await user.click(screen.getByTestId('np-retry'))
    await screen.findByTestId('np-row-error-git')
    await user.click(await waitFor(() => { const back = screen.getByTestId('np-back'); expect(back).toBeEnabled(); return back }))
    expect(await screen.findByTestId('np-location')).toBeInTheDocument()
    await toConfirm(user)
    await user.click(await waitNext())
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('/code/shop'))
  })

  it('执行前的位置类失败：回到「位置」并聚焦名称', async () => {
    const user = userEvent.setup()
    stubFetch({
      picks: [{ ok: true, path: '/code' }],
      onCreate: (body) => (body.dry_run === undefined ? json({ ok: false, code: 'project-path-exists', error: 'server prose' }, 409) : undefined),
    })
    renderDialog()
    await pickParentAndName(user)
    await toConfirm(user)
    await user.click(await waitNext())
    expect(await screen.findByTestId('np-location')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('np-name')).toHaveFocus())
  })

  it('执行前的其他失败（缺身份）：显示本地文案与重试', async () => {
    const user = userEvent.setup()
    stubFetch({
      picks: [{ ok: true, path: '/code' }],
      onCreate: (body) => (body.dry_run === undefined ? json({ ok: false, code: 'user-missing', error: 'server prose' }, 412) : undefined),
    })
    renderDialog()
    await pickParentAndName(user)
    await toConfirm(user)
    await user.click(await waitNext())
    const error = await screen.findByTestId('np-error')
    expect(error).toHaveTextContent('未设置用户身份')
    expect(error).not.toHaveTextContent('server prose')
    expect(within(error).getByTestId('np-retry')).toBeInTheDocument()
  })
})
