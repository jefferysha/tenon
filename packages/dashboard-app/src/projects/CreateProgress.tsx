import { Check, Circle, LoaderCircle, X } from 'lucide-react'
import { useT } from '../i18n'
import { BUTTON_GHOST } from '../shared/uiRecipes'
import { cn } from '@/lib/utils'
import { stepLabelKey } from './newProjectModel'
import type { ProjectCreateRun, RowState } from './useProjectCreateRun'

export interface CreateProgressProps {
  run: ProjectCreateRun
  root: string
  onRetry: () => void
}

const ICON: Record<RowState, JSX.Element> = {
  pending: <Circle className="size-4 text-text-4" aria-hidden="true" />,
  running: <LoaderCircle className="size-4 animate-spin text-(--accent) motion-reduce:animate-none" aria-hidden="true" />,
  done: <Check className="size-4 text-green-d" strokeWidth={2.5} aria-hidden="true" />,
  failed: <X className="size-4 text-red-d" strokeWidth={2.5} aria-hidden="true" />,
}

/** 创建进度：逐项显示 等待 / 进行中 / 完成 / 失败；失败行显示错误原文，「重试」在该行旁。 */
export function CreateProgress({ run, root, onRetry }: CreateProgressProps): JSX.Element {
  const { t } = useT()
  const failedRow = run.rows.some((row) => row.state === 'failed')
  const retry = (
    <button type="button" className={cn(BUTTON_GHOST, 'flex-none')} disabled={run.status === 'running'} data-testid="np-retry" onClick={onRetry}>
      {t('projects.retry')}
    </button>
  )
  return (
    <div className="grid gap-3" data-testid="np-progress" aria-busy={run.status === 'running'}>
      <p className="flex min-w-0 items-center gap-2 text-caption">
        <span className="flex-none text-text-3">{t('projects.path')}</span>
        <span className="truncate font-mono text-text" title={root}>{root}</span>
      </p>
      {run.status === 'running' && run.rows.length === 0 && (
        <LoaderCircle className="size-5 animate-spin justify-self-center text-(--accent) motion-reduce:animate-none" aria-label={t('projects.state_running')} />
      )}
      {run.rows.length > 0 && (
        <ol className="divide-y divide-border rounded-md border border-border bg-card" aria-label={t('projects.progress_label')} data-testid="np-progress-rows">
          {run.rows.map((row) => {
            const label = stepLabelKey(row.id)
            return (
              <li key={row.id} className="grid gap-1 px-3 py-1.5" data-testid={`np-row-${row.id}`} data-state={row.state}>
                <div className="flex min-h-9 items-center gap-3 whitespace-nowrap">
                  <span className="grid size-5 flex-none place-items-center" role="img" aria-label={t(`projects.state_${row.state}`)}>{ICON[row.state]}</span>
                  <span className={cn('min-w-0 flex-1 truncate text-body', row.state === 'pending' ? 'text-text-3' : 'text-text')}>{t(label.key, label.vars)}</span>
                  {row.state === 'failed' && retry}
                </div>
                {row.state === 'failed' && row.error !== undefined && (
                  <p className="pl-8 font-mono text-caption break-words whitespace-pre-wrap text-red-d" role="alert" data-testid={`np-row-error-${row.id}`}>{row.error}</p>
                )}
              </li>
            )
          })}
        </ol>
      )}
      {run.status === 'failed' && !failedRow && (
        <div className="flex items-center gap-3 rounded-md border border-red-b bg-red-t px-3 py-2" role="alert" data-testid="np-error">
          <span className="min-w-0 flex-1 truncate text-body font-semibold text-red-d">{t(`projects.errors.${run.errorKey ?? run.failure ?? 'unknown'}`)}</span>
          {retry}
        </div>
      )}
    </div>
  )
}
