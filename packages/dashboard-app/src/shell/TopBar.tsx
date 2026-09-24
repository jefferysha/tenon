import { useRef } from 'react'
import { Check, ChevronDown, User as UserIcon } from 'lucide-react'
import { DropdownMenu as DropdownMenuPrimitive } from 'radix-ui'
import type { CurrentUserState } from '../api/userClient'
import { useT } from '../i18n'
import type { Lang } from '../i18n/translations'
import { SLIDING_INDICATOR_CLS, useSlidingIndicator } from '../shared/useSlidingIndicator'
import { TopBarSettings } from './TopBarSettings'
import { VIEWS, type ThemePreference, type View } from './views'
import { cn } from '@/lib/utils'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

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
  /** 挂在「工作台」标签右上角的待决策计数；0 时不渲染。 */
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

/** 导航标签：当前页只换字色与字重，浅绿底由导航内的共享指示块滑过去；悬停底只给非当前页。 */
const TAB_CLS =
  'relative inline-flex min-h-10 items-center rounded-sm px-4 py-1.5 text-base font-medium whitespace-nowrap text-text-2 outline-none transition-colors duration-(--dur-fast) ease-(--ease-out) not-aria-[current=page]:hover:bg-fill hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent) aria-[current=page]:font-semibold aria-[current=page]:text-(--accent) motion-reduce:transition-none'
const MENU_BTN_CLS =
  'flex min-h-10 items-center gap-2 rounded-sm px-2.5 text-base font-medium text-text outline-none transition-colors duration-(--dur-fast) ease-(--ease-out) hover:bg-fill focus-visible:ring-2 focus-visible:ring-(--accent) data-[state=open]:bg-fill motion-reduce:transition-none'
/** 项目菜单项（menuitemradio）：当前项 600 字重 + 行尾对勾，不用强调色。 */
const MENU_ITEM_CLS =
  'flex min-h-10 w-full cursor-default items-center gap-2 rounded-sm px-2.5 text-left text-base text-text-2 outline-none select-none data-[highlighted]:bg-fill data-[highlighted]:text-text data-[state=checked]:font-semibold data-[state=checked]:text-text'

