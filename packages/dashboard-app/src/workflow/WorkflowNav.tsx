import { useEffect, useRef, useState, type ReactNode } from 'react'
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
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { ChevronDown, Download, FileCheck, Lock, MoreHorizontal, Plus, RotateCcw, Trash2 } from 'lucide-react'
import type { WbWorkflowDef, WbWorkflowSource } from '../api/governanceTypes'
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
import { backEdgesFrom, pipelineEdges } from './pipelineModel'
import { MENU_ICON_BUTTON, MENU_ITEM, OverviewRow, STEP_HEIGHT, StepRow } from './WorkflowStepRows'
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
  /** 左栏顶部「总览」行（第 0 步）是否选中；选中时阶段块都不高亮。 */
  overviewSelected?: boolean
  onSelectOverview?: () => void
}

/** 行高 40 + 行距 14：回流弧按序号算坐标，不测 DOM。 */
export const STEP_PITCH = 54
export { STEP_HEIGHT }
export function backEdgePath(fromIndex: number, toIndex: number): string {
  const y1 = fromIndex * STEP_PITCH + STEP_HEIGHT / 2
  const y2 = toIndex * STEP_PITCH + STEP_HEIGHT / 2
  return `M0 ${y1} C 18 ${y1}, 18 ${y2}, 0 ${y2}`
}
/** 回流弧目标端的 5px 开口箭头（弧从右侧回到目标阶段，箭头朝左指向它）。 */
export function backArrowPath(toIndex: number): string {
  const y = toIndex * STEP_PITCH + STEP_HEIGHT / 2
  return `M5 ${y - 3.5} L0 ${y} L5 ${y + 3.5}`
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
  const tabsRef = useRef<HTMLDivElement>(null)
  // 英文轨道名比中文长，页签条放不下时横向滚动：选中的页签（含 URL 深链进来的）要滚进可见范围，不留半截。
  useEffect(() => {
    tabsRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [branch, tracks.length])
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
        <div className="flex items-end gap-3.5 border-b border-border">
          {/* tablist 里只能有 tab：新建轨道的 + 在它旁边，不在它里面。 */}
          <div ref={tabsRef} className="flex min-w-0 items-end gap-3.5 overflow-x-auto" role="tablist" aria-label={t('workflow.tracks_title')} data-testid="wb-tracks">
          {tracks.map((candidate) => {
            const active = candidate.id === branch
            return (
              <button
                key={candidate.id}
                type="button"
                role="tab"
                aria-selected={active}
                className={cn('-mb-px flex-none whitespace-nowrap border-b-2 pb-2 text-body outline-none transition-colors focus-visible:ring-2 focus-visible:ring-(--accent)', active ? 'border-(--accent) font-semibold text-text' : 'border-transparent text-text-2 hover:text-text')}
                title={candidate.label ?? candidate.id}
                data-testid={`wb-track-${candidate.id}`}
                onClick={() => { if (!busy) props.onSwitchBranch(candidate.id) }}
              >
                {candidate.label ?? candidate.id}
              </button>
            )
          })}
          </div>
          <button type="button" className="ml-auto mb-1.5 grid size-6 flex-none place-items-center rounded-xs text-text-3 outline-none hover:bg-fill hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent) disabled:cursor-not-allowed disabled:opacity-50" aria-label={t('workflow.new_track')} title={t('workflow.new_track')} disabled={!canWrite || busy} data-testid="wb-track-new" onClick={props.onNewTrack}>
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
          {props.onSelectOverview !== undefined && def !== null && steps.length > 0 && (
            <OverviewRow selected={props.overviewSelected === true} onSelect={props.onSelectOverview} />
          )}
          <div className="relative">
            {visible.length > 1 && <span className="absolute left-3.5 w-px bg-border-2" style={{ top: STEP_HEIGHT / 2, height: listHeight - STEP_HEIGHT }} aria-hidden="true" />}
            {backEdges.length > 0 && (
              <svg className="pointer-events-none absolute -right-5 top-0 overflow-visible" width="22" height={listHeight} aria-hidden="true">
                {backEdges.map((edge) => {
                  const active = hovered === edge.from || hovered === edge.to || hovered === `${edge.from}->${edge.to}`
                  const label = t('workflow.back_arc', { from: labelOf(edge.from), to: labelOf(edge.to) })
                  return (
                    <g key={`${edge.from}-${edge.to}`} className={cn('fill-none transition-[stroke] duration-(--dur-fast) ease-(--ease-out) motion-reduce:transition-none', active ? 'stroke-(--accent)' : 'stroke-(--flow-line)')} data-testid={`wb-back-arc-${edge.from}-${edge.to}`} data-active={active || undefined}>
                      {/* 悬停标签：透明宽描边接住指针，原生 title 说明从哪退回到哪。 */}
                      <path d={backEdgePath(edge.fromIndex, edge.toIndex)} className="cursor-default" style={{ pointerEvents: 'stroke' }} stroke="transparent" strokeWidth="10" data-testid={`wb-back-hit-${edge.from}-${edge.to}`} onMouseEnter={() => setHovered(`${edge.from}->${edge.to}`)} onMouseLeave={() => setHovered(null)}>
                        <title>{label}</title>
                      </path>
                      <path d={backEdgePath(edge.fromIndex, edge.toIndex)} strokeWidth="1.25" strokeDasharray="2 3" data-testid={`wb-back-edge-${edge.from}-${edge.to}`} />
                      <path d={backArrowPath(edge.toIndex)} strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" data-testid={`wb-back-arrow-${edge.from}-${edge.to}`} />
                    </g>
                  )
                })}
              </svg>
            )}
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={(event: DragStartEvent) => setDragging(String(event.active.id))} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
              <SortableContext items={visible.map((step) => step.id)} strategy={verticalListSortingStrategy}>
                <ol ref={listRef} className="grid" style={{ rowGap: STEP_PITCH - STEP_HEIGHT }} data-testid="stage-list-items">
                  {visible.map((step) => (
                    <StepRow key={step.id} step={step} order={steps.indexOf(step) + 1} selected={props.overviewSelected !== true && step.id === selectedId} issue={lint.find((issue) => issue.stepId === step.id && issue.severity === 'error') ?? lint.find((issue) => issue.stepId === step.id)} editable={editable} deletable={editable && steps.length > 1} labelOf={labelOf} onSelect={props.onSelect} onDelete={props.onDeleteStage} onHover={setHovered} />
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
