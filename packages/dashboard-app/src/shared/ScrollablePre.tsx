import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * 会出滚动条的预格式化文本（日志、堆栈、文件预览、代码块）。键盘用户要能聚焦它才能用方向键滚动，
 * 聚焦就需要一个名字——所以 tabIndex=0 + region + 必填 label 是一个整体，不是各处各写一半。
 */
export function ScrollablePre({ label, className, testId, children }: {
  label: string
  className: string
  testId?: string
  children: ReactNode
}): JSX.Element {
  return (
    <pre
      tabIndex={0}
      role="region"
      aria-label={label}
      className={cn(className, 'outline-none focus-visible:ring-2 focus-visible:ring-(--accent)')}
      data-testid={testId}
    >
      {children}
    </pre>
  )
}
