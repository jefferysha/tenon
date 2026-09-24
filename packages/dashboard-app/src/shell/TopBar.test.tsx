/**
 * 顶部条：无面包屑、导航带共享指示块、待决策徽标（0 不渲染、绝对定位不挤导航）、项目菜单只在工作台窄屏出现、
 * 项目菜单与设置弹层是 Radix（键盘可操作）、设置弹层顶边对齐顶栏下沿、连接正常不显示点、断线只留红点（文字进 Tooltip）。
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Flip } from 'gsap/Flip'
import { I18nProvider } from '../i18n'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Lang } from '../i18n/translations'
import { TopBar, type TopBarProject } from './TopBar'
import type { ThemePreference, View } from './views'

const PROJECTS: TopBarProject[] = [
  { root: '/w/alpha', name: 'alpha', count: 3, ok: true },
  { root: '/w/beta', name: 'beta', count: 1, ok: false },
]

interface Over {
  decisionCount?: number
  onDecisions?: () => void
  theme?: ThemePreference
  lang?: Lang
  onTheme?: (t: ThemePreference) => void
  onLang?: (l: Lang) => void
  onRoot?: (root: string) => void
  currentRoot?: string
  connected?: boolean
  view?: View
}

function renderBar(over: Over = {}) {
  const props = {
    view: over.view ?? ('workspace' as View),
    onView: () => undefined,
    projects: PROJECTS,
    currentRoot: over.currentRoot ?? '',
    onRoot: over.onRoot ?? (() => undefined),
    connected: over.connected ?? true,
    lang: over.lang ?? ('zh' as Lang),
    onLang: over.onLang ?? (() => undefined),
    theme: over.theme ?? ('system' as ThemePreference),
    onTheme: over.onTheme ?? (() => undefined),
    decisionCount: over.decisionCount ?? 0,
    onDecisions: over.onDecisions,
    user: null,
    onUser: () => undefined,
  }
  const view = render(<I18nProvider><TooltipProvider><TopBar {...props} /></TooltipProvider></I18nProvider>)
  return {
    rerender: (next: Partial<typeof props>) => view.rerender(<I18nProvider><TooltipProvider><TopBar {...props} {...next} /></TooltipProvider></I18nProvider>),
  }
}

const classesOf = (element: Element): string[] => element.className.split(/\s+/u)

beforeEach(() => {
  // Radix Tooltip / Popper 用 ResizeObserver 量尺寸；jsdom 没有它。
  vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('TopBar', () => {
  it('没有面包屑：页面名只在导航高亮里出现一次', () => {
    renderBar()
    expect(screen.queryByTestId('breadcrumbs')).toBeNull()
    expect(screen.getAllByText('工作台')).toHaveLength(1)
  })

  it('导航左对齐（不居中）；项目只在左栏选：顶栏的项目菜单只在工作台窄屏出现', () => {
    const { rerender } = renderBar()
    const nav = screen.getByTestId('primary-nav')
    expect(classesOf(nav)).toContain('ml-4')
    expect(classesOf(nav)).not.toContain('mx-auto')
    // 宽屏隐藏（左栏在），≤900px 左栏整列隐藏时才显示。
    expect(classesOf(screen.getByTestId('project-switcher-wrap'))).toEqual(expect.arrayContaining(['hidden', 'max-[900px]:contents']))
    rerender({ view: 'library' })
    expect(screen.queryByTestId('project-switcher')).toBeNull()
    rerender({ view: 'workflow' })
    expect(screen.queryByTestId('project-switcher')).toBeNull()
  })

  it('连接正常时不显示状态点；断线才出现红点', () => {
    const { rerender } = renderBar({ connected: true })
    expect(screen.queryByTestId('conn-indicator')).toBeNull()
    rerender({ connected: false })
    expect(screen.getByTestId('conn-indicator')).toHaveAttribute('data-on', 'false')
  })

  it('语言名永远用各自的语言：英文界面里也是「中文 / English」', async () => {
    localStorage.setItem('tenon-dashboard-lang', 'en')
    renderBar({ lang: 'en' })
    fireEvent.click(screen.getByTestId('nav-settings'))
    await screen.findByTestId('nav-settings-panel')
    const lang = screen.getByRole('radiogroup', { name: 'Language' })
    expect(within(lang).getAllByRole('radio').map((radio) => radio.textContent)).toEqual(['中文', 'English'])
    expect(screen.getByTestId('nav-workspace')).toHaveTextContent('Workspace')
    localStorage.removeItem('tenon-dashboard-lang')
  })

  it('徽标：0 时不渲染；>0 时绝对定位在工作台标签右上角，不占导航宽度', () => {
    const { rerender } = renderBar({ decisionCount: 0 })
    expect(screen.queryByTestId('progress-badge')).toBeNull()
    rerender({ decisionCount: 3 })
    const badge = screen.getByTestId('progress-badge')
    expect(badge).toHaveTextContent('3')
    expect(badge).toHaveAccessibleName('待决策 3')
    expect(classesOf(badge)).toEqual(expect.arrayContaining(['absolute', '-top-1', '-right-1', 'rounded-full', 'bg-amber-t', 'text-amber-d', 'tabular-nums', 'min-w-5', 'h-5']))
    // 与工作台标签是兄弟按钮，不嵌套交互元素；共用一个相对定位的包裹。
    const tab = screen.getByTestId('nav-workspace')
    expect(tab).not.toContainElement(badge)
    expect(badge.parentElement).toBe(tab.parentElement)
    expect(classesOf(tab.parentElement!)).toContain('relative')
    rerender({ decisionCount: 0 })
    expect(screen.queryByTestId('progress-badge')).toBeNull()
  })

  it('聚焦徽标出现 Tooltip「待决策 N」；点击调用 onDecisions', async () => {
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

  it('当前页：字色 + 字重，选中底色来自导航内的共享指示块；切页时指示块用 Flip 滑动', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }))
    const from = vi.spyOn(Flip, 'from')
    const { rerender } = renderBar({ view: 'workspace' })
    const tab = screen.getByTestId('nav-workspace')
    expect(tab).toHaveAttribute('aria-current', 'page')
    expect(classesOf(tab).some((name) => name.startsWith('aria-[current=page]:bg-'))).toBe(false)
    const indicator = screen.getByTestId('nav-indicator')
    expect(indicator).toHaveAttribute('aria-hidden', 'true')
    expect(indicator).toHaveAttribute('data-placed', 'true')
    expect(classesOf(indicator)).toEqual(expect.arrayContaining(['bg-accent-t', 'rounded-sm']))
    rerender({ view: 'skills' })
    await act(async () => { await Promise.resolve() })
    expect(from).toHaveBeenCalledTimes(1)
    expect(from.mock.calls[0]?.[1]).toMatchObject({ duration: 0.22, ease: 'power3.out' })
  })

  it('当前页切换在 reduced-motion 下指示块直接到位，不动画', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), media: query, addEventListener: () => undefined, removeEventListener: () => undefined }))
    const from = vi.spyOn(Flip, 'from')
    const { rerender } = renderBar({ view: 'workspace' })
    rerender({ view: 'library' })
    await act(async () => { await Promise.resolve() })
    expect(from).not.toHaveBeenCalled()
    expect(screen.getByTestId('nav-indicator')).toHaveAttribute('data-placed', 'true')
  })

  it('项目菜单（Radix）：Enter 打开、方向键移动、Enter 选中；当前项为 menuitemradio checked', async () => {
    const user = userEvent.setup()
    const onRoot = vi.fn()
    renderBar({ onRoot, currentRoot: '/w/alpha' })
    const trigger = screen.getByTestId('project-switcher')
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
    trigger.focus()
    await user.keyboard('{Enter}')
    const menu = await screen.findByTestId('project-menu')
    expect(menu).toHaveAttribute('role', 'menu')
    expect(menu).toHaveAccessibleName('项目列表')
    expect(within(menu).getByTestId('project-item-alpha')).toHaveAttribute('role', 'menuitemradio')
    expect(within(menu).getByTestId('project-item-alpha')).toHaveAttribute('aria-checked', 'true')
    expect(within(menu).getByTestId('project-item-all')).toHaveAttribute('aria-checked', 'false')
    expect(within(menu).getByTestId('project-item-beta')).toHaveAttribute('title', '/w/beta')
    await user.keyboard('{ArrowDown}')
    await user.keyboard('{ArrowDown}')
    await user.keyboard('{Enter}')
    expect(onRoot).toHaveBeenCalledTimes(1)
    expect(onRoot).toHaveBeenCalledWith('/w/beta')
    expect(screen.queryByTestId('project-menu')).toBeNull()
    expect(trigger).toHaveFocus()
  })

  it('项目菜单：点选项目回调 root；Esc 关闭并把焦点还给切换器', async () => {
    const user = userEvent.setup()
    const onRoot = vi.fn()
    renderBar({ onRoot })
    await user.click(screen.getByTestId('project-switcher'))
    await user.click(await screen.findByTestId('project-item-beta'))
    expect(onRoot).toHaveBeenCalledWith('/w/beta')
    await user.click(screen.getByTestId('project-switcher'))
    await screen.findByTestId('project-menu')
    await user.keyboard('{Escape}')
    expect(screen.queryByTestId('project-menu')).toBeNull()
    expect(screen.getByTestId('project-switcher')).toHaveFocus()
  })

  it('设置面板：主题与语言两行分段控件显示当前值，点选即回调目标值；滑块是共享指示块', async () => {
    const onTheme = vi.fn()
    const onLang = vi.fn()
    renderBar({ theme: 'dark', lang: 'zh', onTheme, onLang })
    fireEvent.click(screen.getByTestId('nav-settings'))
    const panel = await screen.findByTestId('nav-settings-panel')
    expect(panel).toHaveAttribute('role', 'dialog')
    expect(screen.getByTestId('nav-settings')).toHaveAttribute('aria-expanded', 'true')
    const theme = screen.getByRole('radiogroup', { name: '主题' })
    expect(within(theme).getAllByRole('radio').map((radio) => radio.textContent)).toEqual(['系统', '浅色', '深色'])
    expect(within(theme).getByRole('radio', { name: '深色' })).toHaveAttribute('aria-checked', 'true')
    expect(classesOf(screen.getByTestId('theme-toggle-indicator'))).toEqual(expect.arrayContaining(['bg-card', 'shadow-sm']))
    fireEvent.click(within(theme).getByRole('radio', { name: '系统' }))
    expect(onTheme).toHaveBeenCalledWith('system')
    const lang = screen.getByRole('radiogroup', { name: '语言' })
    expect(within(lang).getAllByRole('radio').map((radio) => radio.textContent)).toEqual(['中文', 'English'])
    expect(within(lang).getByRole('radio', { name: '中文' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.keyDown(within(lang).getByRole('radio', { name: '中文' }), { key: 'ArrowRight' })
    expect(onLang).toHaveBeenCalledWith('en')
    const close = screen.getByRole('button', { name: '关闭对话框' })
    expect(classesOf(close)).toContain('size-10')
    fireEvent.click(close)
    expect(screen.queryByTestId('nav-settings-panel')).toBeNull()
  })

  it('设置弹层顶边对齐顶栏下沿：sideOffset = 顶栏底边 - 齿轮底边', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const bottom = this.dataset.testid === 'top-bar' ? 68 : this.dataset.testid === 'nav-settings' ? 54 : 0
      return { left: 0, top: 0, right: 0, bottom, width: 0, height: bottom, x: 0, y: 0, toJSON: () => ({}) }
    })
    renderBar()
    fireEvent.click(screen.getByTestId('nav-settings'))
    expect(await screen.findByTestId('nav-settings-panel')).toHaveAttribute('data-side-offset', '14')
  })

  it('设置弹层：Esc 关闭', async () => {
    const user = userEvent.setup()
    renderBar()
    await user.click(screen.getByTestId('nav-settings'))
    await screen.findByTestId('nav-settings-panel')
    await user.keyboard('{Escape}')
    expect(screen.queryByTestId('nav-settings-panel')).toBeNull()
  })

  it('连接状态只留状态点，文字进 Tooltip；可聚焦', async () => {
    renderBar({ connected: false })
    const conn = screen.getByTestId('conn-indicator')
    expect(conn).toHaveAttribute('data-on', 'false')
    expect(conn.textContent).toBe('')
    expect(conn).toHaveAccessibleName('连接断开——数据可能过期')
    conn.focus()
    expect(await screen.findByRole('tooltip')).toHaveTextContent('连接断开——数据可能过期')
  })
})
