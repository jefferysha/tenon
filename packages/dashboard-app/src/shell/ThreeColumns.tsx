import type { ReactNode } from 'react'
import { ChevronLeft, ChevronRight, Search } from 'lucide-react'
import { useT } from '../i18n'
import { cn } from '@/lib/utils'
import { LIST_SELECTED_ARIA } from '../shared/uiRecipes'

export { FilterChip, FilterChipGroup } from '../shared/FilterChip'


/**
 * 模板的三列骨架：左列（选择对象，280px，可折叠到 72px 图标栏）/ 中列（列表，360–420px）/ 右列（详情，弹性）。
 * 高度 = 视口 - 顶部条，三列各自滚动。≤1360px 时左列默认折叠为图标栏（折叠钮隐藏）；≤900px 时纵向堆叠、各列自然高度。
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
          ? (narrow ? 'grid-cols-[72px_380px_minmax(0,1fr)]' : 'grid-cols-[72px_minmax(360px,420px)_minmax(0,1fr)]')
          : (narrow
            ? 'grid-cols-[280px_380px_minmax(0,1fr)] max-[1360px]:grid-cols-[72px_344px_minmax(0,1fr)]'
            : 'grid-cols-[280px_minmax(360px,420px)_minmax(0,1fr)] max-[1360px]:grid-cols-[72px_minmax(360px,420px)_minmax(0,1fr)]'),
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
  lead,
  headerAction,
  testId,
}: {
  title: string
  collapsed: boolean
  onToggle: () => void
  children: ReactNode
  /** 列表之前的首项（如工作台的「所有项目」）；与列表同一滚动区。 */
  lead?: ReactNode
  /** 标题行里、折叠按钮左侧的动作（如「+」）；折叠态也显示。 */
  headerAction?: ReactNode
  testId: string
}): JSX.Element {
  const { t } = useT()
  return (
    <aside
      className={cn(
        'flex min-h-0 flex-col overflow-hidden border-r border-border bg-bg',
        collapsed ? 'px-2 py-4' : 'px-4 pt-5 pb-4 max-[1360px]:px-2 max-[1360px]:py-4',
        'max-[900px]:border-r-0 max-[900px]:border-b',
      )}
      data-testid={testId}
      data-collapsed={collapsed}
    >
      <div className={cn('flex items-center gap-1.5 pb-4', collapsed ? 'flex-col justify-center' : 'justify-between px-1.5 max-[1360px]:flex-col max-[1360px]:justify-center max-[900px]:flex-row max-[900px]:justify-between')}>
        {!collapsed && <span className="mr-auto text-body text-text-2 max-[1360px]:hidden max-[900px]:inline">{title}</span>}
        {headerAction}
        {/* ≤1360px 左列必然折叠，钮无作用即隐藏；≤900px 堆叠后恢复。 */}
        <button
          type="button"
          className="grid size-10 place-items-center rounded-sm border border-border bg-card text-text-2 outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent) max-[1360px]:hidden max-[900px]:grid"
          aria-label={collapsed ? t('shell.rail_expand') : t('shell.rail_collapse')}
          aria-expanded={!collapsed}
          data-testid={`${testId}-toggle`}
          onClick={onToggle}
        >
          {collapsed ? <ChevronRight className="size-4" aria-hidden="true" /> : <ChevronLeft className="size-4" aria-hidden="true" />}
        </button>
      </div>
      {/* ≤900px 三列堆叠：左列不再是竖向清单，卡片横向流排，避免整宽只剩一个字母。 */}
      <div className="min-h-0 flex-1 overflow-y-auto max-[900px]:[&>ul]:flex max-[900px]:[&>ul]:flex-wrap max-[900px]:[&>ul]:gap-2">
        {lead !== undefined && <div className="mb-1 grid gap-1" data-testid={`${testId}-lead`}>{lead}</div>}
        {children}
      </div>
    </aside>
  )
}

