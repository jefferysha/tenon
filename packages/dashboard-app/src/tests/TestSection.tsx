import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { CountRoll } from '../shared/CountRoll'
import { COUNT_BADGE } from './testStyles'

/** 一段：标题一行（标题 · 计数徽标 · 行尾动作），内容满宽。段头永不换行。 */
export function TestSection({ title, count, action, testId, children }: {
  title: string
  count?: number | string
  action?: ReactNode
  testId: string
  children: ReactNode
}): JSX.Element {
  return (
    <section className="grid grid-cols-[minmax(0,1fr)] gap-2" data-testid={testId}>
      <div className="flex min-w-0 items-center gap-2 whitespace-nowrap">
        <h3 className="whitespace-nowrap text-title font-semibold text-text">{title}</h3>
        {count !== undefined && <span className={COUNT_BADGE}><CountRoll value={count} /></span>}
        {action !== undefined && <span className="ml-auto flex flex-none items-center gap-2">{action}</span>}
      </div>
      {children}
    </section>
  )
}

/** 定义行：固定宽标签列（默认 6.5rem，容器设 --def-label 可加宽）+ 值列，值不换行（过长截断，全文放 title 由调用方给）。 */
export function DefRow({ label, testId, children, mono = true, danger = false }: {
  label: string
  testId: string
  children: ReactNode
  mono?: boolean
  danger?: boolean
}): JSX.Element {
  return (
    <div className="grid min-h-9 grid-cols-[var(--def-label,6.5rem)_minmax(0,1fr)] items-center gap-3 border-b border-border py-1 last:border-0" role="row" data-testid={testId}>
      <span className="whitespace-nowrap text-caption text-text-3" role="rowheader">{label}</span>
      <span className={cn('min-w-0 truncate whitespace-nowrap text-body', mono && 'font-mono', danger ? 'text-red-d' : 'text-text')} role="cell">{children}</span>
    </div>
  )
}
