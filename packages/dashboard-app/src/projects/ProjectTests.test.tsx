import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { baselinesResponse, catalogResponse, defaultLevels } from '../api/testSystemFixtures'
import type { CatalogLevel, CatalogSuite, KnownFailuresView, SuiteBaselinesResponse, TestCatalogResponse } from '../api/testSystemTypes'
import { I18nProvider } from '../i18n'
import { chartPoints } from './HistoryChart'
import { ProjectsView } from './ProjectsView'
import { isSafeLink } from './SuiteKnownFailures'
import { suiteThresholds } from './suiteThresholds'

const PROJECTS = [{ root: '/repo', name: 'repo', count: 1, ok: true }]

interface Api {
  catalog?: TestCatalogResponse | { status: number } | 'never'
  baselines?: SuiteBaselinesResponse | { status: number }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

function stub(api: Api = {}) {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    if (url.startsWith('/api/tests/catalog?')) {
      const value = api.catalog ?? catalogResponse()
      if (value === 'never') return new Promise<Response>(() => undefined)
      return 'status' in value ? json({ ok: false, error: 'x' }, value.status) : json({ ok: true, ...value })
    }
    if (url.startsWith('/api/tests/baselines?')) {
      const value = api.baselines ?? baselinesResponse()
      return 'status' in value ? json({ ok: false, error: 'x' }, value.status) : json({ ok: true, ...value })
    }
    return json({ ok: false, error: 'not found' }, 404)
  }))
  return calls
}

function mount(revision = 'r1') {
  const view = (rev: string) => (
    <I18nProvider>
      <TooltipProvider>
        <ProjectsView projects={PROJECTS} currentRoot="/repo" onSelectProject={() => undefined} snapshotRevision={rev} />
      </TooltipProvider>
    </I18nProvider>
  )
  const utils = render(view(revision))
  return { ...utils, again: (rev: string) => utils.rerender(view(rev)) }
}

