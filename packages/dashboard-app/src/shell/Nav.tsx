import { useEffect, useRef, useState } from 'react'
import { Bot, FolderKanban, GitBranch, Monitor, Moon, ScanLine, Settings, SlidersHorizontal, Sun, Target, type LucideIcon } from 'lucide-react'
import { useT } from '../i18n'
import type { Lang } from '../i18n/translations'
import { Icon } from './Icon'

/**
 * 外壳左侧图标 rail（v10b `design-demos/v10b-railway-canvas.html` .rail 结构对位；配色一律走
 * token）。2026-07-15 外壳 IA 重构拍板：rail 放视图导航——项目 / 进度 / AFK / 工作台 / 机器 / 宿主计划（六枚
 * lucide 图标 + 小字）。「项目」既是 rail 首枚入口（点入 view='projects' 总览页），也仍由内容区
 * 项目总览直接承担自动发现与项目选择；rail 不重复展示当前项目名。
 *
 * 结构（自上而下）：logo 标（品牌名收进 title 悬浮）→ 分隔线 → 三个竖排日常导航项
 * 项目/进度/工作台（lucide 图标 + 小字，激活态沿 aria-current 变体，进度项挂待拍板红徽标）→ 弹性空档 → 分隔线 → 底部单一「设置」入口；
 * 连接、主题和语言收进锚定浮层。
 * 窄屏（≤720px）切为底部导航并保留短标签，释放横向阅读空间。
 */
export type View = 'overview' | 'projects' | 'progress' | 'afk' | 'workbench' | 'machine' | 'hostPlan'
export type ThemePreference = 'system' | 'light' | 'dark'

/** rail 竖排渲染的三个日常导航项；低频视图由设置面板承载。 */
export type RailView = 'projects' | 'progress' | 'afk' | 'workbench' | 'machine' | 'hostPlan'
export const PRIMARY_VIEWS: RailView[] = ['projects', 'progress', 'workbench']
/** 低频能力通过设置面板进入，保留深链与明确的二级入口。 */
export const SECONDARY_VIEWS: RailView[] = ['afk', 'machine', 'hostPlan']

/** rail 导航项 lucide 图标。 */
const VIEW_ICONS: Record<RailView, LucideIcon> = {
  projects: FolderKanban,
  progress: GitBranch,
  afk: Bot,
  workbench: SlidersHorizontal,
  machine: ScanLine,
  hostPlan: Target,
}

interface NavProps {
  view: View
  onView: (v: View) => void
  lang: Lang
  onLang: (l: Lang) => void
  theme: ThemePreference
  onTheme: (t: ThemePreference) => void
  connected: boolean
  /** 待拍板徽标数（在等你决定的 change 数，currentRoot 语境）——收件箱退役后挂在「进度」导航项上。 */
  decisionCount: number
  /** AFK 待处置徽标数（schedulerHealth.failed，等你处置的失败数，currentRoot 语境）——挂在「AFK」导航项上，>0 才显。 */
  afkCount: number
}

// ── tailwind 类串（状态经 aria-current / data-* 属性挂 aria-*/data-* 变体，测试不断言视觉类名）──
/** rail 竖排按钮骨架（demo .railbtn 对位）：图标 + 小字纵排；窄屏改为保留短标签的底部入口。 */
const RAIL_BTN_CLS =
  'group relative flex min-h-11 w-[72px] cursor-pointer flex-col items-center justify-center gap-[3px] rounded-xl border border-transparent px-1 py-1.5 text-text-3 outline-none transition-[background-color,border-color,color,transform] duration-150 motion-reduce:transition-none hover:bg-fill hover:text-text focus-visible:border-(--accent) focus-visible:ring-[3px] focus-visible:ring-(--ring-blue) active:scale-[.98] motion-reduce:active:scale-100 mobile:h-14 mobile:min-w-11 mobile:flex-1 mobile:rounded-lg mobile:px-0.5 mobile:py-1'
