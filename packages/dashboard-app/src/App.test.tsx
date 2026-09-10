import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App, ErrorBoundary } from './App'
import { I18nProvider } from './i18n'
import { lastEventSource, resetEventSources } from './test-setup'
import { makeChange, makeProject, makeSnapshot } from './testkit'
import { invalidateMandatoryConfig } from './workbench/mandatoryConfig'

const originalNavigationDescriptor = Object.getOwnPropertyDescriptor(window, 'navigation')

/** Trusted Verify fixture: mirror the server snapshot's canonical readiness projection locally. */
const TRUSTED_VERIFY_EXECUTION = {
  readinessByTransition: {
    verify: {
      'verify-pass': { ready: true, blockers: [] },
      'verify-fail': { ready: true, blockers: [] },
    },
  },
}

function trustedVerifyChange(name: string, over: Parameters<typeof makeChange>[2] = {}) {
  return makeChange(name, 'verify', { ...over, workflowExecution: TRUSTED_VERIFY_EXECUTION })
}

// T17（计划 2026-07-11-v5-interaction-rebuild）：IA 收敛三视图。旧断言意图迁移表：
//   · 「一级导航恰 4 项（3+下拉触发）」→「恰 3 项：收件箱/进度/工作台」
//   · 「点看板→board-view / 点设置→settings-view」→「点进度→progress-view / 点工作台→workbench-view」
//   · 「注册对话框（register-dialog）三条」→ 注册 UI 退役（决议#7），迁移为 0 渲染断言；
//     零项目教学态断言收进 G18 describe（教学文案 + 无表单 + 无幽灵命令）
//   · 「工作台下拉→workflow 编辑器（nav-workflows）」→ 工作台是单一视图，直达断言
//   · 新增：视图记忆 localStorage 兜底（旧值 board/settings → inbox）、聚合语境进度渲染护栏
// v9-flowdeck 收件箱退役（叠加迁移）：
//   · 「默认落地=收件箱」→「默认落地=进度」；导航恰 2 项，nav-inbox 0 渲染
//   · 「收件箱空态/卡片/徽标（inbox-empty/inbox-card/inbox-badge）」→ 徽标断言迁 progress-badge，
//     空态「去进度」按钮用例整体删除（视图不复存在）；视图记忆兜底目标 inbox → progress
beforeEach(() => {
  localStorage.clear()
  resetEventSources()
  invalidateMandatoryConfig()
  // 大多数既有 App 用例关注已选项目内行为，统一从显式 root 深链进入；无选择契约用例会覆盖 URL。
  window.history.replaceState({}, '', '/?root=%2Frepo')
  const navigation = new EventTarget()
  Object.defineProperty(navigation, 'currentEntry', {
    configurable: true,
    get: () => ({ index: 0 }),
  })
  Object.defineProperty(window, 'navigation', { configurable: true, value: navigation })
  try {
    delete document.documentElement.dataset.theme
    delete document.documentElement.dataset.themePreference
  } catch {
    /* ignore */
  }
  // 初始 GET /api/snapshot → 单项目一张非 gate 卡（默认落地=进度，无待拍板徽标语境）；
  // /api/workflows、/api/hooks、/api/loops/snapshot 三个分支喂 WorkbenchView 挂载时的真 fetch
  // （names 空 → 选中 default 零网络投影；hooks/loops 给合法空数据，不迫使工作台走错误分支）。
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/snapshot') {
        return { ok: true, json: async () => makeSnapshot([makeProject('/repo', [makeChange('seed-c', 'build')])]) }
      }
      if (url.startsWith('/api/workflows?root=')) {
        return { ok: true, json: async () => ({ names: [] }) }
      }
      if (url.startsWith('/api/hooks?root=')) {
        return { ok: true, json: async () => ({ ok: true, hooks: [], matrix: {} }) }
      }
      if (url === '/api/loops/snapshot') {
        return { ok: true, json: async () => ({ generated_at: '2026-07-11T00:00:00Z', rows: [] }) }
      }
      throw new Error(`unexpected fetch ${url}`)
    }),
  )
})
afterEach(() => {
  vi.restoreAllMocks()
  if (originalNavigationDescriptor) {
    Object.defineProperty(window, 'navigation', originalNavigationDescriptor)
  } else {
    Reflect.deleteProperty(window, 'navigation')
  }
})

const EDITABLE_WORKFLOW = {
  name: 'release-train',
  steps: [
    {
      id: 'draft',
      label: '起草',
      gate: null,
      skills: [],
      inputs: [],
      outputs: [],
      guards: [],
      transitions: [],
    },
  ],
}

function stubEditableWorkbench(options: {
  preserveLocation?: boolean
  roots?: readonly string[]
  promptRoutingBypass?: boolean
  trackSettings?: boolean
} = {}): void {
  const roots = options.roots ?? ['/repo']
  // 编辑器只在页面持有写凭证时开放输入；测试同生产一样由宿主注入 token。
  ;(window as unknown as { __TENON_DASHBOARD_TOKEN__?: string }).__TENON_DASHBOARD_TOKEN__ = 'test-token'
  if (!options.preserveLocation) {
    window.history.replaceState({ page: 'workbench' }, '', '/?view=workbench&root=%2Frepo')
  }
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/snapshot') {
      return new Response(JSON.stringify(makeSnapshot(
        roots.map((root) => makeProject(root, [makeChange(`seed-${root.split('/').filter(Boolean).at(-1) ?? 'root'}`, 'build')])),
      )), { status: 200 })
    }
    if (roots.some((root) => url === `/api/workflows?root=${encodeURIComponent(root)}`)) {
      return new Response(JSON.stringify({ names: ['release-train'] }), { status: 200 })
    }
    if (roots.some((root) => url === `/api/workflows/release-train?root=${encodeURIComponent(root)}`)) {
      return new Response(JSON.stringify(EDITABLE_WORKFLOW), { status: 200 })
    }
    if (url.startsWith('/api/hooks?root=')) {
      return new Response(JSON.stringify({
        ok: true,
        hooks: options.promptRoutingBypass
          ? [{ id: 'router', event: 'UserPromptSubmit', matcher: '*', script: 'hooks/router.sh', configurable: true }]
          : [],
        matrix: {},
        prompt_skip_keyword: 'no-tenon',
      }), { status: 200 })
    }
    if (url === '/api/loops/snapshot') {
      return new Response(JSON.stringify({ generated_at: '2026-07-30T00:00:00Z', rows: [] }), { status: 200 })
    }
    if (url.startsWith('/api/config?root=')) {
      return new Response(JSON.stringify({
        ok: true,
        generated_at: '2026-07-30T00:00:00Z',
        revision: 'app-dirty-r1',
        source: 'builtin-only',
        mandatory_skills_writable_profiles: [],
        mandatory_skills: {},
        tracks: options.trackSettings ? [{
          id: 'pm', label: 'PM', builtin: true,
          workflow: { default: 'default', allowed: '*' },
          policyProfile: {
            reviewSeed: 'pending', automationEligible: true, coverageProfile: 'pm',
            routing: { enabled: false }, skills: { matrix: true, profile: 'pm' },
          },
        }] : [],
      }), { status: 200 })
    }
    if (url === '/api/skills/registry') {
      return new Response(JSON.stringify({ skills: [] }), { status: 200 })
    }
    throw new Error(`unexpected fetch ${url}`)
  }))
}

async function renderDirtyWorkbenchApp(options: {
  preserveLocation?: boolean
  trackSettings?: boolean
} = {}): Promise<void> {
  stubEditableWorkbench(options)
  render(<App />)
  await screen.findByTestId('wb-step-draft')
  const input = await screen.findByTestId('wb-lane-name-input-draft')
  fireEvent.change(input, { target: { value: '未保存草稿' } })
  await screen.findByTestId('wb-dirty')
}

