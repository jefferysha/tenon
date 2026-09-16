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
  { source: 'builtin', category: 'backend', id: 'java-spring-boot-ddd', title: 'Java + Spring Boot DDD', frameworks: [], digest: 'sha256:java', errors: [] },
]

const VARIABLES: Record<string, { key: string; default: string | null }[]> = {
  'typescript-react': [{ key: 'component.soft', default: '200' }],
  'java-spring-boot-ddd': [{ key: 'app', default: 'app' }],
}

interface Call { url: string; init?: RequestInit }

function stubFetch(over: { onCreate?: (call: Call) => unknown } = {}) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const method = init?.method ?? 'GET'
    if (url === '/api/instruction-templates' && method === 'GET') {
      return { ok: true, json: async () => ({ ok: true, sync: { id: 'instruction-templates', state: 'unchanged' }, templates: TEMPLATES }) }
    }
    const single = method === 'GET' ? /\/api\/instruction-templates\/builtin\/[^/]+\/([^?]+)/.exec(url) : null
    if (single) {
      const id = decodeURIComponent(single[1] ?? '')
      const row = TEMPLATES.find((candidate) => candidate.id === id)
      return {
        ok: true,
        json: async () => ({
          ok: true, source: 'builtin', category: row?.category ?? 'common', id, text: `---\nid: ${id}\n---\n## x\n`, digest: `sha256:${id}`,
          block: { title: row?.title ?? id, frameworks: row?.frameworks ?? [], directory: null, directory_label: null, catalog: [], catalog_ref: null, variables: VARIABLES[id] ?? [] },
          errors: [],
        }),
      }
    }
    if (url === '/api/instruction-templates/compose') {
      return {
        ok: true,
        json: async () => ({
          ok: true, markdown: '# shop\n\n## 前端（TypeScript + React）\n', bytes: 40,
          directories: [{ path: 'frontend/', label: '前端工程根目录' }, { path: 'backend/', label: '后端工程根目录' }],
        }),
      }
    }
    if (url === '/api/projects/create') {
      const body = JSON.parse(String(init?.body)) as { dry_run: boolean; instructions: { targets: string[] } | null }
      if (!body.dry_run) {
        const created = over.onCreate?.({ url, init })
        if (created !== undefined) return created
        return { ok: true, json: async () => ({ ok: true, root: '/code/shop', git: 'init', registration: 'add', directories: ['frontend/', 'backend/'], files: (body.instructions?.targets ?? []).map((id) => ({ id, digest: 'sha256:new' })) }) }
      }
      return {
        ok: true,
        json: async () => ({
          ok: true, root: '/code/shop', git: 'init', registration: 'add',
          directories: [{ path: 'frontend/', exists: false }, { path: 'backend/', exists: false }],
          files: (body.instructions?.targets ?? []).map((id) => ({ id, path: `/code/shop/${id}`, base_digest: 'absent', current: null, next: '# shop\n' })),
        }),
      }
    }
    throw new Error(`unexpected fetch ${url}`)
  }))
  return calls
}

function renderDialog() {
  const onCreated = vi.fn()
  const onClose = vi.fn()
  render(<I18nProvider><NewProjectDialog onClose={onClose} onCreated={onCreated} /></I18nProvider>)
  return { onCreated, onClose }
}

