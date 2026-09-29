import { createContext, memo, useContext } from 'react'
import { BaseEdge, Handle, Position, type Edge, type EdgeProps, type Node, type NodeProps } from '@xyflow/react'
import { Bot, Box, FileCheck, FlaskConical, Layers, Pencil, Plus, ScanSearch, ShieldCheck, Zap, type LucideIcon } from 'lucide-react'
import type { OrchestrationFlow, OrchestrationKind } from '@tenon/kernel/workflow/orchestration'
import type { FlowEntry, FlowStage, RunStatus } from '../api/workflowOrchestrationClient'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useT } from '../i18n'
import { kindLabel } from '../tests/testLabels'
import { HEADER_H, PORT, type FlowMode } from './orchestrationLayout'
import { EDGE_STYLE, PulseEdge } from './skillFlowNodes'
import { cn } from '@/lib/utils'

/** 画布级的交互与状态：节点从这里取回调与悬停高亮，节点 data 只放布局。 */
export interface OrchestrationCanvasContext {
  readonly mode: FlowMode
  readonly current: string | null
  readonly hovered: string | null
  readonly setHovered: (stage: string | null) => void
  readonly flows: readonly OrchestrationFlow[]
  readonly labelOf: (stage: string) => string
  readonly onOpenEntry?: (stage: string, entry: FlowEntry) => void
  /** 哪些条目点得开（缺省 = 有 onOpenEntry 就都点得开）。 */
  readonly openable?: (entry: FlowEntry) => boolean
  readonly onOpenStage?: (stage: string) => void
  readonly laneActions?: Partial<Record<OrchestrationKind, LaneAction>>
}

export interface LaneAction {
  readonly icon: 'edit' | 'add'
  readonly label: string
  readonly testId: string
  readonly onClick: () => void
  /** 自带菜单等浮层的动作（如测试的类型选择），替代默认按钮。 */
  readonly render?: () => JSX.Element
}

export const CanvasContext = createContext<OrchestrationCanvasContext>({
  mode: 'overview', current: null, hovered: null, setHovered: () => undefined, flows: [], labelOf: (stage) => stage,
})

export type EntryNode = Node<{ stage: string; entry: FlowEntry; width: number; height: number }, 'entry'>
export type StageNode = Node<{ stage: FlowStage; index: number; width: number; height: number }, 'stage'>
export type LaneNode = Node<{ kind: OrchestrationKind; count: number; width: number; height: number }, 'lane'>
export type PortNode = Node<{ label: string }, 'port'>
export type JunctionNode = Node<Record<string, never>, 'junction'>
export type CanvasNode = EntryNode | StageNode | LaneNode | PortNode | JunctionNode

export const KIND_ICON: Record<OrchestrationKind, LucideIcon> = { executor: Bot, skill: Box, test: FlaskConical, reviewer: ScanSearch }
export const KIND_TITLE: Record<OrchestrationKind, string> = {
  executor: 'workflow.executors_title',
  skill: 'workflow.skills_title',
  test: 'workflow.tests_title',
  reviewer: 'workflow.reviewers_title',
}
const STATUS_DOT: Record<RunStatus, string> = { done: 'bg-green', running: 'bg-info', failed: 'bg-red', waiting: 'bg-text-4', stale: 'bg-(--amber-d)' }
const STATUS_TEXT: Record<RunStatus, string> = { done: 'text-green-d', running: 'text-info-d', failed: 'text-red-d', waiting: 'text-text-3', stale: 'text-amber-d' }
/** 测试节点的状态词与测试页签同一套（通过 / 失败 / 过期 / 未运行 / 运行中）。 */
const TEST_STATE: Record<RunStatus, string> = { done: 'passed', running: 'running', failed: 'failed', waiting: 'missing', stale: 'stale' }
const HIDDEN_HANDLE = '!size-1 !min-h-0 !min-w-0 !border-0 !bg-transparent'

