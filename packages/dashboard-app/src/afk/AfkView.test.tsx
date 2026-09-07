import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { I18nProvider } from '../i18n'
import { makeChange, makeProject, makeSnapshot } from '../testkit'
import { DEFAULT_RULES, rulesKey, type WorkflowRules } from '../model/workflowModel'
import { AfkView } from './AfkView'

vi.mock('./TaskRunPanel', () => ({ TaskRunPanel: () => null }))

const ROOT = '/tmp/afk-proj'

// 沙箱三态 fixture（automation 字段驱动 progressModel 五态判定）：running/queued/failed 各一，
// 外加一条非沙箱（无 automation → agent/gate 态）用于负向断言「不进 AFK 面」。
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

let automationSettings = { max_parallel: 4, max_retries: 1, default_opt_in: false, image: '' }
let afkPosts: Array<{ url: string; init: RequestInit | undefined }> = []
let settingsPosts: Array<Record<string, unknown>> = []

beforeEach(() => {
  localStorage.clear()
  afkPosts = []
  settingsPosts = []
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
    if (url === '/api/loops/snapshot') return new Response(JSON.stringify({ generated_at: '2026-07-20T00:00:00Z', rows: [] }), { status: 200 })
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
      <AfkView {...props} />
    </I18nProvider>,
  )
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  })
  return props
}

