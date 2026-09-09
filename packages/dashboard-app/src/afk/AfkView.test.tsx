import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { I18nProvider } from '../i18n'
import { GlobalSearchProvider, useGlobalSearch } from '../shell/GlobalSearch'
import { makeChange, makeProject, makeSnapshot } from '../testkit'
import { DEFAULT_RULES, rulesKey, type WorkflowRules } from '../model/workflowModel'
import { AfkView } from './AfkView'

vi.mock('./TaskRunPanel', () => ({ TaskRunPanel: () => <div data-testid="task-run-panel-stub" /> }))
vi.mock('../shared/RunAuditPanel', () => ({ RunAuditPanel: () => <div data-testid="run-audit-panel-stub" /> }))

const ROOT = '/tmp/afk-proj'

// 沙箱三态 fixture（automation 字段驱动 progressModel 五态判定）：running/queued/failed 各一，
// 外加一条非沙箱（无 automation → agent/gate 态）与一条终端心跳行，用于负向断言「不进自动化页」。
function fixture() {
  return makeSnapshot([
    makeProject(ROOT, [
      makeChange('run-a', 'build', { fields: { automation: 'running' } }),
      makeChange('q-b', 'spec', { fields: { automation: 'queued' } }),
      makeChange('fail-c', 'verify', {
        fields: {
          automation: 'failed',
          automation_worktree: '/wt/fail-c',
          automation_error: '覆盖率 42%，要求至少 80%',
          workflow: 'default',
          loop_id: 'dependency-update',
          autonomy_level: 'L2',
          skill_bundle_id: 'dependency-sweeper@v1.2.0',
          automation_container: 'node:20-bullseye',
        },
      }),
      makeChange('gate-d', 'build', {}), // 非沙箱（终端里由 agent 推进）
      makeChange('terminal-live', 'build', {
        fields: { automation: 'off' },
        terminalActivity: {
          sessionId: '019f92c7-6e66-7290-9352-f9d915266f14',
          heartbeatAt: '2026-07-24T06:00:00.000Z',
          expiresAt: '2026-07-24T06:02:00.000Z',
        },
      }),
    ]),
  ])
}

function fixtureWithOperations() {
  return { ...fixture(), capabilities: { ...fixture().capabilities, operations: true } }
}

function makeRules(): Map<string, WorkflowRules> {
  return new Map<string, WorkflowRules>([[rulesKey(ROOT, 'default'), DEFAULT_RULES]])
}

/** 顶部条搜索框的替身：本页只消费 GlobalSearch 的 query，用它模拟用户在顶部条输入。 */
function GlobalQueryProbe(): JSX.Element {
  const { setQuery } = useGlobalSearch()
  return <button type="button" data-testid="probe-global-query" onClick={() => setQuery('q-b')}>set</button>
}

let automationSettings = { max_parallel: 4, max_retries: 1, default_opt_in: false, image: '' }
let afkPosts: Array<{ url: string; init: RequestInit | undefined }> = []
let settingsPosts: Array<Record<string, unknown>> = []
let loopRows: Array<Record<string, unknown>> = []

beforeEach(() => {
  localStorage.clear()
  afkPosts = []
  settingsPosts = []
  loopRows = []
  automationSettings = { max_parallel: 4, max_retries: 1, default_opt_in: false, image: '' }
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (/\/api\/automation\?root=/.test(url)) {
      return new Response(JSON.stringify({ ok: true, settings: automationSettings }), { status: 200 })
    }
    if (url === '/api/automation' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      settingsPosts.push(body)
      const { root: _root, ...saved } = body
      return new Response(JSON.stringify({ ok: true, settings: { enabled: false, ...saved } }), { status: 200 })
    }
    if (/\/api\/afk\/[^/]+\/(enqueue|retry)$/.test(url) && init?.method === 'POST') {
      afkPosts.push({ url, init })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    if (url.startsWith('/api/operations/starters')) {
      return new Response(JSON.stringify({ ok: true, templates: [
        { version: 1, id: 'daily-triage', goal: 'Review the queue', trigger: [{ kind: 'schedule' }], risk: 'low', recommendedWorkflow: 'default', recommendedSkills: ['loop-triage'] },
      ], defaults: { runner: 'codex', workflow: 'default' } }), { status: 200 })
    }
    if (url === '/api/loops/snapshot') return new Response(JSON.stringify({ generated_at: '2026-07-20T00:00:00Z', rows: loopRows }), { status: 200 })
    if (url.startsWith('/api/cadence/status')) return new Response(JSON.stringify({ enabled: true, poll_interval_ms: 30000, generated_at: '2026-07-20T00:00:00Z', running: false, errors: [], loops: [] }), { status: 200 })
    throw new Error(`unexpected fetch ${url}`)
  }) as unknown as typeof fetch
})
afterEach(() => {
  vi.restoreAllMocks()
})