function StatusMark({ status, withLabel, test }: { status: RunStatus; withLabel: boolean; test: boolean }): JSX.Element {
  const { t } = useT()
  const label = t(test ? `tests.state.${TEST_STATE[status]}` : `workspace.run_${status}`)
  return (
    <span className={cn('inline-flex flex-none items-center gap-1.5 whitespace-nowrap text-micro', STATUS_TEXT[status])} title={label} data-testid="orch-status" data-status={status}>
      <i className={cn('size-1.5 rounded-full', STATUS_DOT[status], status === 'running' && 'animate-pulse motion-reduce:animate-none')} aria-hidden="true" />
      {withLabel ? label : <span className="sr-only">{label}</span>}
    </span>
  )
}

function SourceMark({ entry }: { entry: FlowEntry }): JSX.Element {
  const { t } = useT()
  const Icon = entry.source === 'openspec' ? FileCheck : entry.source === 'manifest' ? Layers : KIND_ICON[entry.kind]
  const title = entry.source === 'openspec' ? t('workflow.skill_injected') : entry.source === 'manifest' ? t('workflow.skill_manifest') : t(KIND_TITLE[entry.kind])
  return (
    <span className={cn('inline-flex flex-none', entry.source === 'declared' ? 'text-text-3' : 'text-(--accent)')} role="img" aria-label={title} title={title} data-testid={`orch-source-${entry.source}`}>
      <Icon className="size-3.5" aria-hidden="true" />
    </span>
  )
}

function EntryNodeView({ id, data }: NodeProps<EntryNode>): JSX.Element {
  const { t } = useT()
  const context = useContext(CanvasContext)
  const { entry, width, height, stage } = data
  const stageMode = context.mode === 'stage'
  const optional = entry.required ? '' : ` · ${t('workflow.agent_advisory')}`
  // 策略要求运行的测试节点：名字是种类的界面词，标识（unit）在悬停提示里。
  const name = entry.testKind === undefined ? entry.label : kindLabel(entry.testKind, t)
  const hint = entry.testKind === undefined ? entry.label : `${name} · ${entry.testKind}`
  const open = context.onOpenEntry !== undefined && (context.openable?.(entry) ?? true) ? context.onOpenEntry : undefined
  return (
    <div
      className={cn('group relative flex items-center rounded-sm border bg-card px-2.5 transition-[border-color] duration-(--dur-fast) ease-(--ease-out)', entry.required ? 'border-border' : 'border-dashed border-border-2', entry.status === 'running' && 'border-info-b', entry.status === 'failed' && 'border-red-b')}
      style={{ width, height }}
      data-testid={`orch-node-${entry.kind}-${entry.id}`}
      data-flow-node={id}
      data-kind={entry.kind}
      data-wave={entry.wave}
      data-source={entry.source}
      data-status={entry.status}
    >
      <span className="pointer-events-none absolute -inset-px rounded-sm border border-(--accent) opacity-0" aria-hidden="true" data-pulse-flash="" />
      <Handle type="target" id="top" position={Position.Top} className={HIDDEN_HANDLE} isConnectable={false} />
      <button
        type="button"
        className="grid w-full min-w-0 gap-0.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-(--accent) disabled:cursor-default"
        title={`${hint}${optional}`}
        aria-label={`${t(KIND_TITLE[entry.kind])} ${name}${optional}`}
        disabled={open === undefined}
        data-testid={`orch-open-${entry.kind}-${entry.id}`}
        onClick={() => open?.(stage, entry)}
      >
        <span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap">
          <SourceMark entry={entry} />
          <span className={cn('min-w-0 flex-1 truncate text-caption', entry.testKind === undefined && 'font-mono', entry.required ? 'text-text' : 'text-text-3')}>{name}</span>
          {entry.status !== undefined && !stageMode && <StatusMark status={entry.status} withLabel={false} test={entry.kind === 'test'} />}
        </span>
        {entry.status !== undefined && stageMode && <StatusMark status={entry.status} withLabel test={entry.kind === 'test'} />}
      </button>
      <Handle type="source" id="bottom" position={Position.Bottom} className={HIDDEN_HANDLE} isConnectable={false} />
    </div>
  )
}

