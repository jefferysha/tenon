import type { ReactNode } from 'react'
import { ChevronLeft, ChevronRight, Search } from 'lucide-react'
import { useT } from '../i18n'
import { cn } from '@/lib/utils'

/**
 * 模板的三列骨架：左列（选择对象，296px，可折叠到 64px）/ 中列（列表，492px）/ 右列（详情，弹性）。
 * 高度 = 视口 - 顶部条，三列各自滚动。≤1279px 时左列强制折叠；≤900px 时纵向堆叠、各列自然高度。
 */
export function ThreeColumns({
  rail,
  list,
  detail,
  railCollapsed,
  listWidth = 'default',
  testId,
}: {
  rail: ReactNode
  list: ReactNode
  detail: ReactNode
  railCollapsed: boolean
  /** narrow = 中列 380px（工作流页：中列只是流程骨架，空间让给右列）。 */
  listWidth?: 'default' | 'narrow'
  testId: string
}): JSX.Element {
  const narrow = listWidth === 'narrow'
  return (
    <div
      className={cn(
        'grid h-[calc(100vh-var(--topbar-h)-var(--banner-h))] min-h-0 bg-bg',
        railCollapsed
          ? (narrow ? 'grid-cols-[64px_380px_minmax(0,1fr)]' : 'grid-cols-[64px_492px_minmax(0,1fr)]')
          : (narrow
            ? 'grid-cols-[296px_380px_minmax(0,1fr)] max-[1279px]:grid-cols-[64px_344px_minmax(0,1fr)]'
            : 'grid-cols-[296px_492px_minmax(0,1fr)] max-[1279px]:grid-cols-[64px_440px_minmax(0,1fr)]'),
        'max-[900px]:h-auto max-[900px]:min-h-[calc(100vh-var(--topbar-h)-var(--banner-h))] max-[900px]:grid-cols-1',
      )}
      data-testid={testId}
      data-rail-collapsed={railCollapsed}
      data-list-width={listWidth}
    >
      {rail}
      {list}
      {detail}
    </div>
  )
}

/** 两栏骨架（工作流页）：左栏导航 300px / 右栏详情弹性；≤900px 纵向堆叠。 */
export function TwoColumns({ nav, detail, testId }: { nav: ReactNode; detail: ReactNode; testId: string }): JSX.Element {
  return (
    <div
      className="grid h-[calc(100vh-var(--topbar-h)-var(--banner-h))] min-h-0 grid-cols-[300px_minmax(0,1fr)] grid-rows-[minmax(0,1fr)] bg-bg max-[900px]:h-auto max-[900px]:grid-rows-none max-[900px]:min-h-[calc(100vh-var(--topbar-h)-var(--banner-h))] max-[900px]:grid-cols-1"
      data-testid={testId}
    >
      {nav}
      {detail}
    </div>
  )
}

export function RailColumn({
  title,
  collapsed,
  onToggle,
  children,
  footer,
  headerAction,
  testId,
}: {
  title: string
  collapsed: boolean
  onToggle: () => void
  children: ReactNode
  footer?: ReactNode
  /** 标题行里、折叠按钮左侧的动作（如「+」）；折叠态也显示。 */
  headerAction?: ReactNode
  testId: string
}): JSX.Element {
  const { t } = useT()
  return (
    <aside
      className={cn(
        'flex min-h-0 flex-col overflow-hidden border-r border-border bg-bg',
        collapsed ? 'px-2 py-4' : 'px-4 pt-5 pb-4 max-[1279px]:px-2 max-[1279px]:py-4',
        'max-[900px]:border-r-0 max-[900px]:border-b',
      )}
      data-testid={testId}
      data-collapsed={collapsed}
    >
      <div className={cn('flex items-center gap-1.5 pb-4', collapsed ? 'flex-col justify-center' : 'justify-between px-1.5 max-[1279px]:flex-col max-[1279px]:justify-center max-[900px]:flex-row max-[900px]:justify-between')}>
        {!collapsed && <span className="mr-auto text-body text-text-2 max-[1279px]:hidden max-[900px]:inline">{title}</span>}
        {headerAction}
        <button
          type="button"
          className="grid size-8 place-items-center rounded-sm border border-border bg-card text-text-2 outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent)"
          aria-label={collapsed ? t('shell.rail_expand') : t('shell.rail_collapse')}
          aria-expanded={!collapsed}
          data-testid={`${testId}-toggle`}
          onClick={onToggle}
        >
          {collapsed ? <ChevronRight className="size-4" aria-hidden="true" /> : <ChevronLeft className="size-4" aria-hidden="true" />}
        </button>
      </div>
      {/* ≤900px 三列堆叠：左列不再是竖向清单，卡片横向流排，避免整宽只剩一个字母。 */}
      <div className="min-h-0 flex-1 overflow-y-auto max-[900px]:[&>ul]:flex max-[900px]:[&>ul]:flex-wrap max-[900px]:[&>ul]:gap-2">{children}</div>
      {footer !== undefined && (
        <div className="mt-3 grid gap-0.5 border-t border-border pt-3 max-[900px]:flex max-[900px]:flex-wrap">{footer}</div>
      )}
    </aside>
  )
}