describe('App Workbench 未保存草稿离开守卫', () => {

  it('Workbench 内 browser Back 切换项目时，取消保留 root A 草稿，确认才进入 root B', async () => {
    const rootA = '/repo-a'
    const rootB = '/repo-b'
    window.history.replaceState(
      { page: 'workbench-b', __tenonDashboardPosition: 0 },
      '',
      `/?view=workbench&root=${encodeURIComponent(rootB)}`,
    )
    window.history.pushState(
      { page: 'workbench-a', __tenonDashboardPosition: 1 },
      '',
      `/?view=workbench&root=${encodeURIComponent(rootA)}`,
    )
    stubEditableWorkbench({ preserveLocation: true, roots: [rootA, rootB] })
    render(<App />)
    await screen.findByTestId('wb-step-draft')
    const input = await screen.findByTestId('wb-lane-name-input-draft')
    fireEvent.change(input, { target: { value: 'root A 未保存草稿' } })
    await screen.findByTestId('wb-dirty')

    act(() => window.history.back())
    const firstDialog = await screen.findByTestId('app-unsaved-navigation')
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('root')).toBe(rootA))
    expect(screen.getByTestId('wb-lane-name-draft')).toHaveTextContent('root A 未保存草稿')

    fireEvent.click(within(firstDialog).getByRole('button', { name: '继续编辑' }))
    expect(screen.queryByTestId('app-unsaved-navigation')).toBeNull()
    expect(new URLSearchParams(window.location.search).get('root')).toBe(rootA)
    expect(screen.getByTestId('wb-lane-name-draft')).toHaveTextContent('root A 未保存草稿')

    act(() => window.history.back())
    const secondDialog = await screen.findByTestId('app-unsaved-navigation')
    fireEvent.click(within(secondDialog).getByRole('button', { name: '丢弃并离开' }))

    await waitFor(() => expect(new URLSearchParams(window.location.search).get('root')).toBe(rootB))
    await waitFor(() => expect(screen.getByTestId('wb-lane-name-draft')).toHaveTextContent('起草'))
  })

  it('取消浏览器 Back 用 forward 补偿，不 replace/corrupt 目标历史项；随后仍可确认同一次 Back', async () => {
    window.history.replaceState(
      { page: 'overview-target', __tenonDashboardPosition: 0 },
      '',
      '/?view=progress&historyMarker=target',
    )
    window.history.pushState(
      { page: 'workbench-current', __tenonDashboardPosition: 1 },
      '',
      '/?view=workbench&root=%2Frepo',
    )
    await renderDirtyWorkbenchApp({ preserveLocation: true })

    const replaceState = vi.spyOn(window.history, 'replaceState')
    const forward = vi.spyOn(window.history, 'forward')
    act(() => window.history.back())

    const firstDialog = await screen.findByTestId('app-unsaved-navigation')
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('view')).toBe('workbench'))
    expect(forward).toHaveBeenCalledTimes(1)
    expect(replaceState).not.toHaveBeenCalled()
    fireEvent.click(within(firstDialog).getByRole('button', { name: '继续编辑' }))

    act(() => window.history.back())
    const secondDialog = await screen.findByTestId('app-unsaved-navigation')
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('view')).toBe('workbench'))
    fireEvent.click(within(secondDialog).getByRole('button', { name: '丢弃并离开' }))

    expect(await screen.findByTestId('workspace-view')).toBeInTheDocument()
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('historyMarker')).toBe('target'))
  })

  it('取消浏览器 Forward 用 back 补偿；确认时重放 Forward 而不是错误地 Back', async () => {
    window.history.replaceState(
      { page: 'workbench-current', __tenonDashboardPosition: 0 },
      '',
      '/?view=workbench&root=%2Frepo',
    )
    window.history.pushState(
      { page: 'overview-forward', __tenonDashboardPosition: 1 },
      '',
      '/?view=progress&historyMarker=forward-target',
    )
    window.history.back()
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('view')).toBe('workbench'))
    await renderDirtyWorkbenchApp({ preserveLocation: true })

    const back = vi.spyOn(window.history, 'back')
    const forward = vi.spyOn(window.history, 'forward')
    act(() => window.history.forward())

    const firstDialog = await screen.findByTestId('app-unsaved-navigation')
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('view')).toBe('workbench'))
    expect(back).toHaveBeenCalledTimes(1)
    fireEvent.click(within(firstDialog).getByRole('button', { name: '继续编辑' }))

    act(() => window.history.forward())
    const secondDialog = await screen.findByTestId('app-unsaved-navigation')
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('view')).toBe('workbench'))
    fireEvent.click(within(secondDialog).getByRole('button', { name: '丢弃并离开' }))

    expect(await screen.findByTestId('workspace-view')).toBeInTheDocument()
    expect(forward).toHaveBeenCalledTimes(3)
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('historyMarker')).toBe('forward-target'))
  })

  it('未标记的 browser Forward 使用宿主真实 history index 补偿与重放，不误判为 Back', async () => {
    Object.defineProperty(window, 'navigation', {
      configurable: true,
      value: {
        get currentEntry() {
          return {
            index: new URLSearchParams(window.location.search).get('historyMarker') === 'unmarked-forward-target'
              ? 1
              : 0,
          }
        },
      },
    })
    window.history.replaceState(
      { page: 'workbench-current' },
      '',
      '/?view=workbench&root=%2Frepo',
    )
    window.history.pushState(
      { page: 'overview-forward' },
      '',
      '/?view=progress&historyMarker=unmarked-forward-target',
    )
    window.history.back()
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('view')).toBe('workbench'))
    await renderDirtyWorkbenchApp({ preserveLocation: true })

    const back = vi.spyOn(window.history, 'back')
    const forward = vi.spyOn(window.history, 'forward')
    act(() => window.history.forward())

    const firstDialog = await screen.findByTestId('app-unsaved-navigation')
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('view')).toBe('workbench'))
    expect(back).toHaveBeenCalledTimes(1)
    expect(forward).toHaveBeenCalledTimes(1)
    fireEvent.click(within(firstDialog).getByRole('button', { name: '继续编辑' }))

    act(() => window.history.forward())
    const secondDialog = await screen.findByTestId('app-unsaved-navigation')
    fireEvent.click(within(secondDialog).getByRole('button', { name: '丢弃并离开' }))

    expect(await screen.findByTestId('workspace-view')).toBeInTheDocument()
    expect(forward).toHaveBeenCalledTimes(3)
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('historyMarker')).toBe('unmarked-forward-target'))
  })

  it('Dashboard push 后跨多项跳到未标记 entry，按最新宿主 index 完整补偿而不是少走一步', async () => {
    Object.defineProperty(window, 'navigation', {
      configurable: true,
      value: {
        get currentEntry() {
          const marker = new URLSearchParams(window.location.search).get('historyMarker')
          if (marker === 'unmarked-distant-target') return { index: 0 }
          const position = typeof window.history.state === 'object' && window.history.state !== null
            ? Reflect.get(window.history.state, '__tenonDashboardPosition')
            : null
          return { index: position === 1 ? 2 : 1 }
        },
      },
    })
    window.history.replaceState(
      { page: 'unmarked-overview' },
      '',
      '/?view=progress&historyMarker=unmarked-distant-target',
    )
    window.history.pushState(
      { page: 'dashboard-projects' },
      '',
      '/?view=progress&historyMarker=dashboard-middle',
    )
    stubEditableWorkbench({ preserveLocation: true })
    render(<App />)
    fireEvent.click(await screen.findByTestId('project-rail-item-repo'))
    await waitFor(() => {
      const search = new URLSearchParams(window.location.search)
      expect(search.get('view')).toBe('progress')
      expect(search.get('root')).toBe('/repo')
    }, { timeout: 5_000 })
    expect(await screen.findByTestId('workspace-view', {}, { timeout: 5_000 })).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('nav-workbench'))
    await screen.findByTestId('wb-step-draft')
    const input = await screen.findByTestId('wb-lane-name-input-draft')
    fireEvent.change(input, { target: { value: '跨多项草稿' } })
    await screen.findByTestId('wb-dirty')

    act(() => window.history.go(-2))
    const dialog = await screen.findByTestId('app-unsaved-navigation')
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('view')).toBe('workbench'))
    expect(screen.getByTestId('wb-lane-name-draft')).toHaveTextContent('跨多项草稿')
    fireEvent.click(within(dialog).getByRole('button', { name: '继续编辑' }))
  })

  it('dirty Workbench 在 SSE 移除或降级当前项目时保留草稿宿主并禁写，恢复后草稿仍在，只有显式丢弃才卸载', async () => {
    await renderDirtyWorkbenchApp()
    const eventSource = lastEventSource()
    expect(eventSource).toBeDefined()

    act(() => {
      eventSource!.emit('snapshot', JSON.stringify(makeSnapshot([
        makeProject('/repo', [makeChange('seed-c', 'build')], { ok: false }),
      ])))
    })

    const firstDialog = await screen.findByTestId('app-unsaved-navigation')
    const retainedHost = screen.getByTestId('workbench-retained-host')
    expect(retainedHost).toHaveAttribute('inert')
    expect(firstDialog).not.toHaveAttribute('inert')
    expect(screen.getByTestId('wb-lane-name-draft')).toHaveTextContent('未保存草稿')
    fireEvent.click(within(firstDialog).getByRole('button', { name: '继续编辑' }))
    expect(screen.getByTestId('workbench-retained-host')).toHaveAttribute('inert')
    expect(screen.getByTestId('wb-lane-name-draft')).toHaveTextContent('未保存草稿')
    expect(new URLSearchParams(window.location.search).get('root')).toBe('/repo')

    act(() => {
      eventSource!.emit('snapshot', JSON.stringify(makeSnapshot([
        makeProject('/repo', [makeChange('seed-c', 'build')]),
      ])))
    })
    await waitFor(() => expect(screen.getByTestId('workbench-retained-host')).not.toHaveAttribute('inert'))
    expect(screen.getByTestId('wb-lane-name-draft')).toHaveTextContent('未保存草稿')
    expect(new URLSearchParams(window.location.search).get('root')).toBe('/repo')

    act(() => {
      eventSource!.emit('snapshot', JSON.stringify(makeSnapshot([])))
    })
    const secondDialog = await screen.findByTestId('app-unsaved-navigation')
    expect(screen.getByTestId('wb-lane-name-draft')).toHaveTextContent('未保存草稿')
    fireEvent.click(within(secondDialog).getByRole('button', { name: '丢弃并离开' }))

    expect(await screen.findByTestId('onboard-no-project')).toBeInTheDocument()
    expect(screen.queryByTestId('workbench-view')).toBeNull()
  })

  it('已阻断的 browser Back 不会被随后发生的 root 失权覆盖，丢弃后仍到达原历史目标', async () => {
    window.history.replaceState(
      { page: 'overview', __tenonDashboardPosition: 0 },
      '',
      '/?view=progress',
    )
    window.history.pushState(
      { page: 'workbench', __tenonDashboardPosition: 1 },
      '',
      '/?view=workbench&root=%2Frepo',
    )
    await renderDirtyWorkbenchApp({ preserveLocation: true })
    const eventSource = lastEventSource()
    expect(eventSource).toBeDefined()

    act(() => window.history.back())
    const dialog = await screen.findByTestId('app-unsaved-navigation')
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('view')).toBe('workbench'))

    act(() => {
      eventSource!.emit('snapshot', JSON.stringify(makeSnapshot([])))
    })
    expect(screen.getByTestId('workbench-retained-host')).toHaveAttribute('inert')
    expect(screen.getByTestId('wb-lane-name-draft')).toHaveTextContent('未保存草稿')

    fireEvent.click(within(dialog).getByRole('button', { name: '丢弃并离开' }))

    // 项目注册表已空：落到零项目教学态，URL 仍指向工作台。
    expect(await screen.findByTestId('onboard-no-project')).toBeInTheDocument()
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('view')).toBe('progress'))
  })

  it('已阻断的一级导航不会被随后发生的 root 失权覆盖，丢弃后仍到达原页面目标', async () => {
    await renderDirtyWorkbenchApp()
    const eventSource = lastEventSource()
    expect(eventSource).toBeDefined()

    fireEvent.click(screen.getByTestId('nav-progress'))
    const dialog = await screen.findByTestId('app-unsaved-navigation')

    act(() => {
      eventSource!.emit('snapshot', JSON.stringify(makeSnapshot([])))
    })
    expect(screen.getByTestId('workbench-retained-host')).toHaveAttribute('inert')
    expect(screen.getByTestId('wb-lane-name-draft')).toHaveTextContent('未保存草稿')

    fireEvent.click(within(dialog).getByRole('button', { name: '丢弃并离开' }))

    // 项目注册表已空：工作台落到零项目教学态（onboarding 覆盖所有视图）。
    expect(await screen.findByTestId('onboard-no-project')).toBeInTheDocument()
    expect(new URLSearchParams(window.location.search).get('view')).toBe('progress')
    expect(screen.queryByTestId('workbench-view')).toBeNull()
  })

  it('已阻断的一级导航不会被随后发生的 browser Back 覆盖，丢弃后仍到达最先请求的页面', async () => {
    window.history.replaceState({ page: 'projects' }, '', '/?view=progress&root=%2Frepo')
    window.history.pushState({ page: 'workbench' }, '', '/?view=workbench&root=%2Frepo')
    await renderDirtyWorkbenchApp({ preserveLocation: true })

    fireEvent.click(screen.getByTestId('nav-progress'))
    const dialog = await screen.findByTestId('app-unsaved-navigation')

    act(() => window.history.back())
    fireEvent.click(within(dialog).getByRole('button', { name: '丢弃并离开' }))

    expect(await screen.findByTestId('workspace-view')).toBeInTheDocument()
    expect(new URLSearchParams(window.location.search).get('view')).toBe('progress')
    expect(screen.queryByTestId('workbench-view')).toBeNull()
  })

  it('Navigation API 在 traversal 发起点取消迟到 Back，不依赖动画帧推定结算', async () => {
    window.history.replaceState({ page: 'projects' }, '', '/?view=progress&root=%2Frepo')
    window.history.pushState({ page: 'workbench' }, '', '/?view=workbench&root=%2Frepo')
    await renderDirtyWorkbenchApp({ preserveLocation: true })

    const delayedBacks: Array<() => void> = []
    const navigation = Reflect.get(window, 'navigation') as EventTarget
    vi.spyOn(window.history, 'back').mockImplementation(() => {
      const navigate = new Event('navigate', { cancelable: true })
      Object.defineProperties(navigate, {
        navigationType: { value: 'traverse' },
        canIntercept: { value: true },
      })
      navigation.dispatchEvent(navigate)
      if (navigate.defaultPrevented) return
      delayedBacks.push(() => {
        window.history.replaceState(
          { page: 'projects', __tenonDashboardPosition: -1 },
          '',
          '/?view=progress&root=%2Frepo',
        )
        window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }))
      })
    })

    fireEvent.click(screen.getByTestId('nav-progress'))
    const dialog = await screen.findByTestId('app-unsaved-navigation')
    act(() => window.history.back())
    expect(delayedBacks).toHaveLength(0)
    fireEvent.click(within(dialog).getByRole('button', { name: '丢弃并离开' }))

    expect(await screen.findByTestId('workspace-view')).toBeInTheDocument()
    expect(new URLSearchParams(window.location.search).get('view')).toBe('progress')
    expect(screen.queryByTestId('workbench-view')).toBeNull()
  })

  it('不可取消的 traverse 已发起时等待真实 popstate 与 inverse restore，再提交普通页面目标', async () => {
    window.history.replaceState(
      { page: 'projects', __tenonDashboardPosition: -1 },
      '',
      '/?view=progress&root=%2Frepo',
    )
    window.history.pushState(
      { page: 'workbench', __tenonDashboardPosition: 0 },
      '',
      '/?view=workbench&root=%2Frepo',
    )
    await renderDirtyWorkbenchApp({ preserveLocation: true })

    const delayedBacks: Array<() => void> = []
    const navigation = Reflect.get(window, 'navigation') as EventTarget
    vi.spyOn(window.history, 'back').mockImplementation(() => {
      const navigate = new Event('navigate', { cancelable: false })
      Object.defineProperties(navigate, {
        navigationType: { value: 'traverse' },
        canIntercept: { value: false },
      })
      navigation.dispatchEvent(navigate)
      delayedBacks.push(() => {
        window.history.replaceState(
          { page: 'projects', __tenonDashboardPosition: -1 },
          '',
          '/?view=progress&root=%2Frepo',
        )
        window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }))
      })
    })
    vi.spyOn(window.history, 'forward').mockImplementation(() => {
      window.history.replaceState(
        { page: 'workbench', __tenonDashboardPosition: 0 },
        '',
        '/?view=workbench&root=%2Frepo',
      )
      window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }))
    })

    fireEvent.click(screen.getByTestId('nav-progress'))
    const dialog = await screen.findByTestId('app-unsaved-navigation')
    act(() => window.history.back())
    fireEvent.click(within(dialog).getByRole('button', { name: '丢弃并离开' }))
    expect(screen.getByTestId('workbench-view')).toBeInTheDocument()

    act(() => delayedBacks.shift()?.())
    expect(await screen.findByTestId('workspace-view')).toBeInTheDocument()
    expect(new URLSearchParams(window.location.search).get('view')).toBe('progress')
    expect(screen.queryByTestId('workbench-view')).toBeNull()
  })

  it('不可取消的 traverse 在 popstate 前 abort 会按精确事务释放 barrier', async () => {
    await renderDirtyWorkbenchApp()
    const navigation = Reflect.get(window, 'navigation') as EventTarget
    const controller = new AbortController()

    fireEvent.click(screen.getByTestId('nav-progress'))
    const dialog = await screen.findByTestId('app-unsaved-navigation')
    const navigate = new Event('navigate', { cancelable: false })
    Object.defineProperties(navigate, {
      navigationType: { value: 'traverse' },
      canIntercept: { value: true },
      signal: { value: controller.signal },
    })
    navigation.dispatchEvent(navigate)
    act(() => controller.abort())

    fireEvent.click(within(dialog).getByRole('button', { name: '丢弃并离开' }))
    expect(await screen.findByTestId('workspace-view')).toBeInTheDocument()
    expect(new URLSearchParams(window.location.search).get('view')).toBe('progress')
  })

  it('丢弃已等待不可取消 traversal 时，后续 abort 会执行且只执行 winner callback', async () => {
    await renderDirtyWorkbenchApp()
    const navigation = Reflect.get(window, 'navigation') as EventTarget
    const controller = new AbortController()

    fireEvent.click(screen.getByTestId('nav-progress'))
    const dialog = await screen.findByTestId('app-unsaved-navigation')
    const navigate = new Event('navigate', { cancelable: false })
    Object.defineProperties(navigate, {
      navigationType: { value: 'traverse' },
      canIntercept: { value: true },
      signal: { value: controller.signal },
    })
    navigation.dispatchEvent(navigate)
    fireEvent.click(within(dialog).getByRole('button', { name: '丢弃并离开' }))
    expect(screen.getByTestId('workbench-view')).toBeInTheDocument()

    act(() => controller.abort())
    expect(await screen.findByTestId('workspace-view')).toBeInTheDocument()
    expect(new URLSearchParams(window.location.search).get('view')).toBe('progress')
    expect(screen.queryByTestId('app-unsaved-navigation')).toBeNull()
  })

  it('旧不可取消 traversal abort 后同一任务派发的 cancelable navigate 仍由首请求事务取消', async () => {
    await renderDirtyWorkbenchApp()
    const navigation = Reflect.get(window, 'navigation') as EventTarget
    const firstController = new AbortController()

    fireEvent.click(screen.getByTestId('nav-progress'))
    const dialog = await screen.findByTestId('app-unsaved-navigation')
    const firstNavigate = new Event('navigate', { cancelable: false })
    Object.defineProperties(firstNavigate, {
      navigationType: { value: 'traverse' },
      canIntercept: { value: false },
      signal: { value: firstController.signal },
    })
    navigation.dispatchEvent(firstNavigate)
    fireEvent.click(within(dialog).getByRole('button', { name: '丢弃并离开' }))

    const supersedingNavigate = new Event('navigate', { cancelable: true })
    Object.defineProperties(supersedingNavigate, {
      navigationType: { value: 'traverse' },
      canIntercept: { value: true },
    })
    act(() => {
      firstController.abort()
      navigation.dispatchEvent(supersedingNavigate)
    })

    expect(supersedingNavigate.defaultPrevented).toBe(true)
    expect(await screen.findByTestId('workspace-view')).toBeInTheDocument()
    expect(new URLSearchParams(window.location.search).get('view')).toBe('progress')
  })

  it('旧 traversal abort 后若出现新的不可取消 barrier，首请求等待新 signal 再提交', async () => {
    await renderDirtyWorkbenchApp()
    const navigation = Reflect.get(window, 'navigation') as EventTarget
    const firstController = new AbortController()
    const secondController = new AbortController()

    fireEvent.click(screen.getByTestId('nav-progress'))
    const dialog = await screen.findByTestId('app-unsaved-navigation')
    const firstNavigate = new Event('navigate', { cancelable: false })
    Object.defineProperties(firstNavigate, {
      navigationType: { value: 'traverse' },
      canIntercept: { value: false },
      signal: { value: firstController.signal },
    })
    navigation.dispatchEvent(firstNavigate)
    fireEvent.click(within(dialog).getByRole('button', { name: '丢弃并离开' }))

    const supersedingNavigate = new Event('navigate', { cancelable: false })
    Object.defineProperties(supersedingNavigate, {
      navigationType: { value: 'traverse' },
      canIntercept: { value: false },
      signal: { value: secondController.signal },
    })
    act(() => {
      firstController.abort()
      navigation.dispatchEvent(supersedingNavigate)
    })
    expect(screen.getByTestId('workbench-view')).toBeInTheDocument()

    act(() => secondController.abort())
    expect(await screen.findByTestId('workspace-view')).toBeInTheDocument()
    expect(new URLSearchParams(window.location.search).get('view')).toBe('progress')
  })

  it('缺少 Navigation API 时普通离开降级为同步原生确认，不暴露异步 traversal 竞态', async () => {
    Reflect.deleteProperty(window, 'navigation')
    await renderDirtyWorkbenchApp()
    const confirm = vi.spyOn(window, 'confirm')
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)

    fireEvent.click(screen.getByTestId('nav-progress'))
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('workbench-view')).toBeInTheDocument()
    expect(screen.queryByTestId('app-unsaved-navigation')).toBeNull()

    fireEvent.click(screen.getByTestId('nav-progress'))
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(await screen.findByTestId('workspace-view')).toBeInTheDocument()
    expect(new URLSearchParams(window.location.search).get('view')).toBe('progress')
  })

  it('缺少 Navigation API 时未标记 Forward 不猜方向、不补偿且不会卡住', async () => {
    Reflect.deleteProperty(window, 'navigation')
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    window.history.replaceState(
      { page: 'workbench-current' },
      '',
      '/?view=workbench&root=%2Frepo',
    )
    window.history.pushState(
      { page: 'overview-forward' },
      '',
      '/?view=progress&historyMarker=unmarked-forward-no-navigation-api',
    )
    window.history.back()
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('view')).toBe('workbench'))
    await renderDirtyWorkbenchApp({ preserveLocation: true })

    const back = vi.spyOn(window.history, 'back')
    const forward = vi.spyOn(window.history, 'forward')
    act(() => window.history.forward())

    expect(await screen.findByTestId('workspace-view')).toBeInTheDocument()
    expect(new URLSearchParams(window.location.search).get('historyMarker'))
      .toBe('unmarked-forward-no-navigation-api')
    expect(back).not.toHaveBeenCalled()
    expect(forward).toHaveBeenCalledTimes(1)
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('app-unsaved-navigation')).toBeNull()
  })

  it('缺少 Navigation API 时未标记 Back 不猜方向、不补偿且不会卡住', async () => {
    Reflect.deleteProperty(window, 'navigation')
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    window.history.replaceState(
      { page: 'overview-back' },
      '',
      '/?view=progress&historyMarker=unmarked-back-no-navigation-api',
    )
    window.history.pushState(
      { page: 'workbench-current' },
      '',
      '/?view=workbench&root=%2Frepo',
    )
    await renderDirtyWorkbenchApp({ preserveLocation: true })

    const back = vi.spyOn(window.history, 'back')
    const forward = vi.spyOn(window.history, 'forward')
    act(() => window.history.back())

    expect(await screen.findByTestId('workspace-view')).toBeInTheDocument()
    expect(new URLSearchParams(window.location.search).get('historyMarker'))
      .toBe('unmarked-back-no-navigation-api')
    expect(back).toHaveBeenCalledTimes(1)
    expect(forward).not.toHaveBeenCalled()
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('app-unsaved-navigation')).toBeNull()
  })

  it('缺少 Navigation API 时取消未标记 traversal 会恢复当前 URL 并保留草稿', async () => {
    Reflect.deleteProperty(window, 'navigation')
    window.history.replaceState(
      { page: 'overview-back', custom: 'target-state' },
      '',
      '/?view=progress&debug=target#summary',
    )
    window.history.pushState(
      { page: 'workbench-current', custom: 'draft-state' },
      '',
      '/?view=workbench&root=%2Frepo&debug=draft#editor',
    )
    await renderDirtyWorkbenchApp({ preserveLocation: true })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)

    act(() => window.history.back())

    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('workbench-view')).toBeInTheDocument()
    expect(new URLSearchParams(window.location.search).get('view')).toBe('workbench')
    expect(new URLSearchParams(window.location.search).get('root')).toBe('/repo')
    expect(new URLSearchParams(window.location.search).get('debug')).toBe('draft')
    expect(window.location.hash).toBe('#editor')
    expect(window.history.state).toMatchObject({ page: 'workbench-current', custom: 'draft-state' })
    expect(window.history.state).not.toHaveProperty('__tenonDashboardPosition')
    expect(screen.queryByTestId('app-unsaved-navigation')).toBeNull()
    expect(screen.getByTestId('wb-lane-name-draft')).toHaveTextContent('未保存草稿')
  })

  it('缺少 Navigation API 时取消未标记 Forward 也恢复完整快照并开启无标记 epoch', async () => {
    Reflect.deleteProperty(window, 'navigation')
    window.history.replaceState(
      { page: 'workbench-current', custom: 'forward-draft-state' },
      '',
      '/?view=workbench&root=%2Frepo&debug=forward-draft#editor-forward',
    )
    window.history.pushState(
      { page: 'overview-forward', custom: 'forward-target-state' },
      '',
      '/?view=progress&debug=forward-target#summary-forward',
    )
    window.history.back()
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('view')).toBe('workbench'))
    await renderDirtyWorkbenchApp({ preserveLocation: true })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)

    act(() => window.history.forward())

    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('workbench-view')).toBeInTheDocument()
    expect(new URLSearchParams(window.location.search).get('debug')).toBe('forward-draft')
    expect(window.location.hash).toBe('#editor-forward')
    expect(window.history.state).toMatchObject({
      page: 'workbench-current',
      custom: 'forward-draft-state',
    })
    expect(window.history.state).not.toHaveProperty('__tenonDashboardPosition')
    expect(screen.getByTestId('wb-lane-name-draft')).toHaveTextContent('未保存草稿')
  })

  it('已有 marked pop 事务时后续未知 traversal 不覆盖首请求，确认仍提交首目标', async () => {
    Reflect.deleteProperty(window, 'navigation')
    window.history.replaceState(
      { page: 'overview-first', __tenonDashboardPosition: -1 },
      '',
      '/?view=progress&historyMarker=first-marked-target',
    )
    window.history.pushState(
      { page: 'workbench-current', __tenonDashboardPosition: 0 },
      '',
      '/?view=workbench&root=%2Frepo&historyMarker=committed-workbench',
    )
    window.history.pushState(
      { page: 'projects-later' },
      '',
      '/?view=progress&historyMarker=later-unmarked-target',
    )
    window.history.back()
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('view')).toBe('workbench'))
    await renderDirtyWorkbenchApp({ preserveLocation: true })
    const confirm = vi.spyOn(window, 'confirm')

    act(() => window.history.back())
    const dialog = await screen.findByTestId('app-unsaved-navigation')
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('view')).toBe('workbench'))

    act(() => window.history.forward())
    await waitFor(() => expect(window.history.state).not.toHaveProperty('__tenonDashboardPosition'))
    expect(new URLSearchParams(window.location.search).get('view')).toBe('workbench')
    expect(confirm).not.toHaveBeenCalled()
    expect(screen.getByTestId('app-unsaved-navigation')).toBe(dialog)

    fireEvent.click(within(dialog).getByRole('button', { name: '丢弃并离开' }))
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('historyMarker'))
      .toBe('first-marked-target'))
    expect(await screen.findByTestId('workspace-view')).toBeInTheDocument()
  })

  it('同一确认框内后续 Forward 不覆盖最先阻断的 Back，丢弃后重放首个历史目标', async () => {
    window.history.replaceState(
      { page: 'overview-back', __tenonDashboardPosition: -1 },
      '',
      '/?view=progress&historyMarker=first-back',
    )
    window.history.pushState(
      { page: 'workbench', __tenonDashboardPosition: 0 },
      '',
      '/?view=workbench&root=%2Frepo',
    )
    window.history.pushState(
      { page: 'projects-forward', __tenonDashboardPosition: 1 },
      '',
      '/?view=progress&historyMarker=later-forward',
    )
    window.history.back()
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('view')).toBe('workbench'))
    await renderDirtyWorkbenchApp({ preserveLocation: true })

    const back = vi.spyOn(window.history, 'back')
    const forward = vi.spyOn(window.history, 'forward')
    act(() => window.history.back())
    const dialog = await screen.findByTestId('app-unsaved-navigation')
    await waitFor(() => expect(forward).toHaveBeenCalledTimes(1))

    act(() => window.history.forward())
    await waitFor(() => expect(back).toHaveBeenCalledTimes(2))
    fireEvent.click(within(dialog).getByRole('button', { name: '丢弃并离开' }))

    expect(await screen.findByTestId('workspace-view')).toBeInTheDocument()
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('historyMarker')).toBe('first-back'))
    expect(new URLSearchParams(window.location.search).get('historyMarker')).not.toBe('later-forward')
  })

  it('同一确认框内后续 Back 不覆盖最先阻断的 Forward，丢弃后重放首个历史目标', async () => {
    window.history.replaceState(
      { page: 'overview-back', __tenonDashboardPosition: -1 },
      '',
      '/?view=progress&historyMarker=later-back',
    )
    window.history.pushState(
      { page: 'workbench', __tenonDashboardPosition: 0 },
      '',
      '/?view=workbench&root=%2Frepo',
    )
    window.history.pushState(
      { page: 'projects-forward', __tenonDashboardPosition: 1 },
      '',
      '/?view=progress&historyMarker=first-forward',
    )
    window.history.back()
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('view')).toBe('workbench'))
    await renderDirtyWorkbenchApp({ preserveLocation: true })

    const back = vi.spyOn(window.history, 'back')
    const forward = vi.spyOn(window.history, 'forward')
    act(() => window.history.forward())
    const dialog = await screen.findByTestId('app-unsaved-navigation')
    await waitFor(() => expect(back).toHaveBeenCalledTimes(1))

    act(() => window.history.back())
    await waitFor(() => expect(forward).toHaveBeenCalledTimes(2))
    fireEvent.click(within(dialog).getByRole('button', { name: '丢弃并离开' }))

    expect(await screen.findByTestId('workspace-view')).toBeInTheDocument()
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('historyMarker')).toBe('first-forward'))
    expect(new URLSearchParams(window.location.search).get('historyMarker')).not.toBe('later-back')
  })

  it('继续编辑会清除旧历史事务，下一次 Forward 可独立确认并到达新目标', async () => {
    window.history.replaceState(
      { page: 'overview-back', __tenonDashboardPosition: -1 },
      '',
      '/?view=progress&historyMarker=cancelled-back',
    )
    window.history.pushState(
      { page: 'workbench', __tenonDashboardPosition: 0 },
      '',
      '/?view=workbench&root=%2Frepo',
    )
    window.history.pushState(
      { page: 'projects-forward', __tenonDashboardPosition: 1 },
      '',
      '/?view=progress&historyMarker=new-forward',
    )
    window.history.back()
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('view')).toBe('workbench'))
    await renderDirtyWorkbenchApp({ preserveLocation: true })

    const back = vi.spyOn(window.history, 'back')
    const forward = vi.spyOn(window.history, 'forward')
    act(() => window.history.back())
    const firstDialog = await screen.findByTestId('app-unsaved-navigation')
    await waitFor(() => expect(forward).toHaveBeenCalledTimes(1))
    fireEvent.click(within(firstDialog).getByRole('button', { name: '继续编辑' }))

    act(() => window.history.forward())
    const secondDialog = await screen.findByTestId('app-unsaved-navigation')
    await waitFor(() => expect(back).toHaveBeenCalledTimes(2))
    fireEvent.click(within(secondDialog).getByRole('button', { name: '丢弃并离开' }))

    expect(await screen.findByTestId('workspace-view')).toBeInTheDocument()
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('historyMarker')).toBe('new-forward'))
    expect(new URLSearchParams(window.location.search).get('historyMarker')).not.toBe('cancelled-back')
  })

  it('已阻断的未标记 browser Forward 在 root 失权后仍按原方向确认重放', async () => {
    Object.defineProperty(window, 'navigation', {
      configurable: true,
      value: {
        get currentEntry() {
          return {
            index: new URLSearchParams(window.location.search).get('historyMarker') === 'forward-target'
              ? 1
              : 0,
          }
        },
      },
    })
    window.history.replaceState(
      { page: 'workbench' },
      '',
      '/?view=workbench&root=%2Frepo',
    )
    window.history.pushState(
      { page: 'overview-forward' },
      '',
      '/?view=progress&historyMarker=forward-target',
    )
    window.history.back()
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('view')).toBe('workbench'))
    await renderDirtyWorkbenchApp({ preserveLocation: true })
    const eventSource = lastEventSource()
    expect(eventSource).toBeDefined()

    act(() => window.history.forward())
    const dialog = await screen.findByTestId('app-unsaved-navigation')
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('view')).toBe('workbench'))

    act(() => {
      eventSource!.emit('snapshot', JSON.stringify(makeSnapshot([])))
    })
    expect(screen.getByTestId('workbench-retained-host')).toHaveAttribute('inert')

    fireEvent.click(within(dialog).getByRole('button', { name: '丢弃并离开' }))

    expect(await screen.findByTestId('onboard-no-project')).toBeInTheDocument()
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('historyMarker')).toBe('forward-target'))
  })

  it('一级导航与 Overview 共用可访问 Dialog；取消保留页面、草稿、URL 与触发焦点，确认才离开', async () => {
    await renderDirtyWorkbenchApp()
    const overview = screen.getByTestId('nav-progress')
    overview.focus()
    fireEvent.click(overview)

    const dialog = await screen.findByTestId('app-unsaved-navigation')
    expect(within(dialog).getByRole('dialog')).toHaveAccessibleName('未保存的修改')
    expect(screen.getByTestId('workbench-view')).toBeInTheDocument()
    expect(screen.getByTestId('wb-lane-name-draft')).toHaveTextContent('未保存草稿')
    expect(new URLSearchParams(window.location.search).get('view')).toBe('workbench')

    fireEvent.click(within(dialog).getByRole('button', { name: '继续编辑' }))
    expect(screen.queryByTestId('app-unsaved-navigation')).toBeNull()
    expect(overview).toHaveFocus()
    expect(screen.getByTestId('wb-lane-name-draft')).toHaveTextContent('未保存草稿')

    fireEvent.click(overview)
    fireEvent.click(within(await screen.findByTestId('app-unsaved-navigation')).getByRole('button', { name: '丢弃并离开' }))
    expect(await screen.findByTestId('workspace-view')).toBeInTheDocument()
    expect(new URLSearchParams(window.location.search).get('view')).toBe('progress')
  })

  it('dirty 时 beforeunload 触发原生浏览器保护；未 dirty 时不拦截', async () => {
    stubEditableWorkbench()
    render(<App />)
    await screen.findByTestId('wb-step-draft')

    const cleanEvent = new Event('beforeunload', { cancelable: true })
    expect(window.dispatchEvent(cleanEvent)).toBe(true)
    expect(cleanEvent.defaultPrevented).toBe(false)

    const input = await screen.findByTestId('wb-lane-name-input-draft')
    fireEvent.change(input, { target: { value: '未保存草稿' } })
    await screen.findByTestId('wb-dirty')

    const dirtyEvent = new Event('beforeunload', { cancelable: true })
    expect(window.dispatchEvent(dirtyEvent)).toBe(false)
    expect(dirtyEvent.defaultPrevented).toBe(true)
  })

  it('浏览器返回先恢复已提交 URL/UI 并弹确认；取消保持一致，确认才应用目标地址', async () => {
    window.history.replaceState(
      { page: 'overview', __tenonDashboardPosition: 0 },
      '',
      '/?view=progress',
    )
    window.history.pushState(
      { page: 'workbench', __tenonDashboardPosition: 1 },
      '',
      '/?view=workbench&root=%2Frepo',
    )
    await renderDirtyWorkbenchApp({ preserveLocation: true })
    act(() => window.history.back())

    const dialog = await screen.findByTestId('app-unsaved-navigation')
    expect(screen.getByTestId('workbench-view')).toBeInTheDocument()
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('view')).toBe('workbench'))

    fireEvent.click(within(dialog).getByRole('button', { name: '继续编辑' }))
    expect(screen.getByTestId('workbench-view')).toBeInTheDocument()
    expect(new URLSearchParams(window.location.search).get('view')).toBe('workbench')

    act(() => window.history.back())
    fireEvent.click(within(await screen.findByTestId('app-unsaved-navigation')).getByRole('button', { name: '丢弃并离开' }))

    expect(await screen.findByTestId('workspace-view')).toBeInTheDocument()
    expect(new URLSearchParams(window.location.search).get('view')).toBe('progress')
  })
})