async function renderAfk(over: Partial<Parameters<typeof AfkView>[0]> = {}) {
  const props = {
    snapshot: fixture(),
    currentRoot: ROOT,
    rulesByKey: makeRules(),
    onView: vi.fn(),
    onToast: vi.fn(),
    ...over,
  }
  render(
    <I18nProvider>
      <GlobalSearchProvider>
        <GlobalQueryProbe />
        <AfkView {...props} />
      </GlobalSearchProvider>
    </I18nProvider>,
  )
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  })
  return props
}

function openSheet(id: 'overview' | 'run' | 'handle' | 'records'): void {
  fireEvent.click(screen.getByTestId(`afk-detail-tab-${id}`))
}

describe('AfkView 三列自动运行页', () => {
  it('English empty state and cadence settings contain no hard-coded Chinese product copy', async () => {
    localStorage.setItem('tenon-dashboard-lang', 'en')
    const empty = makeSnapshot([makeProject(ROOT, [makeChange('manual', 'build', {})])])
    empty.capabilities = { ...empty.capabilities, operations: true }
    await renderAfk({ snapshot: empty })
    expect(screen.getByTestId('afk-empty')).toHaveTextContent('No automatic runs right now')
    expect(screen.getByTestId('afk-view').textContent).not.toMatch(/[㐀-鿿]/u)
    // 「新建运行」常驻左列：manual 尚未进入自动化，是合法候选。
    expect(screen.getByTestId('afk-new-run')).not.toBeDisabled()
    fireEvent.click(screen.getByTestId('afk-rail-settings'))
    expect(screen.getByTestId('afk-settings-tab-starter')).toHaveTextContent('New schedule')
    expect(screen.getByTestId('afk-settings-tab-run')).toHaveTextContent('Validate schedule')
    expect(screen.getByTestId('afk-view').textContent).not.toMatch(/[㐀-鿿]/u)
  })

  it('English populated list, facts, handling, and retry preview contain no Chinese product copy', async () => {
    localStorage.setItem('tenon-dashboard-lang', 'en')
    const snapshot = makeSnapshot([
      makeProject(ROOT, [
        makeChange('failed-en', 'verify', {
          fields: {
            automation: 'failed',
            automation_worktree: '/wt/failed-en',
            automation_error: 'Coverage is below threshold',
            workflow: 'default',
            autonomy_level: 'L2',
            skill_bundle_id: 'verification@v1',
            automation_container: 'node:22',
          },
        }),
        makeChange('queued-en', 'spec', { fields: { automation: 'queued' } }),
      ]),
    ])
    await renderAfk({ snapshot })
    const view = screen.getByTestId('afk-view')
    expect(view.textContent).not.toMatch(/[㐀-鿿]/u)
    openSheet('handle')
    expect(view.textContent).not.toMatch(/[㐀-鿿]/u)
    fireEvent.click(screen.getByTestId('afk-retry-preview-failed-en'))
    expect(screen.getByTestId('afk-retry-sheet').textContent).not.toMatch(/[㐀-鿿]/u)
  })

  it('打开页面即选中最需要处置的运行；右列头部给失败原因，概览 sheet 给运行事实', async () => {
    await renderAfk()
    expect(screen.getByTestId('afk-columns')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: '运行' })).toBeInTheDocument()
    const detail = screen.getByTestId('afk-detail')
    expect(screen.getByTestId('afk-detail-title')).toHaveTextContent('fail-c')
    expect(screen.getByTestId('afk-detail-status')).toHaveTextContent('覆盖率 42%，要求至少 80%')
    expect(screen.getByTestId('afk-detail-badge')).toHaveAttribute('data-tone', 'blocked')
    const facts = screen.getByTestId('afk-run-facts')
    expect(facts).toHaveTextContent('工作流 default')
    expect(facts).toHaveTextContent('自治 L2')
    expect(facts).toHaveTextContent('技能 dependency-sweeper@v1.2.0')
    expect(facts).toHaveTextContent('容器 node:20-bullseye')
    expect(facts).toHaveTextContent('2026年07月07日 00:00:00')
    openSheet('handle')
    expect(detail).toHaveTextContent('查看重试预览')
  })

  it('右列一次只显示一个 sheet：运行 → TaskRunPanel；记录 → RunAuditPanel', async () => {
    await renderAfk()
    expect(screen.queryByTestId('task-run-panel-stub')).toBeNull()
    openSheet('run')
    expect(screen.getByTestId('task-run-panel-stub')).toBeInTheDocument()
    expect(screen.queryByTestId('afk-run-facts')).toBeNull()
    openSheet('records')
    expect(screen.getByTestId('run-audit-panel-stub')).toBeInTheDocument()
    expect(screen.queryByTestId('task-run-panel-stub')).toBeNull()
  })

  it('阶段轨与工作台同源：六段主流程，fail-c 停在验证段且标为受阻', async () => {
    await renderAfk()
    const rail = screen.getByTestId('phase-rail')
    expect(within(rail).getAllByRole('button')).toHaveLength(6)
    expect(screen.getByTestId('phase-rail-open')).toHaveAttribute('data-status', 'done')
    expect(screen.getByTestId('phase-rail-build')).toHaveAttribute('data-status', 'done')
    expect(screen.getByTestId('phase-rail-verify')).toHaveAttribute('data-status', 'failed')
    expect(screen.getByTestId('phase-rail-ship')).toHaveAttribute('data-status', 'pending')
    expect(screen.queryByTestId('phase-rail-archive')).toBeNull()
  })

  it('中列只列自动化三桶的 change；非沙箱 change 不进列表；左列汇总计数同源', async () => {
    await renderAfk()
    expect(within(screen.getByTestId('afk-sec-running')).getByTestId('afk-row-run-a')).toBeInTheDocument()
    expect(within(screen.getByTestId('afk-sec-queued')).getByTestId('afk-row-q-b')).toBeInTheDocument()
    expect(within(screen.getByTestId('afk-sec-failed')).getByTestId('afk-row-fail-c')).toBeInTheDocument()
    expect(screen.queryByTestId('afk-row-gate-d')).toBeNull()
    // 正常对话的终端心跳虽然在工作台属于“运行中”，但不是自动运行任务。
    expect(screen.queryByTestId('afk-row-terminal-live')).toBeNull()
    const health = screen.getByTestId('afk-health')
    expect(health).toHaveAttribute('data-status', 'attention')
    expect(health).toHaveTextContent('1 个运行中 · 1 个待处置')
    expect(within(health).getByTestId('afk-scope-all')).toHaveTextContent('3')
    expect(screen.getByTestId('afk-filter-need')).toHaveTextContent('1')
    expect(screen.getByTestId('afk-filter-running')).toHaveTextContent('1')
    expect(screen.getByTestId('afk-filter-queued')).toHaveTextContent('1')
  })

  it('状态页签过滤列表：需要你 = 失败', async () => {
    await renderAfk()
    fireEvent.click(screen.getByTestId('afk-filter-need'))
    expect(screen.getByTestId('afk-row-fail-c')).toBeInTheDocument()
    expect(screen.queryByTestId('afk-row-run-a')).toBeNull()
    expect(screen.queryByTestId('afk-row-q-b')).toBeNull()
  })

  it('选择运行中的任务后详情同步切换，处置 sheet 不残留失败任务的重试动作', async () => {
    await renderAfk()
    fireEvent.click(screen.getByTestId('afk-row-run-a'))
    expect(screen.getByTestId('afk-detail-title')).toHaveTextContent('run-a')
    expect(screen.getByTestId('afk-detail-badge')).toHaveTextContent('运行中')
    openSheet('handle')
    expect(screen.queryByTestId('afk-retry-preview-fail-c')).toBeNull()
    expect(screen.getByTestId('afk-handle-none')).toHaveTextContent('无需处置')
  })

  it('搜索无结果时清除过期详情并提供恢复入口', async () => {
    await renderAfk()
    const search = screen.getByPlaceholderText('搜索运行')
    fireEvent.change(search, { target: { value: 'does-not-exist' } })

    expect(screen.getByTestId('afk-filter-empty')).toBeInTheDocument()
    expect(screen.queryByTestId('afk-detail')).toBeNull()
    expect(screen.getByTestId('afk-detail-empty')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '清除条件' }))
    expect(screen.getByTestId('afk-detail')).toBeInTheDocument()
  })

  it('顶部条搜索词同样过滤本页列表', async () => {
    await renderAfk()
    fireEvent.click(screen.getByTestId('probe-global-query'))
    expect(screen.getByTestId('afk-row-q-b')).toBeInTheDocument()
    expect(screen.queryByTestId('afk-row-fail-c')).toBeNull()
    expect(screen.getByTestId('afk-detail-title')).toHaveTextContent('q-b')
  })

  it('运行卡：data-state、状态 pill、workflow · track slug、阶段与下一步', async () => {
    await renderAfk()
    const row = screen.getByTestId('afk-row-fail-c')
    expect(row).toHaveAttribute('data-state', 'failed')
    expect(within(row).getByTestId('afk-badge-fail-c')).toHaveTextContent('失败')
    expect(row).toHaveTextContent('default · backend')
    expect(row).toHaveTextContent('验证')
    expect(row).toHaveTextContent('下一步 · 处置失败或重试')
    expect(screen.getByTestId('afk-row-q-b')).toHaveTextContent('下一步 · 等待空闲槽位')
  })

  it('并发上限是可保存的真实设置：修改后 POST 全量 automation 配置', async () => {
    await renderAfk()
    openSheet('handle')
    await waitFor(() => expect(screen.getByTestId('afk-limit-input')).toHaveValue('4'))
    fireEvent.change(screen.getByTestId('afk-limit-input'), { target: { value: '6' } })
    await waitFor(() => expect(settingsPosts).toEqual([{ root: ROOT, max_parallel: 6, max_retries: 1, default_opt_in: false, image: '' }]))
  })

  it('HTTP 200 的畸形 AFK 写回不保留 settings 乐观值或显示成功 toast', async () => {
    localStorage.setItem('tenon-dashboard-lang', 'en')
    const baseFetch = global.fetch
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/automation' && init?.method === 'POST') {
        return new Response(JSON.stringify({ ok: false }), { status: 200 })
      }
      return baseFetch(input, init)
    }) as unknown as typeof fetch
    const props = await renderAfk()
    openSheet('handle')
    await waitFor(() => expect(screen.getByTestId('afk-limit-input')).toHaveValue('4'))

    fireEvent.change(screen.getByTestId('afk-limit-input'), { target: { value: '6' } })

    await waitFor(() => expect(screen.getByTestId('afk-settings-error')).toHaveTextContent('Invalid server response.'))
    expect(screen.getByTestId('afk-limit-input')).toHaveValue('4')
    expect(props.onToast).not.toHaveBeenCalled()
  })

  it('HTTP 200 的畸形 enqueue body 保持对话框打开，显示本地化 invalid-response 且不 toast', async () => {
    localStorage.setItem('tenon-dashboard-lang', 'en')
    const baseFetch = global.fetch
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/afk/gate-d/enqueue' && init?.method === 'POST') {
        return new Response('not-json', { status: 200 })
      }
      return baseFetch(input, init)
    }) as unknown as typeof fetch
    const props = await renderAfk()

    fireEvent.click(screen.getByTestId('afk-new-run'))
    fireEvent.click(screen.getByTestId('afk-enqueue-gate-d'))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Invalid server response.'))
    expect(screen.getByTestId('afk-tool-sheet')).toBeInTheDocument()
    expect(props.onToast).not.toHaveBeenCalled()
  })

  it('AFK 入队与设置保存各自拥有独立 generation，不会互相清 busy 或吞掉结果', async () => {
    const baseFetch = global.fetch
    let resolveAction!: (response: Response) => void
    const delayedAction = new Promise<Response>((resolve) => { resolveAction = resolve })
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/afk/gate-d/enqueue' && init?.method === 'POST') return delayedAction
      return baseFetch(input, init)
    }) as unknown as typeof fetch
    const props = await renderAfk()
    openSheet('handle')
    await waitFor(() => expect(screen.getByTestId('afk-limit-input')).toHaveValue('4'))
    fireEvent.click(screen.getByTestId('afk-new-run'))
    const enqueue = screen.getByTestId('afk-enqueue-gate-d')
    fireEvent.click(enqueue)
    fireEvent.change(screen.getByTestId('afk-limit-input'), { target: { value: '6' } })
    await waitFor(() => expect(settingsPosts).toHaveLength(1))
    expect(enqueue).toBeDisabled()

    await act(async () => {
      resolveAction(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      await delayedAction
    })
    await waitFor(() => expect(screen.queryByTestId('afk-tool-sheet')).toBeNull())
    expect(props.onToast).toHaveBeenCalledWith(expect.stringContaining('gate-d'))
    expect(props.onToast).toHaveBeenCalledWith(expect.stringContaining('6'))
  })

  it('生产能力开启时：新建运行走居中对话框；定时任务的新建 / 验证是节奏设置的两个 sheet', async () => {
    await renderAfk({ snapshot: fixtureWithOperations() })
    fireEvent.click(screen.getByTestId('afk-new-run'))
    expect(within(screen.getByTestId('afk-tool-sheet')).getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByTestId('afk-tool-sheet')).toHaveTextContent('开启自动运行')
    expect(screen.getByTestId('afk-tool-sheet')).toHaveTextContent('不创建新任务，也不改变它的工作流')
    expect(screen.getByTestId('afk-enqueue-gate-d')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('afk-tool-close'))
    fireEvent.click(screen.getByTestId('afk-rail-settings'))
    expect(screen.getByTestId('afk-settings')).toBeInTheDocument()
    expect(screen.queryByTestId('afk-detail')).toBeNull()
    fireEvent.click(screen.getByTestId('afk-settings-tab-starter'))
    await waitFor(() => expect(screen.getByTestId('ops-starter-daily-triage')).toBeInTheDocument())
    expect(screen.getByTestId('afk-settings')).toHaveTextContent('选择定时任务类型')
    expect(screen.getByTestId('afk-settings')).toHaveTextContent('模板决定如何发现或生成任务')
  })

  it('节奏设置面板：并发上限、重试上限与默认入队来自真实配置；点范围卡回到运行详情', async () => {
    await renderAfk()
    fireEvent.click(screen.getByTestId('afk-rail-settings'))
    await waitFor(() => expect(screen.getByTestId('afk-limit-input')).toHaveValue('4'))
    const stats = screen.getByTestId('afk-settings-stats')
    expect(stats).toHaveTextContent('重试上限')
    expect(stats).toHaveTextContent('1')
    expect(stats).toHaveTextContent('关闭')
    expect(screen.getByTestId('afk-settings-health')).toHaveAttribute('data-tone', 'blocked')
    fireEvent.click(screen.getByTestId('afk-scope-all'))
    expect(screen.getByTestId('afk-detail')).toBeInTheDocument()
    expect(screen.queryByTestId('afk-settings')).toBeNull()
  })

  it('工具 Dialog 进入首个控件、困住 Tab，Escape 关闭并把焦点还给打开按钮', async () => {
    await renderAfk({ snapshot: fixtureWithOperations() })
    const trigger = screen.getByTestId('afk-new-run')
    trigger.focus()
    fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog', { name: '自动运行工具' })
    const close = screen.getByTestId('afk-tool-close')
    const last = within(dialog).getAllByRole('button').at(-1)
    expect(close).toHaveFocus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(last).toHaveFocus()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(dialog).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('生产操作能力未接通时仍可开启现有任务的自动运行，但节奏设置里没有定时任务 sheet 并说明原因', async () => {
    await renderAfk()
    expect(screen.getByTestId('afk-new-run')).not.toBeDisabled()
    fireEvent.click(screen.getByTestId('afk-rail-settings'))
    expect(screen.queryByTestId('afk-settings-tab-starter')).toBeNull()
    expect(screen.queryByTestId('afk-settings-tab-run')).toBeNull()
    expect(screen.getByTestId('afk-ops-unavailable')).toBeInTheDocument()
  })

  it('没有可入队候选时「新建运行」禁用并说明原因', async () => {
    const snap = makeSnapshot([makeProject(ROOT, [makeChange('run-only', 'build', { fields: { automation: 'running' } })])])
    await renderAfk({ snapshot: snap })
    const link = screen.getByTestId('afk-new-run')
    expect(link).toBeDisabled()
    expect(link).toHaveAttribute('title', '当前没有可开启自动运行的任务')
  })
})