async function openTests(): Promise<void> {
  await userEvent.click(screen.getByTestId('proj-segment-tab-tests'))
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('项目页 · 「客户端 / 测试」分段', () => {
  it('列头是分段页签（客户端 · 测试），H1 退成读屏标题；默认客户端，切到测试才请求目录', async () => {
    const calls = stub()
    mount()
    const tabs = screen.getByRole('tablist', { name: '项目视图' })
    expect(within(tabs).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['客户端', '测试'])
    expect(screen.getByTestId('proj-segment-tab-clients')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('heading', { level: 1, name: '客户端' }).className).toContain('sr-only')
    expect(calls.some((url) => url.startsWith('/api/tests/catalog'))).toBe(false)
    await openTests()
    expect(screen.getByTestId('proj-segment-tab-tests')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('heading', { level: 1, name: '测试' })).toBeInTheDocument()
    await screen.findByTestId('proj-tests-table')
    expect(calls).toContain('/api/tests/catalog?root=%2Frepo')
    await userEvent.click(screen.getByTestId('proj-segment-tab-clients'))
    expect(screen.queryByTestId('proj-tests-table')).toBeNull()
  })

  it('方向键在两段之间移动并即时切换', async () => {
    stub()
    mount()
    screen.getByTestId('proj-segment-tab-clients').focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(screen.getByTestId('proj-segment-tab-tests')).toHaveAttribute('aria-selected', 'true')
    await screen.findByTestId('proj-tests-table')
  })
})

describe('项目页 · 套件表', () => {
  it('列：图标 + 名称（label，缺省 id）· 工具 · 最近结果 · 不稳定数；没有记录的套件是破折号', async () => {
    stub()
    mount()
    await openTests()
    await screen.findByTestId('proj-tests-table')
    expect(within(screen.getByTestId('proj-tests-head')).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['名称', '工具', '最近结果', '不稳定'])
    expect(within(screen.getByTestId('proj-tests-table')).getAllByRole('row').slice(1).map((row) => within(row).getByRole('button').textContent)).toEqual(['前端单测', '浏览器 e2e', '接口基准', 'types'])
    expect(screen.getByTestId('proj-suite-open-types')).toHaveAttribute('title', 'types')
    expect(screen.getByTestId('proj-suite-web-e2e').textContent).toContain('playwright')
    expect(screen.getByTestId('proj-suite-result-web-unit').textContent).toBe('通过')
    expect(screen.getByTestId('proj-suite-result-web-e2e').textContent).toBe('失败')
    expect(screen.getByTestId('proj-suite-result-web-e2e').querySelector('[data-tone="blocked"]')).toBeTruthy()
    expect(screen.getByTestId('proj-suite-flaky-web-e2e').textContent).toBe('1')
    expect(screen.getByTestId('proj-suite-flaky-web-unit').textContent).toBe('0')
    expect(screen.getByTestId('proj-suite-result-api-bench').textContent).toBe('—')
    expect(screen.getByTestId('proj-suite-flaky-api-bench').textContent).toBe('—')
  })

  it('每个套件显示所属测试类（旧种类名按类归并）：图标 + 类名，标识放 Tooltip', async () => {
    stub()
    mount()
    await openTests()
    await screen.findByTestId('proj-tests-table')
    const classOf = (id: string): [string | null, string | null] => {
      const cell = screen.getByTestId(`proj-suite-kind-${id}`)
      return [cell.getAttribute('data-kind'), cell.textContent]
    }
    expect(classOf('web-unit')).toEqual(['unit', '单测'])
    expect(classOf('web-e2e')).toEqual(['e2e', '端到端'])
    expect(classOf('api-bench')).toEqual(['benchmark', '基准'])
    expect(classOf('types')).toEqual(['static', '静态'])
    expect(screen.getByTestId('proj-suite-kind-web-unit').querySelector('svg')).toHaveAttribute('data-kind', 'unit')
  })

  it('「不稳定」整列都是 0 / 没有记录时不出这一列（只剩名称 · 工具 · 最近结果）；有一个非零就整列出现', async () => {
    const quiet = catalogResponse()
    stub({ catalog: { ...quiet, latest: quiet.latest.map((run) => ({ ...run, totals: { ...run.totals, flaky: 0 } })) } })
    const view = mount()
    await openTests()
    const head = await screen.findByTestId('proj-tests-head')
    expect(within(head).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['名称', '工具', '最近结果'])
    expect(screen.queryByTestId('proj-suite-flaky-web-unit')).toBeNull()
    expect(/grid-cols-\[([^\]]+)\]/u.exec(head.className)?.[1]?.split('_')).toEqual(['minmax(0,1fr)', '5.5rem', '5.5rem'])
    expect(screen.getByTestId('proj-suite-web-e2e').className).toContain('grid-cols-[minmax(0,1fr)_5.5rem_5.5rem]')
    view.unmount()
    vi.unstubAllGlobals()
    stub()
    mount()
    await openTests()
    expect(within(await screen.findByTestId('proj-tests-head')).getAllByRole('columnheader')).toHaveLength(4)
    // 非零用正文色，0 与破折号退成 text-3。
    expect(screen.getByTestId('proj-suite-flaky-web-e2e').className).toContain('text-text')
    expect(screen.getByTestId('proj-suite-flaky-web-unit').className).toContain('text-text-3')
  })

  it('表不是卡片：无 ul / li，行为 grid 单行不折行，名称截断', async () => {
    stub()
    mount()
    await openTests()
    const table = await screen.findByTestId('proj-tests-table')
    expect(table.querySelector('ul, li')).toBeNull()
    const row = screen.getByTestId('proj-suite-web-unit')
    expect(row.className).toContain('whitespace-nowrap')
    expect(row.className).not.toMatch(/rounded-md|bg-card/)
    expect(screen.getByTestId('proj-suite-open-web-unit').className).toContain('truncate')
  })

  it('工具列固定宽，放得下 playwright（不再被挤成 vit…）；名称格吃剩余宽度', async () => {
    stub()
    mount()
    await openTests()
    const head = await screen.findByTestId('proj-tests-head')
    const columns = /grid-cols-\[([^\]]+)\]/u.exec(head.className)?.[1]?.split('_') ?? []
    expect(columns).toEqual(['minmax(0,1fr)', '5.5rem', '5.5rem', '3.5rem'])
    expect(screen.getByTestId('proj-suite-web-e2e').className).toContain(head.className.match(/grid-cols-\[[^\]]+\]/u)?.[0] ?? 'missing')
  })

  it('默认选中第一个套件（右列不留空）；点行或名称切换，选中态用共享的列表选中类', async () => {
    stub()
    mount()
    await openTests()
    await screen.findByTestId('proj-suite-title')
    expect(screen.getByTestId('proj-suite-web-unit')).toHaveAttribute('aria-current', 'true')
    expect(screen.getByTestId('proj-suite-title').textContent).toBe('前端单测')
    await userEvent.click(screen.getByTestId('proj-suite-web-e2e'))
    expect(screen.getByTestId('proj-suite-web-e2e')).toHaveAttribute('aria-current', 'true')
    expect(screen.getByTestId('proj-suite-title').textContent).toBe('浏览器 e2e')
    await userEvent.click(screen.getByTestId('proj-suite-open-types'))
    expect(screen.getByTestId('proj-suite-title').textContent).toBe('types')
  })
})