describe('App 默认落地 = 进度（v9-flowdeck：收件箱退役，进度=唯一在制面）', () => {
  it('首屏渲染进度视图，而非工作台；收件箱视图不复存在', async () => {
    render(<App />)
    expect(await screen.findByTestId('workspace-view')).toBeInTheDocument()
    expect(screen.queryByTestId('inbox-view')).toBeNull()
    expect(screen.queryByTestId('workbench-view')).toBeNull()
  })

  it('顶部条两个标签：工作台 / 工作流；项目切换器与设置都在顶部条', async () => {
    render(<App />)
    await screen.findByTestId('workspace-view')
    const nav = screen.getByTestId('primary-nav')
    expect(within(nav).getAllByRole('button').map((button) => button.textContent)).toEqual(['工作台', '工作流'])
    expect(screen.getByTestId('project-switcher')).toBeInTheDocument()
    expect(screen.queryByTestId('app-navigation')).toBeNull()
    expect(screen.queryByTestId('secondary-nav')).toBeNull()
    expect(screen.queryByTestId('nav-inbox')).toBeNull()
    expect(screen.queryByTestId('nav-hostPlan')).toBeNull()
    expect(screen.queryByTestId('readonly-pill')).toBeNull()
    expect(screen.getByTestId('conn-indicator')).toHaveAttribute('data-on', 'true')
    fireEvent.click(screen.getByTestId('nav-settings'))
    expect(screen.getByTestId('nav-settings-panel')).toBeInTheDocument()
    expect(screen.getByTestId('theme-toggle')).toBeInTheDocument()
    expect(screen.getByTestId('lang-toggle')).toBeInTheDocument()
  })

  it('首个可聚焦控件是跳到主内容的链接，目标 main 可被程序聚焦', async () => {
    render(<App />)
    await screen.findByTestId('workspace-view')
    const skip = screen.getByRole('link', { name: '跳到主要内容' })
    expect(skip).toHaveAttribute('href', '#main-content')
    const main = screen.getByTestId('app-main')
    expect(main).toHaveAttribute('id', 'main-content')
    expect(main).toHaveAttribute('tabindex', '-1')
    await userEvent.tab()
    expect(skip).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    expect(main).toHaveFocus()
  })

  it('面包屑「工作空间 / 当前页」随标签切换', async () => {
    render(<App />)
    await screen.findByTestId('workspace-view')
    const breadcrumbs = screen.getByTestId('breadcrumbs')
    expect(breadcrumbs).toHaveTextContent('工作空间')
    expect(within(breadcrumbs).getByTestId('breadcrumb-page')).toHaveAttribute('aria-current', 'page')
    expect(within(breadcrumbs).getByTestId('breadcrumb-page')).toHaveTextContent('工作台')
    fireEvent.click(screen.getByTestId('nav-workbench'))
    await screen.findByTestId('workbench-view')
    expect(within(screen.getByTestId('breadcrumbs')).getByTestId('breadcrumb-page')).toHaveTextContent('工作流')
  })

  it('无项目上下文时工作台聚合全部项目，左列「所有项目」为当前项', async () => {
    window.history.replaceState({}, '', '/?view=progress')
    render(<App />)
    await screen.findByTestId('workspace-view')
    expect(screen.getByTestId('project-rail-all')).toHaveAttribute('aria-current', 'true')
    expect(await screen.findByTestId('task-card-seed-c')).toBeInTheDocument()
    expect(new URLSearchParams(window.location.search).get('view')).toBe('progress')
    fireEvent.click(screen.getByTestId('project-rail-item-repo'))
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('root')).toBe('/repo'))
    expect(screen.getByTestId('project-rail-item-repo')).toHaveAttribute('aria-current', 'true')
  })
})


