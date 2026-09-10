import { useRef, useState } from 'react'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CornerLeftUp, Plus, ShieldCheck, Zap } from 'lucide-react'
import type { WbStepDef, WbWorkflowDef } from '../api/governanceTypes'
import { useT } from '../i18n'
import { matchesQuery } from '../shell/GlobalSearch'
import { ListColumn } from '../shell/ThreeColumns'
import { useFlipLayout } from '../shared/useFlip'
import type { LintIssue } from './lint'
import { backEdgesFrom, linkedToNext, pipelineEdges, type PipelineEdge } from './pipelineModel'
import { cn } from '@/lib/utils'

export interface PipelineListProps {
  def: WbWorkflowDef | null
  /** 当前工作流的分支（tracks）；只有单条 pipeline 时不显示切换条。 */
  branches: ReadonlyArray<{ id: string; label: string | null }>
  branch: string
  onSwitchBranch: (branch: string) => void
  labelOf: (stepId: string) => string
  selectedId: string | null
  lint: readonly LintIssue[]
  query: string
  loading: boolean
  error: string | null
  canWrite: boolean
  onSelect: (id: string) => void
  onAddStage: () => void
  /** 拖拽排序：把 fromId 放到 toId 之前 / 之后。 */
  onReorder: (fromId: string, toId: string, after: boolean) => void
}

function GateMark({ gate }: { gate: WbStepDef['gate'] }): JSX.Element | null {
  const { t } = useT()
  if (gate === null) return null
  const Icon = gate === 'review' ? ShieldCheck : Zap
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-caption font-medium', gate === 'review' ? 'bg-seg-now-t text-seg-now' : 'bg-accent-t text-(--accent)')} data-testid="wb-gate-mark" data-gate={gate}>
      <Icon className="size-3" aria-hidden="true" />
      {t(`workflow.gate_${gate}`)}
    </span>
  )
}

