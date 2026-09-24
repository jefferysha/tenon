import { Fragment, useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { useT } from '../i18n'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { GAP, fitCount, priorityOf } from './facetLayout'
import { FILTER_CHIP_CLS, FilterChip, FilterChipGroup } from './FilterChip'

export { fitCount } from './facetLayout'

export interface FacetOption {
  id: string
  label: string
  count?: number
  /** 缺省 `${group.testId}-${id}`。 */
  testId?: string
}

/**
 * 一个筛选维度。`chips` = 行内单选芯片（每个芯片单独参与溢出）；`menu` = 单个下拉触发器。
 * menu 的 options 含「全部」项（id = allId）；除「全部」外只剩一个取值且未选中时整组隐藏。
 */
export interface FacetGroup {
  id: string
  kind: 'chips' | 'menu'
  label: string
  options: readonly FacetOption[]
  value: string
  onChange: (id: string) => void
  testId: string
  /** 缺省 'all'。 */
  allId?: string
  mono?: boolean
}

export interface FacetBarProps {
  groups: readonly FacetGroup[]
  /** 整条筛选栏的可访问名称。 */
  label: string
  testId: string
  /** 行尾常驻内容（不参与溢出）。 */
  trailing?: ReactNode
  /** 宽度测量；缺省读 DOM。测试注入：按 `data-measure`（container / item:<key> / more / trailing）返回宽度。 */
  measureWidth?: (element: HTMLElement) => number
}

interface Item {
  key: string
  group: FacetGroup
  /** chips 组的单个芯片；menu 组为 null。 */
  option: FacetOption | null
}

function allIdOf(group: FacetGroup): string {
  return group.allId ?? 'all'
}

function isVisibleGroup(group: FacetGroup): boolean {
  if (group.kind === 'chips') return group.options.length > 0
  const values = group.options.filter((option) => option.id !== allIdOf(group))
  return values.length > 1 || group.value !== allIdOf(group)
}

function itemsOf(groups: readonly FacetGroup[]): Item[] {
  const items: Item[] = []
  for (const group of groups) {
    if (!isVisibleGroup(group)) continue
    if (group.kind === 'chips') for (const option of group.options) items.push({ key: `${group.id}:${option.id}`, group, option })
    else items.push({ key: group.id, group, option: null })
  }
  return items
}

const TRIGGER_CLS = 'inline-flex min-h-10 flex-none items-center gap-1 whitespace-nowrap rounded-sm border border-border px-2.5 text-body text-text-2 outline-none hover:bg-fill focus-visible:ring-2 focus-visible:ring-(--accent) data-[active=true]:border-accent-b data-[active=true]:bg-accent-t data-[active=true]:text-(--accent) aria-expanded:bg-fill'
/* 计数用等宽数字（tabular-nums）而非等宽字体，与汉字基线对齐。 */
const COUNT_CLS = 'text-caption tabular-nums text-text-3'

function Count({ value, selected }: { value: number | undefined; selected?: boolean }): JSX.Element | null {
  if (value === undefined) return null
  return <span className={cn(COUNT_CLS, selected && 'text-(--accent)')}>{value}</span>
}

function selectedOption(group: FacetGroup): FacetOption | undefined {
  return group.value === allIdOf(group) ? undefined : group.options.find((option) => option.id === group.value)
}

/** 触发器文字：未选 = 维度名；已选 = 维度名 + 当前值 + 计数。 */
function TriggerContent({ group }: { group: FacetGroup }): JSX.Element {
  const current = selectedOption(group)
  return (
    <>
      <span>{group.label}</span>
      {current !== undefined && (
        <>
          <span className={cn('max-w-40 truncate font-semibold', group.mono && 'font-mono')}>{current.label}</span>
          <Count value={current.count} selected />
        </>
      )}
      <ChevronDown className="size-4 flex-none" aria-hidden="true" />
    </>
  )
}

function RadioItems({ group, options }: { group: FacetGroup; options: readonly FacetOption[] }): JSX.Element {
  return (
    <DropdownMenuRadioGroup value={group.value} onValueChange={group.onChange}>
      {options.map((option) => (
        <DropdownMenuRadioItem
          key={option.id}
          value={option.id}
          className="min-h-10 whitespace-nowrap text-body"
          data-testid={option.testId ?? `${group.testId}-${option.id}`}
        >
          <span className={cn('flex-1', group.mono && option.id !== allIdOf(group) && 'font-mono')}>{option.label}</span>
          <Count value={option.count} />
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  )
}

function MenuFacet({ group }: { group: FacetGroup }): JSX.Element {
  const current = selectedOption(group)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={TRIGGER_CLS}
        data-active={current !== undefined}
        aria-label={current === undefined ? group.label : `${group.label}: ${current.label}`}
        data-testid={group.testId}
      >
        <TriggerContent group={group} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" aria-label={group.label}>
        <RadioItems group={group} options={group.options} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ChipGroup({ group, options }: { group: FacetGroup; options: readonly FacetOption[] }): JSX.Element {
  const checkedShown = options.some((option) => option.id === group.value)
  return (
    <FilterChipGroup label={group.label} testId={group.testId}>
      {options.map((option, index) => (
        <FilterChip
          key={option.id}
          label={option.label}
          {...(option.count === undefined ? {} : { count: option.count })}
          selected={group.value === option.id}
          focusable={checkedShown ? group.value === option.id : index === 0}
          testId={option.testId ?? `${group.testId}-${option.id}`}
          onClick={() => group.onChange(option.id)}
        />
      ))}
    </FilterChipGroup>
  )
}

/**
 * 单行筛选栏：芯片组 + 下拉触发器，永不换行。放不下时从末尾起收进「更多 N」菜单，
 * 任何芯片都整颗显示或整颗收起，不会被裁成半个词。宽度由隐藏的测量层读出（ResizeObserver 跟随列宽）。
 */
export function FacetBar({ groups, label, testId, trailing, measureWidth }: FacetBarProps): JSX.Element {
  const { t } = useT()
  const items = itemsOf(groups)
  const priority = priorityOf(items)
  const [visible, setVisible] = useState(items.length)
  const containerRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const trailingRef = useRef<HTMLDivElement>(null)
  const signature = JSON.stringify(items.map((item) => [item.key, item.option?.label, item.option?.count, item.group.value, item.group.label]))

  const recompute = useCallback((): void => {
    const container = containerRef.current
    const layer = measureRef.current
    if (container === null || layer === null) return
    const width = measureWidth ?? ((element: HTMLElement) => (element === container ? element.clientWidth : element.getBoundingClientRect().width))
    const clones = [...layer.querySelectorAll<HTMLElement>('[data-measure^="item:"]')]
    const more = layer.querySelector<HTMLElement>('[data-measure="more"]')
    const containerWidth = width(container)
    // 未参与布局（jsdom、display:none 的列）时读不到宽度：全部显示，不凭 0 把一切收进「更多」。
    if (containerWidth <= 0) { setVisible(clones.length); return }
    const trailingWidth = trailingRef.current === null ? 0 : width(trailingRef.current) + GAP
    const available = containerWidth - trailingWidth
    setVisible(fitCount(clones.map(width), available, more === null ? 0 : width(more)))
  }, [measureWidth])

  useLayoutEffect(() => { recompute() }, [recompute, signature])
  useLayoutEffect(() => {
    const container = containerRef.current
    if (container === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => recompute())
    observer.observe(container)
    return () => observer.disconnect()
  }, [recompute])

  const kept = new Set(priority.slice(0, visible).map((item) => item.key))
  const shown = items.filter((item) => kept.has(item.key))
  const hidden = items.filter((item) => !kept.has(item.key))
  const hiddenGroups = groups.filter((group) => hidden.some((item) => item.group === group))
  const moreActive = hidden.some((item) => (item.option === null ? item.group.value !== allIdOf(item.group) : item.group.value === item.option.id))

  return (
    <div
      ref={containerRef}
      className="relative flex w-full min-w-0 flex-nowrap items-center gap-1"
      role="group"
      aria-label={label}
      data-testid={testId}
      data-measure="container"
    >
      {groups.filter(isVisibleGroup).map((group) => {
        if (group.kind === 'menu') return shown.some((item) => item.group === group) ? <MenuFacet key={group.id} group={group} /> : null
        const options = shown.filter((item) => item.group === group).flatMap((item) => (item.option === null ? [] : [item.option]))
        return options.length === 0 ? null : <ChipGroup key={group.id} group={group} options={options} />
      })}
      {hidden.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger className={TRIGGER_CLS} data-active={moreActive} data-testid={`${testId}-more`}>
            {t('common.more')}
            <span className={COUNT_CLS}>{hidden.length}</span>
            <ChevronDown className="size-4 flex-none" aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" data-testid={`${testId}-more-menu`}>
            {hiddenGroups.map((group, index) => (
              <Fragment key={group.id}>
                {index > 0 && <DropdownMenuSeparator />}
                <DropdownMenuLabel className="text-caption text-text-3">{group.label}</DropdownMenuLabel>
                <RadioItems
                  group={group}
                  options={group.kind === 'menu' ? group.options : hidden.filter((item) => item.group === group).flatMap((item) => (item.option === null ? [] : [item.option]))}
                />
              </Fragment>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {trailing !== undefined && (
        <div ref={trailingRef} className="ml-auto flex flex-none items-center gap-1" data-measure="trailing">{trailing}</div>
      )}
      {/* 测量层：与真实芯片 / 触发器同样式的静态副本，不可见、不可交互，只为读出单行时的自然宽度。 */}
      <div ref={measureRef} className="pointer-events-none invisible absolute top-0 left-0 flex flex-nowrap" aria-hidden="true">
        {priority.map((item) => (
          item.option === null
            ? <span key={item.key} className={TRIGGER_CLS} data-measure={`item:${item.key}`} data-active={item.group.value !== allIdOf(item.group)}><TriggerContent group={item.group} /></span>
            : <span key={item.key} className={cn(FILTER_CHIP_CLS, item.group.value === item.option.id && 'font-semibold')} data-measure={`item:${item.key}`}>{item.option.label}<Count value={item.option.count} /></span>
        ))}
        <span className={TRIGGER_CLS} data-measure="more">{t('common.more')}<span className={COUNT_CLS}>{items.length}</span><ChevronDown className="size-4" aria-hidden="true" /></span>
      </div>
    </div>
  )
}
