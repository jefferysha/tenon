import type { ReactNode } from 'react'
import { useT } from '../i18n'
import { Icon } from './Icon'

export interface TaskDetailIntroProps {
  name: string
  badge?: ReactNode
  actions?: ReactNode
  footLabel: string
  requirement?: string
  onClose?: () => void
}

export function TaskDetailIntro({
  name,
  badge,
  actions,
  footLabel,
  requirement,
  onClose,
}: TaskDetailIntroProps): JSX.Element {
  const { t } = useT()
  return (
    <>
      <header className="flex flex-wrap items-center gap-[9px] border-b border-border py-[13px]" data-testid="dt-head">
        <span className="font-mono text-[13.5px] font-bold text-text">{name}</span>
        {badge}
        <span className="flex-1" />
        {onClose && (
          <button
            type="button"
            className="cursor-pointer rounded-[6px] border border-transparent bg-transparent px-2.5 py-[5px] text-xs text-text-3 transition-colors hover:border-border hover:bg-fill hover:text-red"
            data-testid="detail-close"
            aria-label={t('detail.close')}
            onClick={onClose}
          >
            <Icon name="x" size={14} />
          </button>
        )}
      </header>
      {actions !== undefined && (
        <div className="flex flex-wrap items-center gap-[9px] border-b border-border py-3" data-testid="dt8-acts">
          <div className="flex items-center gap-2">{actions}</div>
          {footLabel !== '' && (
            <span className="font-mono text-[11.5px] tabular-nums text-text-3" data-testid="dt-foot-label">
              {footLabel}
            </span>
          )}
        </div>
      )}
      {requirement !== undefined && requirement !== '' && (
        <div className="border-b border-border py-[13px] last:border-b-0">
          <div className="mb-2.5 flex items-baseline gap-[7px] text-[12.5px] font-bold text-text">
            {t('detail.req_heading')}
          </div>
          <p className="m-0 text-[13px] leading-[1.6] text-text-2">{requirement}</p>
        </div>
      )}
    </>
  )
}
