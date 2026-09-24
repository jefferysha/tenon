import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { useT } from '../i18n'
import type { ProjectCreatePlan } from '../api/instructionsDecoders'
import { cn } from '@/lib/utils'
import { CLIENTS, stepLabelKey } from './newProjectModel'

const clientNames = (ids: readonly string[]): string =>
  ids.map((id) => CLIENTS.find((client) => client.id === id)?.name ?? id).join(', ')

export interface ConfirmStepProps {
  plan: ProjectCreatePlan
  mode: 'existing' | 'empty'
  /** 记入 `.tenon/clients.json` 的客户端 id。 */
  clients: readonly string[]
}

const ROW = 'flex min-h-10 items-center gap-3 px-3 whitespace-nowrap'

function Label({ id }: { id: string }): JSX.Element {
  const { t } = useT()
  const label = stepLabelKey(id)
  return <span className="min-w-0 flex-1 truncate text-body text-text">{t(label.key, label.vars)}</span>
}

/** 确认：列出将执行的动作与将生成的文件；文件行可展开看将写入的内容。 */
export function ConfirmStep({ plan, mode, clients }: ConfirmStepProps): JSX.Element {
  const { t } = useT()
  const [open, setOpen] = useState<string | null>(null)
  return (
    <div className="grid gap-3" data-testid="np-confirm">
      <p className="flex min-w-0 items-center gap-2 text-caption" data-testid="np-confirm-root">
        <span className="flex-none text-text-3">{t('projects.path')}</span>
        <span className="truncate font-mono text-text" title={plan.root}>{plan.root}</span>
      </p>
      <ul className="divide-y divide-border rounded-md border border-border bg-card" data-testid="np-actions">
        {mode === 'empty' && (
          <>
            <li className={ROW} data-testid="np-action-directory"><Label id="directory" /></li>
            <li className={ROW} data-testid="np-action-git"><Label id="git" /></li>
            {plan.directories.length > 0 && (
              <li className={ROW} data-testid="np-action-skeleton">
                <Label id="skeleton" />
                <span className="min-w-0 truncate font-mono text-caption text-text-3" title={plan.directories.map((entry) => entry.path).join(' ')}>
                  {plan.directories.map((entry) => entry.path).join(' ')}
                </span>
              </li>
            )}
          </>
        )}
        {plan.files.map((file) => {
          const expanded = open === file.id
          const change = file.current === null ? 'projects.change_new' : file.current === file.next ? 'projects.change_same' : 'projects.change_modify'
          return (
            <li key={file.id} data-testid={`np-plan-${file.id}`}>
              <button
                type="button"
                aria-expanded={expanded}
                aria-label={`${t(stepLabelKey(`file:${file.id}`).key, { file: file.id })} · ${t('projects.expand')}`}
                className={cn(ROW, 'w-full text-left outline-none transition-colors duration-(--dur-fast) hover:bg-fill focus-visible:ring-2 focus-visible:ring-(--accent)')}
                data-testid={`np-plan-toggle-${file.id}`}
                onClick={() => setOpen(expanded ? null : file.id)}
              >
                <Label id={`file:${file.id}`} />
                <span className="flex-none text-caption text-text-2">{t(change)}</span>
                <ChevronRight className={cn('size-4 flex-none text-text-3 transition-transform duration-(--dur-fast)', expanded && 'rotate-90')} aria-hidden="true" />
              </button>
              {expanded && (
                <pre className="max-h-60 overflow-auto border-t border-border bg-fill/45 px-3 py-2 font-mono text-micro text-text-2 animate-in fade-in-0 duration-(--dur-base)" data-testid={`np-plan-content-${file.id}`}>
                  {file.next}
                </pre>
              )}
            </li>
          )
        })}
        <li className={ROW} data-testid="np-action-clients">
          <Label id="clients" />
          <span className="min-w-0 truncate text-caption text-text-3" title={clientNames(clients)}>{clientNames(clients)}</span>
        </li>
        <li className={ROW} data-testid="np-action-register">
          <Label id="register" />
          {plan.registration === 'already' && <span className="flex-none text-caption text-text-2">{t('projects.registered')}</span>}
        </li>
      </ul>
    </div>
  )
}