function FlowLines({ stage }: { stage: string }): JSX.Element | null {
  const context = useContext(CanvasContext)
  const own = context.flows.filter((flow) => flow.from === stage)
  if (own.length === 0) return null
  return (
    <ul className="grid gap-0.5" data-testid={`orch-flows-${stage}`}>
      {own.map((flow) => (
        <li key={`${flow.slot}:${flow.id}`} className="whitespace-nowrap">
          <span className="font-mono">{flow.id}</span>
          {' → '}
          {flow.to.map(context.labelOf).join(' · ')}
        </li>
      ))}
    </ul>
  )
}

function GateMark({ gate }: { gate: FlowStage['gate'] }): JSX.Element | null {
  const { t } = useT()
  if (gate === null) return null
  const Icon = gate === 'review' ? ShieldCheck : Zap
  return (
    <span className={cn('grid flex-none place-items-center', gate === 'review' ? 'text-amber-d' : 'text-(--accent)')} role="img" aria-label={t(`workflow.gate_${gate}`)} title={t(`workflow.gate_${gate}`)} data-testid="orch-gate" data-gate={gate}>
      <Icon className="size-3.5" aria-hidden="true" />
    </span>
  )
}

function StageNodeView({ id, data }: NodeProps<StageNode>): JSX.Element {
  const context = useContext(CanvasContext)
  const { stage, index, width, height } = data
  const current = context.current === stage.id
  const hovered = context.hovered
  const consumer = hovered !== null && hovered !== stage.id
    && context.flows.some((flow) => flow.from === hovered && flow.to.includes(stage.id))
  const hasFlows = context.flows.some((flow) => flow.from === stage.id)
  const header = (
    <button
      type="button"
      className={cn('flex w-full min-w-0 items-center gap-2 px-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-(--accent)', current ? 'text-(--accent)' : 'text-text')}
      style={{ height: HEADER_H }}
      aria-current={current ? 'step' : undefined}
      data-testid={`orch-stage-${stage.id}`}
      onClick={() => context.onOpenStage?.(stage.id)}
      onMouseEnter={() => context.setHovered(stage.id)}
      onMouseLeave={() => context.setHovered(null)}
      onFocus={() => context.setHovered(stage.id)}
      onBlur={() => context.setHovered(null)}
    >
      <span className="flex-none font-mono text-caption text-text-3">{index + 1}</span>
      <span className={cn('min-w-0 flex-1 truncate whitespace-nowrap text-body', current ? 'font-semibold' : 'font-medium')} title={stage.label}>{stage.label}</span>
      <GateMark gate={stage.gate} />
    </button>
  )
  return (
    <div
      className={cn('relative rounded-md border transition-[border-color] duration-(--dur-fast) ease-(--ease-out)', current ? 'border-(--accent)' : consumer ? 'border-accent-b' : 'border-border')}
      style={{ width, height }}
      data-testid={`orch-frame-${stage.id}`}
      data-flow-node={id}
      data-current={current || undefined}
      data-consumer={consumer || undefined}
    >
      <Handle type="target" id="left" position={Position.Left} className={HIDDEN_HANDLE} style={{ top: HEADER_H / 2 }} isConnectable={false} />
      <Handle type="source" id="right" position={Position.Right} className={HIDDEN_HANDLE} style={{ top: HEADER_H / 2 }} isConnectable={false} />
      <Handle type="source" id="down" position={Position.Bottom} className={HIDDEN_HANDLE} style={{ top: HEADER_H, bottom: 'auto' }} isConnectable={false} />
      <Handle type="source" id="arc-out" position={Position.Top} className={HIDDEN_HANDLE} isConnectable={false} />
      <Handle type="target" id="arc-in" position={Position.Top} className={HIDDEN_HANDLE} isConnectable={false} />
      <span className="pointer-events-none absolute -inset-px rounded-md border border-(--accent) opacity-0" aria-hidden="true" data-pulse-flash="" />
      {hasFlows ? (
        <Tooltip>
          <TooltipTrigger asChild>{header}</TooltipTrigger>
          <TooltipContent side="top" sideOffset={6} className="max-w-none">
            <FlowLines stage={stage.id} />
          </TooltipContent>
        </Tooltip>
      ) : header}
    </div>
  )
}