/**
 * 顶部横条：logo → 标签（左对齐；工作台右上角挂待决策徽标）→ 用户 → 断线点 → 设置（主题 / 语言两行分段控件）。
 * 项目选择只在左栏；窄屏左栏隐藏时，工作台在这里补一个项目菜单。连接正常时不显示状态点，断线才出现红点。
 * 页面名只在导航高亮里出现，不再有面包屑。项目菜单与设置弹层都是 Radix（键盘、焦点回收、Esc 与点外关闭由它负责）。
 * 状态一律走 aria-* / data-*；testid：top-bar / primary-nav / nav-<view> / nav-indicator / project-switcher /
 * project-menu / project-item-all / project-item-<name> / conn-indicator / progress-badge / top-bar-user /
 * top-bar-user-missing（设置弹层的 testid 见 TopBarSettings）。
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
  const barRef = useRef<HTMLElement>(null)
  const nav = useSlidingIndicator<HTMLElement>()

  const current = projects.find((project) => project.root === currentRoot)
  const currentName = current?.name ?? (currentRoot !== '' ? rootBasename(currentRoot) : t('shell.all_projects'))
  const decisionLabel = t('nav.progress_badge', { count: decisionCount })

  return (
    <header
      ref={barRef}
      className="sticky top-0 z-40 flex h-[var(--topbar-h)] items-center gap-3.5 border-b border-border bg-card px-5 max-[900px]:h-auto max-[900px]:flex-wrap max-[900px]:gap-3 max-[900px]:py-3"
      role="banner"
      data-testid="top-bar"
    >
      <span className="grid size-9 flex-none place-items-center rounded-sm bg-ink text-title font-semibold text-ink-fg" aria-hidden="true">t</span>
      {/* 项目只在左栏选；左栏在窄屏（≤900px）整列隐藏，只有工作台窄屏时由这里代替。 */}
      {view === 'workspace' && (
        <div className="hidden max-[900px]:contents" data-testid="project-switcher-wrap">
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={MENU_BTN_CLS}
                aria-label={t('shell.project_switch_label')}
                data-testid="project-switcher"
              >
                <span className={cn('size-1.5 rounded-full', current === undefined ? 'bg-text-3' : current.ok ? 'bg-green' : 'bg-red')} aria-hidden="true" />
                <span className="max-w-[24ch] truncate" data-testid="project-label">{currentName}</span>
                <ChevronDown className="size-3.5 text-text-3" aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              sideOffset={8}
              aria-label={t('shell.project_menu_label')}
              aria-labelledby={undefined}
              className="min-w-[260px] rounded-md border-0 bg-surface-raised p-1 shadow-(--shadow-2)"
              data-testid="project-menu"
            >
              <DropdownMenuPrimitive.RadioGroup value={currentRoot} onValueChange={onRoot}>
                <DropdownMenuPrimitive.RadioItem value="" className={MENU_ITEM_CLS} data-testid="project-item-all">
                  <span className="min-w-0 flex-1 truncate">{t('shell.all_projects')}</span>
                  <MenuCheck />
                </DropdownMenuPrimitive.RadioItem>
                {projects.map((project) => (
                  <DropdownMenuPrimitive.RadioItem
                    key={project.root}
                    value={project.root}
                    className={MENU_ITEM_CLS}
                    title={project.root}
                    data-testid={`project-item-${project.name}`}
                  >
                    <span className={cn('size-1.5 flex-none rounded-full', project.ok ? 'bg-green' : 'bg-red')} aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">{project.name}</span>
                    <span className="text-caption tabular-nums text-text-3">{project.count}</span>
                    <MenuCheck />
                  </DropdownMenuPrimitive.RadioItem>
                ))}
              </DropdownMenuPrimitive.RadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}

      <nav
        ref={nav.containerRef}
        className="relative isolate ml-4 flex gap-0.5 max-[900px]:order-3 max-[900px]:ml-0 max-[900px]:w-full max-[900px]:overflow-x-auto max-[900px]:pt-1"
        aria-label={t('nav.primary_label')}
        data-testid="primary-nav"
      >
        {VIEWS.map((candidate) => (
          <span key={candidate} className="relative flex items-center">
            <button
              type="button"
              className={TAB_CLS}
              aria-current={view === candidate ? 'page' : undefined}
              data-testid={`nav-${candidate}`}
              onClick={() => onView(candidate)}
            >
              {t(`nav.${candidate}`)}
            </button>
            {candidate === 'workspace' && decisionCount > 0 && (
              // 徽标绝对定位在标签右上角：出现 / 消失都不改导航宽度。与标签是兄弟按钮，不嵌套交互元素；
              // after 伪元素把点击区撑到 40px。
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="absolute -top-1 -right-1 z-10 grid h-5 min-w-5 place-items-center rounded-full bg-amber-t px-1 text-micro font-semibold tabular-nums text-amber-d outline-none after:absolute after:-inset-2.5 after:content-[''] focus-visible:ring-2 focus-visible:ring-(--accent)"
                    aria-label={decisionLabel}
                    data-count={decisionCount}
                    data-testid="progress-badge"
                    onClick={onDecisions}
                  >
                    <span aria-hidden="true">{decisionCount}</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent sideOffset={4}>{decisionLabel}</TooltipContent>
              </Tooltip>
            )}
          </span>
        ))}
        <span ref={nav.indicatorRef} className={cn(SLIDING_INDICATOR_CLS, 'rounded-sm bg-accent-t')} aria-hidden="true" data-testid="nav-indicator" />
      </nav>

      <div className="ml-auto flex items-center gap-3.5">
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
        {/* 连接正常不占位；断线只留一个红点，文字进 Tooltip。可聚焦，键盘也能读到。 */}
        {!connected && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className="grid size-10 place-items-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-(--accent)"
                role="img"
                tabIndex={0}
                aria-label={t('common.offline')}
                data-on="false"
                data-testid="conn-indicator"
              >
                <span className="size-2 rounded-full bg-red" aria-hidden="true" />
              </span>
            </TooltipTrigger>
            <TooltipContent sideOffset={4}>{t('common.offline')}</TooltipContent>
          </Tooltip>
        )}
        <TopBarSettings lang={lang} onLang={onLang} theme={theme} onTheme={onTheme} barRef={barRef} />
      </div>
    </header>
  )
}

/** 项目菜单当前项的行尾对勾；非当前项不占位。 */
function MenuCheck(): JSX.Element {
  return (
    <DropdownMenuPrimitive.ItemIndicator className="flex-none text-text-2">
      <Check className="size-4" aria-hidden="true" />
    </DropdownMenuPrimitive.ItemIndicator>
  )
}
