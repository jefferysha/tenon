import { useEffect, useRef, useState } from 'react'
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
import { ChevronDown, Download, Plus, RotateCcw, ShieldCheck, Trash2, Zap } from 'lucide-react'
import type { WbStepDef, WbWorkflowDef, WbWorkflowSource } from '../api/governanceTypes'
import { useT } from '../i18n'
import { MenuButton } from '../shared/MenuButton'
import { useFlipLayout } from '../shared/useFlip'
import { BASE_BRANCH } from '../workbench/workbenchDefinition'
import type { LintIssue } from './lint'
import { backEdgesFrom, pipelineEdges } from './pipelineModel'
import { cn } from '@/lib/utils'

export interface WorkflowNavProps {
  names: readonly string[]
  current: string | null
  defaultSource: WbWorkflowSource
  branches: ReadonlyArray<{ id: string; label: string | null }>
  branch: string
  def: WbWorkflowDef | null
  labelOf: (stepId: string) => string
  selectedId: string | null
  lint: readonly LintIssue[]
  loading: boolean
  error: string | null
  canWrite: boolean
  busy: boolean
  onSwitch: (name: string) => void
  onSwitchBranch: (branch: string) => void
  onCreate: () => void
  onExport: () => void
  onDelete: () => void
  onNewTrack: () => void
  onDeleteTrack: (trackId: string) => void
  onSelect: (id: string) => void
  onAddStage: () => void
  onReorder: (fromId: string, toId: string, after: boolean) => void
}

/** 行高 40 + 行距 14：回流弧按序号算坐标，不测 DOM。 */
export const STEP_PITCH = 54
export const STEP_HEIGHT = 40
export function backEdgePath(fromIndex: number, toIndex: number): string {
  const y1 = fromIndex * STEP_PITCH + STEP_HEIGHT / 2
  const y2 = toIndex * STEP_PITCH + STEP_HEIGHT / 2
  return `M0 ${y1} C 18 ${y1}, 18 ${y2}, 0 ${y2}`
}

function GateIcon({ gate }: { gate: WbStepDef['gate'] }): JSX.Element | null {
  const { t } = useT()
  if (gate === null) return null
  const Icon = gate === 'review' ? ShieldCheck : Zap
  return (
    <span className={cn('grid flex-none place-items-center', gate === 'review' ? 'text-amber-d' : 'text-(--accent)')} title={t(`workflow.gate_${gate}`)} data-testid="wb-gate-mark" data-gate={gate}>
      <Icon className="size-3.5" aria-hidden="true" />
      <span className="sr-only">{t(`workflow.gate_${gate}`)}</span>
    </span>
  )
}

function StepRow({ step, order, selected, missing, editable, labelOf, onSelect }: {
  step: WbStepDef
  order: number
  selected: boolean
  missing: boolean
  editable: boolean
  labelOf: (stepId: string) => string
  onSelect: (id: string) => void
}): JSX.Element {
  const { t } = useT()
  const { attributes, listeners, setNodeRef, isDragging } = useSortable({ id: step.id, disabled: !editable })
  return (
    <li ref={setNodeRef} data-flip-id={`stage:${step.id}`} className={cn('grid grid-cols-[28px_minmax(0,1fr)] items-center gap-3 transition-opacity duration-150', isDragging && 'opacity-35')} style={{ height: STEP_HEIGHT }} data-testid={`wb-pipeline-node-${step.id}`}>
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
      <button
        type="button"
        className={cn(
          'flex h-10 min-w-0 items-center justify-between gap-2 rounded-sm border px-3 text-left text-base outline-none transition-colors focus-visible:ring-2 focus-visible:ring-(--accent)',
          selected ? 'border-(--accent) bg-accent-t font-semibold text-(--accent)' : 'border-border bg-card font-medium text-text hover:border-border-2',
        )}
        aria-current={selected ? 'true' : undefined}
        data-testid={`wb-step-${step.id}`}
        onClick={() => onSelect(step.id)}
      >
        <span className="truncate">{labelOf(step.id)}</span>
        <span className="flex flex-none items-center gap-1.5">
          {missing && <span className="size-1.5 rounded-full bg-(--amber-d)" title={t('workflow.lint_no_output')} data-testid={`wb-lint-${step.id}`} />}
          {step.gate !== null && <span data-testid={`wb-gate-${step.id}`}><GateIcon gate={step.gate} /></span>}
        </span>
      </button>
    </li>
  )
}

/**
 * 工作流页左栏：工作流名（点开切换）+ ⋯ 菜单 → 轨道下划线页签 +「+」→ 编号纵向流程
 * （圆点 = 拖柄，块 = 名称 + 门禁图标，右侧虚线 = 回流）→ 添加阶段。
 */
