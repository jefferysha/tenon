/** 顶部条：无面包屑（A3）、待决策徽标常驻 + Tooltip + 点击回调（A6）、设置面板分段控件（G1）。 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n'
import type { Lang } from '../i18n/translations'
import { TopBar } from './TopBar'
import type { ThemePreference } from './views'

function renderBar(over: { decisionCount?: number; onDecisions?: () => void; theme?: ThemePreference; lang?: Lang; onTheme?: (t: ThemePreference) => void; onLang?: (l: Lang) => void } = {}) {
  const props = {
    view: 'progress' as const,
    onView: () => undefined,
    projects: [],
    currentRoot: '',
    onRoot: () => undefined,
    connected: true,
    lang: over.lang ?? ('zh' as Lang),
    onLang: over.onLang ?? (() => undefined),
    theme: over.theme ?? ('system' as ThemePreference),
    onTheme: over.onTheme ?? (() => undefined),
    decisionCount: over.decisionCount ?? 0,
    onDecisions: over.onDecisions,
    user: null,
    onUser: () => undefined,
  }
  const view = render(<I18nProvider><TopBar {...props} /></I18nProvider>)
  return {
    rerender: (count: number) => view.rerender(<I18nProvider><TopBar {...props} decisionCount={count} /></I18nProvider>),
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('TopBar', () => {
  it('没有面包屑：页面名只在导航高亮里出现一次', () => {
    renderBar()
    expect(screen.queryByTestId('breadcrumbs')).toBeNull()
    expect(screen.getAllByText('工作台')).toHaveLength(1)
  })

  it('徽标常驻：0 时占位不可见、不可聚焦；变 1 时同一节点显形，不插入新节点', () => {
    const { rerender } = renderBar({ decisionCount: 0 })
    const badge = screen.getByTestId('progress-badge')
    expect(badge.className.split(/\s+/u)).toContain('invisible')
    expect(badge).toHaveAttribute('tabindex', '-1')
    rerender(3)
    expect(screen.getByTestId('progress-badge')).toBe(badge)
    expect(badge.className.split(/\s+/u)).not.toContain('invisible')
    expect(badge).toHaveTextContent('3')
    expect(badge).toHaveAccessibleName('待决策 3')
  })

  it('聚焦徽标出现 Tooltip「待决策 N」；点击调用 onDecisions', async () => {
    // Radix Tooltip 用 ResizeObserver 量箭头；jsdom 没有它。
    vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} })
    const onDecisions = vi.fn()
    renderBar({ decisionCount: 2, onDecisions })
    const badge = screen.getByTestId('progress-badge')
    // Tab 序：项目切换器 → 工作台 → 徽标。
    await userEvent.tab()
    await userEvent.tab()
    await userEvent.tab()
    expect(badge).toHaveFocus()
    expect(await screen.findByRole('tooltip')).toHaveTextContent('待决策 2')
    fireEvent.click(badge)
    expect(onDecisions).toHaveBeenCalledTimes(1)
  })

  it('设置面板：主题与语言两行分段控件显示当前值，点选即回调目标值', () => {
    const onTheme = vi.fn()
    const onLang = vi.fn()
    renderBar({ theme: 'dark', lang: 'zh', onTheme, onLang })
    fireEvent.click(screen.getByTestId('nav-settings'))
    const theme = screen.getByRole('radiogroup', { name: '主题' })
    expect(within(theme).getAllByRole('radio').map((radio) => radio.textContent)).toEqual(['系统', '浅色', '深色'])
    expect(within(theme).getByRole('radio', { name: '深色' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(within(theme).getByRole('radio', { name: '系统' }))
    expect(onTheme).toHaveBeenCalledWith('system')
    const lang = screen.getByRole('radiogroup', { name: '语言' })
    expect(within(lang).getByRole('radio', { name: '中文' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.keyDown(within(lang).getByRole('radio', { name: '中文' }), { key: 'ArrowRight' })
    expect(onLang).toHaveBeenCalledWith('en')
    expect(screen.getByRole('button', { name: '关闭对话框' }).className.split(/\s+/u)).toContain('size-10')
  })
})