describe('项目页 · 套件详情', () => {
  it('定义行：命令可复制、目录、超时、报告格式与路径、覆盖率报告；只写有值的行', async () => {
    const write = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true })
    stub()
    mount()
    await openTests()
    await screen.findByTestId('proj-suite-title')
    expect(screen.getByTestId('proj-suite-command-text').textContent).toContain('npx vitest run')
    // 命令框不撑破右列：截断 + 全文在 title，复制钮始终可见；外层网格轨道是 minmax(0,1fr)。
    expect(screen.getByTestId('proj-suite-command-text').className).toContain('truncate')
    expect(screen.getByTestId('proj-suite-command-text')).toHaveAttribute('title', expect.stringContaining('npx vitest run'))
    expect(screen.getByTestId('proj-suite-command-copy')).toBeVisible()
    expect(screen.getByTestId('proj-suite-command').closest('.py-1')?.parentElement?.parentElement?.className).toContain('grid-cols-[minmax(0,1fr)]')
    await userEvent.click(screen.getByTestId('proj-suite-command-copy'))
    expect(write).toHaveBeenCalledWith(expect.stringContaining('npx vitest run'))
    expect(screen.getByTestId('proj-suite-cwd').textContent).toContain('packages/dashboard-app')
    expect(screen.getByTestId('proj-suite-timeout').textContent).toContain('900s')
    expect(screen.getByTestId('proj-suite-report').textContent).toContain('junit · test-results/web-unit.xml')
    expect(screen.getByTestId('proj-suite-coverage').textContent).toContain('istanbul-summary · coverage/coverage-summary.json')
    expect(screen.queryByTestId('proj-suite-services')).toBeNull()
    expect(screen.queryByTestId('proj-suite-browsers')).toBeNull()
    expect(screen.queryByTestId('proj-suite-retries')).toBeNull()
    expect(screen.getByTestId('proj-suite-tags').textContent).toContain('web')
  })

  it('服务、浏览器、重试：服务 id 上的就绪探测说明在 Tooltip（键盘可达）', async () => {
    stub()
    mount()
    await openTests()
    await userEvent.click(await screen.findByTestId('proj-suite-web-e2e'))
    expect(screen.getByTestId('proj-suite-browsers').textContent).toContain('chromium · webkit')
    expect(screen.getByTestId('proj-suite-retries').textContent).toContain('2')
    screen.getByTestId('proj-service-web-dev').focus()
    expect((await screen.findAllByText('url http://127.0.0.1:5178/ · 60s')).length).toBeGreaterThan(0)
  })

  it('所属测试类是一行定义（类名）', async () => {
    stub()
    mount()
    await openTests()
    await screen.findByTestId('proj-suite-title')
    expect(screen.getByTestId('proj-suite-class').textContent).toContain('单测')
    await userEvent.click(screen.getByTestId('proj-suite-web-e2e'))
    expect(screen.getByTestId('proj-suite-class').textContent).toContain('端到端')
  })

  it('覆盖率门槛来自档位定义：声明了覆盖率报告、且所属类被某档要求或碰到才跑的套件取各档最高值，来源档位在 Tooltip；其余是破折号', async () => {
    stub()
    mount()
    await openTests()
    await screen.findByTestId('proj-suite-title')
    expect(screen.getByTestId('proj-suite-thresholds-value').textContent).toBe('行 80% · 分支 60%')
    screen.getByTestId('proj-suite-thresholds-value').focus()
    expect((await screen.findAllByText('全量: 行 80% · 分支 60%')).length).toBeGreaterThan(0)
    await userEvent.click(screen.getByTestId('proj-suite-web-e2e'))
    expect(screen.getByTestId('proj-suite-thresholds').textContent).toContain('—')
    expect(screen.queryByTestId('proj-suite-thresholds-value')).toBeNull()
    await userEvent.click(screen.getByTestId('proj-suite-api-bench'))
    expect(screen.queryByTestId('proj-suite-thresholds-value')).toBeNull()
  })

  it('目录没写门槛（三档都是内建缺省）：门槛是破折号', async () => {
    stub({ catalog: withLevels(defaultLevels()) })
    mount()
    await openTests()
    await screen.findByTestId('proj-suite-title')
    expect(screen.getByTestId('proj-suite-thresholds').textContent).toContain('—')
  })

  it('项目页不再读工作流：覆盖率门槛不依赖 default 工作流', async () => {
    const calls = stub()
    mount()
    await openTests()
    await screen.findByTestId('proj-suite-title')
    expect(calls.some((url) => url.startsWith('/api/workflows'))).toBe(false)
  })
})