describe('AfkView 左列范围（循环）', () => {
  it('循环按 change 的 loop_id 归属：选中循环只显示归属它的运行，eyebrow 标出循环名', async () => {
    loopRows = [{ root: ROOT, id: 'dependency-update', name: 'dependency-update', autonomy_level: 'L2', status: 'active' }]
    await renderAfk()
    const loop = await screen.findByTestId('afk-scope-dependency-update')
    expect(loop).toHaveTextContent('循环 · active')
    expect(loop).toHaveTextContent('1')
    fireEvent.click(loop)
    expect(screen.getByTestId('afk-row-fail-c')).toBeInTheDocument()
    expect(screen.queryByTestId('afk-row-run-a')).toBeNull()
    expect(screen.getByTestId('afk-run-list')).toHaveTextContent('AFK-PROJ · 自动运行 · dependency-update')
    fireEvent.click(screen.getByTestId('afk-scope-all'))
    expect(screen.getByTestId('afk-row-run-a')).toBeInTheDocument()
  })

  it('其他项目的循环不进本页左列', async () => {
    loopRows = [{ root: '/tmp/other', id: 'elsewhere', name: 'elsewhere', autonomy_level: 'L1', status: 'active' }]
    await renderAfk()
    await waitFor(() => expect(screen.getByText('当前项目没有循环')).toBeInTheDocument())
    expect(screen.queryByTestId('afk-scope-elsewhere')).toBeNull()
  })
})

