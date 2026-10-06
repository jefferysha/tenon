import { useCallback, useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import { useOverflowEdges } from './overflowEdges'

export interface TrackTabsProps {
  tabs: ReadonlyArray<{ id: string; label: string | null }>
  selected: string
  busy: boolean
  /** tablist 的无障碍名称。 */
  label: string
  onSelect: (id: string) => void
}

/** jsdom 没有 scrollIntoView，可选调用。 */
function reveal(tab: Element | null | undefined): void {
  tab?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
}

/**
 * 轨道页签条：名称不缩写、不换行，放不下时横向滚动。被藏起来的那一侧用 .scroll-fade-x 渐隐（只在那个方向还有隐藏内容时），
 * 页签不会在中途被硬切掉；选中的页签和键盘焦点所在的页签都滚进可见范围（容器的 scroll-padding 给渐隐留出位置）。
 * 键盘焦点环画在页签框里面（ring-inset，在下划线之上）：条是 overflow 容器，外圈的环会被它裁掉，只剩左右两道细边。页签两侧各留 6px
 * 内边距让环不贴着字，同时用等量负外边距把版面还原（字的位置、页签间距不变），下划线改由 after 伪元素按字宽画在原位；
 * 条自己也带 6px 内边距并用负外边距还原，第一个与最后一个页签的环才不会被条的边缘裁掉。
 * 新建轨道的「+」在条外面，由调用方放在旁边，永远可见。
 */
export function TrackTabs({ tabs, selected, busy, label, onSelect }: TrackTabsProps): JSX.Element {
  const stripRef = useRef<HTMLDivElement>(null)
  // 页签的 id 与名称：数量没变、名称变了（切换语言、内置名按语言取词）也会让页签变宽。
  const signature = tabs.map((tab) => `${tab.id}:${tab.label ?? ''}`).join('|')
  // 用户自己滚过、点过或把焦点移到某个页签之后，尺寸变化不再把选中的页签拉回来；换选或页签变了就重新跟随。
  const manual = useRef(false)
  const revealSelected = useCallback((): void => {
    reveal(stripRef.current?.querySelector('[aria-selected="true"]'))
  }, [])
  const followSelected = useCallback((): void => {
    if (!manual.current) revealSelected()
  }, [revealSelected])
  const { edges, measure } = useOverflowEdges(stripRef, signature, followSelected)
  // 英文轨道名比中文长：选中的页签（含 URL 深链进来的）要滚进可见范围，不留半截。挂载、换选、页签列表载入或名称变化时都要滚；
  // 挂载之后条变窄、字体载入让页签变宽，由上面的尺寸监听补滚。
  useEffect(() => {
    manual.current = false
    revealSelected()
  }, [selected, signature, revealSelected])
  return (
    <div
      ref={stripRef}
      className="scroll-fade-x -mx-1.5 flex min-w-0 items-end gap-3.5 overflow-x-auto px-1.5"
      role="tablist"
      aria-label={label}
      data-testid="wb-tracks"
      data-fade-start={edges.start || undefined}
      data-fade-end={edges.end || undefined}
      onScroll={measure}
      onWheel={() => { manual.current = true }}
      onPointerDown={() => { manual.current = true }}
      onTouchStart={() => { manual.current = true }}
    >
      {tabs.map((tab) => {
        const active = tab.id === selected
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            className={cn("relative -mx-1.5 -mb-px flex-none whitespace-nowrap border-b-2 border-transparent px-1.5 pb-2 text-body outline-none transition-colors after:absolute after:inset-x-1.5 after:-bottom-0.5 after:h-0.5 after:transition-colors after:content-[''] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--accent)", active ? 'font-semibold text-text after:bg-(--accent)' : 'text-text-2 after:bg-transparent hover:text-text')}
            title={tab.label ?? tab.id}
            data-testid={`wb-track-${tab.id}`}
            onFocus={(event) => { manual.current = true; reveal(event.currentTarget) }}
            onClick={() => { if (!busy) onSelect(tab.id) }}
          >
            {tab.label ?? tab.id}
          </button>
        )
      })}
    </div>
  )
}
