import { createContext, memo, useContext } from 'react'
import { BaseEdge, Handle, Position, type Edge, type EdgeProps, type Node, type NodeProps } from '@xyflow/react'
import { Bot, Box, FileCheck, FlaskConical, Layers, Pencil, Plus, ScanSearch, ShieldCheck, Zap, type LucideIcon } from 'lucide-react'
import type { OrchestrationFlow, OrchestrationKind } from '@tenon/kernel/workflow/orchestration'
import type { FlowEntry, FlowStage, RunStatus } from '../api/workflowOrchestrationClient'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useT } from '../i18n'
import { kindLabel } from '../tests/testLabels'
import { MiddleText, StateGlyph } from './flowGlyphs'
import { HEADER_H, PORT, returnLift, type FlowMode } from './orchestrationLayout'
import type { ZoomLevel } from './orchestrationViewport'
import { ArrivalMarks, EDGE_STYLE, HIDDEN_HANDLE, PortHandle, SignalEdge } from './skillFlowNodes'
import { cn } from '@/lib/utils'

/** 画布级的交互与状态：节点从这里取回调与悬停高亮，节点 data 只放布局。 */
export interface OrchestrationCanvasContext {
  readonly mode: FlowMode
  readonly current: string | null
  readonly hovered: string | null
  readonly setHovered: (stage: string | null) => void
  readonly flows: readonly OrchestrationFlow[]
  readonly labelOf: (stage: string) => string
  /** 语义缩放：只画符号 / 画名称 / 再画元信息；阶段画布恒为 name。 */
  readonly zoomLevel: ZoomLevel
  /** 评审门未放行的阶段：它的门图标围一圈琥珀环。 */
  readonly holding: string | null
  readonly onOpenEntry?: (stage: string, entry: FlowEntry) => void
  /** 哪些条目点得开（缺省 = 有 onOpenEntry 就都点得开）。 */
  readonly openable?: (entry: FlowEntry) => boolean
  /** 点列头：缩得很小时缓动放大到该阶段，已经能读清时进入该阶段。 */
  readonly onHeader?: (stage: string) => void
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
  mode: 'overview', current: null, hovered: null, setHovered: () => undefined, flows: [], labelOf: (stage) => stage, zoomLevel: 'name', holding: null,
})

export type EntryNode = Node<{ stage: string; entry: FlowEntry; width: number; height: number }, 'entry'>
export type StageNode = Node<{ stage: FlowStage; index: number; width: number; height: number }, 'stage'>
export type LaneNode = Node<{ kind: OrchestrationKind; count: number; width: number; height: number }, 'lane'>
export type GhostNode = Node<{ kind: OrchestrationKind; width: number; height: number }, 'ghost'>
export type PortNode = Node<{ label: string }, 'port'>
export type JunctionNode = Node<Record<string, never>, 'junction'>
export type CanvasNode = EntryNode | StageNode | LaneNode | GhostNode | PortNode | JunctionNode

export const KIND_ICON: Record<OrchestrationKind, LucideIcon> = { executor: Bot, skill: Box, test: FlaskConical, reviewer: ScanSearch }
export const KIND_TITLE: Record<OrchestrationKind, string> = {
  executor: 'workflow.executors_title',
  skill: 'workflow.skills_title',
  test: 'workflow.tests_title',
  reviewer: 'workflow.reviewers_title',
}
const STATUS_TEXT: Record<RunStatus, string> = { done: 'text-green-d', running: 'text-(--accent)', failed: 'text-red-d', waiting: 'text-text-3', stale: 'text-amber-d' }
/** 测试节点的状态词与测试页签同一套（通过 / 失败 / 过期 / 未运行 / 运行中）。 */
const TEST_STATE: Record<RunStatus, string> = { done: 'passed', running: 'running', failed: 'failed', waiting: 'missing', stale: 'stale' }

/** 类别图标：安静的灰；叠一层强调色的同形图标，节点收到信号时只动它的 opacity。 */
function SourceMark({ entry }: { entry: FlowEntry }): JSX.Element {
  const { t } = useT()
  const Icon = entry.source === 'openspec' ? FileCheck : entry.source === 'manifest' ? Layers : KIND_ICON[entry.kind]
  const title = entry.source === 'openspec' ? t('workflow.skill_injected') : entry.source === 'manifest' ? t('workflow.skill_manifest') : t(KIND_TITLE[entry.kind])
  return (
    <span className={cn('relative inline-flex flex-none', entry.source === 'declared' ? 'text-text-3' : 'text-(--accent)')} role="img" aria-label={title} title={title} data-testid={`orch-source-${entry.source}`}>
      <Icon className="size-3.5" aria-hidden="true" />
      <span className="pointer-events-none absolute inset-0 text-(--accent) opacity-0" aria-hidden="true" data-signal-icon=""><Icon className="size-3.5" /></span>
    </span>
  )
}

