import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'

/** 铺满型步骤（模板 / 资源：左列表 + 右预览）的固定高度，等于 Tailwind 的 h-96。 */
export const FILL_HEIGHT_PX = 384

/**
 * 向导正文的外框。铺满型步骤（模板 / 资源）固定 384px，子树用 h-full 撑满；其余步骤（位置 / 客户端 / 确认 / 进度）
 * 高度贴内容，不再给「位置」这种只有一个控件的首步留下几百像素空白。内容或步骤变化时高度用 200ms 过渡。
 * 贴内容靠 ResizeObserver 量内部容器的自然高度（用布局高度 offsetHeight / borderBoxSize，不用
 * getBoundingClientRect：对话框进场有 0.97 缩放，后者会把高度量小、裁掉最后一行）；没有 ResizeObserver
 * （jsdom、旧浏览器）就退回自动高度，只是没有过渡。最高仍是 384px，再多则外框内滚动。
 */
export function StepFrame({ fill, children }: { fill: boolean; children: ReactNode }): JSX.Element {
  const inner = useRef<HTMLDivElement>(null)
  const [natural, setNatural] = useState<number | null>(null)
  useLayoutEffect(() => {
    const node = inner.current
    if (node === null || typeof ResizeObserver === 'undefined') return
    const measure = (entries?: readonly ResizeObserverEntry[]): void => {
      const box = entries?.[0]?.borderBoxSize?.[0]
      setNatural(Math.ceil(box === undefined ? node.offsetHeight : box.blockSize))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  const height = fill ? FILL_HEIGHT_PX : natural
  return (
    <div
      className="max-h-96 overflow-y-auto transition-[height] duration-200 ease-(--ease-out) motion-reduce:transition-none"
      style={height === null ? undefined : { height }}
      data-fit={fill ? 'fill' : 'hug'}
      data-testid="np-frame"
    >
      <div ref={inner} className={fill ? 'h-full' : undefined}>{children}</div>
    </div>
  )
}