function withLevels(levels: CatalogLevel[]): TestCatalogResponse {
  const response = catalogResponse()
  if (response.catalog.state !== 'ok') throw new Error('fixture catalog not ok')
  return { ...response, catalog: { ...response.catalog, levels } }
}

describe('项目页 · 档位定义', () => {
  it('三档各一行（写计划 · 跑改动 · 全量）：必需类、碰到才跑的类、门槛；类用图标 + 类名，标识放 Tooltip', async () => {
    stub()
    mount()
    await openTests()
    const section = await screen.findByTestId('proj-levels')
    expect(within(section).getByRole('heading').textContent).toBe('档位')
    const table = within(section).getByRole('table')
    expect(within(table).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['档位', '必需', '碰到才跑', '门槛'])
    expect(within(table).getAllByRole('row').slice(1).map((row) => row.getAttribute('data-testid'))).toEqual(['proj-level-plan', 'proj-level-changed', 'proj-level-full'])
    const classes = (id: string, column: 'required' | 'touched'): string[] =>
      [...screen.getByTestId(`proj-level-${id}-${column}`).querySelectorAll('[data-kind]')]
        .filter((element) => element.tagName === 'SPAN').map((element) => element.getAttribute('data-kind') ?? '')
    expect(classes('plan', 'required')).toEqual(['unit'])
    expect(classes('plan', 'touched')).toEqual([])
    expect(classes('changed', 'touched')).toEqual(['static'])
    expect(classes('full', 'required')).toEqual(['unit'])
    expect(classes('full', 'touched')).toEqual(['integration', 'e2e', 'static', 'benchmark'])
    expect(screen.getByTestId('proj-level-plan-touched').textContent).toBe('—')
    expect(screen.getByTestId('proj-level-full-touched').textContent).toBe('集成端到端静态基准')
  })

  it('标出来自目录还是内建缺省：目录写了的那一档是「目录」，其余是「内建缺省」', async () => {
    stub()
    mount()
    await openTests()
    await screen.findByTestId('proj-levels')
    const source = (id: string): [string | null, string | null] => {
      const element = screen.getByTestId(`proj-level-${id}-source`)
      return [element.getAttribute('data-source'), element.textContent]
    }
    expect(source('plan')).toEqual(['default', '内建缺省'])
    expect(source('changed')).toEqual(['default', '内建缺省'])
    expect(source('full')).toEqual(['catalog', '目录'])
  })

  it('目录没写 levels：三档都显示缺省并标「内建缺省」，门槛是破折号', async () => {
    stub({ catalog: withLevels(defaultLevels()) })
    mount()
    await openTests()
    await screen.findByTestId('proj-levels')
    for (const id of ['plan', 'changed', 'full']) {
      expect(screen.getByTestId(`proj-level-${id}-source`).textContent).toBe('内建缺省')
      expect(screen.getByTestId(`proj-level-${id}-thresholds`).textContent).toBe('—')
    }
  })

  it('门槛一格：覆盖率各项 · 不稳定上限 · 基线 · 场景，完整内容在 title；不折行、截断', async () => {
    stub()
    mount()
    await openTests()
    await screen.findByTestId('proj-levels')
    const cell = screen.getByTestId('proj-level-full-thresholds')
    expect(cell.textContent).toBe('行 80% · 分支 60% · 不稳定 ≤ 2 · 基线 · 场景映射')
    expect(cell).toHaveAttribute('title', '行 80% · 分支 60% · 不稳定 ≤ 2 · 基线 · 场景映射')
    expect(cell.className).toContain('truncate')
    expect(screen.getByTestId('proj-level-full').className).toContain('whitespace-nowrap')
  })

  it('场景要求通过显示「场景通过」', async () => {
    const levels = defaultLevels().map((level) => (level.name === 'changed' ? { ...level, scenarios: 'passing' as const, source: 'catalog' as const } : level))
    stub({ catalog: withLevels(levels) })
    mount()
    await openTests()
    await screen.findByTestId('proj-levels')
    expect(screen.getByTestId('proj-level-changed-thresholds').textContent).toBe('场景通过')
  })

  it('没有目录、目录无效、没有套件：不出档位定义', async () => {
    stub({ catalog: { catalog: { state: 'missing' }, knownFailures: { state: 'missing' }, latest: [] } })
    mount()
    await openTests()
    await screen.findByTestId('proj-tests-empty')
    expect(screen.queryByTestId('proj-levels')).toBeNull()
  })

  it('页面上没有说明句子', async () => {
    stub()
    mount()
    await openTests()
    const section = await screen.findByTestId('proj-levels')
    expect(section.textContent).not.toContain('。')
  })

  it('档位定义所在的文件只是标题旁图标的 Tooltip（键盘聚焦即可读到），不写成页面上的句子', async () => {
    stub()
    mount()
    await openTests()
    const section = await screen.findByTestId('proj-levels')
    expect(section.textContent).not.toContain('catalog.yaml')
    const hint = screen.getByTestId('proj-levels-file')
    expect(hint).toHaveAccessibleName('档位定义: .tenon/tests/catalog.yaml')
    hint.focus()
    expect((await screen.findAllByText('.tenon/tests/catalog.yaml')).length).toBeGreaterThan(0)
  })

  it('每个格子不折行：档位行 nowrap，类图标一排，不用 flex-wrap', async () => {
    stub()
    mount()
    await openTests()
    const section = await screen.findByTestId('proj-levels')
    for (const id of ['plan', 'changed', 'full']) {
      expect(screen.getByTestId(`proj-level-${id}`).className).toContain('whitespace-nowrap')
      expect(screen.getByTestId(`proj-level-${id}-touched`).className).toContain('flex-nowrap')
    }
    expect(section.innerHTML).not.toContain('flex-wrap')
  })
})