describe('App 初始 snapshot 错误恢复', () => {
  it('English 500 error never exposes the Chinese snapshot transport fallback', async () => {
    localStorage.setItem('tenon-dashboard-lang', 'en')
    window.history.replaceState({}, '', '/?view=progress')
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url !== '/api/snapshot') throw new Error(`unexpected fetch ${url}`)
      return {
        ok: false,
        status: 500,
        json: async () => ({ ok: false, error: '快照暂时不可用' }),
      }
    }))

    render(<App />)

    const errorState = await screen.findByTestId('snapshot-error')
    expect(errorState).toHaveTextContent('Request failed (HTTP 500).')
    expect(errorState.textContent).not.toMatch(/[\u3400-\u9fff]/u)
  })

  it('English malformed successful snapshot is classified as an invalid response, not a network outage', async () => {
    localStorage.setItem('tenon-dashboard-lang', 'en')
    window.history.replaceState({}, '', '/?view=progress')
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url !== '/api/snapshot') throw new Error(`unexpected fetch ${url}`)
      return {
        ok: true,
        status: 200,
        json: async () => { throw new SyntaxError('Unexpected token') },
      }
    }))

    render(<App />)

    expect(await screen.findByTestId('snapshot-error')).toHaveTextContent('Invalid server response.')
  })

  it('首次 500 显示明确错误与重试入口，重试成功后恢复项目总览', async () => {
    window.history.replaceState({}, '', '/?view=progress')
    let snapshotAttempts = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url !== '/api/snapshot') throw new Error(`unexpected fetch ${url}`)
      snapshotAttempts += 1
      if (snapshotAttempts === 1) {
        return {
          ok: false,
          status: 500,
          json: async () => ({ ok: false, error: 'snapshot 暂时不可用' }),
        }
      }
      return {
        ok: true,
        json: async () => makeSnapshot([makeProject('/repo', [makeChange('recovered', 'verify')])]),
      }
    }))

    render(<App />)

    const errorState = await screen.findByTestId('snapshot-error')
    expect(errorState).toHaveAttribute('role', 'alert')
    expect(errorState).toHaveTextContent('请求失败（HTTP 500）。')
    const retry = screen.getByRole('button', { name: '重试加载' })

    fireEvent.click(retry)

    expect(await screen.findByTestId('workspace-view')).toBeInTheDocument()
    expect(await screen.findByTestId('project-rail-item-repo')).toBeInTheDocument()
    expect(screen.queryByTestId('snapshot-error')).toBeNull()
    expect(snapshotAttempts).toBe(2)
  })
})

