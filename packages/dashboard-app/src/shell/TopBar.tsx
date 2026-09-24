import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, Monitor, Moon, Settings, Sun, User as UserIcon, X } from 'lucide-react'
import type { CurrentUserState } from '../api/userClient'
import { useT } from '../i18n'
import type { Lang } from '../i18n/translations'
import { handleRadioKey } from '../shared/radioKeyboard'
import { VIEWS, type ThemePreference, type View } from './views'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

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
  lang: Lang
  onLang: (lang: Lang) => void
  theme: ThemePreference
  onTheme: (theme: ThemePreference) => void
  /** 挂在「工作台」标签旁的待决策计数；徽标常驻，0 时占位不可见。 */
  decisionCount: number
  /** 点徽标：打开工作台并筛到「需要你」。缺省时徽标只展示。 */
  onDecisions?: () => void
  /** Declared user; null while loading or when the request failed. */
  user: CurrentUserState | null
  onUser: () => void
}

function rootBasename(root: string): string {
  const parts = root.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? root
}

const TAB_CLS =
  'relative inline-flex min-h-10 items-center rounded-sm px-4 py-1.5 text-base font-medium whitespace-nowrap text-text-2 outline-none transition-colors hover:bg-fill hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent) aria-[current=page]:bg-accent-t aria-[current=page]:font-semibold aria-[current=page]:text-(--accent) motion-reduce:transition-none'
const MENU_BTN_CLS =
  'flex min-h-10 items-center gap-2 rounded-sm px-2.5 text-base font-medium text-text outline-none transition-colors hover:bg-fill focus-visible:ring-2 focus-visible:ring-(--accent) motion-reduce:transition-none'
const SEGMENT_CLS =
  'inline-flex min-h-10 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-sm px-2 text-caption font-semibold text-text-2 outline-none transition-colors hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent) aria-checked:bg-card aria-checked:text-text aria-checked:shadow-sm motion-reduce:transition-none'
const THEMES: readonly { value: ThemePreference; icon: typeof Monitor; key: string }[] = [
  { value: 'system', icon: Monitor, key: 'common.theme_system' },
  { value: 'light', icon: Sun, key: 'common.theme_light' },
  { value: 'dark', icon: Moon, key: 'common.theme_dark' },
]
const LANGS: readonly { value: Lang; key: string }[] = [
  { value: 'zh', key: 'common.switch_to_chinese' },
  { value: 'en', key: 'common.switch_to_english' },
]
const POPOVER_CLS = 'absolute top-[calc(100%+8px)] z-50 rounded-md border border-border bg-card p-1.5 shadow-lg'

/**
 * 顶部横条：logo → 项目切换器 → 标签（工作台旁常驻待决策徽标）→ 用户 → 连接状态 → 设置（主题 / 语言
 * 两行分段控件）。页面名只在导航高亮里出现，不再有面包屑。
 * 状态一律走 aria-* / data-*；testid：top-bar / nav-<view> / project-switcher / project-menu /
 * project-item-<name> / conn-indicator / nav-settings / nav-settings-panel /
 * theme-toggle（radiogroup）/ theme-option-<pref> / lang-toggle（radiogroup）/ lang-option-<lang> /
 * progress-badge / top-bar-user / top-bar-user-missing。
 */