/** 左列卡片（项目 / 工作流 / 范围 / 机器共用）：首字母方块 + 标题 + 副行 + 右侧计数；选中=浅绿底绿边。 */
export function RailCard({
  mark,
  name,
  meta,
  count,
  selected,
  collapsed,
  tag,
  onClick,
  testId,
}: {
  mark: string
  name: string
  meta?: string
  count?: string | number
  selected: boolean
  collapsed: boolean
  tag?: ReactNode
  onClick: () => void
  testId: string
}): JSX.Element {
  return (
    <button
      type="button"
      className={cn(
        'grid w-full items-center gap-3 rounded-md border border-transparent text-left outline-none transition-colors hover:bg-fill focus-visible:ring-2 focus-visible:ring-(--accent) aria-[current=true]:border-accent-b aria-[current=true]:bg-accent-t motion-reduce:transition-none',
        collapsed ? 'grid-cols-1 justify-items-center p-2 max-[1279px]:grid-cols-1' : 'grid-cols-[auto_minmax(0,1fr)_auto] px-3 py-3 max-[1279px]:grid-cols-1 max-[1279px]:justify-items-center max-[1279px]:p-2',
        'max-[900px]:w-auto max-[900px]:grid-cols-[auto_minmax(0,1fr)] max-[900px]:justify-items-start max-[900px]:gap-2 max-[900px]:px-3 max-[900px]:py-2',
      )}
      aria-current={selected ? 'true' : undefined}
      title={collapsed ? `${name}${meta ? ` · ${meta}` : ''}` : undefined}
      data-testid={testId}
      onClick={onClick}
    >
      <span className="grid size-8 place-items-center rounded-sm border border-border bg-card text-body font-semibold text-text-2 aria-[current=true]:border-accent-b aria-[current=true]:text-(--accent)" aria-hidden="true" aria-current={selected ? 'true' : undefined}>
        {mark}
      </span>
      {!collapsed && (
        <>
          <span className="min-w-0 max-[1279px]:hidden max-[900px]:block">
            <span className={cn('flex items-center gap-1.5 truncate text-base font-semibold', selected ? 'text-(--accent)' : 'text-text')}>
              <span className="truncate">{name}</span>
              {tag}
            </span>
            {meta !== undefined && <span className="block truncate text-caption text-text-2 max-[900px]:hidden">{meta}</span>}
          </span>
          {count !== undefined && (
            <span className={cn('font-mono text-body max-[1279px]:hidden', selected ? 'text-(--accent)' : 'text-text-3')}>{count}</span>
          )}
        </>
      )}
    </button>
  )
}

export function RailFootLink({
  icon,
  label,
  collapsed,
  onClick,
  testId,
  current,
  disabled,
  title,
}: {
  icon: ReactNode
  label: string
  collapsed: boolean
  onClick: () => void
  testId: string
  current?: boolean
  disabled?: boolean
  /** 缺省用 label；禁用时调用方传原因。 */
  title?: string
}): JSX.Element {
  return (
    <button
      type="button"
      className={cn(
        'flex items-center gap-2.5 rounded-sm px-3 py-2 text-base text-text-2 outline-none hover:bg-fill hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent) aria-[current=true]:text-(--accent) disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent',
        collapsed && 'justify-center px-0',
        'max-[1279px]:justify-center max-[1279px]:px-0 max-[900px]:px-3',
      )}
      aria-current={current ? 'true' : undefined}
      title={title ?? label}
      disabled={disabled}
      data-testid={testId}
      onClick={onClick}
    >
      <span className="text-text-3 [&_svg]:size-4" aria-hidden="true">{icon}</span>
      {!collapsed && <span className="max-[1279px]:hidden max-[900px]:inline">{label}</span>}
    </button>
  )
}