describe('项目页 · 基线', () => {
  it('只给声明了基准的套件；每个画像每个指标一行，走势折线从旧到新、当前值在右端', async () => {
    const calls = stub()
    mount()
    await openTests()
    await screen.findByTestId('proj-suite-title')
    expect(screen.queryByTestId('proj-baselines')).toBeNull()
    expect(calls.some((url) => url.startsWith('/api/tests/baselines'))).toBe(false)
    await userEvent.click(screen.getByTestId('proj-suite-api-bench'))
    await screen.findByTestId('proj-baselines')
    expect(calls).toContain('/api/tests/baselines?root=%2Frepo&suite=api-bench')
    const row = screen.getByTestId('proj-baseline-darwin-arm64-m3max-node22-1a2b3c4d-p95_ms')
    const cells = within(row).getAllByRole('cell').map((cell) => cell.textContent)
    expect(cells.slice(0, 5)).toEqual(['darwin-arm64-m3max-node22', 'p95_ms', '12 ms', '15', '5'])
    const chart = screen.getByTestId('proj-baseline-chart-darwin-arm64-m3max-node22-1a2b3c4d-p95_ms')
    expect(chart).toHaveAttribute('role', 'img')
    expect(chart).toHaveAttribute('data-points', '3')
    expect(chart.getAttribute('aria-label')).toBe('p95_ms 13 → 12')
    const line = screen.getByTestId('proj-baseline-chart-darwin-arm64-m3max-node22-1a2b3c4d-p95_ms-line').getAttribute('points') ?? ''
    const xs = line.split(' ').map((pair) => Number(pair.split(',')[0]))
    expect(xs).toEqual([...xs].sort((a, b) => a - b))
    expect(screen.getByTestId('proj-baseline-chart-darwin-arm64-m3max-node22-1a2b3c4d-p95_ms-current')).toBeInTheDocument()
  })

  it('基线文件损坏：一行错误带个数；没有任何基线也没有损坏则整段不出现；读取失败给一行错误', async () => {
    stub({ baselines: { suite: 'api-bench', baselines: [], corrupt: ['a', 'b'] } })
    mount()
    await openTests()
    await userEvent.click(await screen.findByTestId('proj-suite-api-bench'))
    expect((await screen.findByTestId('proj-baselines-corrupt')).textContent).toBe('基线文件损坏 2')
  })

  it('没有基线数据：整段不出现', async () => {
    stub({ baselines: { suite: 'api-bench', baselines: [], corrupt: [] } })
    mount()
    await openTests()
    await userEvent.click(await screen.findByTestId('proj-suite-api-bench'))
    await waitFor(() => expect(screen.queryByTestId('proj-baselines')).toBeNull())
  })

  it('基线读取失败：段内一行错误', async () => {
    stub({ baselines: { status: 500 } })
    mount()
    await openTests()
    await userEvent.click(await screen.findByTestId('proj-suite-api-bench'))
    expect((await screen.findByTestId('proj-baselines-error')).getAttribute('role')).toBe('alert')
  })
})

