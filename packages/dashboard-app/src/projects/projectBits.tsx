import { isValidElement, type ReactNode } from 'react'
import { useT } from '../i18n'
import type { PillTone } from '../shell/ThreeColumns'
import { BUTTON_GHOST } from '../shared/uiRecipes'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { FileStatus } from './clientModel'

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

/** 计数徽标（「+2」「3」）：fill 底、等宽数字，唯一允许的药丸形。 */
export const COUNT_BADGE = 'inline-grid h-5 min-w-5 place-items-center rounded-sm bg-fill px-1.5 text-micro font-semibold tabular-nums text-text-2'

/**
 * 说明放 Tooltip。asChild：子元素本身可聚焦（按钮），直接当触发器；否则包一层可聚焦的 span
 * （计数徽标、图标这类非交互元素也要键盘能读到说明）。
 */
export function Hinted({ hint, children, testId, label, asChild = false }: {
  hint: string
  children: ReactNode
  testId?: string
  label?: string
  asChild?: boolean
}): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {asChild && isValidElement(children) ? children : (
          <span
            tabIndex={0}
            aria-label={label ?? hint}
            className="inline-flex rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-(--accent)"
            data-testid={testId}
          >
            {children}
          </span>
        )}
      </TooltipTrigger>
      <TooltipContent side="bottom" className="whitespace-nowrap">{hint}</TooltipContent>
    </Tooltip>
  )
}

/** 内联错误：一行红色文字 + 可选「重试」。 */
export function InlineError({ errorKey, onRetry, testId }: { errorKey: string; onRetry?: () => void; testId: string }): JSX.Element {
  const { t } = useT()
  return (
    <div className="mb-3 flex min-w-0 items-center gap-3 rounded-md border border-red-b bg-red-t px-4 py-2" role="alert" data-testid={testId}>
      <span className="min-w-0 flex-1 truncate whitespace-nowrap text-body font-semibold text-red-d">{t(`projects.errors.${errorKey}`)}</span>
      {onRetry !== undefined && (
        <button type="button" className={BUTTON_GHOST} data-testid={`${testId}-retry`} onClick={onRetry}>{t('projects.retry')}</button>
      )}
    </div>
  )
}