/** 中列：eyebrow / H1 / 说明框 / 搜索 / 状态页签 / 列表。 */
export function ListColumn({
  eyebrow,
  title,
  note,
  search,
  chips,
  children,
  testId,
}: {
  eyebrow: string
  title: string
  note?: ReactNode
  search?: { value: string; onChange: (next: string) => void; placeholder: string; label: string; name?: string }
  chips?: ReactNode
  children: ReactNode
  testId: string
}): JSX.Element {
  return (
    <section
      className="flex min-h-0 flex-col overflow-y-auto border-r border-border bg-card px-7 pt-7 pb-10 max-[900px]:border-r-0 max-[900px]:border-b max-[900px]:px-4 max-[900px]:pt-5"
      data-testid={testId}
    >
      {/* 头部各块 shrink-0：列表很长时由本列滚动，而不是把搜索框等头部元素压扁。 */}
      <p className="mb-2.5 shrink-0 text-caption font-semibold uppercase tracking-[.08em] text-(--accent)">{eyebrow}</p>
      <h1 className="mb-5 shrink-0 text-page font-bold tracking-[-.01em] text-text">{title}</h1>
      {note !== undefined && (
        <div className="mb-3 shrink-0 rounded-md border border-border px-4 py-3 text-base text-text-2">{note}</div>
      )}
      {search !== undefined && (
        <label className="mb-4 flex h-11 shrink-0 items-center gap-2 rounded-md border border-border bg-card px-3 text-text-3 focus-within:border-accent-b" data-testid={`${testId}-search-box`}>
          <Search className="size-4 flex-none" aria-hidden="true" />
          <span className="sr-only">{search.label}</span>
          <input
            type="search"
            name={search.name}
            autoComplete="off"
            value={search.value}
            placeholder={search.placeholder}
            className="min-w-0 flex-1 bg-transparent text-base text-text outline-none placeholder:text-text-3"
            data-testid={`${testId}-search`}
            onChange={(event) => search.onChange(event.target.value)}
          />
        </label>
      )}
      {chips !== undefined && <div className="mb-4 flex shrink-0 flex-wrap gap-1" data-testid={`${testId}-chips`}>{chips}</div>}
      {children}
    </section>
  )
}

/** 状态页签芯片（全部 5 / 需要你 2 …）：选中=浅绿底绿字。 */
export function FilterChip({
  label,
  count,
  selected,
  onClick,
  testId,
}: {
  label: string
  count?: number
  selected: boolean
  onClick: () => void
  testId: string
}): JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      className="rounded-sm px-3 py-1.5 text-base font-medium whitespace-nowrap text-text-2 outline-none hover:bg-fill focus-visible:ring-2 focus-visible:ring-(--accent) aria-selected:bg-accent-t aria-selected:font-semibold aria-selected:text-(--accent)"
      data-testid={testId}
      onClick={onClick}
    >
      {label}
      {count !== undefined && <span className={cn('ml-1 text-body', selected ? 'text-(--accent)' : 'text-text-3')}>{count}</span>}
    </button>
  )
}

/** 右列：固定头部 + sheet 页签 + 滚动正文 + 底部动作条。 */
export function DetailColumn({
  header,
  sheets,
  children,
  footer,
  testId,
  panelId,
  labelledBy,
}: {
  header: ReactNode
  sheets?: ReactNode
  children: ReactNode
  footer?: ReactNode
  testId: string
  panelId: string
  labelledBy?: string
}): JSX.Element {
  return (
    <section className="flex min-h-0 min-w-0 flex-col bg-surface-detail" data-testid={testId}>
      <div className="relative min-h-0 flex-1 overflow-y-auto px-8 pt-7 pb-7 max-[900px]:px-4 max-[900px]:pt-5">
        {header}
        {sheets}
        <div
          role="tabpanel"
          id={panelId}
          aria-labelledby={labelledBy}
          className="pt-5"
          data-testid={panelId}
        >
          {children}
        </div>
      </div>
      {footer !== undefined && (
        <footer className="flex flex-none flex-wrap items-center justify-between gap-4 border-t border-border bg-surface-detail px-8 py-4 max-[900px]:px-4">
          {footer}
        </footer>
      )}
    </section>
  )
}

/** 右列空态（未选中对象）。 */
export function DetailEmpty({ title, desc, testId }: { title: string; desc: string; testId: string }): JSX.Element {
  return (
    <section className="flex min-h-0 flex-col items-center justify-center bg-surface-detail px-8 text-center" data-testid={testId}>
      <p className="text-title font-semibold text-text">{title}</p>
      <p className="mt-2 max-w-[40ch] text-base text-text-2">{desc}</p>
    </section>
  )
}

/** 模板的状态 pill：圆点 + 文字 + 浅底。 */
export type PillTone = 'pending' | 'running' | 'done' | 'blocked' | 'neutral'
const PILL_TONE: Record<PillTone, string> = {
  pending: 'bg-amber-t text-amber-d [&>i]:bg-(--amber-d)',
  running: 'bg-info-t text-info-d [&>i]:bg-info',
  done: 'bg-green-t text-green-d [&>i]:bg-green',
  blocked: 'bg-red-t text-red-d [&>i]:bg-red',
  neutral: 'bg-fill text-text-2 [&>i]:bg-text-3',
}
export function StatusPill({ tone, children, testId, title, className }: { tone: PillTone; children: ReactNode; testId?: string; title?: string; className?: string }): JSX.Element {
  return (
    <span
      className={cn('inline-flex max-w-full items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-caption font-semibold', PILL_TONE[tone], className)}
      data-tone={tone}
      data-testid={testId}
      title={title}
    >
      <i className="size-1.5 flex-none rounded-full" aria-hidden="true" />
      <span className="truncate">{children}</span>
    </span>
  )
}
