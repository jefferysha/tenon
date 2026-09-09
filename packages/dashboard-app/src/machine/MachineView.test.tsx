import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n'
import { GlobalSearchProvider } from '../shell/GlobalSearch'
import { makeChange, makeProject, makeSnapshot } from '../testkit'
import { MachineView } from './MachineView'

const ROOT = '/repo/current'

beforeEach(() => {
  localStorage.clear()
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.startsWith('/api/afk/readiness')) return new Response(JSON.stringify({ ok: true, docker: { available: true }, image: { configured: 'sandcastle:local', present: false, build_hint: 'npm run sandcastle:build' }, credentials: { 'claude-code': { CLAUDE_CODE_OAUTH_TOKEN: { set: false } }, codex: { OPENAI_API_KEY: { set: false }, CODEX_HOME: { set: true, source: 'default-home' } } } }), { status: 200 })
    if (url === '/api/docker/images') return new Response(JSON.stringify({ ok: true, available: true, images: ['other:latest'] }), { status: 200 })
    if (url === '/api/secrets') return new Response(JSON.stringify({ ok: true, keys: { CLAUDE_CODE_OAUTH_TOKEN: { set: false }, OPENAI_API_KEY: { set: false } } }), { status: 200 })
    if (url === '/api/skills/registry') return new Response(JSON.stringify({ skills: [{ name: 'ci-triage', installed: true, source: 'builtin', tier: 'mandatory', available: true }, { name: 'browser-e2e', installed: false, source: 'user', tier: 'mandatory', available: true, installCmd: 'tenon setup' }, { name: 'zoom-out', installed: false, source: 'user', tier: 'optional', available: false }] }), { status: 200 })
    if (url === '/api/loops/snapshot') return new Response(JSON.stringify({ generated_at: 'now', rows: [
      { root: ROOT, id: 'broken-loop', name: 'Broken', status: 'active', autonomy_level: 'L2', cadence: '1h', goal: 'x', design_doc: 'x', change_prefix: null, risk: 'high', runner: 'codex', human_gates: [], kill_criteria: [], allowlist: [], denylist: [], budget_decl: { max_runs_per_day: 1, max_in_flight: 1, on_exceed: 'skip-run' }, readiness: { score: 30, band: 'not-ready' }, budget: { breaker: 'tripped', runsToday: 1, spentToday: 100, remaining: 0 }, matched_changes: [], phases: [], draft: false, skill_bundle_id: null, ledger: { health: 'degraded', rejected_records: 2 } },
    ] }), { status: 200 })
    throw new Error(`unexpected fetch ${url}`)
  }) as unknown as typeof fetch
})
afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('MachineView 统一就绪与跨项目风险', () => {
  it('全部必要事实返回前保持未知加载态，不提前宣告没有阻断', async () => {
    global.fetch = vi.fn(() => new Promise<Response>(() => undefined)) as typeof fetch
    render(<I18nProvider><GlobalSearchProvider><MachineView snapshot={makeSnapshot([makeProject(ROOT, [])], { capabilities: { operations: true } })} currentRoot={ROOT} onOpenProject={vi.fn()} /></GlobalSearchProvider></I18nProvider>)

    expect(await screen.findByTestId('machine-blockers-loading')).toHaveTextContent('正在读取真实信号')
    expect(screen.getByTestId('machine-blockers')).not.toHaveTextContent('未发现机器级阻断')
  })

  it('compatibility-only 项目不误报损坏，并继续显示 readable sibling 的真实 automation 风险', async () => {
    const project = makeProject(ROOT, [
      makeChange('readable-failed', 'build', { fields: { automation: 'failed' } }),
    ], {
      ok: false,
      compatibilityIssues: [{
        kind: 'unsupported-canonical-version',
        change: 'future-state',
        foundVersion: 2,
        supportedVersion: 1,
        action: 'upgrade-runtime',
      }],
    })

    render(
      <I18nProvider><GlobalSearchProvider>
        <MachineView
          snapshot={makeSnapshot([project], { capabilities: { operations: true } })}
          currentRoot={ROOT}
          onOpenProject={vi.fn()}
        />
      </GlobalSearchProvider></I18nProvider>,
    )

    const queue = await screen.findByTestId('machine-risk-queue')
    expect(queue).toHaveTextContent('readable-failed')
    expect(queue).toHaveTextContent('自动运行失败')
    expect(queue).not.toHaveTextContent('项目无法读取')
    expect(queue).not.toHaveTextContent('unknown error')
  })

  it('把已接线 Trace timeline 暴露在真实机器页诊断入口', async () => {
    const baseFetch = global.fetch
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/traces/sessions') {
        return new Response(JSON.stringify({
          generated_at: 'now',
          outbound: 'local-only',
          count: 0,
          sessions: [],
        }), { status: 200 })
      }
      return baseFetch(input)
    }) as unknown as typeof fetch

    const snapshot = makeSnapshot([makeProject(ROOT, [])], {
      capabilities: { operations: true, traffic: true },
    })
    render(<I18nProvider><GlobalSearchProvider><MachineView snapshot={snapshot} currentRoot={ROOT} onOpenProject={vi.fn()} /></GlobalSearchProvider></I18nProvider>)

    const diagnostics = await screen.findByTestId('machine-diagnostics')
    expect(within(diagnostics).queryByTestId('advanced-panel')).toBeNull()
    fireEvent.click(within(diagnostics).getByText('打开诊断面板'))
    expect(await within(diagnostics).findByTestId('advanced-panel')).toBeInTheDocument()
    expect(screen.getByTestId('advanced-traffic')).toHaveTextContent('Trace 时间线')
    expect(await screen.findByTestId('traffic-empty')).toHaveTextContent('暂无捕获会话')
  })

  it('集中显示核心与 AFK 事实，缺镜像只标记可选能力而未装必备技能仍形成 blocker', async () => {
    const snapshot = makeSnapshot([makeProject(ROOT, [])], { capabilities: { operations: true } })
    render(<I18nProvider><GlobalSearchProvider><MachineView snapshot={snapshot} currentRoot={ROOT} onOpenProject={vi.fn()} /></GlobalSearchProvider></I18nProvider>)
    await waitFor(() => {
      expect(screen.getByTestId('machine-docker')).toHaveAttribute('data-state', 'ready')
      expect(screen.getByTestId('machine-image')).toHaveAttribute('data-state', 'optional-unavailable')
      expect(screen.getByTestId('machine-codex')).toHaveAttribute('data-state', 'ready')
      expect(screen.getByTestId('machine-codex')).toHaveTextContent('默认 Codex 配置目录')
      expect(screen.getByTestId('machine-skills')).toHaveAttribute('data-state', 'blocked')
    })
    expect(screen.getByTestId('machine-codex')).not.toHaveTextContent('default-home')
    expect(screen.getByTestId('machine-afk-readiness')).toContainElement(screen.getByTestId('machine-image'))
    expect(screen.getByTestId('machine-blockers').textContent).not.toContain('sandcastle:local')
    expect(screen.getByTestId('machine-blockers').textContent).toContain('browser-e2e')
  })

  it('Docker daemon 不可用时卡片说明为 AFK 可选能力，不伪装成核心 blocked', async () => {
    localStorage.setItem('tenon-dashboard-lang', 'en')
    const baseFetch = global.fetch
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/api/afk/readiness')) {
        return new Response(JSON.stringify({
          ok: true,
          docker: { available: false },
          image: { configured: 'sandcastle:local', present: false, build_hint: 'npm run sandcastle:build' },
          credentials: { 'claude-code': { CLAUDE_CODE_OAUTH_TOKEN: { set: false } }, codex: { OPENAI_API_KEY: { set: false }, CODEX_HOME: { set: true, source: 'default-home' } } },
        }), { status: 200 })
      }
      if (url === '/api/docker/images') {
        return new Response(JSON.stringify({ ok: true, available: false, images: [] }), { status: 200 })
      }
      return baseFetch(input)
    }) as unknown as typeof fetch

    render(<I18nProvider><GlobalSearchProvider><MachineView snapshot={makeSnapshot([makeProject(ROOT, [])], { capabilities: { operations: true } })} currentRoot={ROOT} onOpenProject={vi.fn()} /></GlobalSearchProvider></I18nProvider>)

    await waitFor(() => expect(screen.getByTestId('machine-docker')).toHaveAttribute('data-state', 'optional-unavailable'))
    expect(screen.getByTestId('machine-docker')).toHaveTextContent('Docker daemon unavailable')
    expect(screen.getByTestId('machine-docker')).not.toHaveTextContent('Docker available')
  })

  it('Docker 卡片的状态与说明只消费同一个全局探测事实', async () => {
    localStorage.setItem('tenon-dashboard-lang', 'en')
    const baseFetch = global.fetch
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith('/api/afk/readiness')) {
        return new Response(JSON.stringify({
          ok: true,
          docker: { available: false },
          image: { configured: 'sandcastle:local', present: false, build_hint: 'npm run sandcastle:build' },
          credentials: { 'claude-code': { CLAUDE_CODE_OAUTH_TOKEN: { set: false } }, codex: { OPENAI_API_KEY: { set: false }, CODEX_HOME: { set: true, source: 'default-home' } } },
        }), { status: 200 })
      }
      if (String(input) === '/api/docker/images') {
        return new Response(JSON.stringify({ ok: true, available: true, images: ['tenon:latest'] }), { status: 200 })
      }
      return baseFetch(input)
    }) as unknown as typeof fetch

    render(<I18nProvider><GlobalSearchProvider><MachineView snapshot={makeSnapshot([makeProject(ROOT, [])], { capabilities: { operations: true } })} currentRoot={ROOT} onOpenProject={vi.fn()} /></GlobalSearchProvider></I18nProvider>)

    await waitFor(() => expect(screen.getByTestId('machine-docker')).toHaveAttribute('data-state', 'ready'))
    expect(screen.getByTestId('machine-docker')).toHaveTextContent('1 local image')
    expect(screen.getByTestId('machine-docker')).not.toHaveTextContent('Docker daemon unavailable')
  })

  it('Docker 镜像探测失败时结束加载态并只在 AFK 卡片显示明确错误', async () => {
    const baseFetch = global.fetch
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/docker/images') {
        return new Response(JSON.stringify({ error: 'docker probe unavailable' }), { status: 503 })
      }
      return baseFetch(input)
    }) as unknown as typeof fetch

    render(<I18nProvider><GlobalSearchProvider><MachineView snapshot={makeSnapshot([makeProject(ROOT, [])], { capabilities: { operations: true } })} currentRoot={ROOT} onOpenProject={vi.fn()} /></GlobalSearchProvider></I18nProvider>)

    await waitFor(() => expect(screen.getByTestId('machine-docker')).toHaveAttribute('data-state', 'optional-unavailable'))
    expect(screen.getByTestId('machine-image')).toHaveAttribute('data-state', 'optional-unavailable')
    expect(screen.getByTestId('machine-docker')).toHaveTextContent('docker probe unavailable')
    expect(screen.getByTestId('machine-image')).toHaveTextContent('docker probe unavailable')
    expect(screen.getByTestId('machine-blockers')).not.toHaveTextContent('docker probe unavailable')
  })

  it('就绪卡保持非 live 语义并只用一个聚合状态播报，宽屏不会挤成五个重叠窄列', async () => {
    const snapshot = makeSnapshot([makeProject(ROOT, [])], { capabilities: { operations: true } })
    render(<I18nProvider><GlobalSearchProvider><MachineView snapshot={snapshot} currentRoot={ROOT} onOpenProject={vi.fn()} /></GlobalSearchProvider></I18nProvider>)

    await waitFor(() => expect(screen.getByTestId('machine-readiness-summary')).toHaveTextContent('就绪 2，受阻 1，未知 0'))
    expect(screen.getByTestId('machine-readiness-summary')).toHaveAttribute('role', 'status')
    expect(screen.getByTestId('machine-readiness-grid')).toHaveClass('grid')
    for (const testId of ['machine-docker', 'machine-image', 'machine-codex', 'machine-skills', 'machine-operations']) {
      expect(screen.getByTestId(testId)).not.toHaveAttribute('role')
      expect(screen.getByTestId(testId)).not.toHaveAttribute('aria-live')
      expect(within(screen.getByTestId(testId)).getByRole('heading', { level: 3 })).toHaveClass('break-words')
    }
  })

  it('风险队列把后端异常翻译为可理解的中文处置项，并为窄屏声明单列与全宽动作', async () => {
    const onOpenProject = vi.fn()
    const snapshot = makeSnapshot([makeProject(ROOT, [makeChange('failed-change', 'build', { fields: { automation: 'failed' } })])])
    render(<I18nProvider><GlobalSearchProvider><MachineView snapshot={snapshot} currentRoot={ROOT} onOpenProject={onOpenProject} /></GlobalSearchProvider></I18nProvider>)
    fireEvent.click(await screen.findByTestId('machine-detail-tab-risks'))
    const queue = await screen.findByTestId('machine-risk-queue')
    for (const text of ['failed-change', '自动运行失败', '账本异常', '预算已熔断', '就绪度不足', '未配置技能包']) expect(queue.textContent).toContain(text)
    for (const raw of ['automation failed', 'ledger degraded', 'budget tripped', 'readiness not-ready', 'skill bundle missing']) expect(queue.textContent).not.toContain(raw)
    const riskRow = within(queue).getByTestId('machine-risk-row-broken-loop')
    expect(riskRow).toHaveClass('max-[480px]:flex-col')
    expect(within(riskRow).getByRole('button')).toHaveClass('max-[480px]:w-full')
    fireEvent.click(within(queue).getByTestId('machine-risk-open-broken-loop'))
    expect(onOpenProject).toHaveBeenCalledWith(ROOT)
  })

  it('有当前项目时默认只展示当前项目风险，并可展开跨项目计数', async () => {
    const otherRoot = '/repo/other'
    const snapshot = makeSnapshot([
      makeProject(ROOT, [makeChange('current-failed', 'build', { fields: { automation: 'failed' } })]),
      makeProject(otherRoot, [makeChange('other-failed', 'build', { fields: { automation: 'failed' } })]),
    ])
    render(<I18nProvider><GlobalSearchProvider><MachineView snapshot={snapshot} currentRoot={ROOT} onOpenProject={vi.fn()} /></GlobalSearchProvider></I18nProvider>)

    const queue = await screen.findByTestId('machine-risk-queue')
    expect(queue).toHaveTextContent('current-failed')
    expect(queue).not.toHaveTextContent('other-failed')
    const crossProject = within(queue).getByTestId('machine-cross-project-count')
    expect(crossProject).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(crossProject)
    expect(queue).toHaveTextContent('other-failed')
    expect(crossProject).toHaveAttribute('aria-pressed', 'true')
  })

  it('同 basename 的跨项目风险显示稳定父目录提示，打开目标不会混淆', async () => {
    const rootA = '/worktrees/alpha/pipeline-worklfow'
    const rootB = '/worktrees/beta/pipeline-worklfow'
    const onOpenProject = vi.fn()
    const snapshot = makeSnapshot([
      makeProject(rootA, [], { ok: false, error: 'unreadable' }),
      makeProject(rootB, [], { ok: false, error: 'unreadable' }),
    ])
    render(<I18nProvider><GlobalSearchProvider><MachineView snapshot={snapshot} currentRoot={ROOT} onOpenProject={onOpenProject} /></GlobalSearchProvider></I18nProvider>)

    fireEvent.click(await screen.findByTestId('machine-detail-tab-risks'))
    const queue = await screen.findByTestId('machine-risk-queue')
    expect(queue).toHaveTextContent('…/alpha/pipeline-worklfow')
    expect(queue).toHaveTextContent('…/beta/pipeline-worklfow')
    const buttons = within(queue).getAllByRole('button', { name: /^打开项目/ })
    expect(buttons[0]).toHaveAccessibleName('打开项目：pipeline-worklfow（…/alpha/pipeline-worklfow）')
    expect(buttons[1]).toHaveAccessibleName('打开项目：pipeline-worklfow（…/beta/pipeline-worklfow）')
    fireEvent.click(buttons[0]!)
    fireEvent.click(buttons[1]!)
    expect(onOpenProject).toHaveBeenNthCalledWith(1, rootA)
    expect(onOpenProject).toHaveBeenNthCalledWith(2, rootB)
  })

  it('风险路径提示兼容反斜杠、限制长度，并在末两段相同时稳定消歧', async () => {
    const rootA = '/Users/alice/src/pipeline-worklfow'
    const rootB = '/Volumes/backup/src/pipeline-worklfow'
    const rootC = `C:\\Users\\alice\\${'very-long-parent-segment-'.repeat(8)}\\pipeline-worklfow`
    const rootD = '/worktrees/12345678😀ABCDEFGHIJKLM/pipeline-worklfow'
    const snapshot = makeSnapshot([
      makeProject(rootA, [], { ok: false, error: 'unreadable' }),
      makeProject(rootB, [], { ok: false, error: 'unreadable' }),
      makeProject(rootC, [], { ok: false, error: 'unreadable' }),
      makeProject(rootD, [], { ok: false, error: 'unreadable' }),
    ])
    render(<I18nProvider><GlobalSearchProvider><MachineView snapshot={snapshot} currentRoot={ROOT} onOpenProject={vi.fn()} /></GlobalSearchProvider></I18nProvider>)

    const queue = await screen.findByTestId('machine-risk-queue')
    const hints = within(queue).getAllByTestId('machine-risk-root-hint').map((node) => node.textContent ?? '')
    expect(hints[0]).toMatch(/^…\/src\/pipeline-worklfow · #[0-9a-f]{12}$/)
    expect(hints[1]).toMatch(/^…\/src\/pipeline-worklfow · #[0-9a-f]{12}$/)
    expect(hints[0]).not.toBe(hints[1])
    expect(hints[2]).toMatch(/^…\/very-long…t-segment-\/pipeline-worklfow$/)
    expect(hints[3]).toContain('…/12345678😀…DEFGHIJKLM/pipeline-worklfow')
    expect(Array.from(hints[3]!).every((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint < 0xd800 || codePoint > 0xdfff
    })).toBe(true)
    expect(hints.every((hint) => hint.length <= 64)).toBe(true)
    expect(queue).not.toHaveTextContent('C:\\Users\\alice')
    expect(queue).not.toHaveTextContent('/Users/alice/src')
    expect(queue).not.toHaveTextContent('/Volumes/backup/src')
  })

  it('optional 或上游已下架的 skill 仍计入明细，但不把机器误判为 blocked、也不生成 blocker', async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/api/afk/readiness')) return new Response(JSON.stringify({ ok: true, docker: { available: true }, image: { configured: 'sandcastle:local', present: true, build_hint: 'npm run sandcastle:build' }, credentials: { 'claude-code': { CLAUDE_CODE_OAUTH_TOKEN: { set: false } }, codex: { OPENAI_API_KEY: { set: false }, CODEX_HOME: { set: true, source: 'default-home' } } } }), { status: 200 })
      if (url === '/api/docker/images') return new Response(JSON.stringify({ ok: true, available: true, images: ['sandcastle:local'] }), { status: 200 })
      if (url === '/api/secrets') return new Response(JSON.stringify({ ok: true, keys: { CLAUDE_CODE_OAUTH_TOKEN: { set: false }, OPENAI_API_KEY: { set: false } } }), { status: 200 })
      if (url === '/api/skills/registry') return new Response(JSON.stringify({ skills: [
        { name: 'browser-qa', installed: true, source: 'user', tier: 'mandatory', available: true },
        { name: 'hallmark', installed: false, source: 'user', tier: 'optional', available: true },
        { name: 'zoom-out', installed: false, source: 'user', tier: 'optional', available: false },
      ] }), { status: 200 })
      if (url === '/api/loops/snapshot') return new Response(JSON.stringify({ generated_at: 'now', rows: [] }), { status: 200 })
      throw new Error(`unexpected fetch ${url}`)
    }) as unknown as typeof fetch

    render(<I18nProvider><GlobalSearchProvider><MachineView snapshot={makeSnapshot([makeProject(ROOT, [])], { capabilities: { operations: true } })} currentRoot={ROOT} onOpenProject={vi.fn()} /></GlobalSearchProvider></I18nProvider>)

    await waitFor(() => expect(screen.getByTestId('machine-skills')).toHaveAttribute('data-state', 'ready'))
    expect(screen.getByTestId('machine-skills')).toHaveTextContent('1/3')
    expect(screen.getByTestId('machine-blockers')).not.toHaveTextContent('hallmark')
    expect(screen.getByTestId('machine-blockers')).not.toHaveTextContent('zoom-out')
  })

  it('Skill registry 的 HTTP 503 保留 HTTP 分类，不误报网络错误', async () => {
    localStorage.setItem('tenon-dashboard-lang', 'en')
    const baseFetch = global.fetch
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/skills/registry') return new Response(JSON.stringify({ error: '上游技能库不可用' }), { status: 503 })
      return baseFetch(input)
    }) as unknown as typeof fetch
    render(<I18nProvider><GlobalSearchProvider><MachineView snapshot={makeSnapshot([makeProject(ROOT, [])], { capabilities: { operations: true } })} currentRoot={ROOT} onOpenProject={vi.fn()} /></GlobalSearchProvider></I18nProvider>)
    const blockers = await screen.findByTestId('machine-blockers')
    await waitFor(() => expect(blockers).toHaveTextContent('HTTP 503'))
    expect(blockers).not.toHaveTextContent('Network error')
  })

  it('Skill registry 的 200 非法 schema 显示服务端响应无效，不崩到 ErrorBoundary', async () => {
    const baseFetch = global.fetch
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/skills/registry') return new Response(JSON.stringify({ skills: [{ name: 'bad', installed: true, source: 'builtin', tier: 42 }] }), { status: 200 })
      return baseFetch(input)
    }) as unknown as typeof fetch
    render(<I18nProvider><GlobalSearchProvider><MachineView snapshot={makeSnapshot([makeProject(ROOT, [])], { capabilities: { operations: true } })} currentRoot={ROOT} onOpenProject={vi.fn()} /></GlobalSearchProvider></I18nProvider>)
    await waitFor(() => expect(screen.getByTestId('machine-blockers')).toHaveTextContent('服务端响应格式无效'))
  })

  it('未选择项目不伪装成机器阻断，也不制造 readiness 网络错误', async () => {
    render(<I18nProvider><GlobalSearchProvider><MachineView snapshot={makeSnapshot([])} currentRoot="" onOpenProject={vi.fn()} /></GlobalSearchProvider></I18nProvider>)
    await waitFor(() => expect(screen.getByTestId('machine-blockers')).toHaveTextContent('browser-e2e'))
    expect(screen.getByTestId('machine-blockers')).not.toHaveTextContent('未选择项目')
    expect(screen.getByTestId('machine-blockers')).not.toHaveTextContent('网络错误')
  })

  it('未显式选择项目时不借用注册表首项，并明确保留项目级事实未知', async () => {
    const fetchSpy = vi.mocked(global.fetch)
    render(<I18nProvider><GlobalSearchProvider><MachineView snapshot={makeSnapshot([makeProject(ROOT, [])], { capabilities: { operations: true } })} currentRoot="" onOpenProject={vi.fn()} /></GlobalSearchProvider></I18nProvider>)

    expect(await screen.findByTestId('machine-project-facts-unavailable')).toHaveTextContent('当前未选择项目')
    expect(screen.getByTestId('machine-codex')).toHaveAttribute('data-state', 'unknown')
    expect(fetchSpy.mock.calls.some(([input]) => String(input).startsWith('/api/afk/readiness'))).toBe(false)
  })

  it('未选择项目时仍使用全局 Docker 探测显示 AFK 可选能力不可用', async () => {
    const baseFetch = global.fetch
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/docker/images') {
        return new Response(JSON.stringify({ ok: true, available: false, images: [] }), { status: 200 })
      }
      return baseFetch(input)
    }) as unknown as typeof fetch

    render(<I18nProvider><GlobalSearchProvider><MachineView snapshot={makeSnapshot([], { capabilities: { operations: true } })} currentRoot="" onOpenProject={vi.fn()} /></GlobalSearchProvider></I18nProvider>)

    await waitFor(() => expect(screen.getByTestId('machine-docker')).toHaveAttribute('data-state', 'optional-unavailable'))
    expect(screen.getByTestId('machine-docker')).toHaveTextContent('Docker daemon 不可用')
    expect(screen.getByTestId('machine-blockers')).not.toHaveTextContent('Docker daemon 不可用')
  })

  it('没有任何可达项目时明确保留项目级事实未知，不宣告机器完全无阻断', async () => {
    const baseFetch = global.fetch
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/skills/registry') {
        return new Response(JSON.stringify({ skills: [
          { name: 'browser-e2e', installed: true, source: 'user', tier: 'mandatory', available: true },
        ] }), { status: 200 })
      }
      return baseFetch(input)
    }) as unknown as typeof fetch

    render(<I18nProvider><GlobalSearchProvider><MachineView snapshot={makeSnapshot([], { capabilities: { operations: true } })} currentRoot="" onOpenProject={vi.fn()} /></GlobalSearchProvider></I18nProvider>)

    expect(await screen.findByTestId('machine-project-facts-unavailable')).toHaveTextContent('项目相关 AFK 信号保持未知')
    expect(screen.getByTestId('machine-blockers')).toHaveTextContent('仍有核心事实未知')
  })
})
