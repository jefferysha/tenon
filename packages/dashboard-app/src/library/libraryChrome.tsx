import type { ReactNode } from 'react'
import { CopyPlus, Lock } from 'lucide-react'
import { useT } from '../i18n'
import { MenuButton } from '../shared/MenuButton'
import { BUTTON_GHOST, LIST_SELECTED_ARIA } from '../shared/uiRecipes'

/**
 * 库的列表行（模板 / 资源 / 测试方向 / agent 共用）：选中 = 中性选中底 + 左侧 2px 内嵌边，不加描边；
 * 与工作台任务卡是同一套选中语汇。`group` 让行内的名称与锁跟随悬停 / 选中。
 */
export const LIST_ROW = `group grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md px-3 py-2.5 text-left outline-none hover:bg-fill focus-visible:ring-2 focus-visible:ring-(--accent) ${LIST_SELECTED_ARIA} aria-[current=true]:hover:bg-sel-bg`
/** 列表行名称：常态 500，选中 600。 */
export const LIST_ROW_NAME = 'min-w-0 truncate text-body font-medium text-text group-aria-[current=true]:font-semibold'

/**
 * 内建条目的唯一标记：锁图标，悬停说明「内建」。自定义条目不带标记。
 * `quiet`（列表行里）：平时 text-4，行悬停 / 选中时 text-3，几十行的锁不抢名称。
 */
export function BuiltinLock({ testId, quiet = false }: { testId?: string; quiet?: boolean }): JSX.Element {
  const { t } = useT()
  return (
    <span
      className={quiet ? 'inline-flex flex-none text-text-4 group-hover:text-text-3 group-aria-[current=true]:text-text-3' : 'inline-flex flex-none text-text-3'}
      role="img"
      aria-label={t('library.builtin')}
      title={t('library.builtin')}
      data-testid={testId}
    >
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
