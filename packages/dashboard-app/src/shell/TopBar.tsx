import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Monitor, Moon, Search, Sun, X } from 'lucide-react'
import { useT } from '../i18n'
import type { Lang } from '../i18n/translations'
import { useGlobalSearch } from './GlobalSearch'
import { VIEWS, type ThemePreference, type View } from './views'
import { cn } from '@/lib/utils'

export interface TopBarProject {
  root: string
  name: string
  count: number
  ok: boolean
}

interface TopBarProps {
  view: View
  onView: (view: View) => void
  projects: readonly TopBarProject[]
  currentRoot: string
  onRoot: (root: string) => void
  connected: boolean
  /** 当前项目不可写时顶部 pill 从「只读视图」变为「项目不可写」并给出原因。 */
  projectWritable: boolean
  lang: Lang
  onLang: (lang: Lang) => void
  theme: ThemePreference
  onTheme: (theme: ThemePreference) => void
  /** 挂在「工作台」标签上的待决定计数；0 不显。 */
  decisionCount: number
  /** 挂在「自动化」标签上的待处置计数；0 不显。 */
  afkCount: number
}

function rootBasename(root: string): string {
  const parts = root.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? root
}

const TAB_CLS =
  'relative rounded-sm px-4 py-1.5 text-base font-medium whitespace-nowrap text-text-2 outline-none transition-colors hover:bg-fill hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent) aria-[current=page]:bg-accent-t aria-[current=page]:font-semibold aria-[current=page]:text-(--accent) motion-reduce:transition-none'
const MENU_BTN_CLS =
  'flex min-h-10 items-center gap-2 rounded-sm px-2.5 text-base font-medium text-text outline-none transition-colors hover:bg-fill focus-visible:ring-2 focus-visible:ring-(--accent) motion-reduce:transition-none'
const POPOVER_CLS = 'absolute top-[calc(100%+8px)] z-50 rounded-md border border-border bg-card p-1.5 shadow-lg'

/**
 * 顶部横条（模板 1:1）：logo → 面包屑「工作空间 / 当前页」→ 项目切换器 → 四标签 → 搜索（`/`）
 * → 只读 pill → 连接状态 → 头像（设置：主题 / 语言）。
 * 状态一律走 aria-* / data-*；testid：top-bar / nav-<view> / project-switcher / project-menu /
 * project-item-<name> / global-search / readonly-pill / conn-indicator / nav-settings / nav-settings-panel /
 * theme-toggle / lang-toggle / progress-badge / afk-badge。
 */