/**
 * 左列项（项目 / 库分区共用）：语义图标（不套方块）+ 标题 + 副行 + 右侧计数；行高 44。
 * 选中 = 列表选中态（uiRecipes 的 LIST_SELECTED_ARIA），图标转强调色，标题只加粗不染绿。
 */
export function RailCard({
  mark,
  name,
  meta,
  metaTitle,
  metaMono,
  danger,
  count,
  selected,
  collapsed,
  tag,
  onClick,
  testId,
}: {
  /** 语义图标（lucide 元素）；字母也行，但图标优先。 */
  mark: ReactNode
  name: string
  meta?: string
  /** 副行被截断时的完整文字（如项目完整路径），挂在副行的 title 上。 */
  metaTitle?: string
  /** 副行是标识（路径）时用等宽字。 */
  metaMono?: boolean
  /** 不可用（如不可读的项目）：图标与副行用红色。 */
  danger?: boolean
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
        'grid min-h-11 w-full items-center gap-3 rounded-md text-left outline-none transition-colors duration-(--dur-fast) ease-(--ease-out) not-aria-[current=true]:hover:bg-fill focus-visible:ring-2 focus-visible:ring-(--accent) motion-reduce:transition-none',
        LIST_SELECTED_ARIA,
        collapsed ? 'grid-cols-1 justify-items-center px-2 max-[1360px]:grid-cols-1' : 'grid-cols-[auto_minmax(0,1fr)_auto] px-3 py-1.5 max-[1360px]:grid-cols-1 max-[1360px]:justify-items-center max-[1360px]:px-2 max-[1360px]:py-0',
        'max-[900px]:w-auto max-[900px]:grid-cols-[auto_minmax(0,1fr)] max-[900px]:justify-items-start max-[900px]:gap-2 max-[900px]:px-3 max-[900px]:py-2',
      )}
      aria-current={selected ? 'true' : undefined}
      // 折叠（含 ≤1360px 被迫折叠）时只剩图标：title 既是悬停提示，也是可访问名的兜底。
      title={`${name}${meta ? ` · ${meta}` : ''}`}
      data-testid={testId}
      onClick={onClick}
    >
      <span
        className={cn(
          'grid size-5 place-items-center text-body font-semibold [&_svg]:size-4',
          selected ? 'text-(--accent)' : danger ? 'text-red-d' : 'text-text-3',
        )}
        aria-hidden="true"
        data-testid={`${testId}-mark`}
      >
        {mark}
      </span>
      {!collapsed && (
        <>
          <span className="min-w-0 max-[1360px]:hidden max-[900px]:block">
            <span className={cn('flex items-center gap-1.5 truncate text-base text-text', selected ? 'font-semibold' : 'font-medium')}>
              <span className="truncate">{name}</span>
              {tag}
            </span>
            {meta !== undefined && (
              <span
                className={cn('block truncate text-caption max-[900px]:hidden', metaMono && 'font-mono', danger ? 'text-red-d' : 'text-text-2')}
                title={metaTitle}
                data-testid={`${testId}-meta`}
              >
                {meta}
              </span>
            )}
          </span>
          {count !== undefined && (
            <span className="text-caption tabular-nums text-text-3 max-[1360px]:hidden">{count}</span>
          )}
        </>
      )}
    </button>
  )
}

