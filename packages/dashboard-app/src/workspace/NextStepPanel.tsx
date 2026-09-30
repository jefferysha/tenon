import { ArrowRight, Terminal } from 'lucide-react'
import { useT } from '../i18n'
import { mergeBlockerRows, type BlockerRow } from './blockerLabel'
import { CommandLine } from './CommandLine'
import { statusCommand, takeoverPrompt } from './taskCommands'
import { forwardExitOf, stageLabel, type TaskRow } from './taskModel'
import { BUTTON_GHOST } from '../shared/uiRecipes'

export interface NextStepPanelProps {
  row: TaskRow
  onToast?: (message: string) => void
}

/**
 * 状态行下的「下一步」：前进出口的阻断（与 `tenon status` exits 同一份判定）。同类阻断合并成一行
 * （「缺少文档 proposal · openspec-design · tasks」），每行 40px、左侧 2px 琥珀条，完整 CLI 文案进 title；
 * 标题旁不再放计数（数量在头部状态里）。可复制的 `tenon status` 命令从头部省略、保留末尾的
 * `tenon status <change>`；「复制接管命令」复制发给 agent 的恢复提示词。已完结不显示。
 * 整块不超出详情列：网格子项 min-w-0，命令截断、复制钮常显。
 */
export function NextStepPanel({ row, onToast }: NextStepPanelProps): JSX.Element | null {
  const { t } = useT()
  const { change, root } = row
  if (row.summary.kind === 'completed') return null
  const exit = forwardExitOf(change, row.rules)
  const plain = (text: string): BlockerRow[] => [{ label: text, title: text }]
  const rows: BlockerRow[] = row.summary.kind === 'review'
    ? plain(t('workspace.summary_review'))
    : exit === null
      ? []
      : exit.ready
        ? plain(t('workspace.summary_ready', { to: stageLabel(exit.to, row.rules) }))
        : mergeBlockerRows(exit.lines, t)
  const takeover = takeoverPrompt(change.name)
  const copyTakeover = (): void => {
    void navigator.clipboard?.writeText(takeover).then(() => onToast?.(t('workspace.takeover_copied')), () => undefined)
  }
  return (
    <section className="mb-6 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3 rounded-md border border-border bg-card p-4" aria-labelledby="task-next-title" data-testid="task-next">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <h2 id="task-next-title" className="flex min-w-0 flex-1 items-center gap-2 whitespace-nowrap text-title font-semibold text-text">
          <ArrowRight className="size-4 flex-none text-(--accent)" aria-hidden="true" />
          <span className="truncate">{t('workspace.next_title')}</span>
        </h2>
        <button type="button" className={`${BUTTON_GHOST} flex-none`} title={`${t('workspace.takeover_hint')} · ${takeover}`} data-testid="task-next-takeover" onClick={copyTakeover}>
          <Terminal className="size-4 flex-none" aria-hidden="true" />
          {t('workspace.copy_takeover')}
        </button>
      </div>
      {rows.length > 0 && (
        <ul className="grid min-w-0 gap-1" data-testid="task-next-blockers">
          {rows.map((item, index) => (
            <li
              key={`${index}:${item.title}`}
              className="h-10 min-w-0 truncate whitespace-nowrap border-l-2 border-amber-d pl-3 text-body leading-10 text-text-2"
              title={item.title}
              data-testid="task-next-blocker"
            >
              {item.label}
            </li>
          ))}
        </ul>
      )}
      <div className="min-w-0" title={t('workspace.next_command_hint')}>
        <CommandLine command={statusCommand(root, change.name)} testId="task-next-command" truncate="start" />
      </div>
    </section>
  )
}
