import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { I18nProvider } from '../i18n'
import { SuiteRunDrawer, type SuiteRunDrawerProps } from './SuiteRunDrawer'
import {
  FIXTURE_CHANGE, FIXTURE_RUN, FIXTURE_USER, recordDetail, recordList, suiteRun, totals, verdict,
} from '../api/testSystemFixtures'
import type { RecordDetail, SuiteRun } from '../api/testSystemTypes'

const TARGET = { user: FIXTURE_USER, runId: FIXTURE_RUN, suite: 'web-e2e' }
const OTHER_RUN = '20260929T090000Z-abc000'

interface Api {
  record?: RecordDetail | ((run: string) => RecordDetail | Response)
  list?: unknown
  logText?: string
  logFails?: boolean
}

function stub(api: Api = {}) {
  const calls: string[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input)
    calls.push(url)
    if (url.startsWith('/api/tests/record?')) {
      const run = new URL(url, 'http://x').searchParams.get('run') ?? ''
      const value = typeof api.record === 'function' ? api.record(run) : api.record ?? recordDetail()
      if (value instanceof Response) return value
      return new Response(JSON.stringify({ ok: true, record: value }), { status: 200 })
    }
    if (url.startsWith('/api/tests/records?')) {
      if (api.list === null) return new Response('{}', { status: 500 })
      return new Response(JSON.stringify({ ok: true, limit: 50, ...(api.list as object ?? recordList()) }), { status: 200 })
    }
    if (url.startsWith('/api/tests/artifact?')) {
      if (api.logFails === true) return new Response('{}', { status: 404 })
      return new Response(api.logText ?? 'log tail line', { status: 200 })
    }
    return new Response('{}', { status: 404 })
  })
  return calls
}

const mounted: Array<() => void> = []

function mount(props: Partial<SuiteRunDrawerProps> = {}) {
  const onClose = vi.fn()
  const view = render(
    <I18nProvider>
      <TooltipProvider>
        <SuiteRunDrawer root="/repo" change={FIXTURE_CHANGE} target={TARGET} onClose={onClose} {...props} />
      </TooltipProvider>
    </I18nProvider>,
  )
  mounted.push(view.unmount)
  return { ...view, onClose }
}

/** 同一个用例里换一套接口桩重新挂载：先卸载已挂的抽屉，再还原 fetch。 */
function remount(): void {
  for (const unmount of mounted.splice(0)) unmount()
  vi.restoreAllMocks()
}

async function ready(): Promise<void> {
  await screen.findByTestId('run-body')
}

function withRun(over: Partial<SuiteRun>, record: Partial<RecordDetail> = {}): RecordDetail {
  return recordDetail({ ...record, suites: [suiteRun(over)] })
}

afterEach(() => {
  remount()
})

