import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n'
import { StageTestsPanel } from './StageTestsPanel'
import type { TestRow } from './stageTests'

const ROWS: TestRow[] = [
  {
    id: 'unit', name: '单测', direction: 'unit', required: true, status: 'passed',
    durationMs: 12_300, finishedAt: '2026-09-15T10:15:30Z', actorName: 'A',
    run: {
      runId: '20260915T101530Z-ab12cd', user: 'a-at-x.io', actor: { id: 'a@x.io', name: 'A' },
      result: 'pass', exitCode: 0, durationMs: 12_300, finishedAt: '2026-09-15T10:15:30Z', reasons: [],
    },
  },
  { id: 'bad', name: 'bad', direction: 'unit', required: true, status: 'failed' },
  { id: 'bench', name: 'bench', direction: 'benchmark', required: false, status: 'missing' },
]

afterEach(() => vi.restoreAllMocks())

describe('StageTestsPanel', () => {
  it('每行带 data-status；必需项有标记；点击回调行 id', async () => {
    const onOpen = vi.fn()
    render(<I18nProvider><StageTestsPanel rows={ROWS} activeId={null} onOpen={onOpen} /></I18nProvider>)
    expect(screen.getByTestId('stage-test-unit')).toHaveAttribute('data-status', 'passed')
    expect(screen.getByTestId('stage-test-bad')).toHaveAttribute('data-status', 'failed')
    expect(screen.getByTestId('stage-test-bench')).toHaveAttribute('data-status', 'missing')
    expect(screen.getByTestId('stage-test-required-unit')).toBeTruthy()
    expect(screen.queryByTestId('stage-test-required-bench')).toBeNull()

    await userEvent.click(screen.getByTestId('stage-test-unit'))
    expect(onOpen).toHaveBeenCalledWith('unit')
    await userEvent.click(screen.getByTestId('stage-test-open-bad'))
    expect(onOpen).toHaveBeenLastCalledWith('bad')
    expect(onOpen).toHaveBeenCalledTimes(2)
  })

  it('是带表头的表（与 IO sheet 同款）：不是卡片；行间细分隔线；状态 = 圆点 + 单词；最近运行一格', () => {
    render(<I18nProvider><StageTestsPanel rows={ROWS} activeId={null} onOpen={() => undefined} /></I18nProvider>)
    const table = screen.getByRole('table')
    expect(screen.getByTestId('stage-tests-head').textContent).toBe('测试类型最近运行状态')
    expect(screen.getAllByRole('columnheader')).toHaveLength(4)
    expect(table.querySelector('ul, li')).toBeNull()
    const row = screen.getByTestId('stage-test-unit')
    expect(row).toHaveAttribute('role', 'row')
    expect(row.className).toContain('border-b')
    expect(row.className).not.toMatch(/rounded-md|bg-card/)
    const cells = row.querySelectorAll('[role="cell"]')
    expect(cells).toHaveLength(4)
    expect(cells[1]?.textContent).toBe('unit')
    expect(cells[2]?.textContent).toMatch(/^12\.3s · \d+\/\d+ \d{2}:\d{2} · A$/)
    const pill = cells[3]?.querySelector('[data-tone]')
    expect(pill).toHaveAttribute('data-tone', 'done')
    expect(pill?.querySelector('i')).toBeTruthy()
    expect(pill?.textContent).toBe('通过')
    expect(screen.getByTestId('stage-test-bad').querySelectorAll('[role="cell"]')[2]?.textContent).toBe('—')
  })

  it('键盘：名称按钮可聚焦并以 Enter 打开', async () => {
    const onOpen = vi.fn()
    render(<I18nProvider><StageTestsPanel rows={ROWS} activeId={null} onOpen={onOpen} /></I18nProvider>)
    screen.getByTestId('stage-test-open-bench').focus()
    await userEvent.keyboard('{Enter}')
    expect(onOpen).toHaveBeenCalledWith('bench')
  })

  it('状态词是单词，正文不出现句子（除错误外不带句号）', () => {
    render(<I18nProvider><StageTestsPanel rows={ROWS} activeId="unit" onOpen={() => undefined} /></I18nProvider>)
    expect(screen.getByTestId('stage-test-open-unit')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('stage-test-open-bad')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTestId('stage-tests').textContent ?? '').not.toContain('。')
    expect(screen.getByTestId('stage-test-unit').textContent ?? '').toContain('通过')
  })

  it('空行集显示占位', () => {
    render(<I18nProvider><StageTestsPanel rows={[]} activeId={null} onOpen={() => undefined} /></I18nProvider>)
    expect(screen.getByTestId('stage-tests').textContent).toContain('无')
  })
})
