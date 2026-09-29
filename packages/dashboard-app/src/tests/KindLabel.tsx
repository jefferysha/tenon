import { useT } from '../i18n'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { KindIcon } from './KindIcon'
import { kindLabel } from './testLabels'

/**
 * 种类 = 图标 + 界面词（单测 / Unit …），标识（unit）放 Tooltip。名字不折行，过长截断。
 * iconOnly：窄列里只放图标，词进 Tooltip 与读屏文字。
 */
export function KindLabel({ kind, iconOnly = false, iconClassName, className, testId }: {
  kind: string
  iconOnly?: boolean
  iconClassName?: string
  className?: string
  testId?: string
}): JSX.Element {
  const { t } = useT()
  const label = kindLabel(kind, t)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn('inline-flex min-w-0 items-center gap-2 whitespace-nowrap', className)} data-kind={kind} data-testid={testId}>
          <KindIcon kind={kind} {...(iconClassName === undefined ? {} : { className: iconClassName })} />
          {iconOnly ? <span className="sr-only">{label}</span> : <span className="min-w-0 truncate">{label}</span>}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="whitespace-nowrap">
        {iconOnly && label !== kind ? <><span>{label}</span>{' · '}<span className="font-mono">{kind}</span></> : <span className="font-mono">{kind}</span>}
      </TooltipContent>
    </Tooltip>
  )
}