describe('SuiteRunDrawer · 运行', () => {
  it('没有目标不渲染；加载中是骨架', async () => {
    stub()
    const { container } = mount({ target: null })
    expect(container.textContent).toBe('')
    expect(screen.queryByTestId('suite-run-drawer')).toBeNull()
    mount()
    expect(screen.getByTestId('run-loading')).toBeInTheDocument()
    await ready()
    expect(screen.queryByTestId('run-loading')).toBeNull()
  })

  it('标题只显示一个名字（label，缺省用 id）与结果；命令、退出码、耗时、范围、用例合计、原因、机器', async () => {
    stub()
    mount({ verdict: verdict({ suite: 'web-e2e', label: '浏览器 e2e', kind: 'playwright' }) })
    await ready()
    const drawer = screen.getByTestId('suite-run-drawer')
    expect(within(drawer).getAllByText('浏览器 e2e').length).toBeGreaterThan(0)
    expect(within(drawer).getByTitle('web-e2e').textContent).toBe('浏览器 e2e')
    expect(screen.getByTestId('run-result').textContent).toBe('失败')
    expect(screen.getByTestId('run-command-text').textContent).toContain('npx playwright test')
    expect(screen.getByTestId('run-exit').textContent).toContain('1')
    expect(screen.getByTestId('run-duration').textContent).toContain('1m 23s')
    expect(screen.getByTestId('run-scope').textContent).toContain('全量')
    expect(within(screen.getByTestId('run-totals')).getByRole('cell').textContent).toBe('通过 45 · 失败 2 · 不稳定 1')
    expect(screen.getByTestId('run-reason-0').textContent).toContain('失败')
    expect(screen.getByTestId('run-reason-0').textContent).not.toContain('test-failed')
    expect(screen.getByTestId('run-machine').textContent).toContain('darwin-arm64-m3max-node22')
    expect(screen.getByTestId('run-body').textContent ?? '').not.toContain('。')
  })

  it('服务就绪表：耗时、退出词、日志下载；残留进程用危险色', async () => {
    stub({
      record: recordDetail({
        services: [
          { id: 'web-dev', readyMs: 2310, exit: 'stopped', log: 'services/web-dev.log', logPresent: true, leaked: 0 },
          { id: 'db', readyMs: null, exit: 'not-ready', log: null, logPresent: false, leaked: 2 },
        ],
      }),
    })
    mount()
    await ready()
    const ok = screen.getByTestId('run-service-web-dev')
    expect(ok.textContent).toContain('2.3s')
    expect(screen.getByTestId('run-service-exit-web-dev').textContent).toBe('已停止')
    expect(screen.getByTestId('run-service-log-web-dev')).toHaveAttribute('href', expect.stringContaining('path=services%2Fweb-dev.log'))
    expect(screen.getByTestId('run-service-exit-db').textContent).toBe('未就绪')
    expect(screen.getByTestId('run-service-exit-db')).toHaveAttribute('data-tone', 'blocked')
    expect(screen.getByTestId('run-service-leaked-db').textContent).toBe('2')
    expect(within(screen.getByTestId('run-service-db')).getAllByText('—')).toHaveLength(2)
  })

  it('记录不在完好的哈希链上：显示记录被改动的短标签，仍可查看', async () => {
    stub({ record: recordDetail({ trusted: false }) })
    mount()
    await ready()
    expect(screen.getByTestId('run-untrusted').textContent).toBe('记录被改动')
  })
})

describe('SuiteRunDrawer · 失败用例', () => {
  it('内容留住右侧内边距：抽屉主体是 minmax(0,1fr) 单列，命令框截断、每一段的网格轨道也被约束', async () => {
    stub()
    mount()
    await ready()
    expect(screen.getByTestId('run-body').className).toContain('grid-cols-[minmax(0,1fr)]')
    expect(screen.getByTestId('run-command-text').className).toContain('truncate')
    for (const id of ['run-summary', 'run-cases', 'run-artifacts', 'run-log', 'run-history']) {
      const section = screen.queryByTestId(id)
      if (section !== null) expect(section.className).toContain('grid-cols-[minmax(0,1fr)]')
    }
  })

  it('失败在前、不稳定在后；名称含分组路径，位置 file:line，消息取第一行', async () => {
    stub()
    mount()
    await ready()
    const rows = screen.getAllByTestId('run-case')
    expect(rows.map((row) => row.getAttribute('data-status'))).toEqual(['fail', 'fail', 'flaky'])
    expect(within(rows[0] as HTMLElement).getByTestId('run-case-name').textContent).toBe('登录 › 登录成功跳转首页')
    expect(within(rows[0] as HTMLElement).getByTestId('run-case-location').textContent).toBe('e2e/login.spec.ts:12')
    expect(within(rows[0] as HTMLElement).getByTestId('run-case-message').textContent).toBe('expected /home')
    expect(within(rows[2] as HTMLElement).getByTestId('run-case-location').textContent).toBe('e2e/nav.spec.ts')
    for (const cell of screen.getAllByTestId('run-case-name')) expect(cell.className).toContain('truncate')
  })

  it('报告没给文件的用例：位置写「未报告文件」，不把哨兵值 (unknown) 摆上页面（产品评估 P2）', async () => {
    const base = suiteRun().cases[1]!
    stub({ record: withRun({ cases: [{ ...base, file: '(unknown)', line: undefined, name: '结算' }] }) })
    mount()
    await ready()
    const row = screen.getAllByTestId('run-case')[0] as HTMLElement
    expect(within(row).getByTestId('run-case-location').textContent).toBe('未报告文件')
    expect(screen.queryByText('(unknown)')).toBeNull()
  })

  it('展开看堆栈与 expected / actual，以及该用例的产物；键盘可展开与收起', async () => {
    stub()
    mount()
    await ready()
    const toggle = screen.getAllByTestId('run-case-toggle')[0] as HTMLElement
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    toggle.focus()
    await userEvent.keyboard('{Enter}')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('run-case-stack').textContent).toContain('at login.spec.ts:12:5')
    expect(screen.getByTestId('run-case-expected').textContent).toBe('/home')
    expect(screen.getByTestId('run-case-actual').textContent).toBe('/login')
    const links = within(screen.getByTestId('run-case-artifacts'))
    expect(links.getByTestId('run-case-image').textContent).toBe('fail.png')
    expect(links.getAllByTestId('run-case-file').map((link) => link.textContent)).toEqual(['trace.zip', 'video.webm'])
    await userEvent.keyboard('{Enter}')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('run-case-detail')).toBeNull()
  })

  it('没有失败、flaky 或已知失败的用例时不出现这一段；截断给计数徽标', async () => {
    stub({ record: withRun({ cases: [{ ...suiteRun().cases[0]!, status: 'pass' }] }) })
    mount()
    await ready()
    expect(screen.queryByTestId('run-cases')).toBeNull()
  })

  it('用例被截断：段头带 N+ 徽标', async () => {
    stub({ record: withRun({ casesTruncated: true }) })
    mount()
    await ready()
    expect(screen.getByTestId('run-cases-truncated').textContent).toBe('3+')
  })
})

