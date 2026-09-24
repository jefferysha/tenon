import { render, screen, waitFor, within } from '@testing-library/react'
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

interface StubOptions {
  detected?: string[]
  registration?: 'add' | 'already'
  /** 原生选择器依次给出的答复。 */
  picks?: unknown[]
  folders?: Record<string, { parent: string | null; entries: string[] }>
  listError?: { status: number; code: string }
  /** 每次 /api/projects/create/stream 的 SSE 帧（按调用次序）。 */
  streams?: string[][]
  onCreate?: (body: Record<string, unknown>) => Reply | undefined
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
        ok: true, source: 'builtin', category: row?.category ?? 'common', id, text: `---\nid: ${id}\n---\n## x\n`, digest: `sha256:${id}`,
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
      const query = new URL(url, 'http://x').searchParams
      const dir = query.get('dir') || '/home/me'
      const entry = options.folders?.[dir] ?? { parent: null, entries: [] }
      return json({ ok: true, dir, parent: entry.parent, home: '/home/me', entries: entry.entries.map((name) => ({ name, path: `${dir === '/' ? '' : dir}/${name}` })), truncated: false })
    }
    if (url === '/api/instruction-templates/compose') {
      return json({ ok: true, markdown: '# shop\n\n## 前端\n', bytes: 20, directories: [{ path: 'frontend/', label: '前端工程根目录' }] })
    }
    if (url === '/api/projects/create') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown> & { mode: string; parent?: string; name?: string; path?: string; instructions: { targets: string[] } | null }
      const created = over(options, body)
      if (created !== undefined) return created
      const root = body.mode === 'empty' ? `${body.parent ?? ''}/${body.name ?? ''}` : body.path ?? ''
      return json({
        ok: true, root, git: body.mode === 'empty' ? 'init' : 'none', registration: options.registration ?? 'add',
        directories: ((body.directories as string[] | undefined) ?? []).map((path) => ({ path, exists: false })),
        files: (body.instructions?.targets ?? []).map((id) => ({ id, path: `${root}/${id}`, base_digest: 'absent', current: null, next: '# shop\n' })),
      })
    }
    if (url === '/api/projects/create/stream') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      const created = over(options, body)
      if (created !== undefined) return created
      return { ok: true, status: 200, body: sse(streams.shift() ?? successFrames('/code/shop', ['register'])) }
    }
    throw new Error(`unexpected fetch ${url}`)
  }))
  return calls
}

function over(options: StubOptions, body: Record<string, unknown>): Reply | undefined {
  return options.onCreate?.(body)
}

function renderDialog() {
  const onCreated = vi.fn()
  const onClose = vi.fn()
  render(<I18nProvider><NewProjectDialog onClose={onClose} onCreated={onCreated} /></I18nProvider>)
  return { onCreated, onClose }
}

const bodies = (calls: Call[], url: string) => calls.filter((call) => call.url === url).map((call) => JSON.parse(String(call.init?.body)) as Record<string, unknown>)

async function pickParentAndName(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByTestId('np-mode-empty'))
  await user.click(screen.getByTestId('np-parent-choose'))
  await screen.findByTestId('np-parent-path')
  await user.type(screen.getByTestId('np-name'), 'shop')
}

