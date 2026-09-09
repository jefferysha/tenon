import { useT } from '../i18n'
import type { ChangeSnapshot } from '../types'
import { Icon } from './Icon'
import {
  SessionResumeRow,
  connKeyCls,
  connNoteCls,
  connRowCls,
  connValCls,
  copyBtnCls,
} from './SessionResumeRow'
import { shellQuote } from './shellQuote'

export interface TaskConnectionCardProps {
  root: string
  change: ChangeSnapshot
  automation: string
  onCopy: (value: string) => void
}

export function TaskConnectionCard({
  root,
  change,
  automation,
  onCopy,
}: TaskConnectionCardProps): JSX.Element | null {
  if (automation !== 'running' && automation !== 'failed' && automation !== 'conflict') return null
  const { t } = useT()
  const worktreeValue = change.fields.automation_worktree
  const sandboxValue = change.fields.automation_sandbox
  const worktree = typeof worktreeValue === 'string' ? worktreeValue : ''
  const sandbox = typeof sandboxValue === 'string' ? sandboxValue : ''
  const worktreeCommand = `cd ${shellQuote(worktree)}`
  const sandboxCommand = `docker exec -it ${shellQuote(sandbox)} bash`
  const rerunCommand = `tenon afk enqueue ${shellQuote(change.name)}`
  const row = (testId: string, label: string, command: string, note?: string): JSX.Element => (
    <div className={connRowCls} data-testid={testId}>
      <span className={connKeyCls}>{label}</span>
      <span className={connValCls}>{command}</span>
      {note && <span className={connNoteCls}>{note}</span>}
      <button
        type="button"
        className={copyBtnCls}
        data-copy={command}
        data-testid={`${testId}-copy`}
        aria-label={t('detail.copy_cmd')}
        onClick={() => onCopy(command)}
      >
        <Icon name="copy" size={12} />
      </button>
    </div>
  )
  return (
    <div className="border-b border-border py-3 last:border-b-0" data-testid="dt8-conn">
      <div className="mb-2.5 flex items-baseline gap-2 text-caption font-bold text-text">
        {t('detail.selffix_title')} <span className="text-caption font-normal text-text-3">{t('detail.selffix_desc')}</span>
      </div>
      <div className="rounded-md border border-accent-b bg-accent-t px-4 py-3">
        <div className="flex flex-col gap-2">
          <SessionResumeRow root={root} name={change.name} onCopy={onCopy} />
          {worktree !== '' && row('dt8-conn-worktree', t('detail.conn_worktree'), worktreeCommand)}
          {sandbox !== '' && row(
            'dt8-conn-sandbox',
            t('detail.conn_sandbox'),
            sandboxCommand,
            automation !== 'running' ? t('detail.conn_not_running') : undefined,
          )}
          {row('dt8-conn-rerun', t('detail.conn_rerun'), rerunCommand)}
        </div>
        <p className="mt-2 mb-0 text-micro text-text-3">{t('detail.conn_src')}</p>
      </div>
    </div>
  )
}
