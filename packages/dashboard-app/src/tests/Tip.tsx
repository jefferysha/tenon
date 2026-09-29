import type { ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/**
 * 表格里的说明：可见文字是词，悬停才出标识或完整说明（Radix Tooltip）。触发器是不参与 Tab 的 span，
 * 所以说明只补充信息，可见文字本身必须已经够用；需要键盘可达的说明用 workflow/Hint（按钮）。
 * 说明允许换行（完整报错很长），其余一切都不换行。
 */
export function Tip({ tip, children, className, testId }: {
  tip: ReactNode
  children: ReactNode
  className?: string
  testId?: string
}): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={className} data-testid={testId}>{children}</span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-96 whitespace-pre-wrap break-words">{tip}</TooltipContent>
    </Tooltip>
  )
}
