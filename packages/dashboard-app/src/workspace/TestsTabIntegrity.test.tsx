import { render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { I18nProvider } from '../i18n'
import { TaskTestsTab } from './TaskTestsTab'
import { planBrief, verifyReport } from '../api/testSystemFixtures'
import type { IntegrityReport, PolicyReport } from '../api/testSystemTypes'

function mount(integrity: IntegrityReport | undefined): void {
  const base: PolicyReport = verifyReport()
  const report: PolicyReport = { ...base, ...(integrity === undefined ? {} : { integrity }) }
  render(
    <I18nProvider>
      <TooltipProvider>
        <TaskTestsTab report={report} plan={planBrief()} legacyRows={[]} activeSuite={null} onOpenSuite={() => {}} stageLabelOf={(stage) => stage} />
      </TooltipProvider>
    </I18nProvider>,
  )
}

const SIGNALS: IntegrityReport['signals'] = [
  { code: 'case-count-drop', subject: 'unit', detail: '120 → 100', suite: 'unit' },
  { code: 'test-skipped', subject: 'src/very/long/path/to/a/deeply/nested/module/a.test.ts', detail: '+2', suite: 'unit' },
  { code: 'coverage-threshold-lowered', subject: 'vitest.config.ts', detail: 'lines 80 → 70' },
]

afterEach(() => window.localStorage.clear())

describe('TestsTabIntegrity · 工作台测试页签的完整性段', () => {
  it('没有 integrity、或读得出且没有信号：整段不出现', () => {
    mount(undefined)
    expect(screen.queryByTestId('tests-integrity')).toBeNull()
  })

  it('读得出且没有信号：整段不出现', () => {
    mount({ mode: 'notice', state: 'ok', signals: [] })
    expect(screen.queryByTestId('tests-integrity')).toBeNull()
  })

  it('notice：表头 + 每个信号一行（信号 · 对象 · 明细 · 套件 · 策略），策略是中性圆点 + 「提示」，计数是信号个数', () => {
    mount({ mode: 'notice', state: 'ok', signals: SIGNALS })
    const section = screen.getByTestId('tests-integrity')
    expect(within(section).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['信号', '对象', '明细', '套件', '策略'])
    const rows = within(section).getAllByTestId('tests-integrity-row')
    expect(rows.map((row) => within(row).getAllByRole('cell').slice(0, 4).map((cell) => cell.textContent))).toEqual([
      ['用例数下降', 'unit', '120 → 100', 'unit'],
      ['用例被跳过', 'src/very/long/path/to/a/deeply/nested/module/a.test.ts', '+2', 'unit'],
      ['覆盖率门槛降低', 'vitest.config.ts', 'lines 80 → 70', '—'],
    ])
    for (const row of rows) {
      const mode = within(row).getByTestId('tests-integrity-mode')
      expect(mode).toHaveAttribute('data-tone', 'neutral')
      expect(mode.textContent).toBe('提示')
    }
    expect(within(rows[0] as HTMLElement).getByTestId('tests-integrity-signal').className).not.toContain('text-red-d')
    expect(section.querySelector('h3')?.nextElementSibling?.textContent).toBe('3')
  })

  it('block：策略是红点 + 「阻塞」，信号名用危险色', () => {
    mount({ mode: 'block', state: 'ok', signals: SIGNALS.slice(0, 1) })
    const row = screen.getByTestId('tests-integrity-row')
    expect(within(row).getByTestId('tests-integrity-mode')).toHaveAttribute('data-tone', 'blocked')
    expect(within(row).getByTestId('tests-integrity-mode').textContent).toBe('阻塞')
    expect(within(row).getByTestId('tests-integrity-signal').className).toContain('text-red-d')
  })

  it('每个格子不折行：对象、明细、套件都是 truncate，完整内容在 title', () => {
    mount({ mode: 'notice', state: 'ok', signals: SIGNALS })
    const long = screen.getAllByTestId('tests-integrity-row')[1] as HTMLElement
    const cells = within(long).getAllByRole('cell')
    for (const cell of cells.slice(0, 4)) expect(cell.className).toContain('truncate')
    expect(cells[1]).toHaveAttribute('title', 'src/very/long/path/to/a/deeply/nested/module/a.test.ts')
    expect(long.className).toContain('whitespace-nowrap')
    expect(within(long).getByTestId('tests-integrity-signal')).toHaveAttribute('title', 'test-skipped')
  })

  it('读不出改动行：一行「未检查」，原因放 title，不写句子；运行记录类信号照常列出', () => {
    mount({ mode: 'block', state: 'unavailable', reason: '当前目录不是 git 仓库', signals: SIGNALS.slice(0, 1) })
    const row = screen.getByTestId('tests-integrity-unavailable')
    expect(within(row).getAllByRole('cell')[0]).toHaveTextContent('未检查')
    expect(within(row).getAllByRole('cell')[0]).toHaveAttribute('title', '当前目录不是 git 仓库')
    expect(screen.getAllByTestId('tests-integrity-row')).toHaveLength(1)
    expect(screen.getByTestId('tests-integrity').textContent).not.toContain('。')
  })

  it('文件太多被截断：多一行「截断」，明细是 已读/总数', () => {
    mount({ mode: 'notice', state: 'ok', signals: [], truncated: { found: 500, limit: 400 } })
    const row = screen.getByTestId('tests-integrity-truncated')
    expect(row.textContent).toContain('截断')
    expect(within(row).getAllByRole('cell')[2]).toHaveTextContent('400/500')
  })

  it('顺序：策略矩阵之后、阻塞之前', () => {
    mount({ mode: 'notice', state: 'ok', signals: SIGNALS })
    const order = ['tests-matrix', 'tests-integrity', 'tests-blockers', 'tests-trace'].map((id) => screen.getByTestId(id))
    for (let index = 1; index < order.length; index += 1) {
      expect(order[index - 1]!.compareDocumentPosition(order[index]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
  })

  it('英文界面用 kernel 的英文信号标签', () => {
    window.localStorage.setItem('tenon-dashboard-lang', 'en')
    mount({ mode: 'notice', state: 'ok', signals: SIGNALS })
    const rows = screen.getAllByTestId('tests-integrity-row')
    expect(rows.map((row) => within(row).getByTestId('tests-integrity-signal').textContent)).toEqual([
      'Case count dropped', 'Tests skipped', 'Coverage threshold lowered',
    ])
    expect(within(rows[0] as HTMLElement).getByTestId('tests-integrity-mode').textContent).toBe('Notice')
    expect(within(screen.getByTestId('tests-integrity')).getAllByRole('columnheader')[0]).toHaveTextContent('Signal')
  })

  it('不认识的信号码原样显示，不猜', () => {
    mount({ mode: 'notice', state: 'ok', signals: [{ code: 'future-signal', subject: 'x', detail: '1' }] })
    expect(screen.getByTestId('tests-integrity-signal').textContent).toBe('future-signal')
  })
})
