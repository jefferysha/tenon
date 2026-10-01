import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { I18nProvider } from '../i18n'
import { LibraryView } from './LibraryView'

const UNIT = {
  id: 'unit', label: '单测', source: 'builtin', yaml: 'id: unit\ncommand: npm test\nlabel: 单测\n',
  definition: { id: 'unit', label: '单测', command: 'npm test', timeout_s: 900 },
}
const PLAYWRIGHT = {
  id: 'playwright', label: 'Playwright', source: 'builtin', yaml: '...',
  definition: {
    id: 'playwright', label: 'Playwright', command: 'npx playwright test', timeout_s: 1800,
    outputs: [
      { path: 'playwright-report', kind: 'report', required: false },
      { path: 'test-results', kind: 'trace', required: true },
      { path: 'misc' },
    ],
  },
}
const BENCHMARK = {
  id: 'benchmark', label: '基准', source: 'builtin', yaml: '...',
  definition: {
    id: 'benchmark', label: '基准', command: 'npm run bench', cwd: 'packages/api', timeout_s: 1800, scope: 'known',
    metrics_path: 'test-results/benchmark.json',
    pass: { exit_code: 0, metrics: [{ name: 'p95_ms', max: 250, max_regression_pct: 10, better: 'lower' }, { name: 'rps', min: 100, better: 'higher' }, { name: 'plain' }] },
    outputs: [{ path: 'test-results/benchmark.json', kind: 'metrics', required: true }],
  },
}
const INTEGRATION = {
  id: 'integration', label: '集成', source: 'builtin', yaml: '...',
  definition: {
    id: 'integration', label: '集成', command: 'npm run test:integration', cwd: '.',
    inputs: [{ kind: 'env', name: 'DATABASE_URL' }, { kind: 'service', name: 'database', url: 'http://x' }, { kind: 'file', path: 'seed.sql' }, { kind: 'document', ref: 'plan' }],
  },
}
const CUSTOM = {
  id: 'my tpl', label: '我的', source: 'custom', yaml: '...',
  definition: { id: 'my tpl', label: '我的', command: 'npm run mine' },
}
const ALL = [UNIT, PLAYWRIGHT, BENCHMARK, INTEGRATION, CUSTOM]

function stub(directions: unknown = ALL, status = 200) {
  const calls: string[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input)
    calls.push(url)
    if (url === '/api/test-directions') {
      return status === 200
        ? new Response(JSON.stringify({ ok: true, directions }), { status: 200 })
        : new Response(JSON.stringify({ ok: false, error: 'x' }), { status })
    }
    if (url.startsWith('/api/instruction-templates')) return new Response(JSON.stringify({ ok: true, templates: [], sync: { state: 'unchanged' } }), { status: 200 })
    return new Response(JSON.stringify({ ok: true, templates: [] }), { status: 200 })
  })
  return calls
}

async function open(): Promise<void> {
  render(<I18nProvider><TooltipProvider><LibraryView /></TooltipProvider></I18nProvider>)
  await userEvent.click(screen.getByTestId('lib-section-test-templates'))
}

afterEach(() => {
  vi.restoreAllMocks()
  delete window.__TENON_DASHBOARD_TOKEN__
})

describe('库 · 测试模板', () => {
  it('左列条目叫「测试模板」并带计数；不再有「测试方向」字样', async () => {
    stub()
    render(<I18nProvider><TooltipProvider><LibraryView /></TooltipProvider></I18nProvider>)
    await waitFor(() => expect(screen.getByTestId('lib-section-test-templates')).toHaveTextContent('5'))
    expect(screen.getByTestId('lib-section-test-templates')).toHaveTextContent('测试模板')
    await userEvent.click(screen.getByTestId('lib-section-test-templates'))
    expect(screen.getByRole('heading', { level: 1, name: '测试模板' })).toBeInTheDocument()
    expect(document.body.textContent ?? '').not.toContain('测试方向')
    expect(screen.getByTestId('library-list-search')).toHaveAttribute('placeholder', '搜索测试模板')
  })

  it('列表行只显示名称，标识在悬停提示里；只有自定义行带标记', async () => {
    stub()
    await open()
    await screen.findByTestId('lib-tt-unit')
    expect(screen.getByTestId('lib-tt-unit').textContent).toBe('单测')
    expect(screen.getByTestId('lib-tt-unit')).toHaveAttribute('title', 'unit')
    expect(screen.queryByTestId('lib-tt-mark-unit')).toBeNull()
    expect(screen.getByTestId('lib-tt-mark-my tpl')).toHaveTextContent('自定义')
  })

  it('右列不留空：没选中时打开第一行；显式选中的保持，被搜索筛掉后换成列表第一行', async () => {
    stub()
    await open()
    await waitFor(() => expect(screen.getByTestId('lib-tt-title')).toHaveTextContent(/^单测$/u))
    expect(screen.getByTestId('lib-tt-unit')).toHaveAttribute('aria-current', 'true')
    await userEvent.click(screen.getByTestId('lib-tt-benchmark'))
    expect(screen.getByTestId('lib-tt-title')).toHaveTextContent(/^基准$/u)
    await userEvent.type(screen.getByTestId('library-list-search'), '集成')
    await waitFor(() => expect(screen.getByTestId('lib-tt-title')).toHaveTextContent(/^集成$/u))
    expect(screen.queryByTestId('lib-tt-unit')).toBeNull()
  })
})