export function WorkflowNav(props: WorkflowNavProps): JSX.Element {
  const { names, current, defaultSource, branches, branch, def, labelOf, selectedId, lint, loading, error, canWrite, busy } = props
  const { t } = useT()
  const [switching, setSwitching] = useState(false)
  const switchRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!switching) return
    const onDown = (event: MouseEvent): void => { if (switchRef.current !== null && !switchRef.current.contains(event.target as Node)) setSwitching(false) }
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') { event.stopPropagation(); setSwitching(false) } }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey, true) }
  }, [switching])

  const isDefault = current === 'default'
  const source = isDefault ? defaultSource : 'project'
  const tracks = branches.filter((candidate) => candidate.id !== BASE_BRANCH)
  const trackLabel = tracks.find((candidate) => candidate.id === branch)?.label ?? branch
  const deleteEnabled = canWrite && !busy && current !== null && (!isDefault || defaultSource === 'project')
  const noToken = canWrite ? undefined : t('workflow.no_token')

  const steps = def?.steps ?? []
  const edges = pipelineEdges(steps)
  const visible = steps
  const editable = canWrite
  const [dragging, setDragging] = useState<string | null>(null)
  const listRef = useRef<HTMLOListElement>(null)
  const captureFlip = useFlipLayout(listRef, [steps.map((step) => step.id).join('|')])
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor))
  const backEdges = steps.flatMap((step, index) => backEdgesFrom(edges, step.id).map((edge) => ({ ...edge, fromIndex: index, toIndex: steps.findIndex((candidate) => candidate.id === edge.to) })))
  const listHeight = visible.length * STEP_PITCH - (visible.length > 0 ? STEP_PITCH - STEP_HEIGHT : 0)

  function onDragEnd(event: DragEndEvent): void {
    setDragging(null)
    const over = event.over
    if (over === null || over.id === event.active.id) return
    const fromIndex = steps.findIndex((step) => step.id === String(event.active.id))
    const toIndex = steps.findIndex((step) => step.id === String(over.id))
    if (fromIndex < 0 || toIndex < 0) return
    captureFlip()
    props.onReorder(String(event.active.id), String(over.id), toIndex > fromIndex)
  }

  const menu = [
    { id: 'new', label: t('workflow.new_workflow'), icon: <Plus />, onSelect: props.onCreate, disabled: !canWrite || busy, title: noToken },
    { id: 'export', label: t('workflow.export_yaml'), icon: <Download />, onSelect: props.onExport, disabled: current === null },
    isDefault
      ? { id: 'restore', label: t('workflow.restore_default'), icon: <RotateCcw />, onSelect: props.onDelete, disabled: !deleteEnabled, title: noToken }
      : { id: 'delete', label: t('workflow.delete_workflow'), icon: <Trash2 />, onSelect: props.onDelete, disabled: !deleteEnabled, title: noToken, danger: true },
    ...(branch !== BASE_BRANCH ? [{ id: 'delete-track', label: `${t('workflow.delete_track')} ${trackLabel}`, icon: <Trash2 />, onSelect: () => props.onDeleteTrack(branch), disabled: !canWrite || busy, title: noToken, danger: true }] : []),
  ]

  return (
    <aside className="flex min-h-0 flex-col gap-5 overflow-y-auto border-r border-border bg-card px-5 py-5 max-[900px]:border-r-0 max-[900px]:border-b" aria-label={t('workflow.rail_title')} data-testid="workflow-nav">
      <div className="flex items-start justify-between gap-2">
        <div ref={switchRef} className="relative min-w-0">
          <button
            type="button"
            className="flex max-w-full items-center gap-1.5 rounded-xs text-left text-title font-bold tracking-[-.01em] text-text outline-none hover:text-(--accent) focus-visible:ring-2 focus-visible:ring-(--accent)"
            aria-haspopup="listbox"
            aria-expanded={switching}
            aria-label={t('workflow.switch_workflow')}
            data-testid="wb-wf-switch"
            onClick={() => setSwitching((value) => !value)}
          >
            <span className="truncate">{current ?? ''}</span>
            <ChevronDown className="size-3.5 flex-none text-text-3" aria-hidden="true" />
          </button>
          <p className="mt-0.5 text-caption text-text-3" data-testid="wb-wf-meta">
            <span data-testid={`wb-wf-source-${current ?? ''}`}>{t(`workflow.source_${source}`)}</span>
            {tracks.length > 0 && <> · {t('workflow.branches_meta', { n: tracks.length })}</>}
          </p>
          {switching && (
            <ul className="absolute left-0 top-[calc(100%+6px)] z-40 min-w-[220px] rounded-md border border-border bg-card p-1 shadow-lg" role="listbox" aria-label={t('workflow.switch_workflow')} data-testid="wb-wf-list">
              {names.map((name) => {
                const selected = name === current
                return (
                  <li key={name}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={selected}
                      className={cn('flex w-full items-center gap-2 rounded-sm px-2.5 py-2 text-left text-body outline-none hover:bg-fill focus-visible:bg-fill', selected ? 'font-semibold text-(--accent)' : 'text-text')}
                      data-testid={`wb-wf-item-${name}`}
                      onClick={() => { setSwitching(false); if (!busy && !selected) props.onSwitch(name) }}
                    >
                      <span className="min-w-0 flex-1 truncate">{name}</span>
                      <span className="rounded-full bg-fill px-1.5 text-micro text-text-2">{t(`workflow.source_${name === 'default' ? defaultSource : 'project'}`)}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
        <MenuButton testId="wb-wf-menu" label={t('workflow.workflow_menu')} disabled={busy} items={menu} />
      </div>

      {tracks.length > 0 && (
        <div className="flex items-end gap-3.5 overflow-x-auto border-b border-border" role="tablist" aria-label={t('workflow.tracks_title')} data-testid="wb-tracks">
          {tracks.map((candidate) => {
            const active = candidate.id === branch
            return (
              <button
                key={candidate.id}
                type="button"
                role="tab"
                aria-selected={active}
                className={cn('-mb-px flex-none whitespace-nowrap border-b-2 pb-2 text-body outline-none transition-colors focus-visible:ring-2 focus-visible:ring-(--accent)', active ? 'border-(--accent) font-semibold text-text' : 'border-transparent text-text-2 hover:text-text')}
                data-testid={`wb-track-${candidate.id}`}
                onClick={() => { if (!busy) props.onSwitchBranch(candidate.id) }}
              >
                {candidate.label ?? candidate.id}
              </button>
            )
          })}
          <button type="button" className="ml-auto mb-1.5 grid size-6 place-items-center rounded-xs text-text-3 outline-none hover:bg-fill hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent) disabled:cursor-not-allowed disabled:opacity-50" aria-label={t('workflow.new_track')} title={noToken ?? t('workflow.new_track')} disabled={!canWrite || busy} data-testid="wb-track-new" onClick={props.onNewTrack}>
            <Plus className="size-3.5" aria-hidden="true" />
          </button>
        </div>
      )}
      {tracks.length === 0 && current !== null && canWrite && (
        <button type="button" className="inline-flex items-center gap-1.5 self-start text-body text-text-2 outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent)" data-testid="wb-track-new" disabled={busy} onClick={props.onNewTrack}>
          <Plus className="size-3.5" aria-hidden="true" />
          {t('workflow.new_track')}
        </button>
      )}

      {error !== null ? (
        <p className="rounded-md border border-red-b bg-red-t px-3 py-2 text-body text-red-d" role="alert">{error}</p>
      ) : loading ? (
        <p className="text-body text-text-3" role="status" aria-live="polite">{t('common.loading')}</p>
      ) : (
        <div className="grid gap-3.5 pt-1">
          <div className="relative">
            {visible.length > 1 && <span className="absolute left-3.5 w-px bg-border-2" style={{ top: STEP_HEIGHT / 2, height: listHeight - STEP_HEIGHT }} aria-hidden="true" />}
            {backEdges.length > 0 && (
              <svg className="pointer-events-none absolute -right-5 top-0 overflow-visible" width="22" height={listHeight} aria-hidden="true">
                {backEdges.map((edge) => <path key={`${edge.from}-${edge.to}`} d={backEdgePath(edge.fromIndex, edge.toIndex)} fill="none" stroke="var(--border-2)" strokeWidth="1.2" strokeDasharray="3 3" data-testid={`wb-back-edge-${edge.from}-${edge.to}`} />)}
              </svg>
            )}
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={(event: DragStartEvent) => setDragging(String(event.active.id))} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
              <SortableContext items={visible.map((step) => step.id)} strategy={verticalListSortingStrategy}>
                <ol ref={listRef} className="grid" style={{ rowGap: STEP_PITCH - STEP_HEIGHT }} data-testid="stage-list-items">
                  {visible.map((step) => (
                    <StepRow key={step.id} step={step} order={steps.indexOf(step) + 1} selected={step.id === selectedId} missing={lint.some((issue) => issue.stepId === step.id && issue.kind === 'step-no-output')} editable={editable} labelOf={labelOf} onSelect={props.onSelect} />
                  ))}
                </ol>
              </SortableContext>
              <DragOverlay dropAnimation={{ duration: 180, easing: 'cubic-bezier(0.2, 0, 0, 1)' }}>
                {dragging !== null && <div className="flex h-10 items-center rounded-sm border border-(--accent) bg-card px-3 text-base font-semibold text-text shadow-lg" data-testid="stage-drag-overlay">{labelOf(dragging)}</div>}
              </DragOverlay>
            </DndContext>
          </div>
          {def !== null && canWrite && (
            <button type="button" className="grid grid-cols-[28px_minmax(0,1fr)] items-center gap-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-(--accent)" data-testid="wb-add-stage" onClick={props.onAddStage}>
              <span className="grid size-7 place-items-center rounded-full border border-dashed border-border-2 text-text-3" aria-hidden="true"><Plus className="size-3.5" /></span>
              <span className="flex h-10 items-center rounded-sm border border-dashed border-border px-3 text-base text-text-3 transition-colors hover:border-border-2 hover:text-text-2">{t('workflow.add_stage')}</span>
            </button>
          )}
        </div>
      )}
    </aside>
  )
}
