import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n'
import { HostTargetPlanClientError } from '../api/hostTargetPlanClient'
import type { HostTargetCatalog, HostTargetDetection, HostTargetPlan } from '../api/hostTargetPlanTypes'
import { HostTargetPlanView } from './HostTargetPlanView'

const catalog: HostTargetCatalog = {
  schema_version: 'host-target-plan/v1',
  targets: [
    {
      id: 'codex',
      kind: 'native',
      cli_flag: '--codex',
      target_scope: 'user',
      supported_operations: ['setup', 'update'],
      capabilities: ['native-marketplace', 'bundled-skills', 'automatic-update'],
    },
    {
      id: 'cursor',
      kind: 'adapter',
      cli_flag: '--cursor',
      target_scope: 'project',
      supported_operations: ['setup', 'update'],
      capabilities: ['project-adapter', 'managed-runtime', 'bundled-skills'],
    },
  ],
}

const setupPlan: HostTargetPlan = {
  schema_version: 'host-target-plan/v1',
  side_effects: 'none',
  host: catalog.targets[0],
  operation: 'setup',
  command: {
    executable: 'tenon',
    args: ['setup', '--codex'],
    display: 'tenon setup --codex',
  },
  steps: [
    { id: 'marketplace-register', label: 'host-plan.step.marketplace-register', command: null },
    {
      id: 'plugin-install',
      label: 'host-plan.step.plugin-install',
      command: {
        executable: 'codex',
        args: ['plugin', 'install', 'tenon'],
        display: 'codex plugin install tenon',
      },
    },
    {
      id: 'codex-auth-status',
      label: 'host-plan.step.codex-auth-status',
      command: {
        executable: 'codex',
        args: ['login', 'status'],
        display: 'codex login status',
      },
    },
  ],
  notices: [
    'host-plan.notice.read-only-generation',
    'host-plan.notice.manual-command-has-effects',
    'host-plan.notice.codex-auth-guidance',
  ],
}

const updatePlan: HostTargetPlan = {
  ...setupPlan,
  operation: 'update',
  command: {
    executable: 'tenon',
    args: ['update', '--codex'],
    display: 'tenon update --codex',
  },
}

const noDetection: HostTargetDetection = {
  schema_version: 'host-target-detection/v1',
  detected_hosts: [],
  recommended_host: null,
  recommended_operation: null,
  reason: 'none',
}

function renderView(over: Partial<Parameters<typeof HostTargetPlanView>[0]> = {}) {
  const props = {
    loadTargets: vi.fn<() => Promise<HostTargetCatalog>>(),
    loadDetection: vi.fn<() => Promise<HostTargetDetection>>().mockResolvedValue(noDetection),
    loadPlan: vi.fn<(host: string, operation: 'setup' | 'update') => Promise<HostTargetPlan>>(),
    copyText: vi.fn<(text: string) => Promise<void>>(),
    ...over,
  }
  render(<I18nProvider><HostTargetPlanView {...props} /></I18nProvider>)
  return props
}

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
})