describe('库 · 测试模板 · 结构化只读字段', () => {
  it('只有模板真有的字段：unit 只有 种类 · 命令 · 超时', async () => {
    stub()
    await open()
    await screen.findByTestId('lib-tt-fields')
    expect(screen.getByTestId('lib-tt-field-kind').textContent).toBe('种类单测')
    expect(screen.getByTestId('lib-tt-field-kind').querySelector('svg')).toHaveAttribute('data-kind', 'unit')
    expect(screen.getByTestId('lib-tt-field-command').textContent).toContain('npm test')
    expect(screen.getByTestId('lib-tt-field-timeout').textContent).toContain('900s')
    for (const absent of ['cwd', 'scope', 'exit', 'metrics-path']) expect(screen.queryByTestId(`lib-tt-field-${absent}`)).toBeNull()
    for (const absent of ['lib-tt-inputs', 'lib-tt-outputs', 'lib-tt-metrics']) expect(screen.queryByTestId(absent)).toBeNull()
  })

  it('playwright：输出表 路径 · 类型 · 必须/可选；缺省类型显示「其它」、缺省 required 为必须', async () => {
    stub()
    await open()
    await userEvent.click(await screen.findByTestId('lib-tt-playwright'))
    expect(screen.getByTestId('lib-tt-field-kind').textContent).toBe('种类Playwright')
    const rows = within(screen.getByTestId('lib-tt-outputs')).getAllByTestId('lib-tt-output')
    expect(rows.map((row) => within(row).getAllByRole('cell').map((cell) => cell.textContent))).toEqual([
      ['playwright-report', '报告', '可选'],
      ['test-results', 'trace', '必须'],
      ['misc', '其它', '必须'],
    ])
  })

  it('benchmark：目录 · 范围 · 退出码 · 指标文件，指标表带上限 / 下限 / 退化 % / 方向', async () => {
    stub()
    await open()
    await userEvent.click(await screen.findByTestId('lib-tt-benchmark'))
    expect(screen.getByTestId('lib-tt-field-cwd').textContent).toContain('packages/api')
    expect(screen.getByTestId('lib-tt-field-scope').textContent).toContain('已知失败')
    expect(screen.getByTestId('lib-tt-field-exit').textContent).toContain('0')
    expect(screen.getByTestId('lib-tt-field-metrics-path').textContent).toContain('test-results/benchmark.json')
    const metrics = within(screen.getByTestId('lib-tt-metrics')).getAllByTestId('lib-tt-metric')
    expect(metrics.map((row) => within(row).getAllByRole('cell').map((cell) => cell.textContent))).toEqual([
      ['p95_ms', '250', '—', '10%', '越低越好'],
      ['rps', '—', '100', '—', '越高越好'],
      ['plain', '—', '—', '—', '—'],
    ])
  })

  it('integration：输入表 类型 · 值；目录为 . 时不显示', async () => {
    stub()
    await open()
    await userEvent.click(await screen.findByTestId('lib-tt-integration'))
    expect(screen.queryByTestId('lib-tt-field-cwd')).toBeNull()
    const rows = within(screen.getByTestId('lib-tt-inputs')).getAllByTestId('lib-tt-input')
    expect(rows.map((row) => within(row).getAllByRole('cell').map((cell) => cell.textContent))).toEqual([
      ['环境变量', 'DATABASE_URL'], ['服务', 'database'], ['文件', 'seed.sql'], ['文档', 'plan'],
    ])
  })

  it('全程只读：详情里没有 YAML、文本框、保存、删除、复制为自定义、新建入口', async () => {
    stub()
    window.__TENON_DASHBOARD_TOKEN__ = 'tok'
    await open()
    for (const id of ['unit', 'playwright', 'benchmark', 'my tpl']) {
      await userEvent.click(await screen.findByTestId(`lib-tt-${id}`))
      const detail = screen.getByTestId('library-test-template-detail')
      expect(detail.querySelector('textarea, pre, details, input')).toBeNull()
      expect(within(detail).queryByRole('button', { name: /保存|删除|复制为自定义|更多/u })).toBeNull()
    }
    expect(screen.queryByText('YAML')).toBeNull()
    expect(screen.queryByTestId('lib-dir-new')).toBeNull()
    expect(screen.queryByTestId('lib-tt-new')).toBeNull()
  })

  it('命令行紧跟标题：tenon test catalog add --from <id>，可复制；标识含空格时被引用', async () => {
    const write = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true })
    stub()
    await open()
    await userEvent.click(await screen.findByTestId('lib-tt-playwright'))
    expect(screen.getByTestId('lib-tt-add-text').textContent).toBe('tenon test catalog add --from playwright')
    await userEvent.click(screen.getByTestId('lib-tt-add-copy'))
    expect(write).toHaveBeenCalledWith('tenon test catalog add --from playwright')
    await userEvent.click(screen.getByTestId('lib-tt-my tpl'))
    expect(screen.getByTestId('lib-tt-add-text').textContent).toBe("tenon test catalog add --from 'my tpl'")
    expect(screen.getByTestId('lib-tt-custom')).toHaveTextContent('自定义')
    const header = screen.getByTestId('lib-tt-header')
    expect(header.compareDocumentPosition(screen.getByTestId('lib-tt-add')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('未知种类的模板（自定义 id）归 custom 种类', async () => {
    stub()
    await open()
    await userEvent.click(await screen.findByTestId('lib-tt-my tpl'))
    expect(screen.getByTestId('lib-tt-field-kind').textContent).toBe('种类自定义')
  })

  it('值不折行：字段值截断、表格单元 nowrap', async () => {
    stub()
    await open()
    await userEvent.click(await screen.findByTestId('lib-tt-playwright'))
    expect(screen.getByTestId('lib-tt-field-command').lastElementChild?.className).toContain('truncate')
    expect(within(screen.getAllByTestId('lib-tt-output')[0] as HTMLElement).getAllByRole('cell')[0]?.className).toContain('truncate')
    expect((screen.getAllByTestId('lib-tt-output')[0] as HTMLElement).className).toContain('whitespace-nowrap')
  })
})

describe('库 · 测试模板 · 状态', () => {
  it('列表为空：详情保留空态，不写字，可访问名称说的是测试模板', async () => {
    stub([])
    await open()
    const empty = await screen.findByTestId('lib-tt-empty')
    await waitFor(() => expect(screen.queryByTestId('lib-tt-loading')).toBeNull())
    expect(empty).toHaveTextContent(/^$/u)
    expect(empty).toHaveAttribute('aria-label', '选择测试模板')
  })

  it('读取中是骨架，读取失败是一行错误 + 重试（重试重新请求）', async () => {
    const calls = stub(ALL, 500)
    await open()
    const error = await screen.findByTestId('lib-tt-error')
    expect(within(error).getByRole('alert')).toBeInTheDocument()
    const before = calls.filter((url) => url === '/api/test-directions').length
    await userEvent.click(screen.getByTestId('lib-tt-retry'))
    await waitFor(() => expect(calls.filter((url) => url === '/api/test-directions').length).toBe(before + 1))
  })
})

describe('库 · 测试模板 · 内置名字按界面语言显示', () => {
  afterEach(() => window.localStorage.clear())

  it('英文：出厂名没被改过的内置模板显示英文（列表与右列标题）；自定义模板与改过名的内置模板原样', async () => {
    window.localStorage.setItem('tenon-dashboard-lang', 'en')
    stub([UNIT, { ...BENCHMARK, label: '性能（自改）' }, CUSTOM, { id: 'regression', label: '回归', source: 'custom', yaml: '...', definition: { id: 'regression', label: '回归', command: 'npm test' } }])
    await open()
    await screen.findByTestId('lib-tt-unit')
    expect(screen.getByTestId('lib-tt-unit').textContent).toBe('Unit')
    expect(screen.getByTestId('lib-tt-benchmark').textContent).toBe('性能（自改）')
    expect(screen.getByTestId('lib-tt-my tpl').textContent).toContain('我的')
    // 自定义的同 id 模板是用户的东西，不翻译。
    expect(screen.getByTestId('lib-tt-regression').textContent).toContain('回归')
    await waitFor(() => expect(screen.getByTestId('lib-tt-title')).toHaveTextContent(/^Unit$/u))
  })

  it('中文：不变', async () => {
    stub()
    await open()
    await screen.findByTestId('lib-tt-unit')
    expect(screen.getByTestId('lib-tt-unit').textContent).toBe('单测')
  })
})