beforeEach(() => {
  localStorage.clear()
  ;(window as unknown as { __TENON_DASHBOARD_TOKEN__?: string }).__TENON_DASHBOARD_TOKEN__ = 'tok-abc'
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('新建项目对话框', () => {
  it('新建目录要填父目录与名称；未算出计划时不能创建', async () => {
    const user = userEvent.setup()
    stubFetch()
    renderDialog()
    await user.click(await screen.findByTestId('np-mode-empty'))
    expect(screen.getByTestId('np-parent')).toBeInTheDocument()
    expect(screen.getByTestId('np-name')).toBeInTheDocument()
    expect(screen.getByTestId('np-create')).toBeDisabled()
  })

  it('勾选 React 后才出现状态管理行，且只列 react 的块', async () => {
    const user = userEvent.setup()
    stubFetch()
    renderDialog()
    await user.click(await screen.findByTestId('np-tab-templates'))
    expect(screen.queryByTestId('np-cat-state')).toBeNull()
    await user.click(screen.getByTestId('np-block-builtin-frontend-typescript-react'))
    const state = await screen.findByTestId('np-cat-state')
    expect(within(state).getByTestId('np-block-builtin-state-zustand')).toBeInTheDocument()
    expect(within(state).queryByTestId('np-block-builtin-state-pinia')).toBeNull()
  })

  it('选中块的变量可填，拼合时按块各自的键提交', async () => {
    const user = userEvent.setup()
    const calls = stubFetch()
    renderDialog()
    await user.click(await screen.findByTestId('np-mode-empty'))
    await user.type(screen.getByTestId('np-parent'), '/code')
    await user.type(screen.getByTestId('np-name'), 'shop')
    await user.click(screen.getByTestId('np-tab-templates'))
    await user.click(screen.getByTestId('np-block-builtin-frontend-typescript-react'))
    const variable = await screen.findByTestId('np-var-frontend-typescript-react-component.soft')
    await user.clear(variable)
    await user.type(variable, '180')
    await user.click(screen.getByTestId('np-tab-preview'))
    await waitFor(() => {
      const compose = calls.find((call) => call.url === '/api/instruction-templates/compose')
      expect(JSON.parse(String(compose?.init?.body))).toEqual({
        project_name: 'shop',
        selections: [{ source: 'builtin', category: 'frontend', id: 'typescript-react', values: { 'component.soft': '180' } }],
      })
    })
  })

  it('预览列出文件与骨架目录；创建提交 dry_run=false 并回调新 root', async () => {
    const user = userEvent.setup()
    const calls = stubFetch()
    const { onCreated } = renderDialog()
    await user.click(await screen.findByTestId('np-mode-empty'))
    await user.type(screen.getByTestId('np-parent'), '/code')
    await user.type(screen.getByTestId('np-name'), 'shop')
    await user.click(screen.getByTestId('np-tab-preview'))
    const plan = await screen.findByTestId('np-preview-files')
    expect(within(plan).getByTestId('np-plan-CLAUDE.md')).toHaveTextContent('新建')
    expect(within(plan).getByTestId('np-plan-AGENTS.md')).toHaveTextContent('新建')
    expect(screen.getByTestId('np-preview-directories')).toHaveTextContent('frontend/')
    expect(screen.getByTestId('np-preview-markdown')).toHaveTextContent('shop')

    await user.click(screen.getByTestId('np-create'))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('/code/shop'))
    const create = calls.filter((call) => call.url === '/api/projects/create').at(-1)
    const body = JSON.parse(String(create?.init?.body)) as Record<string, unknown>
    expect(body).toMatchObject({ mode: 'empty', parent: '/code', name: 'shop', dry_run: false, directories: ['frontend/', 'backend/'] })
    expect(body.instructions).toMatchObject({ targets: ['CLAUDE.md', 'AGENTS.md'], base_digests: { 'CLAUDE.md': 'absent', 'AGENTS.md': 'absent' } })
  })

  it('目录已存在：按错误码显示本地文案，不直出 server 原文', async () => {
    const user = userEvent.setup()
    stubFetch({
      onCreate: () => ({ ok: false, status: 409, json: async () => ({ ok: false, code: 'project-path-exists', error: 'server prose' }) }),
    })
    renderDialog()
    await user.click(await screen.findByTestId('np-mode-empty'))
    await user.type(screen.getByTestId('np-parent'), '/code')
    await user.type(screen.getByTestId('np-name'), 'shop')
    await user.click(screen.getByTestId('np-tab-preview'))
    await screen.findByTestId('np-preview-files')
    await user.click(screen.getByTestId('np-create'))
    const error = await screen.findByTestId('np-error')
    expect(error).toHaveTextContent('目录已存在')
    expect(error).not.toHaveTextContent('server prose')
  })

  it('已有目录模式只提交 path，不带骨架目录', async () => {
    const user = userEvent.setup()
    const calls = stubFetch()
    renderDialog()
    await user.type(await screen.findByTestId('np-path'), '/code/legacy')
    await user.click(screen.getByTestId('np-tab-preview'))
    await screen.findByTestId('np-preview-files')
    const plan = calls.find((call) => call.url === '/api/projects/create')
    const body = JSON.parse(String(plan?.init?.body)) as Record<string, unknown>
    expect(body).toMatchObject({ mode: 'existing', path: '/code/legacy', dry_run: true })
    expect(body.directories).toBeUndefined()
  })
})
