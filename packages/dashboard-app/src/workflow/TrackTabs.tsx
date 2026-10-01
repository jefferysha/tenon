import { useEffect, useRef } from 'react'
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
 * 新建轨道的「+」在条外面，由调用方放在旁边，永远可见。
 */
export function TrackTabs({ tabs, selected, busy, label, onSelect }: TrackTabsProps): JSX.Element {
  const stripRef = useRef<HTMLDivElement>(null)
  const { edges, measure } = useOverflowEdges(stripRef, tabs.map((tab) => `${tab.id}:${tab.label ?? ''}`).join('|'))
  // 英文轨道名比中文长：选中的页签（含 URL 深链进来的）要滚进可见范围，不留半截。
  useEffect(() => {
    reveal(stripRef.current?.querySelector('[aria-selected="true"]'))
  }, [selected, tabs.length])
  return (
    <div
      ref={stripRef}
      className="scroll-fade-x flex min-w-0 items-end gap-3.5 overflow-x-auto"
      role="tablist"
      aria-label={label}
      data-testid="wb-tracks"
      data-fade-start={edges.start || undefined}
      data-fade-end={edges.end || undefined}
      onScroll={measure}
    >
      {tabs.map((tab) => {
        const active = tab.id === selected
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            className={cn('-mb-px flex-none whitespace-nowrap border-b-2 pb-2 text-body outline-none transition-colors focus-visible:ring-2 focus-visible:ring-(--accent)', active ? 'border-(--accent) font-semibold text-text' : 'border-transparent text-text-2 hover:text-text')}
            title={tab.label ?? tab.id}
            data-testid={`wb-track-${tab.id}`}
            onFocus={(event) => reveal(event.currentTarget)}
            onClick={() => { if (!busy) onSelect(tab.id) }}
          >
            {tab.label ?? tab.id}
          </button>
        )
      })}
    </div>
  )
}