describe('SuiteRunDrawer · 产物', () => {
  it('截图网格只列仍在本机的文件；视频；HTML 报告只作下载，不渲染', async () => {
    stub()
    const { container } = mount()
    await ready()
    const shots = screen.getAllByTestId('run-screenshot')
    expect(shots).toHaveLength(1)
    expect(shots[0]?.querySelector('img')).toHaveAttribute('src', expect.stringContaining('/api/tests/artifact?'))
    expect(shots[0]?.querySelector('img')).toHaveAttribute('alt', 'fail.png')
    expect(screen.queryByText('gone.png')).toBeNull()
    const video = screen.getByTestId('run-video')
    expect(video).toHaveAttribute('src', expect.stringContaining('path=test-results%2Flogin%2Fvideo.webm'))
    expect(video).toHaveAttribute('controls')
    const report = screen.getByTestId('run-report')
    expect(report).toHaveAttribute('data-entry', 'true')
    expect(report.textContent).toContain('index.html · 入口')
    expect(screen.getByTestId('run-report-download-0')).toHaveAttribute('download')
    expect(container.ownerDocument.querySelector('iframe')).toBeNull()
    expect(screen.getByTestId('run-artifacts').innerHTML).not.toContain('<html')
  })

  it('trace：下载链接 + 复制 show-trace 命令（路径含空格时被引用）', async () => {
    const write = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true })
    stub()
    mount({ root: '/my repo/' })
    await ready()
    expect(screen.getByTestId('run-trace-download-0')).toHaveAttribute('href', expect.stringContaining('path=test-results%2Flogin%2Ftrace.zip'))
    const expected = `npx playwright show-trace '/my repo/${recordDetail().artifactsDir}/test-results/login/trace.zip'`
    expect(screen.getByTestId('run-trace-command-0-text').textContent).toBe(expected)
    await userEvent.click(screen.getByTestId('run-trace-command-0-copy'))
    expect(write).toHaveBeenCalledWith(expected)
  })

  it('其它文件超过 50 个只列前 50，其余给 +N；索引截断给徽标；全部缺失时整段消失', async () => {
    const many = Array.from({ length: 53 }, (_, index) => ({ path: `data/${index}.json`, bytes: 10, media: 'json' as const, entry: false, present: true }))
    stub({ record: withRun({ artifacts: many, artifactsTruncated: true }) })
    mount()
    await ready()
    expect(screen.getAllByTestId('run-file')).toHaveLength(50)
    expect(screen.getByTestId('run-files-more').textContent).toBe('+3')
    expect(screen.getByTestId('run-artifacts-truncated').textContent).toBe('53+')
    remount()
    stub({ record: withRun({ artifacts: [{ path: 'a.png', bytes: 1, media: 'image', entry: false, present: false }] }) })
    mount()
    await ready()
    expect(screen.queryByTestId('run-artifacts')).toBeNull()
  })

  it('截图放大：点开、左右键切换、Esc 关闭；焦点回到缩略图', async () => {
    const artifacts = [
      { path: 'shots/a.png', bytes: 1, media: 'image' as const, entry: false, present: true },
      { path: 'shots/b.png', bytes: 1, media: 'image' as const, entry: false, present: true },
    ]
    stub({ record: withRun({ artifacts }) })
    mount()
    await ready()
    const first = screen.getAllByTestId('run-screenshot')[0] as HTMLElement
    await userEvent.click(first)
    const viewer = await screen.findByTestId('run-viewer')
    expect(within(viewer).getByTestId('run-viewer-image')).toHaveAttribute('alt', 'a.png')
    expect(within(viewer).getByTestId('run-viewer-position').textContent).toBe('1 / 2')
    await userEvent.keyboard('{ArrowRight}')
    expect(within(viewer).getByTestId('run-viewer-image')).toHaveAttribute('alt', 'b.png')
    await userEvent.keyboard('{ArrowRight}')
    expect(within(viewer).getByTestId('run-viewer-image')).toHaveAttribute('alt', 'a.png')
    await userEvent.keyboard('{ArrowLeft}')
    expect(within(viewer).getByTestId('run-viewer-image')).toHaveAttribute('alt', 'b.png')
    await userEvent.click(within(viewer).getByTestId('run-viewer-prev'))
    expect(within(viewer).getByTestId('run-viewer-image')).toHaveAttribute('alt', 'a.png')
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByTestId('run-viewer')).toBeNull())
    expect(screen.getByTestId('suite-run-drawer')).toBeInTheDocument()
  })

  it('用例展开里的截图链接同样打开查看器', async () => {
    stub()
    mount()
    await ready()
    await userEvent.click(screen.getAllByTestId('run-case-toggle')[0] as HTMLElement)
    await userEvent.click(screen.getByTestId('run-case-image'))
    expect(await screen.findByTestId('run-viewer')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('run-viewer-close'))
    await waitFor(() => expect(screen.queryByTestId('run-viewer')).toBeNull())
  })
})