describe('AfkView 行动作（真实入队 / 重试 + 人工接管）', () => {
  it('「看它的流水线」→ onView(progress)', async () => {
    const props = await renderAfk()
    fireEvent.click(screen.getByTestId('afk-row-run-a'))
    fireEvent.click(screen.getByTestId('afk-flow-run-a'))
    expect(props.onView).toHaveBeenCalledWith('progress')
  })

  it('宿主提供精确入口时，「看它的流水线」传出 change 名而非只切换视图', async () => {
    const onOpenChange = vi.fn()
    const props = await renderAfk({ onOpenChange })
    fireEvent.click(screen.getByTestId('afk-row-run-a'))
    fireEvent.click(screen.getByTestId('afk-flow-run-a'))
    expect(onOpenChange).toHaveBeenCalledWith('run-a')
    expect(props.onView).not.toHaveBeenCalled()
  })

  it('失败行在处置 sheet 给「终端接管」命令（有 worktree → cd 接管），点击拷贝 + toast', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.assign(navigator, { clipboard: { writeText } })
    const props = await renderAfk()
    openSheet('handle')
    const chip = screen.getByTestId('afk-cmd-fail-c')
    expect(chip).toHaveAttribute('title', 'cd /wt/fail-c')
    fireEvent.click(chip)
    expect(writeText).toHaveBeenCalledWith('cd /wt/fail-c')
    await waitFor(() => expect(props.onToast).toHaveBeenCalled())
  })

  it('running / queued 行不给命令（只读推进态）', async () => {
    await renderAfk()
    openSheet('handle')
    fireEvent.click(screen.getByTestId('afk-row-run-a'))
    expect(screen.queryByTestId('afk-cmd-run-a')).toBeNull()
    fireEvent.click(screen.getByTestId('afk-row-q-b'))
    expect(screen.queryByTestId('afk-cmd-q-b')).toBeNull()
  })

  it('未入自动化的 change 可直接挂队：POST enqueue 带当前 root，成功反馈', async () => {
    const props = await renderAfk()
    fireEvent.click(screen.getByTestId('afk-new-run'))
    fireEvent.click(screen.getByTestId('afk-enqueue-gate-d'))
    await waitFor(() => expect(afkPosts).toHaveLength(1))
    expect(afkPosts[0]?.url).toBe('/api/afk/gate-d/enqueue')
    expect(JSON.parse(String(afkPosts[0]?.init?.body))).toEqual({ root: ROOT })
    await waitFor(() => expect(props.onToast).toHaveBeenCalledWith(expect.stringContaining('gate-d')))
  })

  it('失败行先展示只读重试预览，确认前不 POST；确认后才调用真实 retry', async () => {
    await renderAfk()
    openSheet('handle')
    fireEvent.click(screen.getByTestId('afk-retry-preview-fail-c'))
    const preview = screen.getByTestId('afk-retry-sheet')
    expect(preview).toHaveTextContent('重新运行验证')
    expect(preview).toHaveTextContent('不会自动合并')
    expect(afkPosts).toHaveLength(0)
    fireEvent.click(screen.getByTestId('afk-retry-confirm-fail-c'))
    await waitFor(() => expect(afkPosts[0]?.url).toBe('/api/afk/fail-c/retry'))
    expect(screen.getByTestId('afk-cmd-fail-c')).toHaveAttribute('title', 'cd /wt/fail-c')
  })

  it('重试 Dialog 进入取消动作、困住 Shift+Tab，Escape 关闭并恢复触发器焦点', async () => {
    await renderAfk()
    openSheet('handle')
    const trigger = screen.getByTestId('afk-retry-preview-fail-c')
    trigger.focus()
    fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog', { name: '重试预览' })
    const cancel = screen.getByRole('button', { name: '取消' })
    const confirm = screen.getByTestId('afk-retry-confirm-fail-c')
    expect(cancel).toHaveFocus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(confirm).toHaveFocus()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(dialog).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    expect(afkPosts).toHaveLength(0)
  })

  it('失败行无 worktree 现场 → 只给真实 retry，不再展示会被后端拒绝的 enqueue 命令', async () => {
    const snap = makeSnapshot([
      makeProject(ROOT, [makeChange('fail-x', 'build', { fields: { automation: 'failed' } })]),
    ])
    await renderAfk({ snapshot: snap })
    openSheet('handle')
    expect(screen.getByTestId('afk-retry-preview-fail-x')).toBeInTheDocument()
    expect(screen.queryByTestId('afk-cmd-fail-x')).toBeNull()
  })
})

describe('AfkView 空态', () => {
  it('无沙箱任务 → 中列 afk-empty、右列空态；「新建运行」仍在左列', async () => {
    const snap = makeSnapshot([makeProject(ROOT, [makeChange('gate-only', 'build', {})])])
    await renderAfk({ snapshot: snap })
    expect(screen.getByTestId('afk-empty').textContent).toContain('当前没有自动运行任务')
    expect(screen.queryByTestId('afk-sec-running')).toBeNull()
    expect(screen.queryByTestId('afk-sec-queued')).toBeNull()
    expect(screen.queryByTestId('afk-sec-failed')).toBeNull()
    expect(screen.getByTestId('afk-detail-empty')).toBeInTheDocument()
    expect(screen.getByTestId('afk-new-run')).not.toBeDisabled()
  })

  it('搜索输入声明稳定 name 并关闭浏览器自动填充', async () => {
    await renderAfk()
    const search = screen.getByRole('searchbox', { name: '搜索自动运行' })
    expect(search).toHaveAttribute('name', 'afk-search')
    expect(search).toHaveAttribute('autocomplete', 'off')
  })
})
