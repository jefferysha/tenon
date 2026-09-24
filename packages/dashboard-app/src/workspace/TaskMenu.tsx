import { Fragment, type ReactNode } from 'react'
import { Archive, ArchiveRestore, Link2, MoreHorizontal, Trash2, UserCheck } from 'lucide-react'
import { useT } from '../i18n'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import type { Tr } from './taskModel'

export type TaskMenuAction = 'copy-link' | 'take' | 'archive' | 'unarchive' | 'delete'

/** 给了哪个处理函数就出现哪一项；缺省即不可用（无 token、已是负责人、已归档视图…）。 */
export type TaskMenuHandlers = Partial<Record<TaskMenuAction, () => void>>

export interface TaskMenuEntry {
  id: TaskMenuAction
  label: string
  icon: ReactNode
  danger: boolean
  onSelect: () => void
}

const ORDER: readonly TaskMenuAction[] = ['copy-link', 'take', 'archive', 'unarchive', 'delete']
const ICON: Record<TaskMenuAction, ReactNode> = {
  'copy-link': <Link2 />,
  take: <UserCheck />,
  archive: <Archive />,
  unarchive: <ArchiveRestore />,
  delete: <Trash2 />,
}
const LABEL: Record<TaskMenuAction, string> = {
  'copy-link': 'workspace.copy_link',
  take: 'workspace.take_owner',
  archive: 'workspace.archive',
  unarchive: 'workspace.unarchive',
  delete: 'workspace.delete',
}

/** 卡片 ⋯ 与详情 ⋯ 共用的动作清单：复制链接 · 接手 · 归档 / 取消归档 · 删除（删除前分隔）。 */
export function taskMenuItems(handlers: TaskMenuHandlers, t: Tr): TaskMenuEntry[] {
  return ORDER.flatMap((id) => {
    const onSelect = handlers[id]
    return onSelect === undefined ? [] : [{ id, label: t(LABEL[id]), icon: ICON[id], danger: id === 'delete', onSelect }]
  })
}

export function TaskMenu({ items, testId, className }: { items: readonly TaskMenuEntry[]; testId: string; className?: string }): JSX.Element | null {
  const { t } = useT()
  if (items.length === 0) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn('grid size-10 flex-none place-items-center rounded-sm text-text-3 outline-none hover:bg-fill hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent) aria-expanded:bg-fill aria-expanded:text-text', className)}
        aria-label={t('workspace.task_actions')}
        title={t('workspace.task_actions')}
        data-testid={testId}
      >
        <MoreHorizontal className="size-4" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44" data-testid={`${testId}-menu`}>
        {items.map((item, index) => (
          <Fragment key={item.id}>
            {item.danger && index > 0 && <DropdownMenuSeparator />}
            <DropdownMenuItem
              className={cn('min-h-10 text-body [&_svg]:size-4', item.danger ? 'text-red-d focus:text-red-d' : 'text-text')}
              data-testid={`${testId}-${item.id}`}
              onSelect={item.onSelect}
            >
              <span className={cn('flex-none', item.danger ? 'text-red-d' : 'text-text-3')} aria-hidden="true">{item.icon}</span>
              {item.label}
            </DropdownMenuItem>
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