describe('SuiteRunDrawer · 覆盖率与基准', () => {
  it('覆盖率对门槛：低于门槛与「要求却没报告」用危险色，达标与无门槛不用', async () => {
    stub({ record: withRun({ coverage: { lines: 78.5, branches: 70, changedLines: 92 } }) })
    mount({ policy: { plan: 'required', kinds: [], run: [], runIfRegistered: [], scope: 'full', files: 'any', scenarios: 'off', requireBaseline: false, browsers: [], coverage: { lines: 80, changedLines: 90, functions: 60 } } })
    await ready()
    expect(screen.getByTestId('run-coverage-lines')).toHaveAttribute('data-below', 'true')
    expect(screen.getByTestId('run-coverage-lines').textContent).toContain('78.5%')
    expect(screen.getByTestId('run-coverage-lines').textContent).toContain('80%')
    expect(screen.getByTestId('run-coverage-branches')).toHaveAttribute('data-below', 'false')
    expect(screen.getByTestId('run-coverage-changedLines')).toHaveAttribute('data-below', 'false')
    expect(screen.getByTestId('run-coverage-functions')).toHaveAttribute('data-below', 'true')
    expect(screen.getByTestId('run-coverage-functions').textContent).toContain('—')
  })

  it('既没有覆盖率也没有门槛：不出现这一段', async () => {
    stub({ record: withRun({ coverage: null }) })
    mount()
    await ready()
    expect(screen.queryByTestId('run-coverage')).toBeNull()
  })

  it('基准：判定对应本次运行时给基线与变化，越限行危险色；判定属于别的运行时不给', async () => {
    const bench = verdict({
      suite: 'web-e2e', runId: FIXTURE_RUN,
      benchmark: [{ name: 'p95_ms', unit: 'ms', better: 'lower', median: 14.2, p95: 17, baseline: 12, deltaPct: 18.3, failed: true, baselineMissing: false, noisy: true, details: ['退化 18.3% > 10%'] }],
    })
    stub()
    mount({ verdict: bench })
    await ready()
    expect(screen.getByTestId('run-metric-baseline-p95_ms').textContent).toBe('12')
    expect(screen.getByTestId('run-metric-delta-p95_ms').textContent).toBe('+18.3%')
    expect(screen.getByTestId('run-metric-p95_ms')).toHaveAttribute('data-failed', 'true')
    expect(screen.getByTestId('run-metric-delta-p95_ms').className).toContain('text-red-d')
    expect(screen.getByTestId('run-metric-noisy-p95_ms').textContent).toBe('基准波动大')
    remount()
    stub()
    mount({ verdict: { ...bench, runId: OTHER_RUN } })
    await ready()
    expect(screen.getByTestId('run-metric-baseline-p95_ms').textContent).toBe('—')
    expect(screen.getByTestId('run-metric-delta-p95_ms').textContent).toBe('—')
    expect(screen.getByTestId('run-metric-p95_ms')).toHaveAttribute('data-failed', 'false')
  })

  it('缺基线给短标签', async () => {
    stub()
    mount({
      verdict: verdict({
        suite: 'web-e2e', runId: FIXTURE_RUN,
        benchmark: [{ name: 'p95_ms', better: 'lower', median: 14, p95: 17, baseline: null, deltaPct: null, failed: false, baselineMissing: true, noisy: false, details: [] }],
      }),
    })
    await ready()
    expect(screen.getByTestId('run-metric-nobaseline-p95_ms').textContent).toBe('缺基线')
  })
})

