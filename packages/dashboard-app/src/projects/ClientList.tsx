import type { ReactNode } from 'react'
import { MoreHorizontal, Plus } from 'lucide-react'
import { useT } from '../i18n'
import type { InstructionHostRow } from '../api/instructionsDecoders'
import { StatusPill, type PillTone } from '../shell/ThreeColumns'
import { BUTTON_ICON, LIST_SELECTED } from '../shared/uiRecipes'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { canEnable, clientName, type ClientGroup, type FileStatus } from './clientModel'

export const STATUS_KEY: Record<FileStatus, string> = {
  missing: 'projects.status_missing',
  same: 'projects.status_same',
  different: 'projects.status_different',
  error: 'projects.status_error',
}

export const STATUS_TONE: Record<FileStatus, PillTone> = {
  missing: 'neutral',
  same: 'done',
  different: 'pending',
  error: 'blocked',
}

const MENU_ITEM = 'min-h-10 gap-3 text-body text-text'

/** 只带说明的小元素（计数徽标等）：Tooltip 要可聚焦的触发器，所以给 tabIndex。 */
export function Hinted({ hint, children, testId, label }: { hint: string; children: ReactNode; testId?: string; label?: string }): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          aria-label={label ?? hint}
          className="rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-(--accent)"
          data-testid={testId}
        >
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="whitespace-nowrap">{hint}</TooltipContent>
    </Tooltip>
  )
}

/** 计数徽标（「+2」「3」）：fill 底、等宽数字，唯一允许的药丸形。 */
export const COUNT_BADGE = 'inline-grid h-5 min-w-5 place-items-center rounded-sm bg-fill px-1.5 text-micro font-semibold tabular-nums text-text-2'

/** 「+ 添加客户端」：只列尚未启用的客户端；需配置的置灰，原因在 Tooltip。 */
export function AddClientMenu({ hosts, enabled, onEnable }: {
  hosts: readonly InstructionHostRow[]
  enabled: readonly string[]
  onEnable: (clientId: string) => void
}): JSX.Element {
  const { t } = useT()
  const candidates = hosts.filter((host) => !enabled.includes(host.id))
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={BUTTON_ICON}
        aria-label={t('projects.add_client')}
        title={t('projects.add_client')}
        disabled={candidates.length === 0}
        data-testid="proj-add-client"
      >
        <Plus className="size-4" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56" data-testid="proj-add-client-menu">
        {candidates.map((host) => {
          const label = <span className="min-w-0 flex-1 truncate whitespace-nowrap">{clientName(host.id)}</span>
          return (
            <DropdownMenuItem
              key={host.id}
              // 置灰项仍接收指针，好让 Tooltip 说明为什么不能启用。
              className={cn(MENU_ITEM, 'data-[disabled]:pointer-events-auto')}
              disabled={!canEnable(host)}
              data-testid={`proj-add-${host.id}`}
              onSelect={() => onEnable(host.id)}
            >
              {canEnable(host) ? label : (
                <Tooltip>
                  <TooltipTrigger asChild>{label}</TooltipTrigger>
                  <TooltipContent side="left" className="whitespace-nowrap">{t('projects.needs_config_hint')}</TooltipContent>
                </Tooltip>
              )}
              {host.target !== null && <span className="font-mono text-caption text-text-3">{host.target}</span>}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** 一行 = 一个项目级文件：显示第一个读它的客户端 + 文件名；其余读者收进「+n」徽标的 Tooltip。 */
function ClientRow({ group, selected, status, onSelect, onDisable }: {
  group: ClientGroup
  selected: boolean
  status: FileStatus | null
  onSelect: () => void
  onDisable: (clientId: string) => void
}): JSX.Element {
  const { t } = useT()
  const [primary = '', ...others] = group.clients
  const testId = `proj-client-${primary}`
  return (
    <li
      className={cn(
        'flex min-h-11 items-center gap-2 rounded-md pr-1 transition-colors duration-(--dur-fast) ease-(--ease-out) motion-reduce:transition-none',
        selected ? LIST_SELECTED : 'hover:bg-fill',
      )}
      data-testid={testId}
      data-selected={selected}
    >
      <button
        type="button"
        className="grid min-w-0 flex-1 rounded-md px-3 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-(--accent)"
        aria-current={selected ? 'true' : undefined}
        data-testid={`${testId}-select`}
        onClick={onSelect}
      >
        <span className={cn('truncate whitespace-nowrap text-base text-text', selected ? 'font-semibold' : 'font-medium')}>{clientName(primary)}</span>
        <span className="truncate whitespace-nowrap font-mono text-caption text-text-3" data-testid={`${testId}-file`}>{group.file}</span>
      </button>
      {others.length > 0 && (
        <Hinted
          hint={others.map(clientName).join(' · ')}
          label={t('projects.read_by', { names: group.clients.map(clientName).join(', ') })}
          testId={`${testId}-readers`}
        >
          <span className={COUNT_BADGE}>{`+${others.length}`}</span>
        </Hinted>
      )}
      {status !== null && (
        <StatusPill tone={STATUS_TONE[status]} testId={`${testId}-status`} className="flex-none">{t(STATUS_KEY[status])}</StatusPill>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger
          className="grid size-8 flex-none place-items-center rounded-sm text-text-3 outline-none hover:bg-fill-2 hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent) aria-expanded:bg-fill-2 aria-expanded:text-text"
          aria-label={t('projects.more')}
          title={t('projects.more')}
          data-testid={`${testId}-more`}
        >
          <MoreHorizontal className="size-4" aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44" data-testid={`${testId}-more-menu`}>
          {group.clients.map((id) => (
            <DropdownMenuItem key={id} className={MENU_ITEM} data-testid={`proj-disable-${id}`} onSelect={() => onDisable(id)}>
              {group.clients.length === 1 ? t('projects.disable_client') : t('projects.disable_named', { name: clientName(id) })}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  )
}

/** 中列：已启用的客户端（按项目级文件合并），每行带状态点与 ⋯（停用）。 */
export function ClientList({ groups, selectedFile, statusOf, onSelect, onDisable }: {
  groups: readonly ClientGroup[]
  selectedFile: string | null
  statusOf: (file: string) => FileStatus | null
  onSelect: (clientId: string) => void
  onDisable: (clientId: string) => void
}): JSX.Element {
  return (
    <ul className="grid gap-1" data-testid="proj-clients">
      {groups.map((group) => (
        <ClientRow
          key={group.file}
          group={group}
          selected={group.file === selectedFile}
          status={statusOf(group.file)}
          onSelect={() => onSelect(group.clients[0] ?? '')}
          onDisable={onDisable}
        />
      ))}
    </ul>
  )
}
