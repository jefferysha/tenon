import type { ReactElement } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/**
 * 悬停与键盘聚焦都能打开的说明（Radix Tooltip），替代原生 title：原生 title 键盘到不了、触屏看不见。
 * 子元素必须本身可聚焦（按钮），说明文字经 Radix 挂到它的 aria-describedby 上。
 * 延迟用 App 最外层唯一的 TooltipProvider（400 / 300），这里不再自带。
 */
export function Hint({ label, children, side = 'top' }: {
  label: string
  children: ReactElement
  side?: 'top' | 'right' | 'bottom' | 'left'
}): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} sideOffset={6} className="whitespace-nowrap">{label}</TooltipContent>
    </Tooltip>
  )
}
