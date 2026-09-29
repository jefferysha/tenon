import { useSortable } from '@dnd-kit/sortable'
import { AlertTriangle, MoreHorizontal, ShieldCheck, Trash2, Zap } from 'lucide-react'
import type { WbStepDef } from '../api/governanceTypes'
import { useT } from '../i18n'
import { gateKind } from '../workbench/workbenchDefinition'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Hint } from './Hint'
import type { LintIssue } from './lint'
import { lintMessage } from './lintMessages'
import { cn } from '@/lib/utils'

/** 行高 40 + 行距 14：回流弧按序号算坐标，不测 DOM。 */
export const STEP_HEIGHT = 40

export function GateIcon({ gate }: { gate: 'review' | 'auto' }): JSX.Element {
  const { t } = useT()
  const Icon = gate === 'review' ? ShieldCheck : Zap
  return (
    <span className={cn('grid flex-none place-items-center', gate === 'review' ? 'text-amber-d' : 'text-(--accent)')} title={t(`workflow.gate_${gate}`)} data-testid="wb-gate-mark" data-gate={gate}>
      <Icon className="size-3.5" aria-hidden="true" />
      <span className="sr-only">{t(`workflow.gate_${gate}`)}</span>
    </span>
  )
}

export const MENU_ICON_BUTTON = 'grid size-8 flex-none place-items-center rounded-sm text-text-3 outline-none hover:bg-fill hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent) disabled:cursor-not-allowed disabled:opacity-50 data-[state=open]:bg-fill data-[state=open]:text-text'
export const MENU_ITEM = 'min-h-10 gap-2.5 px-2.5 text-body [&_svg]:text-text-3'

export function StepRow({ step, order, selected, issue, editable, deletable, labelOf, onSelect, onDelete, onHover }: {
  step: WbStepDef
  order: number
  selected: boolean
  /** 本阶段最要紧的一条 lint 问题（错误优先）；有就在块上标警示图标，悬停 / 聚焦看原因。 */
  issue: LintIssue | undefined
  editable: boolean
  deletable: boolean
  labelOf: (stepId: string) => string
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  /** 悬停 / 聚焦进出本阶段：null = 离开。与它相关的回流弧据此高亮。 */
  onHover: (id: string | null) => void
}): JSX.Element {
  const { t } = useT()
  const { attributes, listeners, setNodeRef, isDragging } = useSortable({ id: step.id, disabled: !editable })
  const issueText = issue === undefined ? null : lintMessage(t, issue, labelOf)
  const block = (
    <button
      type="button"
      className={cn(
        'flex h-10 w-full min-w-0 items-center justify-between gap-2 rounded-sm border pl-3 text-left text-base outline-none transition-colors focus-visible:ring-2 focus-visible:ring-(--accent)',
        selected ? 'border-(--accent) bg-accent-t pr-10 font-semibold text-(--accent)' : 'border-border bg-card pr-3 font-medium text-text hover:border-border-2',
      )}
      aria-current={selected ? 'true' : undefined}
      data-testid={`wb-step-${step.id}`}
      onClick={() => onSelect(step.id)}
    >
      <span className="truncate whitespace-nowrap">{labelOf(step.id)}</span>
      <span className="flex flex-none items-center gap-1.5">
        {issue !== undefined && <AlertTriangle className={cn('size-4', issue.severity === 'error' ? 'text-red-d' : 'text-amber-d')} aria-hidden="true" data-testid={`wb-lint-${step.id}`} data-severity={issue.severity} />}
        <span data-testid={`wb-gate-${step.id}`}><GateIcon gate={gateKind(step.gate)} /></span>
      </span>
    </button>
  )
  return (
    <li ref={setNodeRef} data-flip-id={`stage:${step.id}`} className={cn('grid grid-cols-[28px_minmax(0,1fr)] items-center gap-3 transition-opacity duration-150', isDragging && 'opacity-35')} style={{ height: STEP_HEIGHT }} data-testid={`wb-pipeline-node-${step.id}`} onMouseEnter={() => onHover(step.id)} onMouseLeave={() => onHover(null)} onFocus={() => onHover(step.id)} onBlur={() => onHover(null)}>
      <button
        type="button"
        className={cn(
          'relative z-10 grid size-7 place-items-center rounded-full border font-mono text-caption outline-none transition-colors focus-visible:ring-2 focus-visible:ring-(--accent)',
          selected ? 'border-(--accent) bg-(--accent) text-btn-fg' : 'border-border-2 bg-card text-text-2',
          editable ? 'cursor-grab touch-none active:cursor-grabbing' : 'cursor-default',
        )}
        aria-label={t('workflow.drag_stage', { name: labelOf(step.id) })}
        disabled={!editable}
        data-testid={`wb-stage-handle-${step.id}`}
        {...listeners}
        {...attributes}
      >
        {order}
      </button>
      <div className="relative min-w-0">
        {issueText === null ? block : <Hint label={issueText} side="right">{block}</Hint>}
        {selected && (
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <button type="button" className={cn(MENU_ICON_BUTTON, 'absolute right-1 top-1')} aria-label={t('workflow.stage_menu', { name: labelOf(step.id) })} data-testid={`wb-stage-menu-${step.id}`}>
                <MoreHorizontal className="size-4" aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[180px]">
              <DropdownMenuItem variant="destructive" className={MENU_ITEM} disabled={!deletable} data-testid={`wb-stage-delete-${step.id}`} onSelect={() => onDelete(step.id)}>
                <Trash2 aria-hidden="true" />
                {t('workflow.delete_stage')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </li>
  )
}

/** 「总览」行：编号 0 + 块，与阶段行同一几何；不可拖、没有门禁。 */
export function OverviewRow({ selected, onSelect }: { selected: boolean; onSelect: () => void }): JSX.Element {
  const { t } = useT()
  return (
    <div className="grid grid-cols-[28px_minmax(0,1fr)] items-center gap-3" style={{ height: STEP_HEIGHT }} data-testid="wb-overview-row">
      <span className={cn('grid size-7 place-items-center rounded-full border font-mono text-caption', selected ? 'border-(--accent) bg-(--accent) text-btn-fg' : 'border-border-2 bg-card text-text-2')} aria-hidden="true">0</span>
      <button
        type="button"
        className={cn(
          'flex h-10 w-full min-w-0 items-center rounded-sm border px-3 text-left text-base outline-none transition-colors focus-visible:ring-2 focus-visible:ring-(--accent)',
          selected ? 'border-(--accent) bg-accent-t font-semibold text-(--accent)' : 'border-border bg-card font-medium text-text hover:border-border-2',
        )}
        aria-current={selected ? 'true' : undefined}
        data-testid="wb-overview"
        onClick={onSelect}
      >
        <span className="truncate whitespace-nowrap">{t('workflow.overview')}</span>
      </button>
    </div>
  )
}