export function TopBar({
  view,
  onView,
  projects,
  currentRoot,
  onRoot,
  connected,
  lang,
  onLang,
  theme,
  onTheme,
  decisionCount,
  onDecisions,
  user,
  onUser,
}: TopBarProps): JSX.Element {
  const { t } = useT()
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
  const decisionLabel = t('nav.progress_badge', { count: decisionCount })
  const hasDecisions = decisionCount > 0

  return (
    <header
      className="sticky top-0 z-40 flex h-[var(--topbar-h)] items-center gap-6 border-b border-border bg-card px-5 max-[900px]:h-auto max-[900px]:flex-wrap max-[900px]:gap-3 max-[900px]:py-3"
      role="banner"
      data-testid="top-bar"
    >
      <div className="flex min-w-0 items-center gap-3.5">
        <span className="grid size-9 flex-none place-items-center rounded-sm bg-ink text-title font-semibold text-ink-fg" aria-hidden="true">t</span>
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
          <span key={candidate} className="flex items-center">
            <button
              type="button"
              className={TAB_CLS}
              aria-current={view === candidate ? 'page' : undefined}
              data-testid={`nav-${candidate}`}
              onClick={() => onView(candidate)}
            >
              {t(`nav.${candidate}`)}
            </button>
            {candidate === 'progress' && (
              // 徽标常驻占位：计数从 0 变 1 时不挤动其余标签；0 时不可见、不可聚焦。
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className={cn(
                        'grid min-h-10 min-w-10 place-items-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-(--accent)',
                        !hasDecisions && 'invisible',
                      )}
                      aria-label={decisionLabel}
                      aria-hidden={hasDecisions ? undefined : true}
                      tabIndex={hasDecisions ? undefined : -1}
                      disabled={!hasDecisions}
                      data-count={decisionCount}
                      data-testid="progress-badge"
                      onClick={onDecisions}
                    >
                      <span className="min-w-6 rounded-full bg-amber-t px-1.5 text-center font-mono text-micro font-semibold text-amber-d" aria-hidden="true">{decisionCount}</span>
                    </button>
                  </TooltipTrigger>
                  {hasDecisions && <TooltipContent sideOffset={4}>{decisionLabel}</TooltipContent>}
                </Tooltip>
              </TooltipProvider>
            )}
          </span>
        ))}
      </nav>

      <div className="flex items-center gap-3.5 max-[900px]:ml-auto">
        {user?.kind === 'set' && (
          <button
            type="button"
            className={cn(MENU_BTN_CLS, 'max-w-[20ch]')}
            title={user.user.id}
            aria-label={t('shell.user')}
            data-source={user.user.source}
            data-testid="top-bar-user"
            onClick={onUser}
          >
            <UserIcon className="size-4 flex-none text-text-3" aria-hidden="true" />
            <span className="truncate whitespace-nowrap">{user.user.name}</span>
          </button>
        )}
        {user?.kind === 'missing' && (
          <button
            type="button"
            className={cn(MENU_BTN_CLS, 'text-amber-d')}
            aria-label={t('shell.user')}
            data-testid="top-bar-user-missing"
            onClick={onUser}
          >
            <UserIcon className="size-4 flex-none" aria-hidden="true" />
            <span className="whitespace-nowrap">{t('shell.user_unset')}</span>
          </button>
        )}
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
            className="grid size-10 place-items-center rounded-sm border border-border bg-card text-text-2 outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent)"
            aria-label={t('common.settings')}
            aria-expanded={settingsOpen}
            aria-haspopup="dialog"
            aria-controls="nav-settings-panel"
            data-testid="nav-settings"
            onClick={() => { setProjectOpen(false); setSettingsOpen((open) => !open) }}
          >
            <Settings className="size-4" aria-hidden="true" />
          </button>
          {settingsOpen && (
            <section
              id="nav-settings-panel"
              role="dialog"
              aria-modal="false"
              aria-label={t('common.settings')}
              className={cn(POPOVER_CLS, 'right-0 w-[320px] p-3.5')}
              data-testid="nav-settings-panel"
            >
              <div className="mb-3 flex items-center justify-between gap-3 border-b border-border pb-3">
                <h2 className="text-base font-bold text-text">{t('common.settings')}</h2>
                <button
                  type="button"
                  className="grid size-10 place-items-center rounded-sm text-text-3 outline-none hover:bg-fill hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent)"
                  aria-label={t('common.dialog_close')}
                  onClick={() => setSettingsOpen(false)}
                >
                  <X className="size-3.5" aria-hidden="true" />
                </button>
              </div>
              <div className="grid gap-3">
                <SegmentRow label={t('common.theme_toggle')} testId="theme-toggle">
                  {THEMES.map((option, index) => {
                    const Icon = option.icon
                    return (
                      <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={theme === option.value}
                        tabIndex={theme === option.value ? 0 : -1}
                        className={SEGMENT_CLS}
                        data-testid={`theme-option-${option.value}`}
                        onClick={() => onTheme(option.value)}
                        onKeyDown={(event) => handleRadioKey(event, index, THEMES.length, (next) => onTheme(THEMES[next]?.value ?? option.value))}
                      >
                        <Icon className="size-4" aria-hidden="true" />
                        {t(option.key)}
                      </button>
                    )
                  })}
                </SegmentRow>
                <SegmentRow label={t('common.language')} testId="lang-toggle">
                  {LANGS.map((option, index) => (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={lang === option.value}
                      tabIndex={lang === option.value ? 0 : -1}
                      lang={option.value === 'zh' ? 'zh-CN' : 'en'}
                      className={SEGMENT_CLS}
                      data-testid={`lang-option-${option.value}`}
                      onClick={() => onLang(option.value)}
                      onKeyDown={(event) => handleRadioKey(event, index, LANGS.length, (next) => onLang(LANGS[next]?.value ?? option.value))}
                    >
                      {t(option.key)}
                    </button>
                  ))}
                </SegmentRow>
              </div>
            </section>
          )}
        </div>
      </div>
    </header>
  )
}

/** 设置面板的一行：左侧名词标签 + 右侧分段控件（radiogroup，显示当前值，点选即生效）。 */
function SegmentRow({ label, testId, children }: { label: string; testId: string; children: ReactNode }): JSX.Element {
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3">
      <span className="whitespace-nowrap text-caption font-semibold text-text-2" aria-hidden="true">{label}</span>
      <div className="flex gap-0.5 rounded-md bg-fill p-0.5" role="radiogroup" aria-label={label} data-testid={testId}>
        {children}
      </div>
    </div>
  )
}