function StageNode({ step, order, last, linked, back, selected, missing, editable, labelOf, onSelect }: {
  step: WbStepDef
  order: number
  last: boolean
  linked: boolean
  back: readonly PipelineEdge[]
  selected: boolean
  missing: boolean
  editable: boolean
  labelOf: (stepId: string) => string
  onSelect: (id: string) => void
}): JSX.Element {
  const { t } = useT()
  const { attributes, listeners, setNodeRef, isDragging } = useSortable({ id: step.id, disabled: !editable })
  return (
    <li ref={setNodeRef} data-flip-id={`stage:${step.id}`} className={cn('grid grid-cols-[32px_minmax(0,1fr)] gap-x-3 transition-opacity duration-150', isDragging && 'opacity-35')} data-testid={`wb-pipeline-node-${step.id}`}>
      <div className="flex flex-col items-center">
        <button
          type="button"
          className={cn(
            'grid size-8 flex-none place-items-center rounded-full border font-mono text-caption outline-none transition-[box-shadow,background-color,border-color] duration-150 focus-visible:ring-2 focus-visible:ring-(--accent)',
            selected ? 'border-(--accent) bg-(--accent) text-btn-fg shadow-[0_0_0_4px_var(--accent-t)]' : 'border-border-2 bg-card text-text-2',
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
        {!last && (
          <span className={cn('my-1 w-0.5 flex-1 rounded-full', linked ? 'bg-gradient-to-b from-border-2 to-border' : 'border-l-2 border-dashed border-border')} aria-hidden="true" data-testid={`wb-link-${step.id}`} data-linked={linked} />
        )}
      </div>
      <div className="pb-3">
        <button
          type="button"
          className={cn(
            'grid w-full min-w-0 gap-1.5 rounded-lg border px-4 py-3 text-left outline-none transition-[box-shadow,border-color,background-color] duration-150 focus-visible:ring-2 focus-visible:ring-(--accent)',
            selected ? 'border-accent-b bg-card shadow-md' : 'border-border bg-card shadow-xs hover:border-border-2 hover:shadow-sm',
          )}
          aria-current={selected ? 'true' : undefined}
          data-testid={`wb-step-${step.id}`}
          onClick={() => onSelect(step.id)}
        >
          <span className="flex min-w-0 items-center justify-between gap-3">
            <span className={cn('truncate text-title font-semibold', selected ? 'text-(--accent)' : 'text-text')}>{labelOf(step.id)}</span>
            <span className="flex flex-none items-center gap-1.5">
              {missing && <span className="rounded-full bg-amber-t px-2 py-0.5 text-caption font-semibold text-amber-d" data-testid={`wb-lint-${step.id}`}>{t('workflow.lint_no_output')}</span>}
              {step.gate !== null && <span data-testid={`wb-gate-${step.id}`}><GateMark gate={step.gate} /></span>}
            </span>
          </span>
          <span className="flex min-w-0 flex-wrap items-center gap-1.5">
            {step.skills.length === 0
              ? <span className="font-mono text-caption text-text-3">{t('workflow.card_skills', { n: 0 })}</span>
              : step.skills.map((skill) => <span key={skill.id} className="rounded-sm bg-fill px-1.5 py-0.5 font-mono text-caption text-text-2">{skill.id}</span>)}
          </span>
        </button>
        {back.map((edge) => (
          <span key={`${edge.from}-${edge.to}`} className="mt-1.5 inline-flex items-center gap-1.5 pl-1 text-caption text-text-3" data-testid={`wb-back-edge-${edge.from}-${edge.to}`}>
            <CornerLeftUp className="size-3.5" aria-hidden="true" />
            {t('workflow.back_to', { stage: labelOf(edge.to) })}
          </span>
        ))}
      </div>
    </li>
  )
}

/** 工作流页中列：分支切换 + 竖向流程图（可拖序号拖拽排序；主干连接线；门禁标；回流边）；末尾「添加阶段」。 */
export function PipelineList({ def, branches, branch, onSwitchBranch, labelOf, selectedId, lint, query, loading, error, canWrite, onSelect, onAddStage, onReorder }: PipelineListProps): JSX.Element {
  const { t } = useT()
  const steps = def?.steps ?? []
  const edges = pipelineEdges(steps)
  const visible = steps.filter((step) => matchesQuery(query, labelOf(step.id), step.id, ...step.skills.map((skill) => skill.id)))
  const [dragging, setDragging] = useState<string | null>(null)
  const listRef = useRef<HTMLOListElement>(null)
  const captureFlip = useFlipLayout(listRef, [steps.map((step) => step.id).join('|')])
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor))
  const editable = canWrite && query.trim() === ''

  function onDragEnd(event: DragEndEvent): void {
    setDragging(null)
    const over = event.over
    if (over === null || over.id === event.active.id) return
    const fromIndex = steps.findIndex((step) => step.id === String(event.active.id))
    const toIndex = steps.findIndex((step) => step.id === String(over.id))
    if (fromIndex < 0 || toIndex < 0) return
    captureFlip()
    onReorder(String(event.active.id), String(over.id), toIndex > fromIndex)
  }

  return (
    <ListColumn eyebrow={def?.name.toUpperCase() ?? ''} title={t('workflow.stages_title')} testId="stage-list">
      {branches.length > 1 && (
        <div className="mb-5 flex flex-wrap gap-1 rounded-md bg-bg p-1" role="tablist" aria-label={t('workflow.tracks_title')} data-testid="branch-tabs">
          {branches.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              role="tab"
              aria-selected={candidate.id === branch}
              className="rounded-sm px-2.5 py-1 text-body text-text-2 outline-none transition-colors hover:bg-fill focus-visible:ring-2 focus-visible:ring-(--accent) aria-selected:bg-card aria-selected:font-semibold aria-selected:text-(--accent) aria-selected:shadow-xs"
              data-testid={`branch-tab-${candidate.id === '' ? 'base' : candidate.id}`}
              onClick={() => onSwitchBranch(candidate.id)}
            >
              {candidate.label ?? t('workflow.branch_base')}
            </button>
          ))}
        </div>
      )}
      {error !== null ? (
        <p className="rounded-md border border-red-b bg-red-t px-4 py-3 text-body text-red-d" role="alert">{error}</p>
      ) : loading ? (
        <p className="text-body text-text-3" role="status" aria-live="polite">{t('common.loading')}</p>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={(event: DragStartEvent) => setDragging(String(event.active.id))} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
          <SortableContext items={visible.map((step) => step.id)} strategy={verticalListSortingStrategy}>
            <ol ref={listRef} className="grid" data-testid="stage-list-items">
              {visible.map((step, index) => {
                const position = steps.indexOf(step)
                const next = steps[position + 1]
                return (
                  <StageNode
                    key={step.id}
                    step={step}
                    order={position + 1}
                    last={index === visible.length - 1}
                    linked={linkedToNext(edges, step.id, next?.id)}
                    back={backEdgesFrom(edges, step.id)}
                    selected={step.id === selectedId}
                    missing={lint.some((issue) => issue.stepId === step.id && issue.kind === 'step-no-output')}
                    editable={editable}
                    labelOf={labelOf}
                    onSelect={onSelect}
                  />
                )
              })}
              {visible.length === 0 && steps.length > 0 && (
                <li className="text-body text-text-3" role="status">{t('workflow.empty_filtered')}</li>
              )}
            </ol>
          </SortableContext>
          <DragOverlay dropAnimation={{ duration: 180, easing: 'cubic-bezier(0.2, 0, 0, 1)' }}>
            {dragging !== null && (
              <div className="rounded-lg border border-accent-b bg-card px-4 py-3 text-title font-semibold text-text shadow-lg" data-testid="stage-drag-overlay">{labelOf(dragging)}</div>
            )}
          </DragOverlay>
        </DndContext>
      )}
      {!loading && error === null && def !== null && (
        <div className="mt-1 grid grid-cols-[32px_minmax(0,1fr)] gap-x-3">
          <span className="grid size-8 place-items-center rounded-full border border-dashed border-border text-text-3" aria-hidden="true"><Plus className="size-4" /></span>
          <button type="button" className="rounded-lg border border-dashed border-border px-4 py-3 text-left text-base text-text-2 outline-none transition-colors hover:border-text-3 hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent) disabled:opacity-50" disabled={!canWrite} data-testid="wb-add-stage" onClick={onAddStage}>
            {t('workflow.add_stage')}
          </button>
        </div>
      )}
    </ListColumn>
  )
}
