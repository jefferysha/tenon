import { act, render, screen, within } from '@testing-library/react'
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
  recordedBy?: string
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
          {...(extra.recordedBy === undefined ? {} : { recordedBy: extra.recordedBy })}
          stageLabelOf={(stage) => (stage === 'build' ? '实现' : stage)}
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

/** 修复命令收在行展开里：点该行的箭头才出现。 */
async function openFix(kind: string): Promise<HTMLElement> {
  await userEvent.click(screen.getByTestId(`tests-fix-toggle-${kind}`))
  return screen.getByTestId(`tests-fix-${kind}-text`)
}

describe('TaskTestsTab · 汇总与顺序', () => {
  it('汇总：套件 · 用例 · 失败 · 不稳定（+ 覆盖率）是并排的大数字，标签在数字下；一行不折行', () => {
    mount()
    const summary = screen.getByTestId('tests-summary')
    expect(summary.className).toContain('whitespace-nowrap')
    expect(summary.className).toContain('flex-nowrap')
    expect(summary).toHaveAttribute('data-pass', 'false')
    const stat = (id: string): string => screen.getByTestId(`tests-stat-${id}`).textContent ?? ''
    expect(['suite', 'case', 'fail', 'flaky', 'coverage'].map(stat)).toEqual(['3套件', '120用例', '0失败', '2不稳定', '91.2%覆盖率'])
    // 24px / 600 的等宽数字 + 13px 标签。
    const value = screen.getByTestId('tests-stat-value-case')
    expect(value.className).toContain('text-section')
    expect(value.className).toContain('font-semibold')
    expect(value.className).toContain('tabular-nums')
    expect(screen.getByTestId('tests-stat-case').querySelector('span:not([data-testid])')?.className).toContain('text-micro')
    expect(summary).toHaveAttribute('aria-label', '套件 3 · 用例 120 · 失败 0 · 不稳定 2 · 覆盖率 91.2%')
  })

  it('0 退成 text-3；失败非零用红，其余非零是正文色', () => {
    const base = verifyReport()
    mount({ ...base, suites: base.suites.map((suite, index) => (index === 0 ? { ...suite, totals: { cases: 4, pass: 3, fail: 1, skip: 0, flaky: 0, knownFail: 0 } } : suite)) })
    const tone = (id: string): string => screen.getByTestId(`tests-stat-value-${id}`).className
    expect(tone('fail')).toContain('text-red-d')
    expect(screen.getByTestId('tests-stat-fail')).toHaveAttribute('data-zero', 'false')
    expect(tone('case')).toContain('text-text')
    reset()
    mount({ ...base, suites: [] })
    for (const id of ['suite', 'case', 'fail', 'flaky']) {
      expect(tone(id), id).toContain('text-text-3')
      expect(tone(id), id).not.toContain('text-red-d')
      expect(screen.getByTestId(`tests-stat-${id}`)).toHaveAttribute('data-zero', 'true')
    }
  })

  it('记录是负责人的：汇总行末尾只加一个「· 名字」（真机验收 F15），13px text-3，不新增句子，不折行', () => {
    mount(verifyReport(), { recordedBy: 'Alice' })
    const summary = screen.getByTestId('tests-summary')
    const owner = screen.getByTestId('tests-summary-owner')
    expect(owner.textContent).toBe('· Alice')
    expect(owner).toHaveAttribute('title', 'Alice')
    expect(owner.className).toContain('text-micro')
    expect(owner.className).toContain('text-text-3')
    expect(owner.className).toContain('truncate')
    // 名字在数字行里最后一个，数字与标签原样；朗读文字以名字收尾。
    expect(summary.lastElementChild).toBe(owner)
    expect(summary.className).toContain('whitespace-nowrap')
    expect(summary.className).toContain('flex-nowrap')
    expect(['suite', 'case', 'fail', 'flaky', 'coverage'].map((id) => screen.getByTestId(`tests-stat-${id}`).textContent)).toEqual(['3套件', '120用例', '0失败', '2不稳定', '91.2%覆盖率'])
    expect(summary).toHaveAttribute('aria-label', '套件 3 · 用例 120 · 失败 0 · 不稳定 2 · 覆盖率 91.2% · Alice')
  })

  it('没有负责人：汇总行没有名字这一格', () => {
    mount()
    expect(screen.queryByTestId('tests-summary-owner')).toBeNull()
  })

  it('没有任何覆盖率：汇总不带覆盖率一格；空运行集全部为 0', () => {
    mount({ ...verifyReport(), suites: [] })
    expect(screen.queryByTestId('tests-stat-coverage')).toBeNull()
    expect(['suite', 'case', 'fail', 'flaky'].map((id) => screen.getByTestId(`tests-stat-${id}`).textContent)).toEqual(['0套件', '0用例', '0失败', '0不稳定'])
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

  it('缺项：行内只有短标签，修复命令收进行展开（点箭头才显示，可再收起）；满足的行没有', async () => {
    mount()
    expect(screen.getByTestId('tests-blocker-label-playwright').textContent).toBe('过期')
    expect(screen.queryByTestId('tests-fix-playwright-text'), '默认收起').toBeNull()
    expect(screen.getByTestId('tests-fix-toggle-playwright')).toHaveAttribute('aria-expanded', 'false')
    expect((await openFix('playwright')).textContent).toBe('tenon test run add-login --suite web-e2e')
    expect(screen.getByTestId('tests-fix-toggle-playwright')).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('tests-fix-toggle-playwright')).toHaveAccessibleName('收起修复命令')
    expect(screen.getByTestId('tests-blocker-label-a11y').textContent).toBe('缺测试种类')
    expect((await openFix('a11y')).textContent).toContain('tenon test waive add-login --kind a11y')
    expect(screen.getByTestId('tests-blocker-label-benchmark').textContent).toBe('基准退化')
    expect(screen.getByTestId('tests-blocker-unit').textContent).toBe('')
    expect(screen.queryByTestId('tests-fix-toggle-unit'), '满足的行没有展开钮').toBeNull()
    await userEvent.click(screen.getByTestId('tests-fix-toggle-playwright'))
    expect(screen.queryByTestId('tests-fix-playwright-text')).toBeNull()
  })

  it('展开的修复命令可复制', async () => {
    const write = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true })
    mount()
    await openFix('playwright')
    await userEvent.click(screen.getByTestId('tests-fix-playwright-copy'))
    expect(write).toHaveBeenCalledWith('tenon test run add-login --suite web-e2e')
  })

  /** 状态标记 = 一个 6px 圆点 + 一个词；没有底色、边框、圆角、内边距、阴影（用户否决过药丸）。 */
  function expectDotAndWord(marker: Element | null, word: string): void {
    expect(marker).toBeTruthy()
    const mark = marker as HTMLElement
    expect(mark.textContent).toBe(word)
    expect(mark.children).toHaveLength(2)
    expect(mark.children[0]?.tagName).toBe('I')
    expect(mark.children[0]?.className).toContain('size-1.5')
    expect(mark.children[0]?.className).toContain('rounded-full')
    const SHAPE_PREFIXES = ['bg-', 'border', 'round', 'p-', 'px-', 'py-', 'pt-', 'pb-', 'pl-', 'pr-', 'shadow', 'ring', 'outline']
    const shape = mark.className.split(/\s+/).filter((name) => !name.startsWith('[') && SHAPE_PREFIXES.some((prefix) => name.startsWith(prefix)))
    expect(shape).toEqual([])
  }

  it('豁免：待批准显示为待批准的点 + 词', () => {
    mount()
    const waiver = screen.getByTestId('tests-waiver-benchmark')
    expect(waiver.textContent).toBe('豁免待批准')
    expect(waiver.querySelector('[data-tone="pending"]')).toBeTruthy()
    expectDotAndWord(waiver.querySelector('[data-tone="pending"]'), '待批准')
    reset()
    mount(verifyReport(), { plan: { ...planBrief(), state: 'ok', waivers: [{ kind: 'benchmark', approved: true }] } as TestPlanBrief })
    expect(screen.getByTestId('tests-waiver-benchmark').querySelector('[data-tone="done"]')).toBeTruthy()
  })

  describe('项目级不适用（目录声明）', () => {
    const declared = (approved: boolean): PolicyReport => ({
      ...verifyReport(),
      notApplicable: [{ kind: 'a11y', reason: '本项目没有浏览器界面', approved }],
      blockers: approved
        ? verifyReport().blockers.filter((item) => item.subject !== 'a11y')
        : verifyReport().blockers.map((item) => (item.subject === 'a11y'
          ? { code: 'waiver-unapproved', blocking: true, message: 'm', fix: 'tenon review request add-login', subject: 'a11y' }
          : item)),
    })

    it('已批准：显示「不适用」，不当作缺（满足、没有缺项标签）；原因在 Tooltip，键盘可达', async () => {
      mount(declared(true))
      expect(screen.getByTestId('tests-registered-a11y').textContent).toBe('不适用')
      expect(screen.getByTestId('tests-kind-a11y')).toHaveAttribute('data-met', 'true')
      expect(screen.queryByTestId('tests-blocker-label-a11y')).toBeNull()
      expect(screen.queryByTestId('tests-fix-toggle-a11y')).toBeNull()
      expect(screen.getByTestId('tests-na-a11y')).toHaveAttribute('data-approved', 'true')
      expect(within(screen.getByTestId('tests-na-a11y')).queryByText('待批准')).toBeNull()
      act(() => screen.getByTestId('tests-na-label-a11y').focus())
      expect((await screen.findAllByText('本项目没有浏览器界面')).length).toBeGreaterThan(0)
    })

    it('未批准：「不适用」旁标待批准，仍是缺（豁免未批准 + 评审命令）', async () => {
      mount(declared(false))
      const mark = screen.getByTestId('tests-na-a11y')
      expect(mark).toHaveAttribute('data-approved', 'false')
      expect(mark.textContent).toBe('不适用待批准')
      expect(mark.querySelector('[data-tone="pending"]')).toBeTruthy()
      expectDotAndWord(mark.querySelector('[data-tone="pending"]'), '待批准')
      expect(screen.getByTestId('tests-kind-a11y')).toHaveAttribute('data-met', 'false')
      expect(screen.getByTestId('tests-blocker-label-a11y').textContent).toBe('豁免未批准')
      expect((await openFix('a11y')).textContent).toBe('tenon review request add-login')
    })

    it('页签计数把已批准的不适用算作满足；不适用与说明一行不折行', () => {
      mount(declared(true))
      expect(screen.getByTestId('tests-na-a11y').className).toContain('whitespace-nowrap')
      expect(screen.getByTestId('tests-na-label-a11y').className).toContain('whitespace-nowrap')
    })

    it('没有声明：和以前一样是「缺测试种类」', () => {
      mount()
      expect(screen.queryByTestId('tests-na-a11y')).toBeNull()
      expect(screen.getByTestId('tests-blocker-label-a11y').textContent).toBe('缺测试种类')
    })
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

  it('计划被改动 / 目录缺失：所有缺项行退到全局阻塞，一行一个短标签与修复命令', async () => {
    const report: PolicyReport = {
      ...verifyReport(), suites: [],
      blockers: [{ code: 'test-plan-tampered', blocking: true, message: 'm', fix: 'tenon test plan add-login --seed' }],
    }
    mount(report, { plan: { state: 'tampered', reason: 'x' } })
    for (const kind of ['unit', 'playwright', 'a11y', 'benchmark']) {
      expect(screen.getByTestId(`tests-blocker-label-${kind}`).textContent).toBe('计划被改动')
      expect((await openFix(kind)).textContent).toBe('tenon test plan add-login --seed')
    }
  })

  it('每个格子不折行：种类、套件、缺项都是 truncate / nowrap', async () => {
    mount()
    const row = screen.getByTestId('tests-kind-playwright')
    expect(row.className).toContain('whitespace-nowrap')
    expect(within(row).getByTestId('tests-blocker-label-playwright').className).toContain('truncate')
    expect((await openFix('playwright')).className).toContain('truncate')
    expect(within(row).getByTestId('tests-suite-web-e2e').className).toContain('truncate')
  })
})

describe('TaskTestsTab · 阻塞与追溯', () => {
  it('阻塞表只列矩阵和文件表没用上的阻塞，提示是中性的；对象与命令各一格', () => {
    mount()
    const rows = within(screen.getByTestId('tests-blockers')).getAllByTestId('tests-blocker')
    expect(rows.map((row) => [row.getAttribute('data-type'), within(row).getByTestId('tests-blocker-code').textContent])).toEqual([
      ['blocker', '不稳定超限'], ['notice', '已修好'],
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
      'auth · 登录成功跳转首页', 'auth · 退出登录', '2.3 · 实现 · 密码为空时禁用提交',
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
        { covers: 'spec:auth/豁免的', kind: 'spec', title: 'auth · 豁免的', required: true, state: 'waived', tests: [], waiver: { approved: false, reason: 'r' } },
        { covers: 'spec:auth/映射了', kind: 'spec', title: 'auth · 映射了', required: true, state: 'mapped', tests: [{ ref: 'x.test.ts › y', status: 'not-run' }] },
      ],
    }
    mount(report)
    expect(screen.getByTestId('tests-trace-state-spec:auth/退出登录')).toHaveAttribute('data-tone', 'neutral')
    expect(screen.getByTestId('tests-trace-state-spec:auth/豁免的').textContent).toBe('豁免')
    expect(screen.getByTestId('tests-trace-state-spec:auth/豁免的')).toHaveAttribute('data-tone', 'pending')
    expect(screen.getByTestId('tests-trace-state-spec:auth/映射了').textContent).toBe('未运行')
  })

  it('追溯行一行：任务 = 编号 · 阶段名 · 文字，场景 = 能力 · 场景；截断并带完整 title；没有阶段小节时省略阶段', async () => {
    const base = verifyReport()
    mount({
      ...base,
      trace: [
        ...base.trace,
        { covers: 'task:4.1', kind: 'task', title: '将本阶段目标拆成可验证任务。', stage: 'spec', required: false, state: 'uncovered', tests: [] },
        { covers: 'task:5.2', kind: 'task', title: '没有阶段小节的条目', required: false, state: 'uncovered', tests: [] },
      ],
    })
    // 骨架任务（可选）合并进「N 可选」，展开后才逐条出现。
    await userEvent.click(screen.getByTestId('tests-trace-optional-toggle'))
    const titleOf = (covers: string): HTMLElement => within(screen.getByTestId(`tests-trace-${covers}`)).getByTestId('tests-trace-title')
    expect(titleOf('task:4.1').textContent).toBe('4.1 · spec · 将本阶段目标拆成可验证任务。')
    expect(titleOf('task:5.2').textContent).toBe('5.2 · 没有阶段小节的条目')
    expect(titleOf('spec:auth/退出登录').textContent).toBe('auth · 退出登录')
    for (const covers of ['task:2.3', 'task:4.1', 'spec:auth/退出登录']) {
      const cell = titleOf(covers)
      expect(cell.getAttribute('title')).toBe(cell.textContent)
      expect(cell.className).toContain('truncate')
      expect(cell.className).toContain('whitespace-nowrap')
    }
  })

  it('可选的任务（非实现阶段小节）没映射时写「可选」，中性，不当缺项；合并成一行，展开才逐条列出', async () => {
    const base = verifyReport()
    mount({ ...base, trace: [...base.trace, { covers: 'task:1.1', kind: 'task', title: '将本阶段目标拆成可验证任务。', required: false, state: 'uncovered', tests: [] }] })
    expect(screen.queryByTestId('tests-trace-task:1.1'), '默认收起').toBeNull()
    await userEvent.click(screen.getByTestId('tests-trace-optional-toggle'))
    expect(screen.getByTestId('tests-trace-state-task:1.1').textContent).toBe('可选')
    expect(screen.getByTestId('tests-trace-state-task:1.1')).toHaveAttribute('data-tone', 'neutral')
    expect(screen.getByTestId('tests-trace-state-spec:auth/退出登录')).toHaveAttribute('data-tone', 'blocked')
  })

  it('英文界面用 kernel 的英文短标签', () => {
    window.localStorage.setItem('tenon-dashboard-lang', 'en')
    mount()
    expect(screen.getByTestId('tests-blocker-label-playwright').textContent).toBe('Stale')
    expect(screen.getByTestId('tests-blocker-label-a11y').textContent).toBe('Kind missing')
    expect(screen.getByTestId('tests-summary')).toHaveAttribute('aria-label', 'Suite 3 · Case 120 · Fail 0 · Flaky 2 · Coverage 91.2%')
    expect(screen.getByTestId('tests-stat-fail').textContent).toBe('0Fail')
  })

  it('可选任务合并成一行「N 可选」：计数随数量，默认收起，可展开再收起；表头计数仍是全部条目', async () => {
    const base = verifyReport()
    const optional = (id: string) => ({ covers: `task:${id}`, kind: 'task' as const, title: '将本阶段目标拆成可验证任务。', stage: 'spec', required: false, state: 'uncovered' as const, tests: [] })
    mount({ ...base, trace: [...base.trace, optional('1.1'), optional('2.1'), optional('3.1')] })
    const toggle = screen.getByTestId('tests-trace-optional-toggle')
    expect(toggle.textContent).toBe('3 可选')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(within(screen.getByTestId('tests-trace')).getAllByTestId('tests-trace-title')).toHaveLength(3)
    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(within(screen.getByTestId('tests-trace')).getAllByTestId('tests-trace-title')).toHaveLength(6)
    await userEvent.click(toggle)
    expect(within(screen.getByTestId('tests-trace')).getAllByTestId('tests-trace-title')).toHaveLength(3)
  })

  it('没有可选任务：不出现「N 可选」行', () => {
    mount()
    expect(screen.queryByTestId('tests-trace-optional')).toBeNull()
  })

  it('失败的行排在最前，其后按 缺映射 → 未运行 → 通过 的顺序；同权重保持服务端顺序', () => {
    const base = verifyReport()
    const row = (covers: string, state: 'passing' | 'failing' | 'mapped' | 'uncovered'): PolicyReport['trace'][number] => ({
      covers: `spec:${covers}`, kind: 'spec', title: covers, required: true, state, tests: [],
    })
    mount({ ...base, trace: [row('a-pass', 'passing'), row('b-mapped', 'mapped'), row('c-fail', 'failing'), row('d-uncovered', 'uncovered'), row('e-fail', 'failing')] })
    expect(within(screen.getByTestId('tests-trace')).getAllByTestId('tests-trace-title').map((cell) => cell.textContent))
      .toEqual(['c-fail', 'e-fail', 'd-uncovered', 'b-mapped', 'a-pass'])
  })
})
