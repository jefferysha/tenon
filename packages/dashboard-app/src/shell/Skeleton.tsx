import { useT } from '../i18n'
import { cn } from '@/lib/utils'
import { ThreeColumns } from './ThreeColumns'

/** 骨架块：浅填充 + 脉冲；reduced-motion 下静止。 */
export const SKELETON_BLOCK = 'rounded-md bg-fill animate-pulse motion-reduce:animate-none'

function Bone({ className }: { className: string }): JSX.Element {
  return <span className={cn('block', SKELETON_BLOCK, className)} aria-hidden="true" />
}

/**
 * 三栏页加载占位：左列 8 条、中列标题 + 3 张卡、右列标题条 + 阶段条。几何对齐真实三栏，
 * 数据到达时不跳版。整块是一个 status 区域，读屏只读「加载中…」。
 */
export function ThreeColumnsSkeleton({ testId }: { testId: string }): JSX.Element {
  const { t } = useT()
  return (
    <div role="status" aria-live="polite" aria-busy="true" data-testid={testId}>
      <span className="sr-only">{t('common.loading')}</span>
      <ThreeColumns
        testId={`${testId}-columns`}
        railCollapsed={false}
        rail={(
          <aside className="flex min-h-0 flex-col gap-1 overflow-hidden border-r border-border bg-bg px-4 pt-5 pb-4 max-[1360px]:px-2 max-[900px]:hidden" data-testid={`${testId}-rail`}>
            <Bone className="mb-4 h-8 w-24 max-[1360px]:w-full" />
            {Array.from({ length: 8 }, (_, index) => <Bone key={index} className="h-[52px] w-full" />)}
          </aside>
        )}
        list={(
          <section className="flex min-h-0 flex-col gap-4 overflow-hidden border-r border-border bg-card px-7 pt-7 pb-10 max-[900px]:border-r-0 max-[900px]:px-4" data-testid={`${testId}-list`}>
            <Bone className="h-10 w-40" />
            <Bone className="h-11 w-full" />
            {Array.from({ length: 3 }, (_, index) => <Bone key={index} className="h-28 w-full" />)}
          </section>
        )}
        detail={(
          <section className="flex min-h-0 min-w-0 flex-col gap-4 bg-surface-detail px-8 pt-7 max-[900px]:px-4" data-testid={`${testId}-detail`}>
            <Bone className="h-10 w-2/3" />
            <Bone className="h-3 w-full" />
          </section>
        )}
      />
    </div>
  )
}
