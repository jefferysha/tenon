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
  })

  it('状态词是单词，正文不出现句子（除错误外不带句号）', () => {
    render(<I18nProvider><StageTestsPanel rows={ROWS} activeId="unit" onOpen={() => undefined} /></I18nProvider>)
    expect(screen.getByTestId('stage-test-unit')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('stage-tests').textContent ?? '').not.toContain('。')
    expect(screen.getByTestId('stage-test-unit').textContent ?? '').toContain('通过')
  })

  it('空行集显示占位', () => {
    render(<I18nProvider><StageTestsPanel rows={[]} activeId={null} onOpen={() => undefined} /></I18nProvider>)
    expect(screen.getByTestId('stage-tests').textContent).toContain('无')
  })
})