describe('App URL 深链路（可复制的视图 / 项目 / Change 现场）', () => {
  it('有已注册项目但 URL 无 root：保持未选择、停留在进度并显示项目引导，不调用 per-root API', async () => {
    window.history.replaceState({}, '', '/?debug=1&view=progress')
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/snapshot') {
        return { ok: true, json: async () => makeSnapshot([makeProject('/repo-a', [makeChange('a1', 'build')])]) }
      }
      throw new Error(`unexpected per-root fetch ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(await screen.findByTestId('workspace-view')).toBeInTheDocument()
    expect(screen.getByTestId('project-rail-all')).toHaveAttribute('aria-current', 'true')
    const params = new URLSearchParams(window.location.search)
    expect(params.get('root')).toBeNull()
    expect(params.get('change')).toBeNull()
    expect(params.get('debug')).toBe('1')
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/snapshot'])
  })

  it('失效 root 深链：清除 root/change 并保持无选择，聚合展示而不重定向首个项目', async () => {
    window.history.replaceState({}, '', '/?debug=1&view=progress&root=%2Fmissing&change=ghost')
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/snapshot') {
        return { ok: true, json: async () => makeSnapshot([makeProject('/repo-a', [makeChange('a1', 'build')])]) }
      }
      throw new Error(`unexpected per-root fetch ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(await screen.findByTestId('workspace-view')).toBeInTheDocument()
    expect(screen.getByTestId('project-rail-all')).toHaveAttribute('aria-current', 'true')
    const params = new URLSearchParams(window.location.search)
    expect(params.get('root')).toBeNull()
    expect(params.get('change')).toBeNull()
    expect(params.get('debug')).toBe('1')
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/snapshot'])
  })

  it('已登记但不可达的 root 深链也必须清除，不能挂载 per-root 视图', async () => {
    window.history.replaceState({}, '', '/?view=progress&root=%2Foffline&change=stale')
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/snapshot') {
        return {
          ok: true,
          json: async () => makeSnapshot([
            makeProject('/offline', [makeChange('stale', 'verify')], {
              ok: false,
              error: 'root 不可达',
            }),
          ]),
        }
      }
      throw new Error(`unexpected per-root fetch ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)

    expect(await screen.findByTestId('workspace-view')).toBeInTheDocument()
    const params = new URLSearchParams(window.location.search)
    expect(params.get('root')).toBeNull()
    expect(params.get('change')).toBeNull()
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/snapshot'])
  })

  it('无项目选择时从跨项目 snapshot 读取自定义 workflow gate，不发 per-root 请求也不误报', async () => {
    window.history.replaceState({}, '', '/?view=progress')
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/snapshot') {
        return {
          ok: true,
          json: async () => makeSnapshot([
            makeProject('/repo-custom', [
              makeChange('review-me', 'review', {
                fields: { workflow: 'compact' },
                workflowRules: {
                  executionModel: 'step-graph',
                  steps: ['review', 'done'],
                  transitions: { review: [{ event: 'approve', to: 'done' }], done: [] },
                  gateByStep: { review: 'review', done: null },
                  labelByStep: { review: '复核', done: '完成' },
                  outputsByStep: { review: [], done: [] },
                },
                workflowExecution: {
                  readinessByTransition: {
                    review: { approve: { ready: true, blockers: [] } },
                    done: {},
                  },
                },
              }),
            ]),
          ]),
        }
      }
      throw new Error(`unexpected per-root fetch ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)

    // 聚合工作台：自定义 workflow 的卡按跨项目快照自带的 rules 判定——阶段芯片「复核」计 1，
    // 一行状态由 readiness 推出「可进入完成」；聚合语境不发任何 per-root 请求。
    expect(await screen.findByTestId('task-card-review-me')).toBeInTheDocument()
    expect(screen.getByTestId('task-filter-review')).toHaveTextContent('1')
    expect(screen.getByTestId('task-summary-review-me')).toHaveTextContent('复核 · 可进入完成')
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(['/api/snapshot'])
  })

  it('浏览器返回到无 root URL：经同一选择模型回到聚合工作台', async () => {
    render(<App />)
    await screen.findByTestId('workspace-view')

    window.history.replaceState({}, '', '/?debug=1&view=progress')
    act(() => window.dispatchEvent(new PopStateEvent('popstate')))

    await waitFor(() => expect(screen.getByTestId('project-rail-all')).toHaveAttribute('aria-current', 'true'))
    const params = new URLSearchParams(window.location.search)
    expect(params.get('root')).toBeNull()
    expect(params.get('debug')).toBe('1')
  })

  it('语言切换同步更新文档 lang 元数据', async () => {
    window.history.replaceState({}, '', '/?view=progress')
    render(<App />)
    await screen.findByTestId('workspace-view')

    expect(document.documentElement).toHaveAttribute('lang', 'zh')
    fireEvent.click(screen.getByTestId('nav-settings'))
    fireEvent.click(screen.getByTestId('lang-toggle'))
    await waitFor(() => expect(document.documentElement).toHaveAttribute('lang', 'en'))
  })

  it('带 view/root/change 首次进入：直接打开对应项目的 Change 抽屉', async () => {
    window.history.replaceState({}, '', '/?view=progress&root=%2Frepo&change=seed-c')
    render(<App />)
    expect(await screen.findByTestId('task-detail-title')).toHaveTextContent('seed-c')
    expect(screen.getByTestId('task-card-seed-c')).toHaveAttribute('aria-current', 'true')
    expect(new URLSearchParams(window.location.search).get('change')).toBe('seed-c')
  })

  it('macOS /tmp 深链能命中 snapshot 的 /private/tmp canonical root，不回落到首个旧项目', async () => {
    window.history.replaceState({}, '', '/?view=progress&root=%2Ftmp%2Fpipeline-ui-project.V60AOf&change=ui-real-browser')
    ;(global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      if (url === '/api/snapshot') {
        return {
          ok: true,
          json: async () => makeSnapshot([
            makeProject('/old/demo-project', []),
            makeProject('/private/tmp/pipeline-ui-project.V60AOf', [makeChange('ui-real-browser', 'build')]),
          ]),
        }
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    render(<App />)
    expect(await screen.findByTestId('task-detail-title')).toHaveTextContent('ui-real-browser')
    expect(new URLSearchParams(window.location.search).get('root')).toBe('/private/tmp/pipeline-ui-project.V60AOf')
  })

  it('点左列「所有项目」会更新可复制 URL，并显式清除项目 root', async () => {
    render(<App />)
    await screen.findByTestId('workspace-view')
    fireEvent.click(screen.getByTestId('project-rail-all'))
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('root')).toBeNull())
    expect(new URLSearchParams(window.location.search).get('view')).toBe('progress')
    expect(screen.getByTestId('project-rail-all')).toHaveAttribute('aria-current', 'true')
  })
})

