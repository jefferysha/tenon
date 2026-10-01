import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { WbStepDef, WbWorkflowDef } from '../api/governanceTypes'
import { baselinesResponse, catalogResponse } from '../api/testSystemFixtures'
import type { KnownFailuresView, SuiteBaselinesResponse, TestCatalogResponse } from '../api/testSystemTypes'
import { I18nProvider } from '../i18n'
import { chartPoints } from './HistoryChart'
import { ProjectsView } from './ProjectsView'
import { isSafeLink } from './SuiteKnownFailures'
import { suiteThresholds } from './suiteThresholds'

const PROJECTS = [{ root: '/repo', name: 'repo', count: 1, ok: true }]

function step(id: string, label: string, policy: WbStepDef['test_policy']): WbStepDef {
  return { id, label, gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [], ...(policy === undefined ? {} : { test_policy: policy }) }
}

const DEFAULT_WORKFLOW: WbWorkflowDef = {
  name: 'default',
  steps: [],
  tracks: {
    backend: { steps: [step('build', '实现', { run: ['unit'], coverage: { lines: 70 } }), step('verify', '验证', { run: ['unit', 'regression'], coverage: { lines: 80, branches: 60 } })] },
    frontend: { steps: [step('verify', '验证', { kinds: ['unit', 'playwright'], coverage: { lines: 85, changed_lines: 90 } })] },
  },
}

interface Api {
  catalog?: TestCatalogResponse | { status: number } | 'never'
  baselines?: SuiteBaselinesResponse | { status: number }
  workflow?: WbWorkflowDef | { status: number }
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
    if (url.startsWith('/api/workflows/default')) {
      const value = api.workflow ?? DEFAULT_WORKFLOW
      return 'status' in value ? json({ ok: false, error: 'x' }, value.status) : json(value)
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
    expect(screen.getByTestId('proj-suite-kind-web-unit').querySelector('svg')).toHaveAttribute('data-kind', 'unit')
    expect(screen.getByTestId('proj-suite-kind-web-e2e').textContent).toBe('Playwright')
    expect(screen.getByTestId('proj-suite-kind-web-e2e')).toHaveAttribute('data-kind', 'playwright')
    expect(screen.getByTestId('proj-suite-web-e2e').textContent).toContain('playwright')
    expect(screen.getByTestId('proj-suite-result-web-unit').textContent).toBe('通过')
    expect(screen.getByTestId('proj-suite-result-web-e2e').textContent).toBe('失败')
    expect(screen.getByTestId('proj-suite-result-web-e2e').querySelector('[data-tone="blocked"]')).toBeTruthy()
    expect(screen.getByTestId('proj-suite-flaky-web-e2e').textContent).toBe('1')
    expect(screen.getByTestId('proj-suite-flaky-web-unit').textContent).toBe('0')
    expect(screen.getByTestId('proj-suite-result-api-bench').textContent).toBe('—')
    expect(screen.getByTestId('proj-suite-flaky-api-bench').textContent).toBe('—')
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

  it('覆盖率门槛来自 default 工作流各阶段的策略：取最高值，来源阶段在 Tooltip；没有要求这个种类的阶段是破折号', async () => {
    stub()
    mount()
    await openTests()
    await screen.findByTestId('proj-suite-title')
    await waitFor(() => expect(screen.getByTestId('proj-suite-thresholds-value').textContent).toBe('行 85% · 分支 60% · 变更行 90%'))
    screen.getByTestId('proj-suite-thresholds-value').focus()
    expect((await screen.findAllByText(/实现: 行 70% \| 验证: 行 80% · 分支 60% \| 验证: 行 85% · 变更行 90%/u)).length).toBeGreaterThan(0)
    await userEvent.click(screen.getByTestId('proj-suite-web-e2e'))
    await waitFor(() => expect(screen.getByTestId('proj-suite-thresholds-value').textContent).toBe('行 85% · 变更行 90%'))
    await userEvent.click(screen.getByTestId('proj-suite-api-bench'))
    expect(screen.getByTestId('proj-suite-thresholds').textContent).toContain('—')
    expect(screen.queryByTestId('proj-suite-thresholds-value')).toBeNull()
  })

  it('default 工作流读不到：门槛是破折号，页面其余照常', async () => {
    stub({ workflow: { status: 500 } })
    mount()
    await openTests()
    await screen.findByTestId('proj-suite-title')
    expect(screen.getByTestId('proj-suite-thresholds').textContent).toContain('—')
    expect(screen.getByTestId('proj-suite-command')).toBeInTheDocument()
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
    stub({ catalog: { catalog: { state: 'ok', suites: [], services: [] }, knownFailures: { state: 'missing' }, latest: [] } })
    mount()
    await openTests()
    expect(await screen.findByTestId('proj-tests-discover')).toBeInTheDocument()
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
  it('suiteThresholds：取各阶段最高值，只算要求过该种类且声明了覆盖率的阶段；没有则 null', () => {
    const found = suiteThresholds(DEFAULT_WORKFLOW, 'unit')
    expect(found?.highest).toEqual({ lines: 85, branches: 60, changed_lines: 90 })
    expect(found?.sources.map((source) => source.stage)).toEqual(['实现', '验证', '验证'])
    expect(suiteThresholds(DEFAULT_WORKFLOW, 'benchmark')).toBeNull()
    expect(suiteThresholds(null, 'unit')).toBeNull()
    expect(suiteThresholds({ name: 'x', steps: [step('a', 'A', { run: ['unit'] })] }, 'unit')).toBeNull()
    const duplicated: WbWorkflowDef = { name: 'x', steps: [step('a', 'A', { run: ['unit'], coverage: { lines: 80 } })], tracks: { t: { steps: [step('a', 'A', { run: ['unit'], coverage: { lines: 80 } })] } } }
    expect(suiteThresholds(duplicated, 'unit')?.sources).toHaveLength(1)
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
