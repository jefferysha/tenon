import { useT } from '../i18n'
import { Check, Circle } from 'lucide-react'
import type { ChangeHistoryEntry } from '../api/client'
import type { EvidenceChip } from '../model/evidence'
import type { PipelineTodoItem } from '../types'
import { Icon } from './Icon'
import { outputPresentation, outputValuePresentation } from './outputPresentation'

export interface EvidencePartProps {
  chip: EvidenceChip
  onCopy: (value: string) => void
}

export function StageChip({ chip, onCopy }: EvidencePartProps): JSX.Element {
  const { lang, t } = useT()
  const presentation = outputPresentation(chip.key, lang)
  if (chip.unset) {
    return (
      <span
        className="inline-flex h-[22px] items-center rounded-sm border border-dashed border-border-2 bg-transparent px-2 font-mono text-micro text-text-3"
        data-testid={`dtl-chip-empty-${chip.key}`}
      >
        <span title={presentation.title}>{presentation.label}</span> · {t('evidence.unset')}
      </span>
    )
  }
  if (!chip.copyable) {
    return (
      <span
        className="inline-flex h-[22px] items-center gap-1 rounded-sm border border-border bg-fill px-2 font-mono text-micro text-text-2"
        data-testid={`dtl-chip-${chip.key}`}
      >
        <span title={presentation.title}>{presentation.label}</span>：{outputValuePresentation(chip.value, lang)}
      </span>
    )
  }
  return (
    <button
      type="button"
      className="inline-flex h-[22px] cursor-pointer items-center gap-1 rounded-sm border border-border bg-fill px-2 font-mono text-micro text-text-2 transition-colors hover:border-border-2 hover:bg-fill-2 hover:text-text"
      data-copy={chip.value}
      data-testid={`dtl-chip-${chip.key}`}
      title={t('detail.copy_field', { field: chip.key })}
      onClick={() => onCopy(chip.value)}
    >
      <span className="text-text-3" aria-hidden="true"><Icon name="copy" size={11} /></span>
      {chip.value}
    </button>
  )
}

export function BoxField({ chip, onCopy }: EvidencePartProps): JSX.Element {
  const { lang, t } = useT()
  const presentation = outputPresentation(chip.key, lang)
  const tone = chip.unset ? 'miss' : chip.tone === 'pass' ? 'pass' : chip.tone === 'fail' ? 'fail' : 'plain'
  const valueClass = tone === 'pass'
    ? 'font-bold text-green-d'
    : tone === 'fail'
      ? 'font-bold text-red-d'
      : tone === 'miss' ? 'text-text-3' : 'text-text'
  return (
    <div
      className={`min-w-0 rounded-sm border border-border px-2 py-1 ${tone === 'miss' ? 'border-dashed bg-transparent' : 'bg-card'}`}
      data-state={tone}
      data-testid={`dt-field-${chip.key}`}
    >
      <div className="text-micro font-semibold text-text-2 [overflow-wrap:anywhere]" title={`${presentation.title} (${chip.key})`}>
        {presentation.label}
      </div>
      {chip.copyable && !chip.unset ? (
        <button
          type="button"
          className={`inline cursor-pointer border-0 bg-transparent p-0 text-left font-mono text-caption transition-colors [overflow-wrap:anywhere] hover:text-accent-d ${valueClass}`}
          data-copy={chip.value}
          title={t('detail.copy_field', { field: chip.key })}
          onClick={() => onCopy(chip.value)}
        >
          {chip.value} <span className="inline-block align-[-2px]" aria-hidden="true"><Icon name="copy" size={11} /></span>
        </button>
      ) : (
        <div className={`text-caption [overflow-wrap:anywhere] ${valueClass}`}>
          {chip.unset ? t('evidence.unset') : outputValuePresentation(chip.value, lang)}
        </div>
      )}
    </div>
  )
}

export interface StageTaskListProps {
  stage: string
  tasks: PipelineTodoItem[]
  collapseCompleted: boolean
}

function TaskItems({ stage, tasks, compact }: {
  stage: string
  tasks: PipelineTodoItem[]
  compact: boolean
}): JSX.Element {
  return (
    <>
      {tasks.map((task, taskIndex) => (
        <li
          className={`flex gap-1.5 [overflow-wrap:anywhere] ${task.completed ? 'text-text-3 line-through' : 'text-text-2'}`}
          data-completed={task.completed ? 'true' : 'false'}
          data-testid={`dtl-todo-${stage}-${compact ? 'compact-' : ''}${taskIndex}`}
          key={`${taskIndex}-${task.text}`}
        >
          {task.completed ? <Check className="mt-0.5 size-3 flex-none" strokeWidth={1.75} aria-hidden="true" /> : <Circle className="mt-0.5 size-3 flex-none" strokeWidth={1.75} aria-hidden="true" />}
          <span>{task.text}</span>
        </li>
      ))}
    </>
  )
}

export function StageTaskList({ stage, tasks, collapseCompleted }: StageTaskListProps): JSX.Element {
  const { t } = useT()
  return (
    <>
      <ul
        className={`mt-2 mb-0 list-none flex-col gap-1 pl-0 text-caption ${collapseCompleted ? 'flex max-[769px]:hidden' : 'flex'}`}
        data-testid={`dtl-todo-${stage}`}
      >
        <TaskItems stage={stage} tasks={tasks} compact={false} />
      </ul>
      {collapseCompleted && (
        <details
          className="mt-2 text-caption text-text-3 min-[769px]:hidden"
          data-testid={`dtl-todo-${stage}-compact`}
        >
          <summary className="cursor-pointer select-none font-medium text-text-2">
            {t('detail.completed_tasks_summary', { n: tasks.length })}
          </summary>
          <ul className="mt-1.5 mb-0 flex list-none flex-col gap-1 pl-0">
            <TaskItems stage={stage} tasks={tasks} compact />
          </ul>
        </details>
      )}
    </>
  )
}

export function historyText(
  entry: ChangeHistoryEntry,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  if (entry.kind === 'transition' && entry.from && entry.to) {
    return `${entry.from} → ${entry.to}${entry.raw ? ` · ${entry.raw}` : ''}`
  }
  if (entry.kind === 'init') return t('detail.hist_init')
  if (entry.kind === 'import') return t('detail.hist_import')
  if (entry.kind === 'set' && entry.field) return t('detail.hist_set', { field: entry.field })
  return entry.raw ?? entry.kind
}
