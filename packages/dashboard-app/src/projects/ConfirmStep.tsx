import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { useT } from '../i18n'
import type { ProjectCreatePlan } from '../api/instructionsDecoders'
import { cn } from '@/lib/utils'
import { CLIENTS, FILE_MODES, stepLabelKey, type FileMode } from './newProjectModel'

const clientNames = (ids: readonly string[]): string =>
  ids.map((id) => CLIENTS.find((client) => client.id === id)?.name ?? id).join(', ')

export interface ConfirmStepProps {
  plan: ProjectCreatePlan
  mode: 'existing' | 'empty'
  /** 记入 `.tenon/clients.json` 的客户端 id。 */
  clients: readonly string[]
  /** 已有文件的处理方式（缺省追加）。 */
  fileModes: Readonly<Record<string, FileMode>>
  onFileMode: (file: string, mode: FileMode) => void
}

const ROW = 'flex min-h-10 items-center gap-3 px-3 whitespace-nowrap'
const MODE_LABEL: Record<FileMode, string> = { append: 'projects.mode_append', replace: 'projects.mode_replace', skip: 'projects.mode_skip' }

function Label({ id, muted = false }: { id: string; muted?: boolean }): JSX.Element {
  const { t } = useT()
  const label = stepLabelKey(id)
  return <span className={cn('min-w-0 flex-1 truncate text-body', muted ? 'text-text-3 line-through' : 'text-text')}>{t(label.key, label.vars)}</span>
}

function ModeChoice({ file, value, onChange }: { file: string; value: FileMode; onChange: (mode: FileMode) => void }): JSX.Element {
  const { t } = useT()
  return (
    <div role="radiogroup" aria-label={file} className="flex flex-none gap-0.5 rounded-sm bg-fill p-0.5" data-testid={`np-file-mode-${file}`}>
      {FILE_MODES.map((mode) => (
        <button
          key={mode}
          type="button"
          role="radio"
          aria-checked={value === mode}
          title={t(`${MODE_LABEL[mode]}_hint`)}
          className="min-h-7 rounded-xs px-2 text-micro font-semibold text-text-2 outline-none transition-colors duration-(--dur-fast) hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent) aria-checked:bg-card aria-checked:text-text aria-checked:shadow-sm"
          data-testid={`np-file-mode-${file}-${mode}`}
          onClick={() => onChange(mode)}
        >
          {t(MODE_LABEL[mode])}
        </button>
      ))}
    </div>
  )
}

/** 确认：列出将执行的动作与将生成的文件；文件行标 新建 / 修改 / 不变，已有文件可选 追加 / 覆盖 / 跳过，可展开看内容。 */
export function ConfirmStep({ plan, mode, clients, fileModes, onFileMode }: ConfirmStepProps): JSX.Element {
  const { t } = useT()
  const [open, setOpen] = useState<string | null>(null)
  return (
    <div className="grid gap-3" data-testid="np-confirm">
      <p className="flex min-w-0 items-center gap-2 text-caption" data-testid="np-confirm-root">
        <span className="flex-none text-text-3">{t('projects.path')}</span>
        <span className="truncate font-mono text-text" title={plan.root}>{plan.root}</span>
      </p>
      <ul className="divide-y divide-border rounded-md border border-border bg-card" data-testid="np-actions">
        {mode === 'empty' && <li className={ROW} data-testid="np-action-directory"><Label id="directory" /></li>}
        {plan.git === 'init' && <li className={ROW} data-testid="np-action-git"><Label id="git" /></li>}
        {plan.directories.length > 0 && (
          <li className={ROW} data-testid="np-action-skeleton">
            <Label id="skeleton" />
            <span className="min-w-0 truncate font-mono text-caption text-text-3" title={plan.directories.map((entry) => entry.path).join(' ')}>
              {plan.directories.map((entry) => entry.path).join(' ')}
            </span>
          </li>
        )}
        {plan.files.map((file) => {
          const expanded = open === file.id
          const fileMode = file.current === null ? null : fileModes[file.id] ?? 'append'
          const skipped = fileMode === 'skip'
          const change = file.current === null ? 'projects.change_new' : file.current === file.next ? 'projects.change_same' : 'projects.change_modify'
          return (
            <li key={file.id} data-testid={`np-plan-${file.id}`} data-mode={fileMode ?? 'new'}>
              <div className={ROW}>
                <button
                  type="button"
                  aria-expanded={expanded}
                  className="flex min-h-10 min-w-0 flex-1 items-center gap-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-(--accent)"
                  data-testid={`np-plan-toggle-${file.id}`}
                  onClick={() => setOpen(expanded ? null : file.id)}
                >
                  <ChevronRight className={cn('size-4 flex-none text-text-3 transition-transform duration-(--dur-fast)', expanded && 'rotate-90')} aria-hidden="true" />
                  <Label id={`file:${file.id}`} muted={skipped} />
                  {!skipped && <span className="flex-none text-caption text-text-2" data-testid={`np-plan-change-${file.id}`}>{t(change)}</span>}
                </button>
                {fileMode !== null && <ModeChoice file={file.id} value={fileMode} onChange={(next) => onFileMode(file.id, next)} />}
              </div>
              {expanded && (
                <pre className="max-h-60 overflow-auto border-t border-border bg-fill/45 px-3 py-2 font-mono text-micro text-text-2 animate-in fade-in-0 duration-(--dur-base)" data-testid={`np-plan-content-${file.id}`}>
                  {skipped ? file.current : file.next}
                </pre>
              )}
            </li>
          )
        })}
        {clients.length > 0 && (
          <li className={ROW} data-testid="np-action-clients">
            <Label id="clients" />
            <span className="min-w-0 truncate text-caption text-text-3" title={clientNames(clients)}>{clientNames(clients)}</span>
          </li>
        )}
        <li className={ROW} data-testid="np-action-register">
          <Label id="register" />
        </li>
      </ul>
    </div>
  )
}