describe('项目页 · 已知失败', () => {
  it('本套件的条目：用例 · 原因 · 链接 · 到期；过期用红点 + 「过期」；别的套件的条目不出现', async () => {
    stub()
    mount()
    await openTests()
    await screen.findByTestId('proj-suite-title')
    const unit = screen.getByTestId('proj-known')
    expect(within(unit).getAllByRole('row')).toHaveLength(2)
    const expired = screen.getByTestId('proj-known-expired-src/a.test.ts › 旧用例')
    expect(expired.textContent).toBe('过期')
    expect(expired).toHaveAttribute('data-tone', 'blocked')
    expect(within(unit).queryByText('e2e/login.spec.ts › 慢速网络')).toBeNull()
    await userEvent.click(screen.getByTestId('proj-suite-web-e2e'))
    const link = within(screen.getByTestId('proj-known')).getByRole('link')
    expect(link).toHaveAttribute('href', 'https://example.test/issues/1')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    expect(link).toHaveAttribute('target', '_blank')
    expect(within(screen.getByTestId('proj-known')).getByText('2999-12-31')).toBeInTheDocument()
  })

  it('非 http(s) 链接当纯文本，不做成锚点', async () => {
    const response = catalogResponse()
    const known: KnownFailuresView = {
      state: 'ok',
      entries: [{ suite: 'web-unit', test: 'a.test.ts › x', reason: 'r', link: 'javascript:alert(1)', expires: '2999-12-31', addedBy: 'a', expired: false }],
    }
    stub({ catalog: { ...response, knownFailures: known } })
    mount()
    await openTests()
    await screen.findByTestId('proj-known')
    expect(within(screen.getByTestId('proj-known')).queryByRole('link')).toBeNull()
    expect(within(screen.getByTestId('proj-known')).getByText('javascript:alert(1)').tagName).toBe('SPAN')
  })

  it('清单无法解析：段内一行错误；没有清单或本套件没有条目：整段不出现', async () => {
    stub({ catalog: { ...catalogResponse(), knownFailures: { state: 'invalid', issues: ['known-failures.yaml:2: bad'] } } })
    mount()
    await openTests()
    expect((await screen.findByTestId('proj-known-invalid')).textContent).toBe('已知失败清单无法解析')
    expect(screen.getByTestId('proj-known-invalid')).toHaveAttribute('title', 'known-failures.yaml:2: bad')
  })

  it('没有清单：不出现', async () => {
    stub({ catalog: { ...catalogResponse(), knownFailures: { state: 'missing' } } })
    mount()
    await openTests()
    await screen.findByTestId('proj-suite-title')
    expect(screen.queryByTestId('proj-known')).toBeNull()
  })
})

