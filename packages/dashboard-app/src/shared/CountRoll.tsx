import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'

/**
 * 计数（数字或「3/5」这样的进度串）。值变化时新值自下滑入 160ms（index.css 的 `.count-roll`），首次渲染
 * 和值不变的重渲染都不动。内容随 key 换，读屏与文本查询看到的仍是同一个字符串。
 * reduced-motion 下动画时长由 index.css 归零，直接落终态。
 */
export function CountRoll({ value, className, testId }: { value: number | string; className?: string; testId?: string }): JSX.Element {
  const text = String(value)
  const previous = useRef(text)
  const changed = previous.current !== text
  useEffect(() => { previous.current = text })
  return (
    <span key={text} className={cn(changed && 'count-roll', className)} data-rolling={changed || undefined} data-testid={testId}>
      {text}
    </span>
  )
}
