import type { ReactNode } from 'react'

export interface PageHeaderProps {
  title: ReactNode
  description?: ReactNode
  eyebrow?: ReactNode
  status?: ReactNode
  actions?: ReactNode
  className?: string
  testId?: string
  animation?: string
}

/**
 * 一级页面的定位锚点：上下文、唯一 H1、说明、状态与主要动作使用同一阅读顺序。
 * 功能域仍拥有自己的工具条和内容结构，避免把不相干页面强行做成一个万能组件。
 */
export function PageHeader({
  title,
  description,
  eyebrow,
  status,
  actions,
  className = '',
  testId,
  animation,
}: PageHeaderProps): JSX.Element {
  return (
    <header
      className={`mb-6 flex flex-wrap items-start gap-x-4 gap-y-3 border-b border-border pb-4 mobile:mb-5 mobile:pb-4 ${className}`}
      data-slot="page-header"
      data-testid={testId}
      data-anim={animation}
    >
      <div className="min-w-0 flex-1">
        {eyebrow !== undefined && (
          <div
            className="mb-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-text-3"
            data-slot="page-eyebrow"
          >
            {eyebrow}
          </div>
        )}
        <h1 className="text-[28px] font-bold leading-[1.08] tracking-[-0.03em] text-text mobile:text-[26px]">
          {title}
        </h1>
        {description !== undefined && (
          <div
            className="mt-2 max-w-3xl text-sm leading-6 text-text-3"
            data-slot="page-description"
          >
            {description}
          </div>
        )}
        {status !== undefined && (
          <div className="mt-3 flex items-center" data-slot="page-status">
            {status}
          </div>
        )}
      </div>
        {actions !== undefined && (
          <div
          className="flex flex-wrap items-center justify-end gap-2 mobile:w-full mobile:justify-start"
          data-slot="page-actions"
        >
          {actions}
        </div>
      )}
    </header>
  )
}