export function TopBar({
  view,
  onView,
  projects,
  currentRoot,
  onRoot,
  connected,
  projectWritable,
  lang,
  onLang,
  theme,
  onTheme,
  decisionCount,
  afkCount,
}: TopBarProps): JSX.Element {
  const { t } = useT()
  const { query, setQuery, inputRef } = useGlobalSearch()
  const [projectOpen, setProjectOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const projectRef = useRef<HTMLDivElement>(null)
  const settingsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!projectOpen && !settingsOpen) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (projectOpen && !projectRef.current?.contains(target)) setProjectOpen(false)
      if (settingsOpen && !settingsRef.current?.contains(target)) setSettingsOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return
      setProjectOpen(false)
      setSettingsOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [projectOpen, settingsOpen])

  const current = projects.find((project) => project.root === currentRoot)
  const currentName = current?.name ?? (currentRoot !== '' ? rootBasename(currentRoot) : t('shell.all_projects'))
  const nextTheme: ThemePreference = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system'
  const themeLabel = theme === 'system' ? t('common.theme_system') : theme === 'dark' ? t('common.theme_dark') : t('common.theme_light')
  const ThemeIcon = theme === 'system' ? Monitor : theme === 'dark' ? Moon : Sun

  return (
    <header
      className="sticky top-0 z-40 flex h-[var(--topbar-h)] items-center gap-6 border-b border-border bg-card px-5 max-[900px]:h-auto max-[900px]:flex-wrap max-[900px]:gap-3 max-[900px]:py-3"
      role="banner"
      data-testid="top-bar"
    >
      <div className="flex min-w-0 items-center gap-3.5">
        <span className="grid size-9 flex-none place-items-center rounded-sm bg-ink text-title font-semibold text-ink-fg" aria-hidden="true">t</span>
        <nav className="flex items-center gap-2 whitespace-nowrap text-base" aria-label={t('navigation.breadcrumbs_label')} data-testid="breadcrumbs">
          <span className="text-text-2">{t('shell.crumb_workspace')}</span>
          <span className="text-text-3" aria-hidden="true">/</span>
          <span className="font-semibold text-text" aria-current="page" data-testid="breadcrumb-page">{t(`nav.${view}`)}</span>
        </nav>
        <div className="relative" ref={projectRef}>
          <button
            type="button"
            className={MENU_BTN_CLS}
            aria-haspopup="menu"
            aria-expanded={projectOpen}
            aria-label={t('shell.project_switch_label')}
            data-testid="project-switcher"
            onClick={() => { setSettingsOpen(false); setProjectOpen((open) => !open) }}
          >
            <span className={cn('size-1.5 rounded-full', current === undefined ? 'bg-text-3' : current.ok ? 'bg-green' : 'bg-red')} aria-hidden="true" />
            <span className="max-w-[24ch] truncate" data-testid="project-label">{currentName}</span>
            <ChevronDown className="size-3.5 text-text-3" aria-hidden="true" />
          </button>
          {projectOpen && (
            <div className={cn(POPOVER_CLS, 'left-0 min-w-[260px]')} role="menu" aria-label={t('shell.project_menu_label')} data-testid="project-menu">
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 rounded-sm px-2.5 py-2 text-left text-base text-text-2 hover:bg-fill data-[on=true]:font-semibold data-[on=true]:text-(--accent)"
                data-on={currentRoot === ''}
                data-testid="project-item-all"
                onClick={() => { onRoot(''); setProjectOpen(false) }}
              >
                {t('shell.all_projects')}
              </button>
              {projects.map((project) => (
                <button
                  key={project.root}
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2 rounded-sm px-2.5 py-2 text-left text-base text-text-2 hover:bg-fill data-[on=true]:font-semibold data-[on=true]:text-(--accent)"
                  data-on={project.root === currentRoot}
                  title={project.root}
                  data-testid={`project-item-${project.name}`}
                  onClick={() => { onRoot(project.root); setProjectOpen(false) }}
                >
                  <span className={cn('size-1.5 flex-none rounded-full', project.ok ? 'bg-green' : 'bg-red')} aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{project.name}</span>
                  <span className="font-mono text-caption text-text-3">{project.count}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <nav className="mx-auto flex gap-0.5 max-[900px]:order-3 max-[900px]:w-full max-[900px]:overflow-x-auto" aria-label={t('nav.primary_label')} data-testid="primary-nav">
        {VIEWS.map((candidate) => (
          <button
            key={candidate}
            type="button"
            className={TAB_CLS}
            aria-current={view === candidate ? 'page' : undefined}
            data-testid={`nav-${candidate}`}
            onClick={() => onView(candidate)}
          >
            {t(`nav.${candidate}`)}
            {candidate === 'progress' && decisionCount > 0 && (
              <span className="ml-1.5 rounded-full bg-amber-t px-1.5 font-mono text-micro font-semibold text-amber-d" data-testid="progress-badge" aria-label={t('nav.progress_badge', { count: decisionCount })}>{decisionCount}</span>
            )}
            {candidate === 'afk' && afkCount > 0 && (
              <span className="ml-1.5 rounded-full bg-red-t px-1.5 font-mono text-micro font-semibold text-red-d" data-testid="afk-badge" aria-label={t('nav.afk_badge', { count: afkCount })}>{afkCount}</span>
            )}
          </button>
        ))}
      </nav>

      <div className="flex items-center gap-3.5 max-[900px]:ml-auto">
        <label className="flex h-10 w-[300px] items-center gap-2 rounded-full border border-border bg-card px-3 text-text-3 focus-within:border-accent-b max-[1279px]:w-[200px] max-[900px]:hidden">
          <Search className="size-4 flex-none" aria-hidden="true" />
          <span className="sr-only">{t('shell.search_label')}</span>
          <input
            ref={inputRef}
            type="search"
            value={query}
            placeholder={t('shell.search_placeholder')}
            className="min-w-0 flex-1 bg-transparent text-base text-text outline-none placeholder:text-text-3"
            data-testid="global-search"
            onChange={(event) => setQuery(event.target.value)}
          />
          <kbd className="rounded-xs border border-border px-1.5 font-mono text-micro text-text-3" aria-hidden="true">/</kbd>
        </label>
        <span
          className={cn(
            'rounded-full border px-3.5 py-1.5 text-base whitespace-nowrap max-[1279px]:hidden',
            projectWritable || currentRoot === '' ? 'border-border text-text-2' : 'border-amber-b bg-amber-t text-amber-d',
          )}
          title={projectWritable || currentRoot === '' ? t('shell.readonly_hint') : t('shell.project_unwritable_hint')}
          data-testid="readonly-pill"
          data-writable={projectWritable}
        >
          {projectWritable || currentRoot === '' ? t('shell.readonly_pill') : t('shell.project_unwritable')}
        </span>
        <span
          className="flex items-center gap-1.5 whitespace-nowrap text-base text-text-2 max-[1279px]:hidden"
          data-on={connected ? 'true' : 'false'}
          title={connected ? t('common.connected') : t('common.offline')}
          data-testid="conn-indicator"
        >
          <span className={cn('size-1.5 rounded-full', connected ? 'bg-green' : 'bg-red')} aria-hidden="true" />
          {t(connected ? 'common.connection_live' : 'common.connection_offline')}
        </span>
        <div className="relative" ref={settingsRef}>
          <button
            type="button"
            className="grid size-8 place-items-center rounded-full bg-(--accent) text-caption font-semibold text-btn-fg outline-none focus-visible:ring-2 focus-visible:ring-(--accent) focus-visible:ring-offset-2"
            aria-label={t('common.settings')}
            aria-expanded={settingsOpen}
            aria-haspopup="dialog"
            aria-controls="nav-settings-panel"
            data-testid="nav-settings"
            onClick={() => { setProjectOpen(false); setSettingsOpen((open) => !open) }}
          >
            {t('shell.avatar')}
          </button>
          {settingsOpen && (
            <section
              id="nav-settings-panel"
              role="dialog"
              aria-modal="false"
              aria-label={t('common.settings')}
              className={cn(POPOVER_CLS, 'right-0 w-[260px] p-3.5')}
              data-testid="nav-settings-panel"
            >
              <div className="mb-3 flex items-center justify-between gap-3 border-b border-border pb-3">
                <h2 className="text-base font-bold text-text">{t('common.settings')}</h2>
                <button
                  type="button"
                  className="grid size-7 place-items-center rounded-sm text-text-3 hover:bg-fill hover:text-text"
                  aria-label={t('common.dialog_close')}
                  onClick={() => setSettingsOpen(false)}
                >
                  <X className="size-3.5" aria-hidden="true" />
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  className="flex min-h-10 items-center justify-center gap-2 rounded-sm border border-border bg-bg px-3 text-caption font-semibold text-text-2 outline-none hover:bg-fill focus-visible:ring-2 focus-visible:ring-(--accent)"
                  data-testid="theme-toggle"
                  aria-label={t('common.theme_toggle_current', { theme: themeLabel })}
                  onClick={() => onTheme(nextTheme)}
                >
                  <ThemeIcon className="size-4" aria-hidden="true" />
                  {themeLabel}
                </button>
                <button
                  type="button"
                  className="min-h-10 rounded-sm border border-border bg-bg px-3 text-caption font-semibold text-text-2 outline-none hover:bg-fill focus-visible:ring-2 focus-visible:ring-(--accent)"
                  data-testid="lang-toggle"
                  onClick={() => onLang(lang === 'zh' ? 'en' : 'zh')}
                >
                  {lang === 'zh' ? t('common.switch_to_english') : t('common.switch_to_chinese')}
                </button>
              </div>
              <p className="mt-3 text-caption leading-5 text-text-3">{t('shell.readonly_hint')}</p>
            </section>
          )}
        </div>
      </div>
    </header>
  )
}
