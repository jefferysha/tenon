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
      <header className="flex flex-wrap items-center gap-2 border-b border-border py-3" data-testid="dt-head">
        <span className="font-mono text-body font-bold text-text">{name}</span>
        {badge}
        <span className="flex-1" />
        {onClose && (
          <button
            type="button"
            className="cursor-pointer rounded-sm border border-transparent bg-transparent px-2.5 py-1 text-caption text-text-3 transition-colors hover:border-border hover:bg-fill hover:text-red"
            data-testid="detail-close"
            aria-label={t('detail.close')}
            onClick={onClose}
          >
            <Icon name="x" size={14} />
          </button>
        )}
      </header>
      {actions !== undefined && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border py-3" data-testid="dt8-acts">
          <div className="flex items-center gap-2">{actions}</div>
          {footLabel !== '' && (
            <span className="font-mono text-micro tabular-nums text-text-3" data-testid="dt-foot-label">
              {footLabel}
            </span>
          )}
        </div>
      )}
      {requirement !== undefined && requirement !== '' && (
        <div className="border-b border-border py-3 last:border-b-0">
          <div className="mb-2.5 flex items-baseline gap-2 text-caption font-bold text-text">
            {t('detail.req_heading')}
          </div>
          <p className="m-0 text-body leading-[1.6] text-text-2">{requirement}</p>
        </div>
      )}
    </>
  )
}
