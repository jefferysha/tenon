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
import { Plus, ShieldCheck, Undo2, Zap } from 'lucide-react'
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
  /** 当前分支的名称（轨道 label ?? id）；单条 pipeline 时为 null。 */
  branchLabel: string | null
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

const GATE_TONE: Record<'review' | 'auto', string> = {
  review: 'border-amber-b bg-amber-t text-amber-d',
  auto: 'border-accent-b bg-accent-t text-(--accent)',
}

/** 门禁标：评审 = 盾（要人停下），自动 = 闪电（输出齐全即放行）。 */
export function GateMark({ gate, compact = false }: { gate: WbStepDef['gate']; compact?: boolean }): JSX.Element | null {
  const { t } = useT()
  if (gate === null) return null
  const Icon = gate === 'review' ? ShieldCheck : Zap
  if (compact) {
    return (
      <span className={cn('grid size-5 place-items-center rounded-full border', GATE_TONE[gate])} data-testid="wb-gate-node" data-gate={gate} title={t(`workflow.gate_${gate}`)}>
        <Icon className="size-3" aria-hidden="true" />
      </span>
    )
  }
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-caption font-semibold', GATE_TONE[gate])} data-testid="wb-gate-mark" data-gate={gate}>
      <Icon className="size-3" aria-hidden="true" />
      {t(`workflow.gate_${gate}`)}
    </span>
  )
}

const SPINE = 'grid grid-cols-[36px_minmax(0,1fr)] gap-x-4'

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
  const line = cn('w-px flex-1', linked ? 'bg-border-2' : 'border-l border-dashed border-border-2')
  return (
    <li ref={setNodeRef} data-flip-id={`stage:${step.id}`} className={cn(SPINE, 'transition-opacity duration-150', isDragging && 'opacity-35')} data-testid={`wb-pipeline-node-${step.id}`}>
      <div className="flex flex-col items-center">
        <button
          type="button"
          className={cn(
            'grid size-9 flex-none place-items-center rounded-full border-2 font-mono text-body font-semibold outline-none transition-[box-shadow,background-color,border-color,color] duration-150 focus-visible:ring-2 focus-visible:ring-(--accent)',
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
          <span className="flex flex-1 flex-col items-center py-1" aria-hidden="true" data-testid={`wb-link-${step.id}`} data-linked={linked}>
            <span className={line} />
            {step.gate !== null && <span className="my-1"><GateMark gate={step.gate} compact /></span>}
            <span className={line} />
          </span>
        )}
      </div>
      <div className="pb-5">
        <button
          type="button"
          className={cn(
            'flex w-full min-w-0 items-center justify-between gap-4 rounded-lg border px-5 py-4 text-left outline-none transition-[box-shadow,border-color,background-color] duration-150 focus-visible:ring-2 focus-visible:ring-(--accent)',
            selected ? 'border-accent-b bg-card shadow-md' : 'border-border bg-card shadow-xs hover:border-border-2 hover:shadow-sm',
          )}
          aria-current={selected ? 'true' : undefined}
          data-testid={`wb-step-${step.id}`}
          onClick={() => onSelect(step.id)}
        >
          <span className={cn('truncate text-title font-semibold', selected ? 'text-(--accent)' : 'text-text')}>{labelOf(step.id)}</span>
          <span className="flex flex-none items-center gap-1.5">
            {missing && <span className="rounded-full bg-amber-t px-2 py-0.5 text-caption font-semibold text-amber-d" data-testid={`wb-lint-${step.id}`}>{t('workflow.lint_no_output')}</span>}
            {step.gate !== null && <span data-testid={`wb-gate-${step.id}`}><GateMark gate={step.gate} /></span>}
          </span>
        </button>
        {back.length > 0 && (
          <span className="mt-2 flex flex-wrap gap-1.5">
            {back.map((edge) => (
              <span key={`${edge.from}-${edge.to}`} className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2.5 py-0.5 text-caption text-text-2" data-testid={`wb-back-edge-${edge.from}-${edge.to}`}>
                <Undo2 className="size-3" aria-hidden="true" />
                {t('workflow.back_to', { stage: labelOf(edge.to) })}
              </span>
            ))}
          </span>
        )}
      </div>
    </li>
  )
}

/**
 * 工作流页中列：所选分支的流程骨架——脊柱上的序号（拖柄）与门禁节点，卡片只有名称与门禁标，
 * 回流边为卡片下的药丸；末尾脊柱上的「+」添加阶段。技能、输入输出都在右列。
 */
export function PipelineList({ def, branchLabel, labelOf, selectedId, lint, query, loading, error, canWrite, onSelect, onAddStage, onReorder }: PipelineListProps): JSX.Element {
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
    <ListColumn eyebrow={def?.name ?? ''} title={branchLabel ?? t('workflow.stages_title')} testId="stage-list">
      {error !== null ? (
        <p className="rounded-md border border-red-b bg-red-t px-4 py-3 text-body text-red-d" role="alert">{error}</p>
      ) : loading ? (
        <p className="text-body text-text-3" role="status" aria-live="polite">{t('common.loading')}</p>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={(event: DragStartEvent) => setDragging(String(event.active.id))} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
          <SortableContext items={visible.map((step) => step.id)} strategy={verticalListSortingStrategy}>
            <ol ref={listRef} className="grid pt-1" data-testid="stage-list-items">
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
              <div className="rounded-lg border border-accent-b bg-card px-5 py-4 text-title font-semibold text-text shadow-lg" data-testid="stage-drag-overlay">{labelOf(dragging)}</div>
            )}
          </DragOverlay>
        </DndContext>
      )}
      {!loading && error === null && def !== null && canWrite && (
        <div className={SPINE}>
          <span className="flex flex-col items-center" aria-hidden="true">
            <span className="mb-1 h-4 w-px border-l border-dashed border-border-2" />
            <span className="grid size-9 place-items-center rounded-full border-2 border-dashed border-border text-text-3"><Plus className="size-4" /></span>
          </span>
          <button type="button" className="mt-5 self-start text-left text-base text-text-2 outline-none transition-colors hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent)" data-testid="wb-add-stage" onClick={onAddStage}>
            {t('workflow.add_stage')}
          </button>
        </div>
      )}
    </ListColumn>
  )
}