describe('项目页 · 空态、错误与刷新', () => {
  it('没有目录：只给可复制的发现命令，没有句子；右列留空', async () => {
    const write = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true })
    stub({ catalog: { catalog: { state: 'missing' }, knownFailures: { state: 'missing' }, latest: [] } })
    mount()
    await openTests()
    const empty = await screen.findByTestId('proj-tests-empty')
    expect(empty).toHaveAttribute('aria-label', '还没有测试目录')
    expect(screen.getByTestId('proj-tests-discover-text').textContent).toBe('tenon test discover --write')
    expect(empty.textContent).toBe('tenon test discover --write')
    await userEvent.click(screen.getByTestId('proj-tests-discover-copy'))
    expect(write).toHaveBeenCalledWith('tenon test discover --write')
    expect(screen.getByTestId('proj-suite-empty').textContent).toBe('')
  })

  it('目录无效：逐条问题，一行一个，不折行；没有套件的目录与缺失同样给发现命令', async () => {
    stub({ catalog: { catalog: { state: 'invalid', issues: ['catalog.yaml:3: 缺 kind', 'catalog.yaml:9: id 重复'] }, knownFailures: { state: 'missing' }, latest: [] } })
    mount()
    await openTests()
    const invalid = await screen.findByTestId('proj-tests-invalid')
    expect(invalid.getAttribute('role')).toBe('alert')
    expect(within(invalid).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['catalog.yaml:3: 缺 kind', 'catalog.yaml:9: id 重复'])
    expect(within(invalid).getAllByRole('listitem')[0]?.className).toContain('whitespace-nowrap')
  })

  it('目录里一个套件都没有：同样给发现命令', async () => {
    stub({ catalog: { catalog: { state: 'ok', suites: [], services: [], levels: defaultLevels() }, knownFailures: { state: 'missing' }, latest: [] } })
    mount()
    await openTests()
    expect(await screen.findByTestId('proj-tests-discover')).toBeInTheDocument()
    expect(screen.queryByTestId('proj-levels')).toBeNull()
  })

  it('读取中是骨架', async () => {
    stub({ catalog: 'never' })
    mount()
    await openTests()
    expect(screen.getByTestId('proj-tests-loading')).toBeInTheDocument()
  })

  it('读取失败：一行错误 + 重试；重试重新请求', async () => {
    const calls = stub({ catalog: { status: 500 } })
    mount()
    await openTests()
    const error = await screen.findByTestId('proj-tests-error')
    expect(error.getAttribute('role')).toBe('alert')
    expect(within(error).getByText(/500/u)).toBeInTheDocument()
    const before = calls.filter((url) => url.startsWith('/api/tests/catalog')).length
    await userEvent.click(screen.getByTestId('proj-tests-retry'))
    await waitFor(() => expect(calls.filter((url) => url.startsWith('/api/tests/catalog')).length).toBe(before + 1))
  })

  it('快照版本变化重读目录；版本不变不重读', async () => {
    const calls = stub()
    const view = mount('r1')
    await openTests()
    await screen.findByTestId('proj-tests-table')
    const count = () => calls.filter((url) => url.startsWith('/api/tests/catalog')).length
    expect(count()).toBe(1)
    view.again('r1')
    expect(count()).toBe(1)
    view.again('r2')
    await waitFor(() => expect(count()).toBe(2))
  })
})

