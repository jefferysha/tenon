import './progress.css'
import { useT } from '../i18n'
import type { ChangeSnapshot } from '../types'
import { Switch } from '@/components/ui/switch'
import { useAfkLog } from './useAfkLog'
import { fieldStr } from '../workspace/taskRows'

export interface RunLogPaneProps {
  root: string
  change: ChangeSnapshot
}

export function RunLogPane({ root, change }: RunLogPaneProps): JSX.Element {
  const { t } = useT()
  const { log, follow, setFollow } = useAfkLog(change.name, fieldStr(change, 'automation'), root)
  const sandboxPhase = fieldStr(change, 'automation_current_phase')
  return (
    <div className="mt-4 border-t border-border pt-3" data-testid={`prg-log-${change.name}`}>
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="font-mono text-caption text-text-3">{t('progress.log_label')}</span>
        <span className="flex items-center gap-2 text-caption text-text-2">
          {t('progress.follow_tail')}
          <Switch
            checked={follow}
            onCheckedChange={setFollow}
            size="sm"
            aria-label={t('progress.follow_tail')}
            data-testid={`prg-follow-${change.name}`}
          />
        </span>
      </div>
      <pre
        className="max-h-[220px] overflow-auto rounded-md border border-code-border bg-code-bg p-2.5 font-mono text-caption leading-relaxed text-text-2"
        data-testid={`prg-logtext-${change.name}`}
      >
        {log}
      </pre>
      {sandboxPhase !== '' && (
        <p className="mt-2 text-caption text-text-3" data-testid={`prg-sandbox-phase-${change.name}`}>
          {t('progress.sandbox_phase', { phase: sandboxPhase })}
        </p>
      )}
    </div>
  )
}
