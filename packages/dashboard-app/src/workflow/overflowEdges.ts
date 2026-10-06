import { useCallback, useLayoutEffect, useState, type RefObject } from 'react'

/** 横向滚动容器的几何：HTMLElement 本身就满足这个形状。 */
export interface ScrollMetrics {
  scrollLeft: number
  clientWidth: number
  scrollWidth: number
}

/** 哪一侧还有被藏起来的内容：start = 左侧（已经滚过去的），end = 右侧（还没滚到的）。 */
export interface OverflowEdges {
  start: boolean
  end: boolean
}

/** 亚像素取整误差：滚到头时 scrollLeft + clientWidth 可能差不到 1px，不该算还有隐藏内容。 */
const SLACK = 1

export function overflowEdges(metrics: ScrollMetrics): OverflowEdges {
  const { scrollLeft, clientWidth, scrollWidth } = metrics
  return {
    start: scrollLeft > SLACK,
    end: scrollLeft + clientWidth < scrollWidth - SLACK,
  }
}

/**
 * 量一个横向滚动容器两端是否还有隐藏内容。挂载、滚动（调用方把 measure 接到 onScroll）、容器或其子项尺寸变化
 * （导航栏收窄、字体载入后标签变宽）和 watch 变化（换语言、增删项）时重新量；两侧状态没变就不触发重渲染。
 * `onResize`（可选，调用方保证引用稳定）在每次尺寸变化量完之后调用，用来在内容变宽后把该看的那一项重新滚进来。
 */
export function useOverflowEdges(
  ref: RefObject<HTMLElement>,
  watch: string,
  onResize?: () => void,
): { edges: OverflowEdges; measure: () => void } {
  const [edges, setEdges] = useState<OverflowEdges>({ start: false, end: false })
  const measure = useCallback((): void => {
    const element = ref.current
    if (element === null) return
    const next = overflowEdges(element)
    setEdges((previous) => (previous.start === next.start && previous.end === next.end ? previous : next))
  }, [ref])
  useLayoutEffect(() => {
    measure()
    const element = ref.current
    if (element === null || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(() => {
      measure()
      onResize?.()
    })
    observer.observe(element)
    for (const child of Array.from(element.children)) observer.observe(child)
    return () => observer.disconnect()
  }, [measure, onResize, ref, watch])
  return { edges, measure }
}