describe('App 视图切换（v9-flowdeck 两视图接线）', () => {
  it('点工作台 → 渲染 WorkbenchView（直达，无下拉）；点进度切回 ProgressView', async () => {
    render(<App />)
    await screen.findByTestId('workspace-view')
    fireEvent.click(screen.getByTestId('nav-workbench'))
    expect(await screen.findByTestId('workbench-view')).toBeInTheDocument()
    expect(screen.queryByTestId('workbench-menu')).toBeNull()
    fireEvent.click(screen.getByTestId('nav-progress'))
    expect(screen.getByTestId('workspace-view')).toBeInTheDocument()
  })

  it('项目非零但全部不可达（ok=false）：工作台渲染诚实空态，不拿不可达 root 挂 WorkbenchView（v10c：不再经聚合语境）', async () => {
    localStorage.setItem('tenon-dashboard-view', 'workbench') // 直接落工作台，回落链此时全落空
    ;(global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      if (url === '/api/snapshot') {
        return { ok: true, json: async () => makeSnapshot([makeProject('/repo', [], { ok: false })]) }
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    render(<App />)
    expect(await screen.findByTestId('wb-no-root')).toHaveTextContent('没有可读取的项目')
    expect(screen.queryByTestId('workbench-view')).toBeNull()
  })

})

describe('App 视图记忆（localStorage 旧值兜底回 progress，收件箱退役）', () => {
  it('记忆值是退役视图（board）→ 落地进度而非崩溃/空渲染', async () => {
    localStorage.setItem('tenon-dashboard-view', 'board')
    render(<App />)
    expect(await screen.findByTestId('workspace-view')).toBeInTheDocument()
  })

  it('记忆值是刚退役的 inbox → 同样兜底回进度，不渲染收件箱', async () => {
    localStorage.setItem('tenon-dashboard-view', 'inbox')
    render(<App />)
    expect(await screen.findByTestId('workspace-view')).toBeInTheDocument()
    expect(screen.queryByTestId('inbox-view')).toBeNull()
  })

  it('记忆值是合法视图（workbench）→ 直接落地工作台', async () => {
    localStorage.setItem('tenon-dashboard-view', 'workbench')
    render(<App />)
    expect(await screen.findByTestId('workbench-view')).toBeInTheDocument()
  })

  it('切视图写回记忆：点工作台后 localStorage 存 workbench', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<App />)
    await screen.findByTestId('workspace-view')
    await act(async () => {
      screen.getByTestId('nav-workbench').click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(localStorage.getItem('tenon-dashboard-view')).toBe('workbench')
    expect(consoleError).not.toHaveBeenCalledWith(
      expect.stringContaining('was not wrapped in act'),
      expect.anything(),
      expect.anything(),
    )
  })

})

describe('App 注册 UI 退役（T17 决议#7：tenon init 自动登记，注册入口全删）', () => {
  it('单项目语境无 ＋ 注册按钮、无注册对话框入口', async () => {
    render(<App />)
    await screen.findByTestId('workspace-view')
    expect(screen.queryByTestId('project-register')).toBeNull()
    expect(screen.queryByTestId('register-dialog')).toBeNull()
  })
})

describe('App SSE 实时更新（真 EventSource stub → 组件真更新，非 mock 返回）', () => {
  it('emit 含复核阶段卡的快照 → 进度徽标由无到 1，新 change 行真渲染', async () => {
    render(<App />)
    await screen.findByTestId('workspace-view')
    // 初始快照只有一张非 gate 卡 → 无待拍板徽标
    expect(screen.queryByTestId('progress-badge')).toBeNull()

    const es = lastEventSource()
    expect(es).toBeDefined()
    // T7 准入修订：verify 卡计入待拍板必须三轨证据齐（缺产出判「等产出」不计）。
    const next = makeSnapshot([
      makeProject('/repo', [
        trustedVerifyChange('needs-review', {
          fields: { verify_result: 'pass', agent_review_result: 'pass', codex_review_result: 'pass' },
        }),
      ]),
    ])
    act(() => {
      es!.emit('snapshot', JSON.stringify(next))
    })

    // 组件真更新：进度徽标计数 1（selectInbox 口径），新 change 名出现在进度列表
    //（可能同时出现在行与详情等多处，getAllByText 断言"至少一处"）。
    await waitFor(() => expect(screen.getByTestId('progress-badge').textContent).toBe('1'))
    expect(screen.getAllByText('needs-review').length).toBeGreaterThan(0)
  })

  it('已选项目从注册快照移除：清除上下文，不把后续请求切到其他项目', async () => {
    render(<App />)
    await screen.findByTestId('workspace-view')
    const es = lastEventSource()

    act(() => {
      es!.emit('snapshot', JSON.stringify(makeSnapshot([makeProject('/repo-b', [makeChange('b1', 'build')])])))
    })

    await waitFor(() => expect(new URLSearchParams(window.location.search).get('root')).toBeNull())
    expect(screen.getByTestId('project-rail-all')).toHaveAttribute('aria-current', 'true')
    expect(await screen.findByTestId('project-rail-item-repo-b')).toBeInTheDocument()
    expect(screen.getByTestId('project-rail-item-repo-b')).not.toHaveAttribute('aria-current')
  })
})

describe('App 深浅色自适应 + i18n', () => {
  it('主题切换在 <html data-theme> 落值', async () => {
    render(<App />)
    await screen.findByTestId('workspace-view')
    // 初始偏好为 system；jsdom 无 matchMedia 时解析为 light。
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'))
    fireEvent.click(screen.getByTestId('nav-settings'))
    fireEvent.click(screen.getByTestId('theme-toggle'))
    expect(document.documentElement.dataset.themePreference).toBe('light')
    fireEvent.click(screen.getByTestId('theme-toggle'))
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'))
  })

  it('系统主题作为显式偏好跟随电脑端系统配色，并清理媒体监听', async () => {
    let dark = true
    const listeners = new Set<() => void>()
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      get matches() { return dark },
      media: '(prefers-color-scheme: dark)',
      onchange: null,
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })))
    localStorage.setItem('tenon-dashboard-theme', 'system')

    const view = render(<App />)
    await screen.findByTestId('workspace-view')
    await waitFor(() => {
      expect(document.documentElement.dataset.themePreference).toBe('system')
      expect(document.documentElement.dataset.theme).toBe('dark')
    })

    dark = false
    act(() => listeners.forEach((listener) => listener()))
    expect(document.documentElement.dataset.theme).toBe('light')

    view.unmount()
    expect(listeners.size).toBe(0)
  })

  it('语言切换 zh→en：一级导航文案真更新', async () => {
    render(<App />)
    await screen.findByTestId('workspace-view')
    const nav = screen.getByTestId('primary-nav')
    expect(nav.textContent).toContain('工作台')
    fireEvent.click(screen.getByTestId('nav-settings'))
    fireEvent.click(screen.getByTestId('lang-toggle'))
    expect(nav.textContent).toContain('Workbench')
    expect(nav.textContent).not.toContain('变更')
  })
})

