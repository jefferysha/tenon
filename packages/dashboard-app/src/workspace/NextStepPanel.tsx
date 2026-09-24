import { ArrowRight, Terminal } from 'lucide-react'
import { useT } from '../i18n'
import { CommandLine } from './CommandLine'
import { statusCommand, takeoverCommand } from './taskCommands'
import { forwardExitOf, stageLabel, type TaskRow } from './taskModel'
import { BUTTON_GHOST } from '../shared/uiRecipes'

export interface NextStepPanelProps {
  row: TaskRow
  onToast?: (message: string) => void
}

/**
 * 状态行下的「下一步」：前进出口的阻断（与 `tenon status` exits 同一份判定），每条一行；
 * 可复制的 `tenon status` 命令看完整下一步；「复制接管命令」在自己的会话里接手。已完结不显示。
 */
export function NextStepPanel({ row, onToast }: NextStepPanelProps): JSX.Element | null {
  const { t } = useT()
  const { change, root } = row
  if (row.summary.kind === 'completed') return null
  const exit = forwardExitOf(change, row.rules)
  const lines = row.summary.kind === 'review'
    ? [t('workspace.summary_review')]
    : exit === null
      ? []
      : exit.ready ? [t('workspace.summary_ready', { to: stageLabel(exit.to, row.rules) })] : exit.blockers
  const takeover = takeoverCommand(root, change.name)
  const copyTakeover = (): void => {
    void navigator.clipboard?.writeText(takeover).then(() => onToast?.(t('workspace.takeover_copied')), () => undefined)
  }
  return (
    <section className="mb-6 grid gap-3 rounded-md border border-border bg-card p-4" aria-labelledby="task-next-title" data-testid="task-next">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <h2 id="task-next-title" className="flex min-w-0 items-center gap-2 whitespace-nowrap text-title font-semibold text-text">
          <ArrowRight className="size-4 flex-none text-(--accent)" aria-hidden="true" />
          {t('workspace.next_title')}
          {lines.length > 1 && <span className="font-mono text-caption font-normal text-text-3">{lines.length}</span>}
        </h2>
        <button type="button" className={BUTTON_GHOST} title={t('workspace.takeover_hint')} data-testid="task-next-takeover" onClick={copyTakeover}>
          <Terminal className="size-4" aria-hidden="true" />
          {t('workspace.copy_takeover')}
        </button>
      </div>
      {lines.length > 0 && (
        <ul className="grid gap-1" data-testid="task-next-blockers">
          {lines.map((line, index) => (
            <li key={`${index}:${line}`} className="truncate whitespace-nowrap text-body text-text-2" title={line} data-testid="task-next-blocker">{line}</li>
          ))}
        </ul>
      )}
      <div title={t('workspace.next_command_hint')}>
        <CommandLine command={statusCommand(root, change.name)} testId="task-next-command" />
      </div>
    </section>
  )
}