describe('SuiteRunDrawer · 日志', () => {
  it('尾部按需读取（256 KiB）；完整日志是下载链接', async () => {
    const calls = stub({ logText: 'first\nsecond' })
    mount()
    await ready()
    expect(screen.queryByTestId('run-log-text')).toBeNull()
    await userEvent.click(screen.getByTestId('run-log-tail'))
    expect((await screen.findByTestId('run-log-text')).textContent).toBe('first\nsecond')
    const tailUrl = calls.find((url) => url.includes('suite-web-e2e.log') && url.includes('tail='))
    expect(tailUrl).toContain('tail=262144')
    const full = screen.getByTestId('run-log-full')
    expect(full).toHaveAttribute('download')
    expect(full.getAttribute('href')).not.toContain('tail=')
  })

  it('读取失败给一行错误；日志不在本机则按钮禁用', async () => {
    stub({ logFails: true })
    mount()
    await ready()
    await userEvent.click(screen.getByTestId('run-log-tail'))
    expect((await screen.findByTestId('run-log-error')).getAttribute('role')).toBe('alert')
    remount()
    stub({ record: withRun({ log: { artifact: 'suite.log', bytesTotal: 1, bytesKept: 1, truncated: true, present: false } }) })
    mount()
    await ready()
    expect(screen.getByTestId('run-log-tail')).toBeDisabled()
    expect(screen.queryByTestId('run-log-full')).toBeNull()
    expect(screen.getByTestId('run-log-absent').textContent).toBe('—')
    // 截断标记是圆点 + 一个词（琥珀），没有底色、没有圆角药丸；说明在 title。
    const truncated = screen.getByTestId('run-log-truncated')
    expect(truncated.textContent).toBe('截断')
    expect(truncated).toHaveAttribute('data-tone', 'pending')
    expect(truncated.querySelector('i')?.className).toContain('rounded-full')
    expect(truncated.className.split(/\s+/u).some((name) => ['bg-', 'px-', 'border', 'round'].some((prefix) => name.startsWith(prefix)))).toBe(false)
    expect(truncated.getAttribute('title')).not.toBe('')
  })
})

