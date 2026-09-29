import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { I18nProvider } from '../i18n'
import { TaskTestsTab } from './TaskTestsTab'
import { planBrief, verdict, verifyReport } from '../api/testSystemFixtures'
import type { PolicyReport, TestPlanBrief } from '../api/testSystemTypes'
import type { TestRow } from './stageTests'

const LEGACY_ROW: TestRow = {
  id: 'smoke-old', name: '旧冒烟', direction: 'smoke', required: true, status: 'failed',
  run: { runId: '20260915T101530Z-ab12cd', user: 'a-at-x.io', actor: { id: 'a@x.io', name: 'A' }, result: 'fail', exitCode: 1, durationMs: 1, finishedAt: '2026-09-15T10:15:30Z', reasons: [] },
}

const mounted: Array<() => void> = []

/** 同一个用例里换一份数据重新挂载：先卸载已挂的。 */
function reset(): void {
  for (const unmount of mounted.splice(0)) unmount()
}

function mount(report: PolicyReport = verifyReport(), extra: {
  plan?: TestPlanBrief | undefined
  legacyRows?: readonly TestRow[]
  activeSuite?: string | null
  onOpenSuite?: (suite: string) => void
} = {}) {
  const onOpenSuite = extra.onOpenSuite ?? vi.fn()
  const view = render(
    <I18nProvider>
      <TooltipProvider>
        <TaskTestsTab
          report={report}
          plan={'plan' in extra ? extra.plan : planBrief()}
          legacyRows={extra.legacyRows ?? []}
          activeSuite={extra.activeSuite ?? null}
          onOpenSuite={onOpenSuite}
        />
      </TooltipProvider>
    </I18nProvider>,
  )
  mounted.push(view.unmount)
  return onOpenSuite
}

afterEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe('TaskTestsTab · 汇总与顺序', () => {
  it('一行汇总：套件 · 用例 · 失败 · flaky · 覆盖率；不折行', () => {
    mount()
    const summary = screen.getByTestId('tests-summary')
    expect(summary.textContent).toBe('套件 3 · 用例 120 · 失败 0 · flaky 2 · 覆盖率 91.2%')
    expect(summary.className).toContain('whitespace-nowrap')
    expect(summary).toHaveAttribute('data-pass', 'false')
  })

  it('没有任何覆盖率：汇总不带覆盖率一段；空运行集全部为 0', () => {
    mount({ ...verifyReport(), suites: [] })
    expect(screen.getByTestId('tests-summary').textContent).toBe('套件 0 · 用例 0 · 失败 0 · flaky 0')
  })

  it('顺序：汇总 → 未登记文件 → 策略矩阵 → 阻塞 → 场景/任务；没有的段整段不出现', () => {
    mount()
    const order = ['tests-summary', 'tests-files', 'tests-matrix', 'tests-blockers', 'tests-trace'].map((id) => screen.getByTestId(id))
    for (let index = 1; index < order.length; index += 1) {
      expect(order[index - 1]!.compareDocumentPosition(order[index]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
    reset()
    mount({ ...verifyReport(), files: { checked: true, unregistered: [], orphans: [] }, blockers: [], notices: [], trace: [] })
    expect(screen.queryByTestId('tests-files')).toBeNull()
    expect(screen.queryByTestId('tests-blockers')).toBeNull()
    expect(screen.queryByTestId('tests-trace')).toBeNull()
    expect(screen.getByTestId('tests-matrix')).toBeInTheDocument()
  })

  it('页面上除错误信息外不写句子：正文不含句号', () => {
    mount()
    expect(screen.getByTestId('task-tests').textContent ?? '').not.toContain('。')
  })
})

describe('TaskTestsTab · 未登记文件', () => {
  it('置顶表：文件 · 套件 · 阻塞短标签 · 可复制的登记命令；孤儿文件没有套件也没有命令', async () => {
    const write = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true })
    mount()
    const files = within(screen.getByTestId('tests-files'))
    const unregistered = files.getByTestId('tests-file-e2e/new.spec.ts')
    expect(within(unregistered).getAllByRole('cell')[0]?.textContent).toBe('e2e/new.spec.ts')
    expect(within(unregistered).getAllByRole('cell')[1]?.textContent).toBe('web-e2e')
    expect(within(unregistered).getAllByRole('cell')[2]?.textContent).toBe('文件未登记')
    expect(within(unregistered).getByTestId('tests-file-fix-e2e/new.spec.ts-text').textContent).toBe('tenon test register add-login --file e2e/new.spec.ts --suite web-e2e')
    await userEvent.click(within(unregistered).getByTestId('tests-file-fix-e2e/new.spec.ts-copy'))
    expect(write).toHaveBeenCalledWith('tenon test register add-login --file e2e/new.spec.ts --suite web-e2e')
    const orphan = files.getByTestId('tests-file-scripts/tmp.test.mjs')
    expect(orphan).toHaveAttribute('data-orphan', 'true')
    const cells = within(orphan).getAllByRole('cell')
    expect(cells[1]?.textContent).toBe('—')
    expect(cells[2]?.textContent).toBe('文件无套件')
    expect(cells[3]?.textContent).toBe('—')
  })
})

describe('TaskTestsTab · 策略矩阵', () => {
  it('按种类一行：要求词、已登记的套件、最近结果；要求词的说明在 Tooltip（键盘可达）', async () => {
    mount()
    expect(['unit', 'playwright', 'a11y', 'benchmark'].map((kind) => screen.getByTestId(`tests-kind-${kind}`).getAttribute('data-met')))
      .toEqual(['true', 'false', 'false', 'false'])
    expect(screen.getByTestId('tests-requirement-unit').textContent).toBe('运行')
    expect(screen.getByTestId('tests-requirement-a11y').textContent).toBe('登记')
    expect(screen.getByTestId('tests-registered-unit').textContent).toBe('前端单测')
    expect(screen.getByTestId('tests-result-unit').textContent).toBe('通过')
    expect(screen.getByTestId('tests-result-playwright').textContent).toBe('过期')
    expect(screen.getByTestId('tests-result-a11y').textContent).toBe('—')
    screen.getByTestId('tests-requirement-a11y').focus()
    expect((await screen.findAllByText('计划里必须有这个种类的套件或已批准的豁免')).length).toBeGreaterThan(0)
  })

  it('缺项：短标签 + 可复制的修复命令；满足的行没有', () => {
    mount()
    expect(screen.getByTestId('tests-blocker-label-playwright').textContent).toBe('过期')
    expect(screen.getByTestId('tests-fix-playwright-text').textContent).toBe('tenon test run add-login --suite web-e2e')
    expect(screen.getByTestId('tests-blocker-label-a11y').textContent).toBe('缺测试种类')
    expect(screen.getByTestId('tests-fix-a11y-text').textContent).toContain('tenon test waive add-login --kind a11y')
    expect(screen.getByTestId('tests-blocker-label-benchmark').textContent).toBe('基准退化')
    expect(screen.getByTestId('tests-blocker-unit').textContent).toBe('')
  })

  it('豁免：待批准显示为待批准的点 + 词', () => {
    mount()
    const waiver = screen.getByTestId('tests-waiver-benchmark')
    expect(waiver.textContent).toBe('豁免待批准')
    expect(waiver.querySelector('[data-tone="pending"]')).toBeTruthy()
    reset()
    mount(verifyReport(), { plan: { ...planBrief(), state: 'ok', waivers: [{ kind: 'benchmark', approved: true }] } as TestPlanBrief })
    expect(screen.getByTestId('tests-waiver-benchmark').querySelector('[data-tone="done"]')).toBeTruthy()
  })

  it('套件名可点：打开时回调套件 id；没有运行记录的套件只是文字', async () => {
    const onOpen = mount()
    await userEvent.click(screen.getByTestId('tests-suite-web-unit'))
    expect(onOpen).toHaveBeenCalledWith('web-unit')
    reset()
    const report = { ...verifyReport(), suites: [verdict({ suite: 'web-unit', label: '前端单测' })] }
    mount(report)
    expect(screen.getByTestId('tests-suite-web-unit').tagName).toBe('SPAN')
  })

  it('当前打开的套件带选中标记', () => {
    mount(verifyReport(), { activeSuite: 'web-e2e' })
    expect(screen.getByTestId('tests-suite-web-e2e')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('tests-suite-web-unit')).toHaveAttribute('aria-pressed', 'false')
  })

  it('旧步骤的内联套件：有旧式运行记录才可点，回调带 step: 前缀', async () => {
    const report: PolicyReport = {
      ...verifyReport(),
      policy: null,
      blockers: [],
      suites: [verdict({ suite: 'step:smoke-old', origin: 'step', kind: 'smoke', reason: 'inline', label: '旧冒烟', state: 'failed' })],
    }
    const onOpen = mount(report, { legacyRows: [LEGACY_ROW] })
    await userEvent.click(screen.getByTestId('tests-suite-step:smoke-old'))
    expect(onOpen).toHaveBeenCalledWith('step:smoke-old')
    reset()
    mount(report, { legacyRows: [{ ...LEGACY_ROW, run: undefined }] })
    expect(screen.getByTestId('tests-suite-step:smoke-old').tagName).toBe('SPAN')
  })

  it('计划被改动 / 目录缺失：所有缺项行退到全局阻塞，一行一个短标签与修复命令', () => {
    const report: PolicyReport = {
      ...verifyReport(), suites: [],
      blockers: [{ code: 'test-plan-tampered', blocking: true, message: 'm', fix: 'tenon test plan add-login --seed' }],
    }
    mount(report, { plan: { state: 'tampered', reason: 'x' } })
    for (const kind of ['unit', 'playwright', 'a11y', 'benchmark']) {
      expect(screen.getByTestId(`tests-blocker-label-${kind}`).textContent).toBe('计划被改动')
      expect(screen.getByTestId(`tests-fix-${kind}-text`).textContent).toBe('tenon test plan add-login --seed')
    }
  })

  it('每个格子不折行：种类、套件、缺项都是 truncate / nowrap', () => {
    mount()
    const row = screen.getByTestId('tests-kind-playwright')
    expect(row.className).toContain('whitespace-nowrap')
    expect(within(row).getByTestId('tests-fix-playwright-text').className).toContain('truncate')
    expect(within(row).getByTestId('tests-suite-web-e2e').className).toContain('truncate')
  })
})

describe('TaskTestsTab · 阻塞与追溯', () => {
  it('阻塞表只列矩阵和文件表没用上的阻塞，提示是中性的；对象与命令各一格', () => {
    mount()
    const rows = within(screen.getByTestId('tests-blockers')).getAllByTestId('tests-blocker')
    expect(rows.map((row) => [row.getAttribute('data-type'), within(row).getByTestId('tests-blocker-code').textContent])).toEqual([
      ['blocker', 'flaky 超限'], ['notice', '已修好'],
    ])
    expect(within(rows[1] as HTMLElement).getByTestId('tests-blocker-code').className).not.toContain('text-red-d')
    expect(within(rows[0] as HTMLElement).getByTestId('tests-blocker-code').className).toContain('text-red-d')
    expect(within(rows[1] as HTMLElement).getAllByRole('cell')[1]?.textContent).toBe('src/a.test.ts › 旧用例')
    expect(within(rows[1] as HTMLElement).getByTestId('tests-blocker-fix-1-text').textContent).toContain('tenon test known rm')
  })

  it('追溯表：场景/任务 · 用例（最多两个，其余 +N）· 结果', () => {
    const base = verifyReport()
    const report: PolicyReport = {
      ...base,
      trace: base.trace.map((row, index) => (index === 2
        ? { ...row, tests: [...row.tests, { ref: 'b.test.ts › 二', status: 'pass' as const }, { ref: 'c.test.ts › 三', status: 'pass' as const }] }
        : row)),
    }
    mount(report)
    const trace = screen.getByTestId('tests-trace')
    expect(within(trace).getAllByTestId('tests-trace-title').map((cell) => cell.textContent)).toEqual([
      'auth · 登录成功跳转首页', 'auth · 退出登录', '2.3 密码为空时禁用提交',
    ])
    const last = within(trace).getByTestId('tests-trace-task:2.3')
    expect(within(last).getByTestId('tests-trace-more').textContent).toBe('+1')
    expect(within(last).getByTestId('tests-trace-cases').getAttribute('title')).toContain('c.test.ts › 三')
    expect(screen.getByTestId('tests-trace-state-spec:auth/登录成功跳转首页').textContent).toBe('失败')
    expect(screen.getByTestId('tests-trace-state-spec:auth/退出登录').textContent).toBe('未覆盖')
    expect(screen.getByTestId('tests-trace-state-spec:auth/退出登录')).toHaveAttribute('data-tone', 'blocked')
    expect(screen.getByTestId('tests-trace-state-task:2.3').textContent).toBe('通过')
    expect(screen.getByTestId('tests-trace-spec:auth/退出登录').querySelector('[data-testid="tests-trace-cases"]')?.textContent).toBe('—')
  })

  it('场景要求关闭时未覆盖是中性的；豁免与映射未通过各有词', () => {
    const base = verifyReport()
    const report: PolicyReport = {
      ...base,
      policy: { ...base.policy!, scenarios: 'off' },
      trace: [
        ...base.trace,
        { covers: 'spec:auth/豁免的', kind: 'spec', title: 'auth · 豁免的', state: 'waived', tests: [], waiver: { approved: false, reason: 'r' } },
        { covers: 'spec:auth/映射了', kind: 'spec', title: 'auth · 映射了', state: 'mapped', tests: [{ ref: 'x.test.ts › y', status: 'not-run' }] },
      ],
    }
    mount(report)
    expect(screen.getByTestId('tests-trace-state-spec:auth/退出登录')).toHaveAttribute('data-tone', 'neutral')
    expect(screen.getByTestId('tests-trace-state-spec:auth/豁免的').textContent).toBe('豁免')
    expect(screen.getByTestId('tests-trace-state-spec:auth/豁免的')).toHaveAttribute('data-tone', 'pending')
    expect(screen.getByTestId('tests-trace-state-spec:auth/映射了').textContent).toBe('未运行')
  })

  it('英文界面用 kernel 的英文短标签', () => {
    window.localStorage.setItem('tenon-dashboard-lang', 'en')
    mount()
    expect(screen.getByTestId('tests-blocker-label-playwright').textContent).toBe('Stale')
    expect(screen.getByTestId('tests-blocker-label-a11y').textContent).toBe('Kind missing')
    expect(screen.getByTestId('tests-summary').textContent).toBe('Suite 3 · Case 120 · Fail 0 · Flaky 2 · Coverage 91.2%')
  })
})
