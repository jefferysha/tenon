import { useRef, useState, type ReactNode } from 'react'
import { isBuiltinWorkflowName, isDefaultWorkflowName } from '@tenon/kernel/workflow/identifier'
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
import { AlertTriangle, ChevronDown, Download, FileCheck, Lock, MoreHorizontal, Plus, RotateCcw, ShieldCheck, Trash2, Zap } from 'lucide-react'
import type { WbStepDef, WbWorkflowDef, WbWorkflowSource } from '../api/governanceTypes'
import { useT } from '../i18n'
import { useFlipLayout } from '../shared/useFlip'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Hint } from './Hint'
import { BASE_BRANCH } from '../workbench/workbenchDefinition'
import type { LintIssue } from './lint'
import { lintMessage } from './lintMessages'
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
  /** 当前工作流是插件内建（只读）：名旁显示锁，悬停说明。 */
  readOnly?: boolean
  /** 能否新建工作流（有写凭证即可，只读的内建也能复制）；缺省同 canWrite。 */
  canCreate?: boolean
  busy: boolean
  /** 工作流是否接入 OpenSpec（default 恒开、不可关）。 */
  openspec: boolean
  onToggleOpenspec: () => void
  onSwitch: (name: string) => void
  onSwitchBranch: (branch: string) => void
  onCreate: () => void
  onExport: () => void
  onDelete: () => void
  onNewTrack: () => void
  onDeleteTrack: (trackId: string) => void
  onSelect: (id: string) => void
  /** 左栏阶段块的 ⋯ → 删除阶段（确认框由页面负责）。 */
  onDeleteStage: (id: string) => void
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
/** 回流弧目标端的 4px 开口箭头（弧从右侧回到目标阶段，箭头朝左指向它）。 */
export function backArrowPath(toIndex: number): string {
  const y = toIndex * STEP_PITCH + STEP_HEIGHT / 2
  return `M4 ${y - 4} L0 ${y} L4 ${y + 4}`
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

const MENU_ICON_BUTTON = 'grid size-8 flex-none place-items-center rounded-sm text-text-3 outline-none hover:bg-fill hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent) disabled:cursor-not-allowed disabled:opacity-50 data-[state=open]:bg-fill data-[state=open]:text-text'
const MENU_ITEM = 'min-h-10 gap-2.5 px-2.5 text-body [&_svg]:text-text-3'

function StepRow({ step, order, selected, issue, editable, deletable, labelOf, onSelect, onDelete, onHover }: {
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
        {step.gate !== null && <span data-testid={`wb-gate-${step.id}`}><GateIcon gate={step.gate} /></span>}
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

type MenuEntry = { id: string; label: string; icon: ReactNode; onSelect: () => void; disabled: boolean; danger?: boolean; checked?: boolean; hint?: string }

/**
 * 工作流页左栏：工作流名（点开切换）+ ⋯ 菜单 → 轨道下划线页签 +「+」→ 编号纵向流程
 * （圆点 = 拖柄，块 = 名称 + 门禁图标，右侧虚线 = 回流）→ 添加阶段。
 */
export function WorkflowNav(props: WorkflowNavProps): JSX.Element {
  const { names, current, defaultSource, branches, branch, def, labelOf, selectedId, lint, loading, error, canWrite, busy, openspec } = props
  const readOnly = props.readOnly === true
  const canCreate = props.canCreate ?? canWrite
  const { t } = useT()
  const isDefault = current !== null && isDefaultWorkflowName(current)
  const tracks = branches.filter((candidate) => candidate.id !== BASE_BRANCH)
  const trackLabel = tracks.find((candidate) => candidate.id === branch)?.label ?? branch
  const deleteEnabled = canWrite && !busy && current !== null && (!isDefault || defaultSource !== 'builtin')

  const steps = def?.steps ?? []
  const edges = pipelineEdges(steps)
  const visible = steps
  const editable = canWrite
  const [dragging, setDragging] = useState<string | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)
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

  // 工作流级动作：常规项在上，破坏性的（删除 / 恢复内建 / 删除轨道）在分隔线下。
  const menu: MenuEntry[] = [
    { id: 'new', label: t('workflow.new_workflow'), icon: <Plus />, onSelect: props.onCreate, disabled: !canCreate || busy },
    { id: 'export', label: t('workflow.export_yaml'), icon: <Download />, onSelect: props.onExport, disabled: current === null },
    // default 恒受 OpenSpec 治理，开关只对自定义工作流开放。
    // 开关决定阶段能否「+ 输入 / + 输出」文档：关闭时输入输出只来自字段，说明放在 Tooltip。
    { id: 'openspec', label: t('workflow.openspec_menu'), icon: <FileCheck />, onSelect: props.onToggleOpenspec, checked: openspec, disabled: !canWrite || busy || isDefault || current === null, hint: t('workflow.openspec_hint') },
  ]
  const destructive: MenuEntry[] = readOnly ? [] : [
    isDefault
      ? { id: 'restore', label: t('workflow.restore_default'), icon: <RotateCcw />, onSelect: props.onDelete, disabled: !deleteEnabled }
      : { id: 'delete', label: t('workflow.delete_workflow'), icon: <Trash2 />, onSelect: props.onDelete, disabled: !deleteEnabled, danger: true },
    ...(branch !== BASE_BRANCH ? [{ id: 'delete-track', label: `${t('workflow.delete_track')} ${trackLabel}`, icon: <Trash2 />, onSelect: () => props.onDeleteTrack(branch), disabled: !canWrite || busy, danger: true }] : []),
  ]
  const menuItem = (item: MenuEntry): JSX.Element => item.checked === undefined ? (
    <DropdownMenuItem key={item.id} variant={item.danger === true ? 'destructive' : 'default'} className={MENU_ITEM} disabled={item.disabled} data-testid={`wb-wf-menu-${item.id}`} onSelect={item.onSelect}>
      {item.icon}
      {item.label}
    </DropdownMenuItem>
  ) : (
    <Hint key={item.id} label={item.hint ?? item.label} side="left">
      <DropdownMenuCheckboxItem className={cn(MENU_ITEM, 'pl-8')} checked={item.checked} disabled={item.disabled} data-testid={`wb-wf-menu-${item.id}`} onSelect={item.onSelect}>
        {item.label}
      </DropdownMenuCheckboxItem>
    </Hint>
  )
  const lockHint = t('workflow.builtin_read_only')

  return (
    <aside className="flex min-h-0 flex-col gap-5 overflow-y-auto border-r border-border bg-card px-5 py-5 max-[900px]:border-r-0 max-[900px]:border-b" aria-label={t('workflow.rail_title')} data-testid="workflow-nav">
      <div className="flex items-center justify-between gap-2">
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex min-h-10 min-w-0 max-w-full items-center gap-1.5 rounded-xs text-left text-title font-bold tracking-[-.01em] text-text outline-none hover:text-(--accent) focus-visible:ring-2 focus-visible:ring-(--accent)"
              aria-label={t('workflow.switch_workflow')}
              data-testid="wb-wf-switch"
              disabled={busy}
            >
              <span className="truncate whitespace-nowrap" title={current ?? undefined}>{current ?? ''}</span>
              <ChevronDown className="size-3.5 flex-none text-text-3" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[220px]" data-testid="wb-wf-list">
            <DropdownMenuRadioGroup value={current ?? ''} onValueChange={(name) => { if (name !== current) props.onSwitch(name) }}>
              {names.map((name) => (
                <DropdownMenuRadioItem key={name} value={name} className={cn(MENU_ITEM, 'pl-8')} data-testid={`wb-wf-item-${name}`}>
                  <span className="min-w-0 flex-1 truncate whitespace-nowrap" title={name}>{name}</span>
                  {isBuiltinWorkflowName(name) && <Lock className="size-3.5 flex-none" aria-label={lockHint} data-testid={`wb-wf-item-lock-${name}`} />}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        {readOnly && (
          <Hint label={lockHint}>
            <button type="button" className="grid size-6 flex-none place-items-center rounded-xs text-text-3 outline-none focus-visible:ring-2 focus-visible:ring-(--accent)" aria-label={lockHint} data-testid="wb-wf-lock">
              <Lock className="size-3.5" aria-hidden="true" />
            </button>
          </Hint>
        )}
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button type="button" className={cn(MENU_ICON_BUTTON, 'ml-auto')} aria-label={t('workflow.workflow_menu')} data-testid="wb-wf-menu" disabled={busy}>
              <MoreHorizontal className="size-4" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[220px]" data-testid="wb-wf-menu-menu">
            {menu.map(menuItem)}
            {destructive.length > 0 && <DropdownMenuSeparator />}
            {destructive.map(menuItem)}
          </DropdownMenuContent>
        </DropdownMenu>
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
          <button type="button" className="ml-auto mb-1.5 grid size-6 place-items-center rounded-xs text-text-3 outline-none hover:bg-fill hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent) disabled:cursor-not-allowed disabled:opacity-50" aria-label={t('workflow.new_track')} title={t('workflow.new_track')} disabled={!canWrite || busy} data-testid="wb-track-new" onClick={props.onNewTrack}>
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
                {backEdges.map((edge) => {
                  const active = hovered === edge.from || hovered === edge.to || hovered === `${edge.from}->${edge.to}`
                  const label = t('workflow.back_arc', { from: labelOf(edge.from), to: labelOf(edge.to) })
                  return (
                    <g key={`${edge.from}-${edge.to}`} className={cn('fill-none transition-[stroke] duration-(--dur-fast) ease-(--ease-out) motion-reduce:transition-none', active ? 'stroke-accent-b' : 'stroke-border-2')} data-testid={`wb-back-arc-${edge.from}-${edge.to}`} data-active={active || undefined}>
                      {/* 悬停标签：透明宽描边接住指针，原生 title 说明从哪退回到哪。 */}
                      <path d={backEdgePath(edge.fromIndex, edge.toIndex)} className="cursor-default" style={{ pointerEvents: 'stroke' }} stroke="transparent" strokeWidth="10" data-testid={`wb-back-hit-${edge.from}-${edge.to}`} onMouseEnter={() => setHovered(`${edge.from}->${edge.to}`)} onMouseLeave={() => setHovered(null)}>
                        <title>{label}</title>
                      </path>
                      <path d={backEdgePath(edge.fromIndex, edge.toIndex)} strokeWidth="1.2" strokeDasharray="3 3" data-testid={`wb-back-edge-${edge.from}-${edge.to}`} />
                      <path d={backArrowPath(edge.toIndex)} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" data-testid={`wb-back-arrow-${edge.from}-${edge.to}`} />
                    </g>
                  )
                })}
              </svg>
            )}
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={(event: DragStartEvent) => setDragging(String(event.active.id))} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
              <SortableContext items={visible.map((step) => step.id)} strategy={verticalListSortingStrategy}>
                <ol ref={listRef} className="grid" style={{ rowGap: STEP_PITCH - STEP_HEIGHT }} data-testid="stage-list-items">
                  {visible.map((step) => (
                    <StepRow key={step.id} step={step} order={steps.indexOf(step) + 1} selected={step.id === selectedId} issue={lint.find((issue) => issue.stepId === step.id && issue.severity === 'error') ?? lint.find((issue) => issue.stepId === step.id)} editable={editable} deletable={editable && steps.length > 1} labelOf={labelOf} onSelect={props.onSelect} onDelete={props.onDeleteStage} onHover={setHovered} />
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