function LaneNodeView({ data }: NodeProps<LaneNode>): JSX.Element {
  const { t } = useT()
  const context = useContext(CanvasContext)
  const action = context.laneActions?.[data.kind]
  const Icon = KIND_ICON[data.kind]
  return (
    <div className="flex items-center gap-1.5 whitespace-nowrap" style={{ width: data.width, height: data.height }} data-testid={`orch-lane-${data.kind}`}>
      <Icon className="size-3.5 flex-none text-text-3" aria-hidden="true" />
      <span className="text-body text-text-2">{t(KIND_TITLE[data.kind])}</span>
      <span className="font-mono text-caption text-text-3">{data.count}</span>
      {action !== undefined && (action.render?.() ?? (
        <button type="button" className="ml-auto grid size-8 flex-none place-items-center rounded-sm text-text-3 outline-none hover:bg-fill hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent)" aria-label={action.label} title={action.label} data-testid={action.testId} onClick={action.onClick}>
          {action.icon === 'add' ? <Plus className="size-3.5" aria-hidden="true" /> : <Pencil className="size-3.5" aria-hidden="true" />}
        </button>
      ))}
    </div>
  )
}

const PortNodeView = memo(function PortNodeView({ id, data }: NodeProps<PortNode>): JSX.Element {
  const context = useContext(CanvasContext)
  const start = id === 'start'
  const vertical = context.mode === 'stage'
  return (
    <div className="relative grid place-items-center" style={{ width: PORT, height: PORT }} data-testid={`orch-${id}`} data-flow-node={id}>
      {!start && <span className="absolute size-2.5 rounded-full border border-(--accent) opacity-0" aria-hidden="true" data-pulse-ring="" />}
      <span className={cn('block size-2.5 rounded-full', start ? 'bg-(--accent)' : 'bg-text-3')} aria-hidden="true" data-pulse-dot={start ? undefined : ''} />
      <span className={cn('absolute whitespace-nowrap text-micro text-text-3', vertical ? 'left-full ml-2' : 'top-full mt-1')}>{data.label}</span>
      {start
        ? <Handle type="source" id="out" position={vertical ? Position.Bottom : Position.Right} className={HIDDEN_HANDLE} isConnectable={false} />
        : <Handle type="target" id="in" position={vertical ? Position.Top : Position.Left} className={HIDDEN_HANDLE} isConnectable={false} />}
    </div>
  )
})

const JunctionNodeView = memo(function JunctionNodeView({ id }: NodeProps<JunctionNode>): JSX.Element {
  return (
    <div className="relative" style={{ width: 2, height: 2 }} data-testid="orch-junction" data-flow-node={id}>
      <Handle type="target" id="top" position={Position.Top} className={HIDDEN_HANDLE} isConnectable={false} />
      <Handle type="source" id="bottom" position={Position.Bottom} className={HIDDEN_HANDLE} isConnectable={false} />
    </div>
  )
})

/** 回流：从来源阶段标题顶端拱起、落回更早阶段标题顶端的虚线弧；悬停说明从哪退回到哪。 */
export type ReturnEdgeData = { label: string }
function ReturnEdge({ id, sourceX, sourceY, targetX, targetY, markerEnd, data }: EdgeProps<Edge<ReturnEdgeData>>): JSX.Element {
  const lift = 28 + Math.abs(sourceX - targetX) * 0.12
  const top = Math.min(sourceY, targetY) - lift
  const path = `M${sourceX} ${sourceY} C ${sourceX} ${top}, ${targetX} ${top}, ${targetX} ${targetY}`
  return (
    <g data-testid={`orch-return-${id}`}>
      <path d={path} fill="none" stroke="transparent" strokeWidth={10} style={{ pointerEvents: 'stroke' }}><title>{data?.label ?? ''}</title></path>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={{ ...EDGE_STYLE, strokeWidth: 1.2, strokeDasharray: '3 3' }} />
    </g>
  )
}

export const CANVAS_NODE_TYPES = {
  entry: memo(EntryNodeView),
  stage: memo(StageNodeView),
  lane: memo(LaneNodeView),
  port: PortNodeView,
  junction: JunctionNodeView,
}
export const CANVAS_EDGE_TYPES = { pulse: PulseEdge, return: ReturnEdge }
