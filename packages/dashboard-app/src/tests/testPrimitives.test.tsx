import { act, render, renderHook, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n'
import { CaseStateMark, ResultMark, SuiteStateMark, caseTone, suiteTone } from './TestState'
import { FixCommand } from './FixCommand'
import { KindIcon } from './KindIcon'
import { blockerLabel, noticeLabel } from './testLabels'
import { formatBytes, formatDelta, formatDuration, formatMetric, formatPercent } from './testFormat'
import { useRemote } from './useRemote'

afterEach(() => vi.restoreAllMocks())

describe('testFormat', () => {
  it('耗时：毫秒 / 秒 / 分秒；无效值破折号', () => {
    expect(formatDuration(250)).toBe('250ms')
    expect(formatDuration(83_400)).toBe('1m 23s')
    expect(formatDuration(12_340)).toBe('12.3s')
    expect(formatDuration(-1)).toBe('—')
    expect(formatDuration(Number.NaN)).toBe('—')
  })

  it('百分比、字节、变化量、指标', () => {
    expect(formatPercent(80)).toBe('80%')
    expect(formatPercent(78.55)).toBe('78.5%')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB')
    expect(formatDelta(18.34)).toBe('+18.3%')
    expect(formatDelta(-0.6)).toBe('-0.6%')
    expect(formatDelta(null)).toBe('—')
    expect(formatMetric(12.34567)).toBe('12.346')
    expect(formatMetric(900)).toBe('900')
  })
})

describe('testLabels', () => {
  it('阻塞与提示的短标签取自 kernel，按语言选；未知码原样', () => {
    expect(blockerLabel('test-stale', 'zh')).toBe('过期')
    expect(blockerLabel('test-stale', 'en')).toBe('Stale')
    expect(blockerLabel('test-catalog-missing', 'zh')).toBe('目录缺失')
    expect(blockerLabel('nope', 'zh')).toBe('nope')
    expect(blockerLabel('constructor', 'zh')).toBe('constructor')
    expect(noticeLabel('known-failure-fixed', 'zh')).toBe('已修好')
    expect(noticeLabel('nope', 'en')).toBe('nope')
  })
})

describe('TestState', () => {
  it('状态 = 圆点 + 一个词；用例状态词与套件状态词各自来自词表', () => {
    render(<I18nProvider><SuiteStateMark state="stale" testId="s" /><ResultMark result="fail" testId="r" /><CaseStateMark status="known-fail" testId="c" /></I18nProvider>)
    expect(screen.getByTestId('s').textContent).toBe('过期')
    expect(screen.getByTestId('s').querySelector('i')).toBeTruthy()
    expect(screen.getByTestId('r').textContent).toBe('失败')
    expect(screen.getByTestId('c').textContent).toBe('已知失败')
    expect(suiteTone('passed')).toBe('done')
    expect(suiteTone('failed')).toBe('blocked')
    expect(caseTone('flaky')).toBe('pending')
    expect(caseTone('not-run')).toBe('neutral')
  })
})

describe('FixCommand', () => {
  it('命令单行不折行；点复制写入剪贴板并短暂变勾', async () => {
    const write = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true })
    render(<I18nProvider><FixCommand command="tenon test discover --write" testId="fix" /></I18nProvider>)
    const text = screen.getByTestId('fix-text')
    expect(text.textContent).toBe('tenon test discover --write')
    expect(text.className).toContain('whitespace-nowrap')
    expect(text).toHaveAttribute('title', 'tenon test discover --write')
    await userEvent.click(screen.getByTestId('fix-copy'))
    expect(write).toHaveBeenCalledWith('tenon test discover --write')
    await waitFor(() => expect(screen.getByTestId('fix-copy')).toHaveAttribute('data-copied', 'true'))
    expect(screen.getByTestId('fix-copy')).toHaveAttribute('aria-label', '已复制')
  })

  it('剪贴板不可用时不抛错也不变勾', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => { throw new Error('denied') }) }, configurable: true })
    render(<I18nProvider><FixCommand command="x" testId="fix" /></I18nProvider>)
    await userEvent.click(screen.getByTestId('fix-copy'))
    expect(screen.getByTestId('fix-copy')).toHaveAttribute('data-copied', 'false')
  })
})

describe('KindIcon', () => {
  it('已知种类各有图标，未知种类回落到 custom 的图标', () => {
    const { container } = render(<div><KindIcon kind="unit" /><KindIcon kind="benchmark" /><KindIcon kind="made-up" /></div>)
    const icons = [...container.querySelectorAll('svg')]
    expect(icons.map((icon) => icon.getAttribute('data-kind'))).toEqual(['unit', 'benchmark', 'made-up'])
    expect(icons.every((icon) => icon.getAttribute('aria-hidden') === 'true')).toBe(true)
  })
})

describe('useRemote', () => {
  it('加载 → 就绪；reload 重取；晚到的旧响应不覆盖新的', async () => {
    const resolvers: Array<(value: string) => void> = []
    const load = vi.fn((signal: AbortSignal) => new Promise<string>((resolve, reject) => {
      resolvers.push(resolve)
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }))
    const { result, rerender } = renderHook(({ key }) => useRemote(load, [key]), { initialProps: { key: 'a' } })
    expect(result.current.state.status).toBe('loading')
    rerender({ key: 'b' })
    expect(load).toHaveBeenCalledTimes(2)
    await act(async () => { resolvers[1]?.('b-data') })
    expect(result.current.state).toEqual({ status: 'ready', data: 'b-data' })
    await act(async () => { resolvers[0]?.('a-data') })
    expect(result.current.state).toEqual({ status: 'ready', data: 'b-data' })
    act(() => result.current.reload())
    expect(result.current.state.status).toBe('loading')
    expect(load).toHaveBeenCalledTimes(3)
  })

  it('失败进入 error；enabled=false 不请求', async () => {
    const boom = new Error('boom')
    const { result } = renderHook(() => useRemote(async () => { throw boom }, []))
    await waitFor(() => expect(result.current.state).toEqual({ status: 'error', error: boom }))
    const idle = vi.fn(async () => 1)
    renderHook(() => useRemote(idle, [], false))
    expect(idle).not.toHaveBeenCalled()
  })
})