describe('AfkView 两栏自动运行工作区', () => {
  it('English empty state and automation tools contain no hard-coded Chinese product copy', async () => {
    localStorage.setItem('tenon-dashboard-lang', 'en')
    const empty = makeSnapshot([makeProject(ROOT, [makeChange('manual', 'build', {})])])
    empty.capabilities = { ...empty.capabilities, operations: true }
    await renderAfk({ snapshot: empty })
    expect(screen.getByTestId('afk-empty')).toHaveTextContent('No automatic runs right now')
    expect(screen.getByTestId('afk-view').textContent).not.toMatch(/[\u3400-\u9fff]/u)
    expect(screen.queryByTestId('afk-new-run')).toBeNull()
    expect(screen.getByTestId('afk-tool-starter')).toHaveTextContent('New schedule')
    expect(screen.getByTestId('afk-tool-run')).toHaveTextContent('Validate schedule')
  })

  it('English populated queue, facts, progress, activity, and retry preview contain no Chinese product copy', async () => {
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
    expect(view.textContent).not.toMatch(/[\u3400-\u9fff]/u)
    fireEvent.click(screen.getByTestId('afk-retry-preview-failed-en'))
    expect(screen.getByTestId('afk-retry-sheet').textContent).not.toMatch(/[\u3400-\u9fff]/u)
  })

  it('打开页面即以待处理任务为主视图，任务事实与动作合并进详情，不再重复展示下一步侧栏', async () => {
    await renderAfk()
    expect(screen.getByTestId('afk-view')).toHaveAttribute('data-page-frame', 'standard')
    expect(screen.getByRole('heading', { name: '自动运行' })).toBeInTheDocument()
    expect(screen.getByTestId('afk-queue')).toHaveTextContent('需要处理')
    expect(screen.getByTestId('afk-detail')).toHaveTextContent('fail-c')
    expect(screen.getByTestId('afk-detail')).toHaveTextContent('覆盖率 42%，要求至少 80%')
    expect(screen.getByTestId('afk-detail')).toHaveTextContent('工作流 default')
    expect(screen.getByTestId('afk-detail')).toHaveTextContent('自治 L2')
    expect(screen.getByTestId('afk-detail')).toHaveTextContent('技能 dependency-sweeper@v1.2.0')
    expect(screen.getByTestId('afk-detail')).toHaveTextContent('容器 node:20-bullseye')
    expect(screen.getByTestId('afk-detail')).toHaveTextContent('查看重试预览')
    expect(screen.queryByTestId('afk-inspector')).toBeNull()
    const queue = screen.getByTestId('afk-queue')
    expect(queue.parentElement?.className).toContain('grid-cols-[360px_minmax(0,1fr)]')
    expect(within(queue).getByText('fail-c').className).not.toContain('truncate')
    for (const project of within(queue).getAllByText('项目 · afk-proj')) expect(project.className).not.toContain('truncate')
  })

  it('七阶段轨道由独立横向滚动视口承载，窄窗口不会裁掉归档阶段', async () => {
    await renderAfk()
    const viewport = screen.getByTestId('afk-stage-scroll')
    const track = screen.getByTestId('afk-stage-track')
    expect(viewport).toContainElement(track)
    expect(within(track).getAllByText(/^(立项|调研|规格|实现|验证|交付|归档)$/)).toHaveLength(7)
  })

  it('三栏各列出对应态的 change；非沙箱 change 不进面板', async () => {
    await renderAfk()
    expect(within(screen.getByTestId('afk-sec-running')).getByTestId('afk-row-run-a')).toBeInTheDocument()
    expect(within(screen.getByTestId('afk-sec-queued')).getByTestId('afk-row-q-b')).toBeInTheDocument()
    expect(within(screen.getByTestId('afk-sec-failed')).getByTestId('afk-row-fail-c')).toBeInTheDocument()
    // 非沙箱（无 automation）不出现
    expect(screen.queryByTestId('afk-row-gate-d')).toBeNull()
    // 正常对话的终端心跳虽然在进度页属于“运行中”，但不是自动运行任务。
    expect(screen.queryByTestId('afk-row-terminal-live')).toBeNull()
    expect(screen.getByTestId('afk-health')).toHaveTextContent('运行中 1')
    expect(screen.getByTestId('afk-health')).toHaveTextContent('等待中 1')
    expect(screen.getByTestId('afk-health')).toHaveTextContent('需要处理 1')
  })

  it('选择运行中的任务后详情同步切换，不残留失败任务的重试动作', async () => {
    await renderAfk()
    fireEvent.click(screen.getByTestId('afk-row-run-a'))
    expect(screen.getByTestId('afk-detail')).toHaveTextContent('run-a')
    expect(screen.getByTestId('afk-detail')).toHaveTextContent('运行中')
    expect(screen.queryByTestId('afk-retry-preview-fail-c')).toBeNull()
  })

  it('搜索无结果时清除过期详情并提供恢复入口', async () => {
    await renderAfk()
    const search = screen.getByPlaceholderText('搜索任务或定时任务…')
    fireEvent.change(search, { target: { value: 'does-not-exist' } })

    expect(screen.getByTestId('afk-filter-empty')).toBeInTheDocument()
    expect(screen.queryByTestId('afk-detail')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '清除条件' }))
    expect(screen.getByTestId('afk-detail')).toBeInTheDocument()
  })

  it('行标 data-state 与相位（afk.at_phase：{phase 展示名} · 沙箱）', async () => {
    await renderAfk()
    const row = screen.getByTestId('afk-row-fail-c')
    expect(row).toHaveAttribute('data-state', 'failed')
    expect(row.textContent).toContain('验证 · 需要处理')
    expect(row).toHaveTextContent('afk-proj')
    expect(row.querySelector('i')).toBeNull()
  })

  it('并发上限是可保存的真实设置：修改后 POST 全量 automation 配置', async () => {
    await renderAfk()
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
    await waitFor(() => expect(screen.queryByTestId('afk-enqueue-panel')).toBeNull())
    expect(props.onToast).toHaveBeenCalledWith(expect.stringContaining('gate-d'))
    expect(props.onToast).toHaveBeenCalledWith(expect.stringContaining('6'))
  })

  it('调度汇总灯：三态齐（有 failed）→ data-status=attention', async () => {
    await renderAfk()
    expect(screen.getByTestId('afk-health')).toHaveAttribute('data-status', 'attention')
  })

  it('生产能力开启时只保留“开启自动运行 / 新建定时任务 / 验证定时任务”，全部在居中对话框打开', async () => {
    await renderAfk({ snapshot: fixtureWithOperations() })
    expect(screen.queryByTestId('afk-tool-cadence')).toBeNull()
    expect(screen.queryByTestId('afk-tool-triage')).toBeNull()
    expect(screen.queryByTestId('afk-tool-sync')).toBeNull()
    expect(screen.queryByTestId('afk-enqueue-panel')).toBeNull()
    fireEvent.click(screen.getByTestId('afk-new-run'))
    expect(within(screen.getByTestId('afk-tool-sheet')).getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByTestId('afk-tool-sheet')).toHaveTextContent('开启自动运行')
    expect(screen.getByTestId('afk-tool-sheet')).toHaveTextContent('不创建新任务，也不改变它的工作流')
    expect(screen.getByTestId('afk-enqueue-gate-d')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('afk-tool-close'))
    fireEvent.click(screen.getByTestId('afk-tool-starter'))
    await waitFor(() => expect(screen.getByTestId('ops-starter-daily-triage')).toBeInTheDocument())
    expect(screen.getByTestId('afk-tool-sheet')).toHaveTextContent('选择定时任务类型')
    expect(screen.getByTestId('afk-tool-sheet')).toHaveTextContent('模板决定如何发现或生成任务')
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

  it('390px 动作区使用完整可见的换行布局，不以隐藏横向滚动承载 English 长标签', async () => {
    localStorage.setItem('tenon-dashboard-lang', 'en')
    await renderAfk({ snapshot: fixtureWithOperations() })
    const nav = screen.getByTestId('afk-tool-nav')
    expect(nav.className).toContain('flex-wrap')
    expect(nav.className).not.toContain('overflow-x-auto')
    expect(within(nav).getAllByRole('button')).toHaveLength(2)
  })

  it('生产操作能力未接通时仍可开启现有任务的自动运行，但新建与验证定时任务明确禁用', async () => {
    await renderAfk()
    expect(screen.getByTestId('afk-new-run')).not.toBeDisabled()
    expect(screen.queryByTestId('afk-tool-nav')).toBeNull()
    expect(screen.queryByTestId('afk-tool-starter')).toBeNull()
    expect(screen.queryByTestId('afk-tool-run')).toBeNull()
  })
})

