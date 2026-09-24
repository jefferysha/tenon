import type { ReactNode } from 'react'
import { CopyPlus, Lock } from 'lucide-react'
import { useT } from '../i18n'
import { MenuButton } from '../shared/MenuButton'
import { BUTTON_GHOST } from '../shared/uiRecipes'

/** 内建条目的唯一标记：锁图标，悬停说明「内建」。自定义条目不带标记。 */
export function BuiltinLock({ testId }: { testId?: string }): JSX.Element {
  const { t } = useT()
  return (
    <span className="inline-flex flex-none text-text-3" role="img" aria-label={t('library.builtin')} title={t('library.builtin')} data-testid={testId}>
      <Lock className="size-3.5" aria-hidden="true" />
    </span>
  )
}

/**
 * 详情头部：名称（只显示 label，标识放在 title 里）+ 内建锁 + 右侧动作。动作放在对象旁，没有底部动作条。
 */
export function DetailTitle({
  title, hint, builtin, actions, testId,
}: {
  title: string
  /** 悬停在名称上看到的标识（id / 路径）。 */
  hint?: string
  builtin: boolean
  actions: ReactNode
  testId: string
}): JSX.Element {
  return (
    <div className="flex min-w-0 items-center gap-3" data-testid={`${testId}-header`}>
      <h1 className="min-w-0 truncate text-page font-bold tracking-[-.01em] text-text" title={hint ?? title} data-testid={`${testId}-title`}>
        {title}
      </h1>
      {builtin && <BuiltinLock testId={`${testId}-builtin`} />}
      <div className="ml-auto flex flex-none items-center gap-2 whitespace-nowrap">{actions}</div>
    </div>
  )
}

/** 「复制为自定义」：写操作（在自定义库里建一份副本），不是复制到剪贴板。 */
export function CopyAsCustomButton({ disabled, onClick, testId }: { disabled: boolean; onClick: () => void; testId: string }): JSX.Element {
  const { t } = useT()
  return (
    <button type="button" className={BUTTON_GHOST} data-testid={testId} disabled={disabled} onClick={onClick}>
      <CopyPlus className="size-4" aria-hidden="true" />
      {t('library.copy')}
    </button>
  )
}

/** ⋯ 菜单里的删除：破坏性动作不和主按钮并排。 */
export function DeleteMenu({ disabled, onDelete, testId }: { disabled: boolean; onDelete: () => void; testId: string }): JSX.Element {
  const { t } = useT()
  return (
    <MenuButton
      label={t('library.more')}
      testId={testId}
      disabled={disabled}
      items={[{ id: 'delete', label: t('library.delete'), danger: true, onSelect: onDelete }]}
    />
  )
}

/** 只读提示（没有写凭证时）。 */
export function ReadOnlyNote({ testId }: { testId: string }): JSX.Element {
  const { t } = useT()
  return <span className="text-caption text-text-3" data-testid={testId}>{t('library.no_token')}</span>
}

/** 列表读取中的骨架：不在数据回来之前显示「没有…」。 */
export function ListSkeleton({ testId, rows = 5 }: { testId: string; rows?: number }): JSX.Element {
  const { t } = useT()
  return (
    <ul className="grid gap-1" role="status" aria-label={t('common.loading')} data-testid={testId}>
      {Array.from({ length: rows }, (_, index) => (
        <li key={index} className="h-14 animate-pulse rounded-md bg-fill motion-reduce:animate-none" />
      ))}
    </ul>
  )
}

/**
 * 标题行右侧的列表动作（「新建」）。ListColumn 还没有 action 插槽时的兼容放法：作为第一个子元素、
 * 零高度、`-order-1` 排到列首，再下移到标题那一行；ListColumn 有了 action 插槽后把 `children` 直接传给它。
 */
export function ListTitleAction({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="-order-1 flex h-0 justify-end" data-slot="list-title-action">
      <div className="relative top-8">{children}</div>
    </div>
  )
}