describe('HostTargetPlanView', () => {
  it('makes additional desktop hosts discoverable with a persistent scroll hint', async () => {
    const adapter = catalog.targets[1]
    if (adapter === undefined) throw new Error('missing adapter fixture')
    const manyTargets: HostTargetCatalog = {
      ...catalog,
      targets: [
        ...catalog.targets,
        { ...adapter, id: 'gemini', cli_flag: '--gemini' },
        { ...adapter, id: 'pi', cli_flag: '--pi' },
        { ...adapter, id: 'devin', cli_flag: '--devin' },
      ],
    }
    renderView({ loadTargets: vi.fn().mockResolvedValue(manyTargets) })

    expect(await screen.findByTestId('host-target-scroll-hint')).toHaveTextContent('滚动列表或按 Tab 查看更多宿主')
  })

  it('loads catalog and detection in parallel, then opens the recommended read-only update plan', async () => {
    let resolveCatalog: ((value: HostTargetCatalog) => void) | undefined
    let resolveDetection: ((value: HostTargetDetection) => void) | undefined
    const loadTargets = vi.fn(() => new Promise<HostTargetCatalog>((resolve) => {
      resolveCatalog = resolve
    }))
    const loadDetection = vi.fn(() => new Promise<HostTargetDetection>((resolve) => {
      resolveDetection = resolve
    }))
    const loadPlan = vi.fn().mockResolvedValue(updatePlan)
    renderView({ loadTargets, loadDetection, loadPlan })

    expect(loadTargets).toHaveBeenCalledTimes(1)
    expect(loadDetection).toHaveBeenCalledTimes(1)
    resolveDetection?.({
      schema_version: 'host-target-detection/v1',
      detected_hosts: ['codex'],
      recommended_host: 'codex',
      recommended_operation: 'update',
      reason: 'tenon-plugin-detected',
    })
    resolveCatalog?.(catalog)

    await waitFor(() => expect(loadPlan).toHaveBeenCalledWith(
      'codex',
      'update',
      expect.any(AbortSignal),
    ))
    expect(screen.getByRole('button', { name: 'Codex，已选择' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '更新' })).toHaveAttribute('aria-pressed', 'true')
    expect(await screen.findByTestId('host-plan-preview')).toHaveTextContent('tenon update --codex')
  })

  it('puts the detected recommended host first and marks it for quick review', async () => {
    renderView({
      loadTargets: vi.fn().mockResolvedValue(catalog),
      loadDetection: vi.fn().mockResolvedValue({
        ...noDetection,
        detected_hosts: ['cursor'],
        recommended_host: 'cursor',
        recommended_operation: 'setup',
        reason: 'host-detected',
      }),
      loadPlan: vi.fn().mockResolvedValue(setupPlan),
    })

    await screen.findByTestId('host-target-cursor')
    const cards = within(screen.getByTestId('host-target-grid')).getAllByRole('article')
    expect(cards[0]).toHaveAttribute('data-testid', 'host-target-cursor')
    expect(cards[0]).toHaveAttribute('data-recommended', 'true')
    expect(cards[1]).toHaveAttribute('data-recommended', 'false')
  })

  it('degrades a missing detection endpoint to complete manual selection without blocking catalog', async () => {
    const loadPlan = vi.fn().mockResolvedValue(setupPlan)
    renderView({
      loadTargets: vi.fn().mockResolvedValue(catalog),
      loadDetection: vi.fn().mockRejectedValue(
        new HostTargetPlanClientError('http', 'HOST_TARGET_HTTP_ERROR', 404),
      ),
      loadPlan,
    })

    expect(await screen.findByRole('button', { name: '选择 Codex' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '选择 Cursor' })).toBeInTheDocument()
    expect(screen.getByTestId('host-detection-status')).toBeInTheDocument()
    expect(loadPlan).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '选择 Codex' }))
    fireEvent.click(screen.getByRole('button', { name: '安装' }))
    expect(await screen.findByTestId('host-plan-preview')).toHaveTextContent('tenon setup --codex')
  })

  it('invalidates a late automatically recommended plan after the user selects another host', async () => {
    let resolvePlan: ((value: HostTargetPlan) => void) | undefined
    const loadPlan = vi.fn(() => new Promise<HostTargetPlan>((resolve) => {
      resolvePlan = resolve
    }))
    renderView({
      loadTargets: vi.fn().mockResolvedValue(catalog),
      loadDetection: vi.fn().mockResolvedValue({
        schema_version: 'host-target-detection/v1',
        detected_hosts: ['codex'],
        recommended_host: 'codex',
        recommended_operation: 'update',
        reason: 'tenon-plugin-detected',
      }),
      loadPlan,
    })

    await waitFor(() => expect(loadPlan).toHaveBeenCalledWith('codex', 'update', expect.any(AbortSignal)))
    fireEvent.click(screen.getByRole('button', { name: '选择 Cursor' }))
    resolvePlan?.(updatePlan)

    await waitFor(() => {
      expect(screen.queryByText('tenon update --codex')).toBeNull()
      expect(screen.getByRole('status')).toHaveTextContent('选择“安装”或“更新”')
    })
  })

  it('announces catalog loading, then renders an honest empty state', async () => {
    let resolveCatalog: ((value: HostTargetCatalog) => void) | undefined
    const loadTargets = vi.fn()
      .mockImplementationOnce(() => new Promise<HostTargetCatalog>((resolve) => {
        resolveCatalog = resolve
      }))
      .mockResolvedValueOnce(catalog)
    renderView({ loadTargets })

    expect(screen.getByRole('status')).toHaveTextContent('正在加载宿主目录')
    resolveCatalog?.({ schema_version: 'host-target-plan/v1', targets: [] })

    expect(await screen.findByTestId('host-plan-empty')).toHaveTextContent('没有可用的宿主目标')
    fireEvent.click(screen.getByRole('button', { name: '重试宿主目录' }))
    expect(await screen.findByRole('button', { name: '选择 Codex' })).toBeInTheDocument()
    expect(loadTargets).toHaveBeenCalledTimes(2)
  })

  it('shows a catalog error and retries without reloading the page', async () => {
    const loadTargets = vi.fn()
      .mockRejectedValueOnce(
        new HostTargetPlanClientError('network', 'HOST_TARGET_NETWORK_ERROR'),
      )
      .mockResolvedValueOnce(catalog)
    renderView({ loadTargets })

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('无法连接本机 Tenon 服务')
    fireEvent.click(screen.getByRole('button', { name: '重试宿主目录' }))

    expect(await screen.findByRole('button', { name: '选择 Codex' })).toBeInTheDocument()
    expect(loadTargets).toHaveBeenCalledTimes(2)
  })

  it('keeps catalog rows compact and moves complete host context into the selected detail', async () => {
    const loadPlan = vi.fn()
    renderView({
      loadTargets: vi.fn().mockResolvedValue(catalog),
      loadPlan,
    })

    const selectCodex = await screen.findByRole('button', { name: '选择 Codex' })
    const codexRow = screen.getByRole('heading', { name: 'Codex' }).closest('article')
    if (!codexRow) throw new Error('Codex catalog row missing')

    expect(within(codexRow).getByText('--codex')).toBeInTheDocument()
    expect(within(codexRow).getByText('原生')).toBeInTheDocument()
    expect(within(codexRow).getByText('用户范围')).toBeInTheDocument()
    expect(within(codexRow).queryByText('原生 marketplace')).toBeNull()
    expect(within(codexRow).queryByText('内置 Skills')).toBeNull()

    fireEvent.click(selectCodex)

    const selectedContext = screen.getByTestId('host-selected-context')
    expect(selectedContext).toHaveTextContent('--codex')
    expect(selectedContext).toHaveTextContent('原生')
    expect(selectedContext).toHaveTextContent('用户范围')
    expect(selectedContext).toHaveTextContent('原生 marketplace')
    expect(selectedContext).toHaveTextContent('内置 Skills')
    expect(selectedContext).toHaveTextContent('自动更新')
    expect(loadPlan).not.toHaveBeenCalled()
  })

  it('selects a target and operation, announces plan loading, localizes tokens, and clears stale plans', async () => {
    let resolvePlan: ((value: HostTargetPlan) => void) | undefined
    const loadPlan = vi.fn(() => new Promise<HostTargetPlan>((resolve) => {
      resolvePlan = resolve
    }))
    renderView({
      loadTargets: vi.fn().mockResolvedValue(catalog),
      loadPlan,
    })

    fireEvent.click(await screen.findByRole('button', { name: '选择 Codex' }))
    const nativeCard = screen.getByRole('heading', { name: 'Codex' }).closest('article')
    if (!nativeCard) throw new Error('Codex card missing')
    expect(within(nativeCard).getByText('用户范围')).toBeInTheDocument()
    expect(within(screen.getByTestId('host-selected-context')).getByText('原生 marketplace'))
      .toBeInTheDocument()
    expect(within(screen.getByTestId('host-selected-context')).getByText('内置 Skills'))
      .toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('选择“安装”或“更新”')

    fireEvent.click(screen.getByRole('button', { name: '安装' }))
    expect(screen.getByRole('status')).toHaveTextContent('正在加载 Codex 的 安装 计划')
    expect(loadPlan).toHaveBeenCalledWith('codex', 'setup', expect.any(AbortSignal))

    resolvePlan?.(setupPlan)
    const preview = await screen.findByTestId('host-plan-preview')
    expect(preview).toHaveTextContent('tenon setup --codex')
    expect(screen.getByTestId('host-plan-ready-announcement')).toHaveTextContent(
      'Codex 的 安装 计划已就绪',
    )
    expect(preview).toHaveTextContent('登记宿主 marketplace')
    expect(preview).toHaveTextContent('安装 Tenon 插件')
    expect(preview).toHaveTextContent('检查 Codex 登录状态')
    expect(preview).toHaveTextContent('codex login status')
    expect(preview).toHaveTextContent('认证引导')
    expect(preview).toHaveTextContent('生成计划是只读操作')
    expect(screen.queryByRole('button', { name: /执行|Run command/i })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '选择 Cursor' }))
    expect(screen.queryByText('tenon setup --codex')).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('选择“安装”或“更新”')
  })

  it('keeps a stable master-detail layout instead of expanding and reflowing the selected card', async () => {
    renderView({
      loadTargets: vi.fn().mockResolvedValue(catalog),
      loadPlan: vi.fn().mockResolvedValue(setupPlan),
    })

    fireEvent.click(await screen.findByRole('button', { name: '选择 Cursor' }))

    expect(screen.getByTestId('host-plan-workspace').className).toContain(
      'min-[900px]:grid-cols-[minmax(300px,0.8fr)_minmax(0,1.2fr)]',
    )
    expect(screen.getByTestId('host-target-grid').className).not.toContain('order-')
    expect(screen.getByTestId('host-plan-detail').className).not.toContain('order-')
    const selectedCard = screen.getByRole('heading', { name: 'Cursor' }).closest('article')
    expect(selectedCard?.className).not.toContain('col-span-full')
    expect(within(screen.getByTestId('host-plan-detail')).getByRole('region', {
      name: 'Cursor 操作',
    })).toBeInTheDocument()
  })

  it('keeps mobile DOM and visual order aligned, preserves the selected host name, and focuses its detail', async () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: true,
      media: '(max-width: 899px)',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0)
      return 1
    })
    const scrollIntoView = vi.fn()
    HTMLElement.prototype.scrollIntoView = scrollIntoView
    renderView({
      loadTargets: vi.fn().mockResolvedValue(catalog),
      loadPlan: vi.fn().mockResolvedValue(setupPlan),
    })

    fireEvent.click(await screen.findByRole('button', { name: '选择 Cursor' }))

    const selected = screen.getByRole('button', { name: 'Cursor，已选择' })
    const grid = screen.getByTestId('host-target-grid')
    const detail = screen.getByTestId('host-plan-detail')
    expect(grid.compareDocumentPosition(detail) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    expect(detail).toHaveAttribute('tabindex', '-1')
    expect(detail.className).toContain('focus-visible:ring-2')
    expect(detail.className).toContain('focus-visible:ring-(--accent)')
    expect(detail).toHaveFocus()
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' })
    expect(selected).toHaveAttribute('aria-pressed', 'true')
  })

  it('shows a plan error and retries the exact selected operation', async () => {
    const loadPlan = vi.fn()
      .mockRejectedValueOnce(
        new HostTargetPlanClientError('http', 'HOST_TARGET_PLAN_UNAVAILABLE', 503),
      )
      .mockResolvedValueOnce(setupPlan)
    renderView({
      loadTargets: vi.fn().mockResolvedValue(catalog),
      loadPlan,
    })

    fireEvent.click(await screen.findByRole('button', { name: '选择 Codex' }))
    fireEvent.click(screen.getByRole('button', { name: '安装' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('宿主计划服务暂时不可用')

    fireEvent.click(screen.getByRole('button', { name: '重试“安装”计划' }))
    expect(await screen.findByTestId('host-plan-preview')).toHaveTextContent('tenon setup --codex')
    expect(loadPlan).toHaveBeenNthCalledWith(2, 'codex', 'setup', expect.any(AbortSignal))
  })

  it('copies only the previewed command and announces success', async () => {
    const copyText = vi.fn().mockResolvedValue(undefined)
    renderView({
      loadTargets: vi.fn().mockResolvedValue(catalog),
      loadPlan: vi.fn().mockResolvedValue(setupPlan),
      copyText,
    })

    fireEvent.click(await screen.findByRole('button', { name: '选择 Codex' }))
    fireEvent.click(screen.getByRole('button', { name: '安装' }))
    fireEvent.click(await screen.findByRole('button', { name: '复制命令' }))

    expect(await screen.findByText('命令已复制。')).toHaveAttribute('role', 'status')
    expect(copyText).toHaveBeenCalledWith('tenon setup --codex')
  })

  it('keeps the command visible and announces clipboard failure', async () => {
    const copyText = vi.fn().mockRejectedValue(new Error('clipboard denied'))
    renderView({
      loadTargets: vi.fn().mockResolvedValue(catalog),
      loadPlan: vi.fn().mockResolvedValue(setupPlan),
      copyText,
    })

    fireEvent.click(await screen.findByRole('button', { name: '选择 Codex' }))
    fireEvent.click(screen.getByRole('button', { name: '安装' }))
    fireEvent.click(await screen.findByRole('button', { name: '复制命令' }))

    expect(await screen.findByText('复制失败，请手动选择命令。')).toHaveAttribute('role', 'status')
    expect(screen.getByText('tenon setup --codex')).toBeVisible()
  })

  it('turns a synchronous clipboard exception into an announced copy error', async () => {
    const copyText = vi.fn(() => {
      throw new Error('clipboard unavailable')
    })
    renderView({
      loadTargets: vi.fn().mockResolvedValue(catalog),
      loadPlan: vi.fn().mockResolvedValue(setupPlan),
      copyText,
    })

    fireEvent.click(await screen.findByRole('button', { name: '选择 Codex' }))
    fireEvent.click(screen.getByRole('button', { name: '安装' }))
    fireEvent.click(await screen.findByRole('button', { name: '复制命令' }))

    expect(await screen.findByText('复制失败，请手动选择命令。')).toHaveAttribute('role', 'status')
  })

  it('ignores a late plan response after the user switches targets', async () => {
    let resolvePlan: ((value: HostTargetPlan) => void) | undefined
    renderView({
      loadTargets: vi.fn().mockResolvedValue(catalog),
      loadPlan: vi.fn(() => new Promise<HostTargetPlan>((resolve) => {
        resolvePlan = resolve
      })),
    })

    fireEvent.click(await screen.findByRole('button', { name: '选择 Codex' }))
    fireEvent.click(screen.getByRole('button', { name: '安装' }))
    fireEvent.click(screen.getByRole('button', { name: '选择 Cursor' }))
    resolvePlan?.(setupPlan)

    await waitFor(() => {
      expect(screen.queryByTestId('host-plan-preview')).toBeNull()
      expect(screen.getByRole('status')).toHaveTextContent('选择“安装”或“更新”')
    })
  })

  it('aborts the active plan request when the user switches targets', async () => {
    let planSignal: AbortSignal | undefined
    renderView({
      loadTargets: vi.fn().mockResolvedValue(catalog),
      loadPlan: vi.fn((
        _host: string,
        _operation: 'setup' | 'update',
        signal?: AbortSignal,
      ) => {
        planSignal = signal
        return new Promise<HostTargetPlan>(() => undefined)
      }),
    })

    fireEvent.click(await screen.findByRole('button', { name: '选择 Codex' }))
    fireEvent.click(screen.getByRole('button', { name: '安装' }))
    fireEvent.click(screen.getByRole('button', { name: '选择 Cursor' }))

    expect(planSignal).toBeInstanceOf(AbortSignal)
    expect(planSignal?.aborted).toBe(true)
  })

  it('aborts the active catalog request when the view unmounts', async () => {
    let catalogSignal: AbortSignal | undefined
    const loadTargets = vi.fn((signal?: AbortSignal) => {
      catalogSignal = signal
      return new Promise<HostTargetCatalog>(() => undefined)
    })
    const rendered = render(
      <I18nProvider>
        <HostTargetPlanView loadTargets={loadTargets} />
      </I18nProvider>,
    )

    await waitFor(() => expect(loadTargets).toHaveBeenCalledTimes(1))
    rendered.unmount()

    expect(catalogSignal).toBeInstanceOf(AbortSignal)
    expect(catalogSignal?.aborted).toBe(true)
  })

  it('renders the complete fixed UI in English without leaking Chinese copy', async () => {
    localStorage.setItem('tenon-dashboard-lang', 'en')
    renderView({
      loadTargets: vi.fn().mockResolvedValue(catalog),
      loadPlan: vi.fn().mockResolvedValue(setupPlan),
    })

    expect(await screen.findByRole('heading', { name: 'Host target plans' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Select Codex' }))
    const selectedContext = screen.getByTestId('host-selected-context')
    expect(selectedContext).toHaveTextContent('User scope')
    expect(selectedContext).toHaveTextContent('Native marketplace')
    fireEvent.click(screen.getByRole('button', { name: 'Setup' }))

    const view = await screen.findByTestId('host-plan-view')
    expect(view).toHaveTextContent('Register the host marketplace')
    expect(view).toHaveTextContent('Generating this plan is read-only')
    expect(view.textContent).not.toMatch(/[宿主选择计划步骤复制安装更新]/)
  })

  it.each([
    [
      'network',
      new HostTargetPlanClientError('network', 'HOST_TARGET_NETWORK_ERROR'),
      'Could not reach the local Tenon service. Check the connection and retry.',
    ],
    [
      'HTTP',
      new HostTargetPlanClientError('http', 'HOST_TARGET_PLAN_UNAVAILABLE', 503),
      'Host plan service is temporarily unavailable. Retry in a moment.',
    ],
    [
      'decoder',
      new HostTargetPlanClientError('decoder', 'HOST_TARGET_CATALOG_RESPONSE_INVALID', 200),
      'The host target catalog response was invalid. Retry after updating Tenon.',
    ],
  ])('maps a stable %s catalog error to English UI copy', async (_kind, error, expected) => {
    localStorage.setItem('tenon-dashboard-lang', 'en')
    renderView({ loadTargets: vi.fn().mockRejectedValue(error) })

    expect(await screen.findByRole('alert')).toHaveTextContent(expected)
    expect(screen.queryByText(error.code)).toBeNull()
  })

  it('maps a stable plan mismatch to English UI copy', async () => {
    localStorage.setItem('tenon-dashboard-lang', 'en')
    renderView({
      loadTargets: vi.fn().mockResolvedValue(catalog),
      loadPlan: vi.fn().mockRejectedValue(
        new HostTargetPlanClientError('mismatch', 'HOST_TARGET_PLAN_REQUEST_MISMATCH', 200),
      ),
    })

    fireEvent.click(await screen.findByRole('button', { name: 'Select Codex' }))
    fireEvent.click(screen.getByRole('button', { name: 'Setup' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The returned plan did not match the selected host and operation. Retry the request.',
    )
  })

  it('falls back to unknown stable step and notice tokens without hiding the plan', async () => {
    const planWithFutureTokens: HostTargetPlan = {
      ...setupPlan,
      steps: [{ id: 'future-step', label: 'host-plan.step.future-step', command: null }],
      notices: ['host-plan.notice.future-notice'],
    }
    renderView({
      loadTargets: vi.fn().mockResolvedValue(catalog),
      loadPlan: vi.fn().mockResolvedValue(planWithFutureTokens),
    })

    fireEvent.click(await screen.findByRole('button', { name: '选择 Codex' }))
    fireEvent.click(screen.getByRole('button', { name: '安装' }))

    expect(await screen.findByText('host-plan.step.future-step')).toBeInTheDocument()
    expect(screen.getByText('host-plan.notice.future-notice')).toBeInTheDocument()
  })
})