beforeEach(() => {
  localStorage.clear()
  ;(window as unknown as { __TENON_DASHBOARD_TOKEN__?: string }).__TENON_DASHBOARD_TOKEN__ = 'tok-abc'
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('新建项目向导：步骤与返回', () => {
  it('位置 → 模板 → 客户端 → 确认；已完成的步骤可点击返回，后面的步骤不可点', async () => {
    const user = userEvent.setup()
    stubFetch({ picks: [{ ok: true, path: '/code/legacy' }] })
    renderDialog()
    expect(screen.getByTestId('np-step-location')).toHaveAttribute('aria-current', 'step')
    expect(screen.getByTestId('np-step-templates')).toBeDisabled()
    expect(screen.getByTestId('np-next')).toBeDisabled()
    await user.click(screen.getByTestId('np-existing-choose'))
    expect(await screen.findByTestId('np-existing-path')).toHaveTextContent('/code/legacy')
    expect(screen.getByTestId('np-existing-path')).toHaveAttribute('title', '/code/legacy')
    await user.click(screen.getByTestId('np-next'))
    expect(await screen.findByTestId('np-cat-common')).toBeInTheDocument()
    expect(screen.getByTestId('np-step-templates')).toHaveAttribute('aria-current', 'step')
    await user.click(screen.getByTestId('np-next'))
    expect(await screen.findByTestId('np-clients')).toBeInTheDocument()
    await user.click(screen.getByTestId('np-next'))
    expect(await screen.findByTestId('np-confirm')).toBeInTheDocument()
    expect(screen.getByTestId('np-next')).toHaveTextContent('创建')
    expect(screen.getByTestId('np-step-location')).toHaveAttribute('data-state', 'done')
    await user.click(screen.getByTestId('np-step-location'))
    expect(await screen.findByTestId('np-existing-path')).toHaveTextContent('/code/legacy')
    await user.click(screen.getByTestId('np-next'))
    await user.click(await screen.findByTestId('np-back'))
    expect(await screen.findByTestId('np-location')).toBeInTheDocument()
  })

  it('已有目录已登记：选中后提示「已登记」', async () => {
    const user = userEvent.setup()
    stubFetch({ picks: [{ ok: true, path: '/code/legacy' }], registration: 'already' })
    renderDialog()
    await user.click(screen.getByTestId('np-existing-choose'))
    expect(await screen.findByTestId('np-registered')).toHaveTextContent('已登记')
  })

  it('新建目录：选父目录 + 短文件夹名，预览最终路径；非法名称报错且不能下一步', async () => {
    const user = userEvent.setup()
    const calls = stubFetch({ picks: [{ ok: true, path: '/code' }] })
    renderDialog()
    await pickParentAndName(user)
    expect(screen.getByTestId('np-final-path')).toHaveTextContent('/code/shop')
    expect(screen.getByTestId('np-next')).toBeEnabled()
    await user.type(screen.getByTestId('np-name'), '/x')
    expect(screen.getByTestId('np-name-error')).toBeInTheDocument()
    expect(screen.getByTestId('np-next')).toBeDisabled()
    expect(bodies(calls, '/api/fs/choose-folder')[0]).toEqual({ title: '选择父目录' })
  })

  it('位置校验失败（目录已存在）：按错误码显示本地文案，停在位置', async () => {
    const user = userEvent.setup()
    stubFetch({
      picks: [{ ok: true, path: '/code' }],
      onCreate: () => json({ ok: false, code: 'project-path-exists', error: 'server prose' }, 409),
    })
    renderDialog()
    await pickParentAndName(user)
    await user.click(screen.getByTestId('np-next'))
    const error = await screen.findByTestId('np-error')
    expect(error).toHaveTextContent('目录已存在')
    expect(error).not.toHaveTextContent('server prose')
    expect(screen.getByTestId('np-location')).toBeInTheDocument()
  })
})

describe('选择文件夹：原生对话框与页面内浏览器', () => {
  it('取消：什么都不变，仍是「选择文件夹…」', async () => {
    const user = userEvent.setup()
    stubFetch({ picks: [{ ok: false, cancelled: true }] })
    renderDialog()
    await user.click(screen.getByTestId('np-existing-choose'))
    await waitFor(() => expect(screen.getByTestId('np-existing-choose')).toBeEnabled())
    expect(screen.queryByTestId('np-browser')).toBeNull()
    expect(screen.queryByTestId('np-existing-path')).toBeNull()
  })

  it('不可用：改用页面内浏览器，只能逐级选择；之后不再调原生对话框', async () => {
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
    expect(within(browser).getByTestId('np-browser-dir')).toHaveTextContent('/home/me/code')
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
  it('勾选 React 后才出现状态管理行，变量按块各自的键提交拼合', async () => {
    const user = userEvent.setup()
    const calls = stubFetch({ picks: [{ ok: true, path: '/code' }] })
    renderDialog()
    await pickParentAndName(user)
    await user.click(screen.getByTestId('np-next'))
    await screen.findByTestId('np-cat-common')
    expect(screen.queryByTestId('np-cat-state')).toBeNull()
    await user.click(screen.getByTestId('np-block-builtin-frontend-typescript-react'))
    const state = await screen.findByTestId('np-cat-state')
    expect(within(state).queryByTestId('np-block-builtin-state-pinia')).toBeNull()
    const variable = await screen.findByTestId('np-var-frontend-typescript-react-component.soft')
    await user.type(variable, '180')
    await user.click(screen.getByTestId('np-next'))
    await user.click(await screen.findByTestId('np-next'))
    await screen.findByTestId('np-confirm')
    expect(bodies(calls, '/api/instruction-templates/compose')[0]).toEqual({
      project_name: 'shop',
      selections: [{ source: 'builtin', category: 'frontend', id: 'typescript-react', values: { 'component.soft': '180' } }],
    })
  })

  it('客户端默认勾选本机检测到的，其余收在「更多客户端」；勾选 Gemini 多写 GEMINI.md', async () => {
    const user = userEvent.setup()
    const calls = stubFetch({ picks: [{ ok: true, path: '/code/legacy' }], detected: ['claude'] })
    renderDialog()
    await user.click(screen.getByTestId('np-existing-choose'))
    await screen.findByTestId('np-existing-path')
    await user.click(screen.getByTestId('np-next'))
    await user.click(await screen.findByTestId('np-next'))
    expect(await screen.findByTestId('np-client-claude')).toBeChecked()
    expect(screen.queryByTestId('np-client-codex')).toBeNull()
    expect(screen.queryByTestId('np-clients-more')).toBeNull()
    await user.click(screen.getByTestId('np-clients-more-toggle'))
    expect(screen.getByTestId('np-client-codex')).not.toBeChecked()
    await user.click(screen.getByTestId('np-client-gemini'))
    await user.click(screen.getByTestId('np-next'))
    await screen.findByTestId('np-confirm')
    const plan = bodies(calls, '/api/projects/create').at(-1)
    expect(plan).toMatchObject({ mode: 'existing', path: '/code/legacy', dry_run: true, instructions: { targets: ['CLAUDE.md', 'GEMINI.md'] } })
    expect(plan?.directories).toBeUndefined()
  })
})

describe('确认与创建进度', () => {
  async function toConfirm(user: ReturnType<typeof userEvent.setup>) {
    await pickParentAndName(user)
    await user.click(screen.getByTestId('np-next'))
    await user.click(await screen.findByTestId('np-next'))
    await user.click(await screen.findByTestId('np-next'))
    return screen.findByTestId('np-confirm')
  }

  it('确认列出动作与文件，文件可展开看内容；创建后逐步显示进度，完成后「打开项目」', async () => {
    const user = userEvent.setup()
    const steps = ['directory', 'git', 'skeleton', 'file:CLAUDE.md', 'file:AGENTS.md', 'register']
    const calls = stubFetch({ picks: [{ ok: true, path: '/code' }], streams: [successFrames('/code/shop', steps)] })
    const { onCreated } = renderDialog()
    const confirm = await toConfirm(user)
    for (const id of ['directory', 'git', 'skeleton', 'register']) expect(within(confirm).getByTestId(`np-action-${id}`)).toBeInTheDocument()
    expect(within(confirm).getByTestId('np-action-skeleton')).toHaveTextContent('frontend/')
    expect(within(confirm).getByTestId('np-plan-CLAUDE.md')).toHaveTextContent('新建')
    await user.click(within(confirm).getByTestId('np-plan-toggle-AGENTS.md'))
    expect(within(confirm).getByTestId('np-plan-content-AGENTS.md')).toHaveTextContent('# shop')

    await user.click(screen.getByTestId('np-next'))
    const rows = await screen.findByTestId('np-progress-rows')
    await waitFor(() => expect(within(rows).getByTestId('np-row-register')).toHaveAttribute('data-state', 'done'))
    for (const id of steps) expect(within(rows).getByTestId(`np-row-${id}`)).toHaveAttribute('data-state', 'done')
    expect(within(rows).getByTestId('np-row-file:CLAUDE.md')).toHaveTextContent('写入 CLAUDE.md')
    const stream = bodies(calls, '/api/projects/create/stream')[0]
    expect(stream).toMatchObject({ mode: 'empty', parent: '/code', name: 'shop', directories: ['frontend/'] })
    expect(stream?.instructions).toMatchObject({ targets: ['CLAUDE.md', 'AGENTS.md'], base_digests: { 'CLAUDE.md': 'absent', 'AGENTS.md': 'absent' } })
    await user.click(screen.getByTestId('np-open'))
    expect(onCreated).toHaveBeenCalledWith('/code/shop')
  })

  it('某步失败：显示错误原文与重试，后续步骤保持等待；重试重新 dry run 后再执行', async () => {
    const user = userEvent.setup()
    const failing = [
      frame('plan', { steps: ['directory', 'git', 'register'] }),
      frame('step', { id: 'directory', state: 'running' }), frame('step', { id: 'directory', state: 'done' }),
      frame('step', { id: 'git', state: 'running' }), frame('step', { id: 'git', state: 'failed', error: 'git init: fatal: cannot init' }),
      frame('failed', { ok: false, status: 500, code: 'project-create-failed', error: '新建项目失败', step: 'git-init' }),
    ]
    const calls = stubFetch({ picks: [{ ok: true, path: '/code' }], streams: [failing, successFrames('/code/shop', ['directory', 'git', 'register'])] })
    const { onClose } = renderDialog()
    await toConfirm(user)
    await user.click(screen.getByTestId('np-next'))
    const error = await screen.findByTestId('np-row-error-git')
    expect(error).toHaveTextContent('git init: fatal: cannot init')
    expect(screen.getByTestId('np-row-register')).toHaveAttribute('data-state', 'pending')
    const dryRuns = bodies(calls, '/api/projects/create').length
    await user.click(screen.getByTestId('np-retry'))
    await waitFor(() => expect(screen.getByTestId('np-row-register')).toHaveAttribute('data-state', 'done'))
    expect(bodies(calls, '/api/projects/create').length).toBe(dryRuns + 1)
    await user.click(screen.getByTestId('np-finish'))
    expect(onClose).toHaveBeenCalled()
  })

  it('执行前失败（缺身份）：按错误码显示本地文案，可回到确认', async () => {
    const user = userEvent.setup()
    stubFetch({
      picks: [{ ok: true, path: '/code' }],
      onCreate: (body) => (body.dry_run === false || body.dry_run === undefined ? json({ ok: false, code: 'user-missing', error: 'server prose' }, 412) : undefined),
    })
    renderDialog()
    await toConfirm(user)
    await user.click(screen.getByTestId('np-next'))
    const error = await screen.findByTestId('np-error')
    expect(error).toHaveTextContent('未设置用户身份')
    expect(error).not.toHaveTextContent('server prose')
    await user.click(screen.getByTestId('np-back'))
    expect(await screen.findByTestId('np-confirm')).toBeInTheDocument()
  })
})