describe('纯逻辑', () => {
  describe('suiteThresholds', () => {
    const suite = (over: Partial<CatalogSuite>): CatalogSuite => ({
      id: 's', kind: 'unit', runner: 'vitest', command: 'x', cwd: '.', timeoutS: 1, report: { format: 'junit' },
      services: [], retries: 0, parallel: false, tags: [], browsers: [], ...over,
    })
    const withCoverage = { coverage: { format: 'istanbul-summary', path: 'coverage/c.json' } }
    const level = (name: CatalogLevel['name'], over: Partial<CatalogLevel>): CatalogLevel => ({
      name, required: ['unit'], touched: [], scenarios: 'off', requireBaseline: false, source: 'catalog', ...over,
    })

    it('取各档最高值；来源档位按档名给出；只算声明了覆盖率的档位', () => {
      const levels = [
        level('plan', {}),
        level('changed', { coverage: { lines: 70, changedLines: 90 } }),
        level('full', { coverage: { lines: 85, branches: 60 } }),
      ]
      const found = suiteThresholds(levels, suite(withCoverage))
      expect(found?.highest).toEqual({ lines: 85, branches: 60, changed_lines: 90 })
      expect(found?.sources.map((source) => source.level)).toEqual(['changed', 'full'])
    })

    it('套件所属类不在档位的必需类或碰到才跑的类里：不算；类按旧种类名归并（coverage 属于单测类）', () => {
      const levels = [level('full', { required: ['integration'], touched: ['static'], coverage: { lines: 85 } })]
      expect(suiteThresholds(levels, suite(withCoverage))).toBeNull()
      expect(suiteThresholds(levels, suite({ ...withCoverage, kind: 'typecheck' }))?.highest).toEqual({ lines: 85 })
      expect(suiteThresholds([level('full', { coverage: { lines: 85 } })], suite({ ...withCoverage, kind: 'coverage' }))?.highest).toEqual({ lines: 85 })
    })

    it('没有声明覆盖率报告的套件（种类也不是 coverage）、没有门槛、没有档位：null', () => {
      const levels = [level('full', { coverage: { lines: 85 } })]
      expect(suiteThresholds(levels, suite({}))).toBeNull()
      expect(suiteThresholds(levels, suite({ kind: 'coverage' }))?.highest).toEqual({ lines: 85 })
      expect(suiteThresholds([level('full', {})], suite(withCoverage))).toBeNull()
      expect(suiteThresholds([], suite(withCoverage))).toBeNull()
      expect(suiteThresholds(null, suite(withCoverage))).toBeNull()
    })

    it('五项指标都认：函数、语句同样进最高值；档位没有声明任何指标：不算来源', () => {
      const found = suiteThresholds([level('changed', { coverage: {} }), level('full', { coverage: { functions: 80, statements: 75 } })], suite(withCoverage))
      expect(found?.highest).toEqual({ functions: 80, statements: 75 })
      expect(found?.sources.map((source) => source.level)).toEqual(['full'])
    })
  })

  it('chartPoints：等距、按最小到最大映射；单点居中；全相等居中；空为空', () => {
    expect(chartPoints([])).toEqual([])
    expect(chartPoints([5])).toEqual([{ x: 60, y: 14 }])
    const flat = chartPoints([2, 2, 2])
    expect(flat.map((point) => point.y)).toEqual([14, 14, 14])
    const rising = chartPoints([1, 2, 3])
    expect(rising.map((point) => point.x)).toEqual([3, 60, 117])
    expect(rising[0]?.y).toBeGreaterThan(rising[2]?.y ?? 0)
  })

  it('isSafeLink 只认 http(s)', () => {
    expect(isSafeLink('https://a.test/x')).toBe(true)
    expect(isSafeLink('http://a.test')).toBe(true)
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'ftp://a', '//a.test', 'https://a b']) expect(isSafeLink(bad)).toBe(false)
  })
})