describe('SuiteRunDrawer · 失效与历史', () => {
  it('过期：逐项列出哪个绑定变了，说明在 Tooltip（键盘可达）', async () => {
    stub()
    mount({ verdict: verdict({ suite: 'web-e2e', state: 'stale', staleBecause: ['candidate', 'plan'], runId: FIXTURE_RUN }) })
    await ready()
    const marks = screen.getByTestId('run-stale')
    expect(within(marks).getByTestId('run-stale-candidate').textContent).toBe('代码')
    expect(within(marks).getByTestId('run-stale-plan').textContent).toBe('计划')
    expect(within(marks).queryByTestId('run-stale-workflow')).toBeNull()
    within(marks).getByTestId('run-stale-candidate').focus()
    expect(await screen.findAllByText('运行之后代码变化了')).not.toHaveLength(0)
    remount()
    stub()
    mount({ verdict: verdict({ suite: 'web-e2e', state: 'stale', staleBecause: ['candidate'], runId: OTHER_RUN }) })
    await ready()
    expect(screen.queryByTestId('run-stale')).toBeNull()
  })

  it('历史：点另一次运行换看它；当前行标记；读取失败只藏这一段', async () => {
    const older = { ...recordList().runs[0]!, runId: OTHER_RUN, step: 'build', result: 'pass' as const }
    const list = { users: recordList().users, runs: [recordList().runs[0]!, older] }
    const calls = stub({
      list,
      record: (run) => run === OTHER_RUN ? withRun({ result: 'pass', exitCode: 0, reasons: [] }, { runId: OTHER_RUN }) : recordDetail(),
    })
    mount()
    await ready()
    expect(screen.getByTestId(`run-history-${FIXTURE_RUN}`)).toHaveAttribute('aria-current', 'true')
    expect(screen.getByTestId(`run-history-${OTHER_RUN}`)).not.toHaveAttribute('aria-current')
    await userEvent.click(screen.getByTestId(`run-history-open-${OTHER_RUN}`))
    await waitFor(() => expect(screen.getByTestId('run-result').textContent).toBe('通过'))
    expect(calls.some((url) => url.startsWith('/api/tests/record?') && url.includes(`run=${OTHER_RUN}`))).toBe(true)
    expect(screen.getByTestId(`run-history-${OTHER_RUN}`)).toHaveAttribute('aria-current', 'true')
    expect(screen.getByTestId('suite-run-drawer')).toBeInTheDocument()

    remount()
    stub({ list: null })
    mount()
    await ready()
    expect(screen.queryByTestId('run-history')).toBeNull()
    expect(screen.getByTestId('run-summary')).toBeInTheDocument()
  })

  it('历史里不可信的记录用短标签替代结果', async () => {
    const list = { users: recordList().users, runs: [{ ...recordList().runs[0]!, trusted: false }] }
    stub({ list })
    mount()
    await ready()
    expect(screen.getByTestId(`run-history-untrusted-${FIXTURE_RUN}`).textContent).toBe('记录被改动')
  })
})

describe('SuiteRunDrawer · 错误', () => {
  it('记录读取失败：一行错误 + 重试；重试重新请求', async () => {
    let fail = true
    const calls = stub({ record: () => fail ? new Response(JSON.stringify({ ok: false, error: 'x' }), { status: 500 }) : recordDetail() })
    mount()
    const error = await screen.findByTestId('run-error')
    expect(error.textContent).toContain('重试')
    expect(within(error).getByRole('alert').className).toContain('whitespace-nowrap')
    fail = false
    await userEvent.click(screen.getByTestId('run-retry'))
    await ready()
    expect(calls.filter((url) => url.startsWith('/api/tests/record?'))).toHaveLength(2)
  })

  it('记录里没有这个套件：一行错误', async () => {
    stub({ record: recordDetail({ suites: [suiteRun({ suite: 'other' })] }) })
    mount()
    expect((await screen.findByTestId('run-suite-missing')).getAttribute('role')).toBe('alert')
  })

  it('总计数为 0 的记录也能渲染（totals 全零）', async () => {
    stub({ record: withRun({ totals: totals({ cases: 0, pass: 0 }), cases: [], reasons: [] }) })
    mount()
    await ready()
    expect(within(screen.getByTestId('run-totals')).getByRole('cell').textContent).toBe('通过 0 · 失败 0')
  })
})