describe('AfkView 行动作（真实入队 / 重试 + 人工接管）', () => {
  it('每行「看它的流水线」→ onView(progress)', async () => {
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

  it('失败行给「回终端」命令 chip（有 worktree → cd 接管），点击拷贝 + toast', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.assign(navigator, { clipboard: { writeText } })
    const props = await renderAfk()
    const chip = screen.getByTestId('afk-cmd-fail-c')
    expect(chip).toHaveAttribute('title', 'cd /wt/fail-c')
    fireEvent.click(chip)
    expect(writeText).toHaveBeenCalledWith('cd /wt/fail-c')
    await waitFor(() => expect(props.onToast).toHaveBeenCalled())
  })

  it('running / queued 行不给命令 chip（只读推进态）', async () => {
    await renderAfk()
    expect(screen.queryByTestId('afk-cmd-run-a')).toBeNull()
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
    expect(screen.getByTestId('afk-retry-preview-fail-x')).toBeInTheDocument()
    expect(screen.queryByTestId('afk-cmd-fail-x')).toBeNull()
  })
})

describe('AfkView 迷你流水线轨（MiniTrack：change 在整条流水线的位置）', () => {
  // DEFAULT_RULES.steps 剔 archive = [open, explore, spec, build, verify, ship]（6 节）。
  it('每行渲染迷你轨；节点数 = steps 去 archive 后长度', async () => {
    await renderAfk()
    const track = screen.getByTestId('afk-track-run-a')
    expect(track).toBeInTheDocument()
    expect(track).toHaveAttribute('data-phase', 'build')
    expect(track.querySelectorAll('[data-state]')).toHaveLength(6)
  })

  it('change.phase 命中处 = current，之前 = done，之后 = todo', async () => {
    await renderAfk()
    // run-a 在 build（default 序第 4 步，idx 3）：open/explore/spec = done，build = current，verify/ship = todo
    const track = screen.getByTestId('afk-track-run-a')
    const state = (phase: string) => track.querySelector(`[data-phase="${phase}"]`)?.getAttribute('data-state')
    expect(state('open')).toBe('done')
    expect(state('explore')).toBe('done')
    expect(state('spec')).toBe('done')
    expect(state('build')).toBe('current')
    expect(state('verify')).toBe('todo')
    expect(state('ship')).toBe('todo')
    // archive 终态不入轨
    expect(track.querySelector('[data-phase="archive"]')).toBeNull()
  })

  it('轨纯装饰（aria-hidden）——相位语义由行内 afk.at_phase 文本承载', async () => {
    await renderAfk()
    expect(screen.getByTestId('afk-track-q-b')).toHaveAttribute('aria-hidden', 'true')
  })

  it('三态各自当前步命中：queued(spec)/failed(verify)', async () => {
    await renderAfk()
    const qCurrent = screen
      .getByTestId('afk-track-q-b')
      .querySelector('[data-state="current"]')
    expect(qCurrent).toHaveAttribute('data-phase', 'spec')
    const fCurrent = screen
      .getByTestId('afk-track-fail-c')
      .querySelector('[data-state="current"]')
    expect(fCurrent).toHaveAttribute('data-phase', 'verify')
    expect(fCurrent).toHaveAttribute('data-error', 'true')
  })

  it('详情不重复展示状态和当前阶段；时间统一为中文年月日时分秒', async () => {
    await renderAfk()
    const detail = screen.getByTestId('afk-detail')
    expect(within(detail).queryByRole('heading', { name: '运行状态' })).toBeNull()
    expect(detail).not.toHaveTextContent('当前阶段')
    expect(detail).toHaveTextContent('2026年07月07日 00:00:00')
  })
})

describe('AfkView 空态', () => {
  it('无沙箱任务 → afk-empty，三栏不渲染且只保留工具栏一处创建入口', async () => {
    const snap = makeSnapshot([makeProject(ROOT, [makeChange('gate-only', 'build', {})])])
    await renderAfk({ snapshot: snap })
    expect(screen.getByTestId('afk-empty').textContent).toContain('当前没有自动运行任务')
    expect(screen.queryByTestId('afk-sec-running')).toBeNull()
    expect(screen.queryByTestId('afk-sec-queued')).toBeNull()
    expect(screen.queryByTestId('afk-sec-failed')).toBeNull()
    expect(screen.queryByTestId('afk-new-run')).toBeNull()
    expect(screen.queryByTestId('afk-tool-nav')).toBeNull()
  })

  it('搜索输入声明稳定 name 并关闭浏览器自动填充', async () => {
    await renderAfk()
    expect(screen.getByRole('textbox', { name: '搜索自动运行' })).toHaveAttribute('name', 'afk-search')
    expect(screen.getByRole('textbox', { name: '搜索自动运行' })).toHaveAttribute('autocomplete', 'off')
  })
})