/** rail / bottom-nav 按钮短标签；移动端也可见，避免纯图标入口依赖记忆。 */
const RAIL_LB_CLS = 'max-w-full text-center text-[11px] font-medium leading-[1.2] mobile:whitespace-normal mobile:text-[9px] mobile:leading-[1.05]'
export function Nav({ view, onView, lang, onLang, theme, onTheme, connected, decisionCount, afkCount }: NavProps): JSX.Element {
  const { t } = useT()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const settingsTriggerRef = useRef<HTMLButtonElement>(null)
  const settingsPanelRef = useRef<HTMLElement>(null)
  const connLabel = t(connected ? 'common.connection_live' : 'common.connection_offline')
  const nextTheme: ThemePreference = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system'
  const themeLabel = theme === 'system' ? t('common.theme_system') : theme === 'dark' ? t('common.theme_dark') : t('common.theme_light')

  useEffect(() => {
    if (!settingsOpen) return
    const panel = settingsPanelRef.current
    const firstControl = panel?.querySelector<HTMLElement>(
      'button:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
    )
    firstControl?.focus()

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.key !== 'Escape') return
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return
      event.preventDefault()
      setSettingsOpen(false)
      settingsTriggerRef.current?.focus()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [settingsOpen])

  return (
    <header
      className="sticky top-0 z-40 flex h-screen w-[88px] flex-none flex-col items-center gap-1 border-r border-border bg-card/96 px-2 py-3 backdrop-blur-xl mobile:fixed mobile:bottom-0 mobile:top-auto mobile:h-[calc(72px+env(safe-area-inset-bottom))] mobile:w-full mobile:flex-row mobile:items-start mobile:gap-1 mobile:border-r-0 mobile:border-t mobile:px-2 mobile:pb-[env(safe-area-inset-bottom)] mobile:pt-1.5 mobile:backdrop-blur-none"
      role="banner"
      data-testid="app-navigation"
      data-responsive="rail-to-bottom"
    >
      <div
        className="hidden mobile:fixed mobile:inset-x-0 mobile:top-0 mobile:z-0 mobile:flex mobile:h-14 mobile:items-center mobile:border-b mobile:border-border mobile:bg-card/96 mobile:pl-16 mobile:text-sm mobile:font-bold mobile:text-text mobile:backdrop-blur-xl"
        aria-hidden="true"
      >
        Tenon
      </div>
      {/* 品牌 logo 标（demo .rail .logo 对位）：品牌名收成图标，全名走 title 悬浮。 */}
      <button
        type="button"
        data-testid="nav-overview"
        aria-label={t('solution.nav_label')}
        aria-current={view === 'overview' ? 'page' : undefined}
        className="mb-1.5 grid h-10 w-10 flex-none cursor-pointer place-items-center rounded-xl border border-transparent bg-ink text-ink-fg outline-none transition-colors motion-reduce:transition-none hover:bg-ink-hover focus-visible:border-(--accent) focus-visible:ring-[3px] focus-visible:ring-(--ring-blue) aria-[current=page]:border-(--accent) mobile:fixed mobile:top-1.5 mobile:left-3 mobile:z-10 mobile:mb-0 mobile:h-11 mobile:min-w-11 mobile:w-11"
        title={t('solution.nav_label')}
        onClick={() => {
          setSettingsOpen(false)
          onView('overview')
        }}
      >
        <Icon name="flow" size={16} />
      </button>

      <div className="my-1.5 w-14 flex-none border-t border-border mobile:hidden" aria-hidden="true" />

      <nav className="flex flex-col gap-1 mobile:min-w-0 mobile:flex-1 mobile:flex-row mobile:justify-around mobile:overflow-x-auto mobile:overscroll-x-contain mobile:[scrollbar-width:none]" aria-label={t('nav.primary_label')} data-testid="primary-nav">
        {PRIMARY_VIEWS.map((v) => {
          const IconCmp = VIEW_ICONS[v]
          return (
            <button
              key={v}
              type="button"
              data-testid={`nav-${v}`}
              aria-current={view === v ? 'page' : undefined}
              title={t(`nav.${v}`)}
              className={`${RAIL_BTN_CLS} aria-[current=page]:border-accent-b aria-[current=page]:bg-accent-t aria-[current=page]:font-bold aria-[current=page]:text-accent-d`}
              onClick={() => {
                setSettingsOpen(false)
                onView(v)
              }}
            >
              <IconCmp size={18} strokeWidth={1.75} aria-hidden="true" />
              <span data-testid={`nav-label-${v}`} className={RAIL_LB_CLS}>{t(`nav.${v}`)}</span>
              {v === 'progress' && decisionCount > 0 && (
                <span
                  className="absolute -top-0.5 right-1.5 inline-block h-[17px] min-w-[17px] rounded-[9px] border border-red-b bg-red-t px-[5px] text-center font-mono text-[10.5px] font-bold leading-[17px] text-red-d mobile:-right-1"
                  data-testid="progress-badge"
                  aria-label={t('nav.progress_badge', { count: decisionCount })}
                >
                  {decisionCount}
                </span>
              )}

            </button>
          )
        })}
      </nav>

      <div className="flex-1 mobile:hidden" aria-hidden="true" />
      <div className="my-1.5 w-14 flex-none border-t border-border mobile:hidden" aria-hidden="true" />

      <div className="relative flex flex-none flex-col items-center mobile:mt-1">
        <button
          type="button"
          ref={settingsTriggerRef}
          data-testid="nav-settings"
          aria-label={t('common.settings')}
          aria-expanded={settingsOpen}
          aria-haspopup="dialog"
          aria-controls={settingsOpen ? 'nav-settings-panel' : undefined}
          className={`${RAIL_BTN_CLS} aria-[expanded=true]:border-accent-b aria-[expanded=true]:bg-accent-t aria-[expanded=true]:font-bold aria-[expanded=true]:text-accent-d mobile:w-11 mobile:flex-none`}
          onClick={() => setSettingsOpen((open) => !open)}
        >
          <Settings size={18} strokeWidth={1.75} aria-hidden="true" />
          <span className={RAIL_LB_CLS}>{t('common.settings')}</span>
        </button>

        {settingsOpen && (
          <section
            ref={settingsPanelRef}
            id="nav-settings-panel"
            role="dialog"
            aria-modal="false"
            aria-label={t('common.settings')}
            data-testid="nav-settings-panel"
            className="absolute bottom-0 left-[calc(100%+12px)] z-50 w-[248px] rounded-2xl border border-border bg-card/96 p-3.5 text-left shadow-lg backdrop-blur-2xl mobile:bottom-[calc(100%+12px)] mobile:left-auto mobile:right-0 mobile:max-w-[calc(100vw-24px)]"
          >
            <div className="mb-3 flex items-center justify-between gap-3 border-b border-border pb-3">
              <h2 className="text-sm font-bold text-text">{t('common.settings')}</h2>
              <span
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-text-2"
                data-on={connected ? 'true' : 'false'}
                title={connected ? t('common.connected') : t('common.offline')}
                data-testid="conn-indicator"
              >
                <span className={connected ? 'h-2 w-2 rounded-full bg-green' : 'h-2 w-2 rounded-full bg-red'} aria-hidden="true" />
                {connLabel}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                className="flex min-h-10 items-center justify-center gap-2 rounded-xl border border-border bg-bg px-3 text-xs font-semibold text-text-2 outline-none transition-colors motion-reduce:transition-none hover:bg-fill focus-visible:border-(--accent) focus-visible:ring-[3px] focus-visible:ring-(--ring-blue)"
                data-testid="theme-toggle"
                aria-label={t('common.theme_toggle_current', { theme: themeLabel })}
                onClick={() => onTheme(nextTheme)}
              >
                {theme === 'system' ? <Monitor className="h-4 w-4" aria-hidden="true" /> : theme === 'dark' ? <Moon className="h-4 w-4" aria-hidden="true" /> : <Sun className="h-4 w-4" aria-hidden="true" />}
                {themeLabel}
              </button>
              <button
                type="button"
                className="min-h-10 rounded-xl border border-border bg-bg px-3 text-xs font-semibold text-text-2 outline-none transition-colors motion-reduce:transition-none hover:bg-fill focus-visible:border-(--accent) focus-visible:ring-[3px] focus-visible:ring-(--ring-blue)"
                data-testid="lang-toggle"
                onClick={() => onLang(lang === 'zh' ? 'en' : 'zh')}
              >
                {lang === 'zh' ? t('common.switch_to_english') : t('common.switch_to_chinese')}
              </button>
            </div>

            <div className="mb-3 rounded-xl border border-border bg-bg/70 p-2" data-testid="secondary-nav">
              <p className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wide text-text-3">{t('nav.secondary_label')}</p>
              <div className="grid gap-1">
                {SECONDARY_VIEWS.map((v) => {
                  const IconCmp = VIEW_ICONS[v]
                  return (
                    <button
                      key={v}
                      type="button"
                      data-testid={`nav-${v}`}
                      aria-current={view === v ? 'page' : undefined}
                      className="flex min-h-9 items-center gap-2 rounded-lg px-2.5 text-left text-xs font-semibold text-text-2 transition-colors hover:bg-fill hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent) aria-[current=page]:bg-accent-t aria-[current=page]:text-accent-d"
                      onClick={() => {
                        setSettingsOpen(false)
                        onView(v)
                      }}
                    >
                      <IconCmp size={15} strokeWidth={1.8} aria-hidden="true" />
                      <span>{t(`nav.${v}`)}</span>
                      {v === 'afk' && afkCount > 0 ? <span data-testid="afk-badge" aria-label={t('nav.afk_badge', { count: afkCount })} className="ml-auto rounded-full bg-red-t px-1.5 py-0.5 font-mono text-[10px] text-red-d">{afkCount}</span> : null}
                    </button>
                  )
                })}
              </div>
            </div>
          </section>
        )}
      </div>
    </header>
  )
}
