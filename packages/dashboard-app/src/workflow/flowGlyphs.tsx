import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { CircleCheck, CircleX, Clock } from 'lucide-react'
import { cn } from '@/lib/utils'
import { fitName } from './fitName'

/** 节点的运行状态；「等待」是默认状态：只画一个安静的小圆，不写字。 */
export type GlyphState = 'waiting' | 'running' | 'done' | 'failed' | 'stale'

/**
 * 量一批文本在 `host` 里的渲染宽度：把它们放进 host 的一个隐藏容器（继承 host 的字体、字号、字距，不可见、不占位），
 * 一次布局读回各自的宽度，马上拆掉。只在名字放不下、或宽度变了的时候才量。
 */
function measureIn(host: HTMLElement, texts: readonly string[]): number[] {
  const ruler = document.createElement('span')
  ruler.className = 'pointer-events-none invisible absolute left-0 top-0 whitespace-nowrap'
  ruler.setAttribute('aria-hidden', 'true')
  ruler.setAttribute('data-fit-ruler', '')
  const items = texts.map((text) => {
    const item = document.createElement('span')
    item.className = 'block w-max'
    item.textContent = text
    ruler.append(item)
    return item
  })
  host.append(ruler)
  const widths = items.map((item) => item.offsetWidth)
  ruler.remove()
  return widths
}

/**
 * 画布节点里的名称：整名放得下就完整显示；放不下按段缩（见 fitName：首段…末段，整段整段地留），
 * 只有一段的名字在末尾截断；完整名字始终在 title。宽度变了（缩放层级、状态字出现）、字体加载完都会重新量。
 * 度量用真实字体，没有布局的环境（jsdom）量不到宽度，就显示整名。
 */
export function FitName({ text, className, testId }: { text: string; className?: string; testId?: string }): JSX.Element {
  const box = useRef<HTMLSpanElement>(null)
  const [fitted, setFitted] = useState<{ readonly source: string; readonly shown: string }>({ source: text, shown: text })
  const refit = useCallback((): void => {
    const host = box.current
    if (host === null) return
    const shown = fitName(text, host.clientWidth, (texts) => measureIn(host, texts))
    setFitted((current) => (current.source === text && current.shown === shown ? current : { source: text, shown }))
  }, [text])
  useLayoutEffect(refit, [refit])
  useEffect(() => {
    const host = box.current
    if (host === null) return undefined
    let width = host.clientWidth
    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => { if (host.clientWidth !== width) { width = host.clientWidth; refit() } })
    observer?.observe(host)
    const fonts: FontFaceSet | undefined = typeof document === 'undefined' ? undefined : document.fonts
    fonts?.addEventListener('loadingdone', refit)
    return () => {
      observer?.disconnect()
      fonts?.removeEventListener('loadingdone', refit)
    }
  }, [refit])
  return (
    <span ref={box} className={cn('min-w-0 flex-1 truncate whitespace-nowrap', className)} title={text} data-testid={testId}>
      {fitted.source === text ? fitted.shown : text}
    </span>
  )
}

/** 12px 弧形符号：运行中匀速旋转（transform，走合成器）；减少动态效果时静止。 */
function ArcGlyph({ className }: { className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 12 12" className={cn('size-3 flex-none animate-[flow-spin_1s_linear_infinite] motion-reduce:animate-none', className)} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true" data-testid="flow-arc">
      <path d="M6 1.5a4.5 4.5 0 1 1-4.5 4.5" />
    </svg>
  )
}

const GLYPH_TONE: Record<GlyphState, string> = {
  waiting: 'text-text-4',
  running: 'text-(--accent)',
  done: 'text-green',
  failed: 'text-red-d',
  stale: 'text-amber-d',
}

/** 左侧状态符号：形状 + 颜色，两者缺一不可（等待 = 小圆点，运行 = 转动的弧，完成 = 勾，失败 = 叉，过期 = 钟）。 */
export function StateGlyph({ state, label }: { state: GlyphState; label: string }): JSX.Element {
  return (
    <span className={cn('grid size-3.5 flex-none place-items-center', GLYPH_TONE[state])} title={label} data-testid="flow-glyph" data-glyph={state}>
      {state === 'running' ? <ArcGlyph />
        : state === 'done' ? <CircleCheck className="size-3.5" aria-hidden="true" />
          : state === 'failed' ? <CircleX className="size-3.5" aria-hidden="true" />
            : state === 'stale' ? <Clock className="size-3.5" aria-hidden="true" />
              : <i className="block size-1.5 rounded-full bg-current" aria-hidden="true" />}
    </span>
  )
}