describe('App G18 教学空状态（T17 起纯教学态）', () => {
  it('零项目快照 → 全视图替换为教学 onboarding：无注册表单、CLI 是 tenon init、无幽灵命令', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/snapshot') return { ok: true, json: async () => makeSnapshot([]) }
        if (url.startsWith('/api/workflows?root=')) return { ok: true, json: async () => ({ names: [] }) }
        throw new Error(`unexpected fetch ${url}`)
      }),
    )
    render(<App />)
    const ob = await screen.findByTestId('onboard-no-project')
    expect(screen.queryByTestId('workspace-view')).toBeNull()
    // 决议#7 + T2：注册表单退役，教学 CLI 为 tenon init（自动登记），幽灵命令清除
    expect(screen.queryByTestId('project-register-form')).toBeNull()
    expect(screen.queryByTestId('project-register-path')).toBeNull()
    expect(screen.queryByTestId('project-register-submit')).toBeNull()
    expect(screen.getByTestId('onboard-cli').textContent).toContain('tenon init')
    expect(ob.textContent).not.toContain('projects add')
  })

  it('有项目零 change → 工作台中列给出 tenon init 教学空态，创建留在终端', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/snapshot') return { ok: true, json: async () => makeSnapshot([makeProject('/repo', [])]) }
        if (url.startsWith('/api/workflows?root=')) return { ok: true, json: async () => ({ names: [] }) }
        throw new Error(`unexpected fetch ${url}`)
      }),
    )
    render(<App />)
    const empty = await screen.findByTestId('task-list-empty-no-task')
    expect(empty.textContent).toContain('tenon init')
    expect(screen.getByTestId('task-detail-empty')).toBeInTheDocument()
  })

  it('未来 canonical 版本优先于 no-change 教学态，进入只读升级恢复路径', async () => {
    const project = makeProject('/repo', [], {
      ok: false,
      compatibilityIssues: [{
        kind: 'unsupported-canonical-version',
        change: 'future-change',
        foundVersion: 2,
        supportedVersion: 1,
        action: 'upgrade-runtime',
      }],
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/snapshot') return { ok: true, json: async () => makeSnapshot([project]) }
        throw new Error(`unexpected fetch ${url}`)
      }),
    )

    render(<App />)
    expect(await screen.findByTestId('canonical-state-version-notice')).toBeInTheDocument()
    expect(screen.queryByTestId('task-list-empty-no-task')).toBeNull()
    expect(screen.getByText('future-change')).toBeInTheDocument()
  })

  it('混合项目同时展示升级要求与可读 Change，不把项目整体降级为不可达', async () => {
    const project = makeProject('/repo', [makeChange('readable-change', 'build')], {
      ok: false,
      compatibilityIssues: [{
        kind: 'unsupported-canonical-version',
        change: 'future-change',
        foundVersion: 2,
        supportedVersion: 1,
        action: 'upgrade-runtime',
      }],
    })
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/snapshot') return { ok: true, json: async () => makeSnapshot([project]) }
      throw new Error(`unexpected fetch ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)
    expect(await screen.findByTestId('canonical-state-version-notice')).toBeInTheDocument()
    expect(await screen.findByTestId('task-card-readable-change')).toBeInTheDocument()
    expect(screen.queryByTestId('task-list-empty-no-task')).toBeNull()

    // 兼容期项目只读：工作流页含写入口，不挂载；没有任何可写项目时给诚实空态。
    fireEvent.click(screen.getByTestId('nav-workbench'))
    expect(await screen.findByTestId('wb-no-root')).toBeInTheDocument()
    expect(screen.queryByTestId('workbench-view')).toBeNull()
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/workflows?root='))).toBe(false)
  })

  it('英文刷新遇到 503 时不泄漏中文 client 文案，并用通用 Retry 恢复既有 snapshot', async () => {
    localStorage.setItem('tenon-dashboard-lang', 'en')
    const project = makeProject('/repo', [makeChange('readable-change', 'build')], {
      ok: false,
      compatibilityIssues: [{
        kind: 'unsupported-canonical-version',
        change: 'future-change',
        foundVersion: 2,
        supportedVersion: 1,
        action: 'upgrade-runtime',
      }],
    })
    let attempts = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url !== '/api/snapshot') throw new Error(`unexpected fetch ${url}`)
      attempts += 1
      if (attempts === 2) {
        return {
          ok: false,
          status: 503,
          json: async () => ({ error: '服务端中文错误' }),
        }
      }
      return { ok: true, json: async () => makeSnapshot([project]) }
    }))

    render(<App />)
    const upgradeRefresh = await screen.findByRole('button', { name: 'Refresh after updating' })
    fireEvent.click(upgradeRefresh)

    const errorState = await screen.findByTestId('prg-error')
    expect(errorState).toHaveTextContent('Snapshot request failed (HTTP 503)')
    expect(errorState).not.toHaveTextContent('快照获取失败')
    expect(errorState).not.toHaveTextContent('服务端中文错误')

    fireEvent.click(within(errorState).getByRole('button', { name: 'Retry loading' }))
    await waitFor(() => expect(screen.queryByTestId('prg-error')).toBeNull())
    expect(attempts).toBe(3)
  })

  it('非 Progress 视图保留旧 snapshot 时也显示本地化失败状态并可通用 Retry', async () => {
    localStorage.setItem('tenon-dashboard-lang', 'en')
    let attempts = 0
    let resolveRetry: ((response: {
      ok: true
      status: 200
      json: () => Promise<ReturnType<typeof makeSnapshot>>
    }) => void) | undefined
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url !== '/api/snapshot') throw new Error(`unexpected fetch ${url}`)
      attempts += 1
      if (attempts === 2) {
        return {
          ok: false,
          status: 503,
          json: async () => ({ error: '服务端中文错误' }),
        }
      }
      if (attempts === 3) {
        return await new Promise<{
          ok: true
          status: 200
          json: () => Promise<ReturnType<typeof makeSnapshot>>
        }>((resolve) => { resolveRetry = resolve })
      }
      return {
        ok: true as const,
        status: 200 as const,
        json: async () => makeSnapshot([makeProject('/repo', [makeChange('retained', 'build')])]),
      }
    }))

    render(<App />)
    await screen.findByTestId('workspace-view')
    fireEvent.click(screen.getByTestId('nav-progress'))
    expect(await screen.findByTestId('workspace-view')).toBeInTheDocument()

    const eventSource = lastEventSource()
    expect(eventSource).toBeDefined()
    act(() => eventSource?.emit('error', ''))
    fireEvent.click(await screen.findByTestId('offline-reconnect'))

    const errorState = await screen.findByTestId('prg-error')
    expect(screen.getByTestId('workspace-view')).toBeInTheDocument()
    expect(errorState).toHaveTextContent('Snapshot request failed (HTTP 503)')
    expect(errorState).not.toHaveTextContent('服务端中文错误')

    fireEvent.click(within(errorState).getByRole('button', { name: 'Retry loading' }))
    expect(await within(screen.getByTestId('prg-error')).findByRole('button', { name: 'Retry loading' })).toBeDisabled()
    act(() => resolveRetry?.({
      ok: true,
      status: 200,
      json: async () => makeSnapshot([makeProject('/repo', [makeChange('retained', 'build')])]),
    }))
    await waitFor(() => expect(screen.queryByTestId('prg-error')).toBeNull())
    expect(screen.getByTestId('workspace-view')).toBeInTheDocument()
    expect(attempts).toBe(3)
  })

  it('普通损坏与未来版本并存时回到不可达项目面，不用升级提示掩盖错误', async () => {
    const project = makeProject('/repo', [makeChange('readable-change', 'build')], {
      ok: false,
      error: 'broken-current: 状态损坏或不可读',
      compatibilityIssues: [{
        kind: 'unsupported-canonical-version',
        change: 'future-change',
        foundVersion: 2,
        supportedVersion: 1,
        action: 'upgrade-runtime',
      }],
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/snapshot') return { ok: true, json: async () => makeSnapshot([project]) }
        throw new Error(`unexpected fetch ${url}`)
      }),
    )

    render(<App />)
    expect(await screen.findByTestId('project-rail-item-repo')).toHaveTextContent('不可读')
    expect(screen.queryByTestId('canonical-state-version-notice')).toBeNull()
    expect(screen.queryByTestId('task-card-readable-change')).toBeNull()
  })
})

describe('App currentRoot 语义（只消费显式选择）', () => {
  it('双项目快照：进度徽标只计显式选择项目的 gate 卡', async () => {
    window.history.replaceState({}, '', '/?view=progress&root=%2Frepo-a')
    // T7 准入修订：证据齐的 gate 卡才计入徽标（判据在 inbox.test.tsx 钉，这里只验 currentRoot 过滤）。
    const evidenceOk = { verify_result: 'pass', agent_review_result: 'pass', codex_review_result: 'pass' }
    const next = makeSnapshot([
      makeProject('/repo-a', [trustedVerifyChange('a-verify', { fields: { ...evidenceOk } })]),
      makeProject('/repo-b', [
        trustedVerifyChange('b-verify', { fields: { ...evidenceOk } }),
        makeChange('b-spec', 'spec', { fields: { design_doc: 'docs/d.md', plan: 'docs/p.md' } }),
      ]),
    ])
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/snapshot') return { ok: true, json: async () => next }
      throw new Error(`unexpected fetch ${url}`)
    }))
    render(<App />)
    await screen.findByTestId('workspace-view')
    await waitFor(() => expect(screen.getByTestId('progress-badge').textContent).toBe('1'))
    // a-verify 可能同时出现在行与详情等多处，getAllByText 断言"至少一处"
    //（意图不变：currentRoot 过滤后只看得到显式选择项目的卡）。
    expect(screen.getAllByText('a-verify').length).toBeGreaterThan(0)
    expect(screen.queryByText('b-verify')).toBeNull()
  })
})

describe('App 聚合语境（root=\'\' + 工作台 → 聚合全部可读项目的任务）', () => {
  it("旧聚合偏好（root='')停在 progress → 聚合展示两个项目的任务，左列两张项目卡", async () => {
    localStorage.setItem('tenon-dashboard-root', '') // 旧聚合偏好（本次重构退役）
    localStorage.setItem('tenon-dashboard-view', 'progress')
    window.history.replaceState({}, '', '/?view=progress')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/snapshot') {
          return {
            ok: true,
            json: async () =>
              makeSnapshot([
                makeProject('/repo-a', [makeChange('a1', 'build')]),
                makeProject('/repo-b', [makeChange('b1', 'build')]),
              ]),
          }
        }
        if (url.startsWith('/api/workflows?root=')) return { ok: true, json: async () => ({ names: [] }) }
        throw new Error(`unexpected fetch ${url}`)
      }),
    )
    render(<App />)
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(await screen.findByTestId('workspace-view')).toBeInTheDocument()
    expect(screen.getByTestId('project-rail-item-repo-a')).toBeInTheDocument()
    expect(screen.getByTestId('project-rail-item-repo-b')).toBeInTheDocument()
    expect(screen.getByTestId('task-card-a1')).toBeInTheDocument()
    expect(screen.getByTestId('task-card-b1')).toBeInTheDocument()
  })

  it('点左列项目卡进入单项目工作台：写 URL root，只看该项目', async () => {
    localStorage.setItem('tenon-dashboard-view', 'progress')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/snapshot') {
          return {
            ok: true,
            json: async () =>
              makeSnapshot([
                makeProject('/repo-a', [makeChange('a1', 'build')]),
                makeProject('/repo-b', [makeChange('b1', 'build')]),
              ]),
          }
        }
        if (url.startsWith('/api/workflows?root=')) return { ok: true, json: async () => ({ names: [] }) }
        throw new Error(`unexpected fetch ${url}`)
      }),
    )
    const push = vi.spyOn(window.history, 'pushState')
    render(<App />)
    fireEvent.click(await screen.findByTestId('project-rail-item-repo-b'))
    expect(await screen.findByTestId('workspace-view')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('task-card-b1')).toBeInTheDocument())
    expect(screen.queryByTestId('task-card-a1')).toBeNull()
    expect(push).toHaveBeenCalled()
    expect(new URLSearchParams(window.location.search).get('root')).toBe('/repo-b')
  })

  it('未选择项目时不把首个项目写进 URL，停留在聚合工作台', async () => {
    window.history.replaceState({}, '', '/?view=progress')
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/snapshot') {
        return { ok: true, json: async () => makeSnapshot([
          makeProject('/repo-a', [makeChange('a1', 'build')]),
          makeProject('/repo-b', [makeChange('b1', 'build')]),
        ]) }
      }
      throw new Error(`unexpected fetch ${url}`)
    }))
    render(<App />)
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(await screen.findByTestId('workspace-view')).toBeInTheDocument()
    expect(new URLSearchParams(window.location.search).get('root')).toBeNull()
  })
})

describe('App 调试外壳退役', () => {
  it('高级调试面与 server 版本不再占用全局页脚', async () => {
    render(<App />)
    await screen.findByTestId('workspace-view')
    expect(screen.queryByTestId('advanced-panel')).toBeNull()
    // 右列的底部动作条是页面内容的一部分；不再有全局页脚承载服务端版本或流量面板。
    expect(screen.queryByTestId('app-footer')).toBeNull()
    const nav = screen.getByTestId('primary-nav')
    expect(nav.textContent).not.toMatch(/流量|traffic|高级/i)
  })
})

describe('App 断线横幅 + 重连（评审 P2-13，Task 5）', () => {
  it('connected=true（默认）时不渲染 offline-banner', async () => {
    render(<App />)
    await screen.findByTestId('workspace-view')
    expect(screen.queryByTestId('offline-banner')).toBeNull()
  })

  it('SSE onerror → connected=false → 渲染 offline-banner（role=status，文案含"连接断开"）', async () => {
    render(<App />)
    await screen.findByTestId('workspace-view')
    const es = lastEventSource()
    expect(es).toBeDefined()
    act(() => {
      es!.emit('error', '')
    })
    const banner = await screen.findByTestId('offline-banner')
    expect(banner).toHaveAttribute('role', 'status')
    expect(banner.textContent).toContain('连接断开')
  })

  it('点「重连」：新发起一次 GET /api/snapshot + 重建一条新 SSE 订阅（不复用失效的旧连接）', async () => {
    render(<App />)
    await screen.findByTestId('workspace-view')
    const es = lastEventSource()
    act(() => {
      es!.emit('error', '')
    })
    await screen.findByTestId('offline-banner')

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    const before = fetchMock.mock.calls.filter((c: unknown[]) => c[0] === '/api/snapshot').length

    fireEvent.click(screen.getByTestId('offline-reconnect'))

    await waitFor(() => {
      const after = fetchMock.mock.calls.filter((c: unknown[]) => c[0] === '/api/snapshot').length
      expect(after).toBe(before + 1)
    })
    expect(lastEventSource()).not.toBe(es)
  })

  // 评审修复（担忧①）：重连此前另开一条独立订阅，不碰 useSnapshot 内部真正持有 connected
  // 的那条订阅——点了重连横幅不会自愈。下沉到 hook 本体后，新连接收到帧时 connected 走 hook
  // 既有的置位逻辑自然翻正，横幅必须从 DOM 消失（而不是像修复前那样常驻，直到原订阅自己恢复）。
  it('点「重连」→ 新连接送帧后，offline-banner 从 DOM 消失（重连下沉 useSnapshot 本体）', async () => {
    render(<App />)
    await screen.findByTestId('workspace-view')
    const es = lastEventSource()
    act(() => {
      es!.emit('error', '')
    })
    await screen.findByTestId('offline-banner')

    fireEvent.click(screen.getByTestId('offline-reconnect'))

    const next = lastEventSource()
    expect(next).not.toBe(es)

    act(() => {
      next!.emit('snapshot', JSON.stringify(makeSnapshot([makeProject('/repo', [makeChange('seed-c', 'build')])])))
    })

    await waitFor(() => expect(screen.queryByTestId('offline-banner')).toBeNull())
  })
})

// v10c：聚合语境（currentRoot 空串）整体退役——「点全部项目→空串保持」「空串偏好跨刷新保持」两用例
// 随之删除。切项目能力由 project-switcher 下拉 + 「项目」总览页卡覆盖（见上方护栏 describe）。

describe('App 项目切换（左列项目卡与顶部切换器同源）', () => {
  it('双项目：点 repo-b 打开该项目工作台，切换器可再切 repo-a', async () => {
    render(<App />)
    await screen.findByTestId('workspace-view')
    const es = lastEventSource()
    const next = makeSnapshot([
      makeProject('/repo-a', [makeChange('a1', 'build')]),
      makeProject('/repo-b', [makeChange('b1', 'build')]),
    ])
    act(() => {
      es!.emit('snapshot', JSON.stringify(next))
    })
    const row = await screen.findByTestId('project-rail-item-repo-b')
    fireEvent.click(row)
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('root')).toBe('/repo-b'))
    expect(screen.getByTestId('workspace-view')).toBeInTheDocument()
    expect(screen.getByTestId('project-label')).toHaveTextContent('repo-b')
    // 顶部条切换器与左列同源：切到 repo-a
    fireEvent.click(screen.getByTestId('project-switcher'))
    fireEvent.click(await screen.findByTestId('project-item-repo-a'))
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('root')).toBe('/repo-a'))
  })
})

describe('App 项目自动发现外壳', () => {
  it('不提供手工注册或注销入口', async () => {
    render(<App />)
    await screen.findByTestId('workspace-view')
    for (const id of ['project-register-path', 'project-register-submit', 'unregister-confirm']) {
      expect(screen.queryByTestId(id)).toBeNull()
    }
  })
})

// Workbench 只负责编辑工作流，不重复展示在办任务数量；运行中的阶段只保留轻量脉冲提示。
/**
 * Bug3 配套：顶层 ErrorBoundary——任意子树 render 抛错时局部降级兜底，不再整页白屏
 * （client.ts 形状校验是第一道，ErrorBoundary 是兜底第二道：任何未预期的 render 抛错都被接住）。
 */
describe('ErrorBoundary 顶层兜底（render 抛错不白屏）', () => {
  function Boom(): JSX.Element {
    throw new Error('render boom')
  }
  it('子树 render 抛错 → 渲染降级兜底（app-error-boundary）而非白屏', () => {
    // React 会把捕获的错误打到 console.error——本用例故意触发，静音以免污染输出。
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <I18nProvider>
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>
      </I18nProvider>,
    )
    expect(screen.getByTestId('app-error-boundary')).toBeInTheDocument()
    spy.mockRestore()
  })

  it('子树不抛错 → 正常渲染 children，不显兜底', () => {
    render(
      <I18nProvider>
        <ErrorBoundary>
          <div data-testid="ok-child">ok</div>
        </ErrorBoundary>
      </I18nProvider>,
    )
    expect(screen.getByTestId('ok-child')).toBeInTheDocument()
    expect(screen.queryByTestId('app-error-boundary')).toBeNull()
  })
})
