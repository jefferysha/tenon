import type { ReactElement } from 'react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

/**
 * 悬停与键盘聚焦都能打开的说明（Radix Tooltip），替代原生 title：原生 title 键盘到不了、触屏看不见。
 * 子元素必须本身可聚焦（按钮），说明文字经 Radix 挂到它的 aria-describedby 上。
 */
export function Hint({ label, children, side = 'top' }: {
  label: string
  children: ReactElement
  side?: 'top' | 'right' | 'bottom' | 'left'
}): JSX.Element {
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent side={side} sideOffset={6} className="whitespace-nowrap">{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