/*
 * React Flow 给既不可选也不可拖的节点把包裹层设成 pointer-events:none，子元素继承——按钮会点不到。
 * 所以节点里会被点的东西（条目按钮、列头、泳道动作、幽灵「＋」）都显式写 pointer-events-auto。
 */
function EntryNodeView({ id, data }: NodeProps<EntryNode>): JSX.Element {
  const { t } = useT()
  const context = useContext(CanvasContext)
  const { entry, width, height, stage } = data
  const stageMode = context.mode === 'stage'
  const level = stageMode ? 'name' : context.zoomLevel
  const optional = entry.required ? '' : ` · ${t('workflow.agent_advisory')}`
  // 策略要求运行的测试节点：名字是种类的界面词，标识（unit）在悬停提示里。
  const name = entry.testKind === undefined ? entry.label : kindLabel(entry.testKind, t)
  const hint = entry.testKind === undefined ? entry.label : `${name} · ${entry.testKind}`
  const open = context.onOpenEntry !== undefined && (context.openable?.(entry) ?? true) ? context.onOpenEntry : undefined
  const status = entry.status
  const statusText = status === undefined ? null : t(entry.kind === 'test' ? `tests.state.${TEST_STATE[status]}` : `workspace.run_${status}`)
  // 默认状态（等待 / 完成）不写字，只有需要注意的状态出字；图标已经说了。
  const spoken = status === 'running' || status === 'failed' || status === 'stale'
  const showWord = spoken && (stageMode || level === 'meta')
  return (
    <div
      className={cn('group relative flex items-center rounded-sm border bg-card transition-[border-color] duration-(--dur-fast) ease-(--ease-out)', entry.required ? 'border-(--flow-node-border)' : 'border-dashed border-(--flow-node-border)', status === 'running' && 'border-(--accent) shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_12%,transparent)]', status === 'failed' && 'border-red-b')}
      style={{ width, height }}
      data-testid={`orch-node-${entry.kind}-${entry.id}`}
      data-flow-node={id}
      data-transit={height}
      data-kind={entry.kind}
      data-wave={entry.wave}
      data-source={entry.source}
      data-status={status}
    >
      <ArrivalMarks />
      <PortHandle type="target" id="top" position={Position.Top} isConnectable={false} />
      <PortHandle type="target" id="left" position={Position.Left} isConnectable={false} />
      <button
        type="button"
        className={cn('pointer-events-auto flex h-full w-full min-w-0 items-center gap-2 px-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-(--accent) disabled:cursor-default', !stageMode && 'before:absolute before:inset-x-0 before:-inset-y-1 before:content-[""]')}
        title={`${hint}${optional}`}
        aria-label={`${t(KIND_TITLE[entry.kind])} ${name}${optional}`}
        disabled={open === undefined}
        data-testid={`orch-open-${entry.kind}-${entry.id}`}
        onClick={() => open?.(stage, entry)}
      >
        {status === undefined ? <SourceMark entry={entry} /> : <StateGlyph state={status} label={statusText ?? status} />}
        {level === 'glyph'
          ? <span className="min-w-0 flex-1" aria-label={name} />
          : <MiddleText text={name} className={cn('font-sans text-caption font-medium', entry.required ? 'text-text' : 'text-text-3')} />}
        {statusText !== null && (
          <span className={cn('flex-none whitespace-nowrap text-micro', STATUS_TEXT[status ?? 'waiting'], !showWord && 'sr-only')} data-testid="orch-status" data-status={status}>{statusText}</span>
        )}
        {status !== undefined && <SourceMark entry={entry} />}
      </button>
      <PortHandle type="source" id="bottom" position={Position.Bottom} isConnectable={false} />
      <PortHandle type="source" id="right" position={Position.Right} isConnectable={false} />
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

/** 门禁图标：评审 = 盾（琥珀），自动 = 闪电（强调色）；评审门未放行时围一圈琥珀环。 */
function GateMark({ gate, holding }: { gate: FlowStage['gate']; holding: boolean }): JSX.Element | null {
  const { t } = useT()
  if (gate === null) return null
  const Icon = gate === 'review' ? ShieldCheck : Zap
  return (
    <span className={cn('grid size-6 flex-none place-items-center rounded-full', gate === 'review' ? 'text-amber-d' : 'text-(--accent)', holding && 'ring-1 ring-(--flow-hold)')} role="img" aria-label={t(`workflow.gate_${gate}`)} title={t(`workflow.gate_${gate}`)} data-testid="orch-gate" data-gate={gate} data-holding={holding || undefined}>
      <Icon className="size-3.5" aria-hidden="true" />
    </span>
  )
}

/** 列带：无边框，实色 4% 底 + 标题行，高度贴内容；标题行收到信号时闪一下（评审门琥珀、自动门强调色）。 */
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
      className={cn('pointer-events-auto relative flex w-full min-w-0 items-center gap-2 px-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-(--accent)', current ? 'text-(--accent)' : 'text-text')}
      style={{ height: HEADER_H }}
      aria-current={current ? 'step' : undefined}
      data-testid={`orch-stage-${stage.id}`}
      onClick={() => context.onHeader?.(stage.id)}
      onMouseEnter={() => context.setHovered(stage.id)}
      onMouseLeave={() => context.setHovered(null)}
      onFocus={() => context.setHovered(stage.id)}
      onBlur={() => context.setHovered(null)}
    >
      <span className="flex-none font-mono text-caption tabular-nums text-text-3">{index + 1}</span>
      <span className={cn('min-w-0 flex-1 truncate whitespace-nowrap text-body', current ? 'font-semibold' : 'font-medium')} title={stage.label}>{stage.label}</span>
      <GateMark gate={stage.gate} holding={context.holding === stage.id} />
    </button>
  )
  return (
    <div
      className={cn('relative rounded-md transition-shadow duration-(--dur-fast) ease-(--ease-out)', consumer && 'ring-1 ring-accent-b')}
      style={{ width, height, background: 'var(--flow-band)' }}
      data-testid={`orch-frame-${stage.id}`}
      data-flow-node={id}
      data-transit={width}
      data-current={current || undefined}
      data-consumer={consumer || undefined}
    >
      <Handle type="target" id="left" position={Position.Left} className={HIDDEN_HANDLE} style={{ top: HEADER_H / 2 }} isConnectable={false} />
      <Handle type="source" id="right" position={Position.Right} className={HIDDEN_HANDLE} style={{ top: HEADER_H / 2 }} isConnectable={false} />
      <Handle type="source" id="down" position={Position.Bottom} className={HIDDEN_HANDLE} style={{ top: HEADER_H, bottom: 'auto' }} isConnectable={false} />
      <Handle type="source" id="arc-out" position={Position.Top} className={HIDDEN_HANDLE} isConnectable={false} />
      <Handle type="target" id="arc-in" position={Position.Top} className={HIDDEN_HANDLE} isConnectable={false} />
      <span className={cn('pointer-events-none absolute inset-x-0 top-0 rounded-md border opacity-0', stage.gate === 'review' ? 'border-(--flow-hold) shadow-[0_0_0_4px_color-mix(in_srgb,var(--flow-hold)_16%,transparent)]' : 'border-(--accent) shadow-[0_0_0_4px_color-mix(in_srgb,var(--accent)_16%,transparent)]')} style={{ height: HEADER_H }} aria-hidden="true" data-signal-flash="" />
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

/** 阶段画布的分组标题：节点上方 13px 的小标题（图标 · 名称 · 数量），动作在右端。 */
function LaneNodeView({ data }: NodeProps<LaneNode>): JSX.Element {
  const { t } = useT()
  const context = useContext(CanvasContext)
  const action = context.laneActions?.[data.kind]
  const Icon = KIND_ICON[data.kind]
  return (
    <div className="pointer-events-auto flex items-center gap-2 whitespace-nowrap" style={{ width: data.width, height: data.height }} data-testid={`orch-lane-${data.kind}`}>
      <Icon className="size-3.5 flex-none text-text-3" aria-hidden="true" />
      <span className="text-micro text-text-3">{t(KIND_TITLE[data.kind])}</span>
      <span className="text-micro tabular-nums text-text-3">{data.count}</span>
      {action !== undefined && data.count > 0 && (action.render?.() ?? <LaneButton action={action} />)}
    </div>
  )
}

function LaneButton({ action }: { action: LaneAction }): JSX.Element {
  return (
    <button type="button" className="-my-2 ml-auto grid size-10 flex-none place-items-center rounded-sm text-text-3 outline-none hover:bg-fill hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent)" aria-label={action.label} title={action.label} data-testid={action.testId} onClick={action.onClick}>
      {action.icon === 'add' ? <Plus className="size-3.5" aria-hidden="true" /> : <Pencil className="size-3.5" aria-hidden="true" />}
    </button>
  )
}

/** 空泳道的幽灵「＋」：只在可编辑且该泳道有动作时出现；点它 = 该泳道的动作。 */
function GhostNodeView({ data }: NodeProps<GhostNode>): JSX.Element | null {
  const context = useContext(CanvasContext)
  const action = context.laneActions?.[data.kind]
  if (action === undefined) return null
  return (
    <div className="pointer-events-auto grid place-items-center rounded-sm border border-dashed border-(--flow-node-border) bg-card text-text-3 transition-colors duration-(--dur-fast) hover:text-text" style={{ width: data.width, height: data.height }} data-testid={`orch-ghost-${data.kind}`}>
      {action.render?.() ?? (
        <button type="button" className="grid size-full place-items-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-(--accent)" aria-label={action.label} title={action.label} data-testid={action.testId} onClick={action.onClick}>
          <Plus className="size-4" aria-hidden="true" />
        </button>
      )}
    </div>
  )
}

/** 起点 / 终点：实心圆点；起点每放出一颗彗星、终点每收到一颗，各放一圈光环。评审门拦在终点前时终点转琥珀。 */
const PortNodeView = memo(function PortNodeView({ id, data }: NodeProps<PortNode>): JSX.Element {
  const context = useContext(CanvasContext)
  const start = id === 'start'
  const vertical = context.mode === 'stage'
  return (
    <div className="relative grid place-items-center" style={{ width: PORT, height: PORT }} data-testid={`orch-${id}`} data-flow-node={id} data-transit={PORT}>
      <span className="pointer-events-none absolute size-3 rounded-full border border-(--accent) opacity-0" aria-hidden="true" data-signal-ring="" />
      <span className={cn('block size-2.5 rounded-full', start ? 'bg-(--accent)' : 'bg-text-3')} aria-hidden="true" data-testid={`orch-${id}-dot`} />
      <span className={cn('absolute whitespace-nowrap text-micro text-text-3', vertical ? 'left-full ml-2' : 'top-full mt-1')}>{data.label}</span>
      {start
        ? <Handle type="source" id="out" position={vertical ? Position.Bottom : Position.Right} className={HIDDEN_HANDLE} isConnectable={false} />
        : <Handle type="target" id="in" position={vertical ? Position.Top : Position.Left} className={HIDDEN_HANDLE} isConnectable={false} />}
    </div>
  )
})

const JunctionNodeView = memo(function JunctionNodeView({ id }: NodeProps<JunctionNode>): JSX.Element {
  return (
    <div className="relative" style={{ width: 2, height: 2 }} data-testid="orch-junction" data-flow-node={id} data-transit={0}>
      <Handle type="target" id="top" position={Position.Top} className={HIDDEN_HANDLE} isConnectable={false} />
      <Handle type="source" id="bottom" position={Position.Bottom} className={HIDDEN_HANDLE} isConnectable={false} />
    </div>
  )
})

/** 回流：从来源阶段标题顶端拱起、落回更早阶段标题顶端的虚线弧（线色同主线、1.25px、虚线 2 3、5px 箭头）；悬停说明从哪退回到哪。 */
export type ReturnEdgeData = { label: string }
function ReturnEdge({ id, sourceX, sourceY, targetX, targetY, markerEnd, data }: EdgeProps<Edge<ReturnEdgeData>>): JSX.Element {
  const lift = returnLift(sourceX - targetX)
  const top = Math.min(sourceY, targetY) - lift
  const path = `M${sourceX} ${sourceY} C ${sourceX} ${top}, ${targetX} ${top}, ${targetX} ${targetY}`
  return (
    <g data-testid={`orch-return-${id}`}>
      <path d={path} fill="none" stroke="transparent" strokeWidth={10} style={{ pointerEvents: 'stroke' }}><title>{data?.label ?? ''}</title></path>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={{ ...EDGE_STYLE, strokeDasharray: '2 3' }} />
    </g>
  )
}

export const CANVAS_NODE_TYPES = {
  entry: memo(EntryNodeView),
  stage: memo(StageNodeView),
  lane: memo(LaneNodeView),
  ghost: memo(GhostNodeView),
  port: PortNodeView,
  junction: JunctionNodeView,
}
export const CANVAS_EDGE_TYPES = { signal: SignalEdge, return: ReturnEdge }