/** 中列：H1（+ 行尾动作）/ 说明框 / 搜索 / 筛选芯片 / 列表。页面名只在 H1 出现一次，不再有 eyebrow。 */
export function ListColumn({
  title,
  action,
  note,
  search,
  chips,
  chipsLabel,
  children,
  testId,
}: {
  title: string
  /** H1 同行右侧的对象级动作（如「新建」）；不换行。 */
  action?: ReactNode
  note?: ReactNode
  search?: { value: string; onChange: (next: string) => void; placeholder: string; label: string; name?: string }
  chips?: ReactNode
  /** 给了就把芯片行作为一个 radiogroup（单组单选芯片时用）；多组芯片各自用 FilterChipGroup。 */
  chipsLabel?: string
  children: ReactNode
  testId: string
}): JSX.Element {
  return (
    <section
      className="flex min-h-0 flex-col overflow-y-auto border-r border-border bg-card px-7 pt-7 pb-10 max-[900px]:border-r-0 max-[900px]:border-b max-[900px]:px-4 max-[900px]:pt-5"
      data-testid={testId}
    >
      {/* 头部各块 shrink-0：列表很长时由本列滚动，而不是把搜索框等头部元素压扁。 */}
      <div className="mb-5 flex shrink-0 items-center gap-3" data-testid={`${testId}-head`}>
        <h1 className="min-w-0 flex-1 truncate whitespace-nowrap text-page font-bold tracking-[-.01em] text-text">{title}</h1>
        {action !== undefined && <div className="flex flex-none items-center gap-2" data-testid={`${testId}-action`}>{action}</div>}
      </div>
      {note !== undefined && (
        <div className="mb-3 shrink-0 rounded-md border border-border px-4 py-3 text-base text-text-2">{note}</div>
      )}
      {search !== undefined && (
        <label
          className="mb-4 flex h-11 shrink-0 items-center gap-2 rounded-md border border-border bg-card px-3 text-text-3 transition-[border-color,box-shadow] focus-within:border-(--accent) focus-within:ring-2 focus-within:ring-(--accent)/25 motion-reduce:transition-none"
          data-testid={`${testId}-search-box`}
        >
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
      {chips !== undefined && (
        <div
          className="mb-4 flex min-w-0 shrink-0 flex-nowrap items-center gap-1"
          role={chipsLabel !== undefined ? 'radiogroup' : undefined}
          aria-label={chipsLabel}
          data-chip-group=""
          data-testid={`${testId}-chips`}
        >
          {chips}
        </div>
      )}
      {children}
    </section>
  )
}

/** 右列：头部（H1 + 旁边的 ⋯）+ sheet 页签 + 滚动正文。没有底部动作条：动作放在对象旁。 */
export function DetailColumn({
  header,
  sheets,
  children,
  testId,
  panelId,
  labelledBy,
}: {
  header: ReactNode
  sheets?: ReactNode
  children: ReactNode
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
    </section>
  )
}

/** 右列空态（未选中对象）：只有一个名词短语，不配副标题。 */
export function DetailEmpty({ title, testId }: {
  title: string
  testId: string
}): JSX.Element {
  return (
    <section className="flex min-h-0 flex-col items-center justify-center bg-surface-detail px-8 text-center" data-testid={testId}>
      <p className="whitespace-nowrap text-title font-semibold text-text">{title}</p>
    </section>
  )
}

/**
 * 状态标记：语义色圆点 + 同色文字，无底色无药丸（色不单独承载语义，文字总在）。
 * 名字沿用 StatusPill 以保持调用方兼容。justify-self-start：放进 grid 头部时是内容宽度。
 */
export type PillTone = 'pending' | 'running' | 'done' | 'blocked' | 'neutral'
const PILL_TONE: Record<PillTone, string> = {
  pending: 'text-amber-d [&>i]:bg-(--amber-d)',
  running: 'text-info-d [&>i]:bg-info',
  done: 'text-green-d [&>i]:bg-green',
  blocked: 'text-red-d [&>i]:bg-red',
  neutral: 'text-text-2 [&>i]:bg-text-3',
}
export function StatusPill({ tone, children, testId, title, className }: { tone: PillTone; children: ReactNode; testId?: string; title?: string; className?: string }): JSX.Element {
  return (
    <span
      className={cn('inline-flex max-w-full items-center gap-1.5 justify-self-start whitespace-nowrap text-caption font-semibold', PILL_TONE[tone], className)}
      data-tone={tone}
      data-testid={testId}
      title={title}
    >
      <i className="size-1.5 flex-none rounded-full" aria-hidden="true" />
      <span className="truncate">{children}</span>
    </span>
  )
}
