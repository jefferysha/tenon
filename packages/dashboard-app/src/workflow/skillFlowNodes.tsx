import { memo, useId } from 'react'
import { BaseEdge, Handle, MarkerType, Position, getBezierPath, type Edge, type EdgeProps, type Node, type NodeProps } from '@xyflow/react'
import { Box, X } from 'lucide-react'
import type { WbSkillEntry } from '../api/governanceTypes'
import { useT } from '../i18n'
import type { PulseMode } from './flowPulse'
import { SkillSourceIcon } from './SkillSourceIcon'
import { cn } from '@/lib/utils'

export const NODE_WIDTH = 260
export const NODE_HEIGHT = 40
export const PORT_SIZE = 12
export const EDGE_STYLE = { stroke: 'var(--border-2)', strokeWidth: 1.5 }
export const MARKER = { type: MarkerType.ArrowClosed, width: 16, height: 16, color: 'var(--border-2)' }

export type SkillRunState = 'idle' | 'running' | 'done'
export type SkillNodeData = {
  label: string
  /** 不显示在节点上，只作为按钮的 aria-describedby 与悬停提示。 */
  description: string | null
  /** 节点最小高度（nodeHeightFor(行数)），同一画布所有节点等高，行距才能按序号算。 */
  height: number
  /** 名称下的一行小字（评审者的 必需 · 中 · 测试 n）；null 不渲染。 */
  caption: string | null
  source: WbSkillEntry['source'] | null
  editable: boolean
  entering: boolean
  status: SkillRunState | null
  statusLabel: string | null
  onOpen: (id: string) => void
  onRemove: (id: string) => void
}
export type SkillNode = Node<SkillNodeData, 'skill'>
export type PortNode = Node<{ label: string }, 'port'>
export type LabelNode = Node<{ label: string }, 'label'>
export type GhostNode = Node<{ label: string; mode: string }, 'ghost'>
export type JunctionNode = Node<Record<string, never>, 'junction'>
export type FlowNode = SkillNode | PortNode | LabelNode | GhostNode | JunctionNode

export type { PulseMode }
/** 这一段在整条传递里的先后（段序）；时长与动画都由 SkillFlow 的统一 timeline 决定（见 flowPulse）。 */
export type PulseData = { order: number }

/** 画布级脉冲模式：看不见时不播；有技能在跑就循环；否则只在编辑过后走一遍。 */
/**
 * 用户定的规则：技能画布上的脉冲从起点到终点依次传递、持续可见（表达「流」），不只在运行或编辑后才播。
 * 画布离开视口就停；减少动态效果时 timeline 自己不建。running / edits 不再决定播不播——编辑后
 * 由 timeline 的 key 变化从起点重新开始。
 */
export function pulseModeOf({ visible }: { visible: boolean; running: boolean; edits: number }): PulseMode {
  return visible ? 'loop' : 'off'
}

/**
 * 边 + 叠在上面的一组高亮描边（2px 实色 + 6px 12% 柔光），平时不可见。组上带段序与目标节点，
 * SkillFlow 的 timeline 按它们把高亮段从起点依次推到终点；本组件自己不起动画。
 */
export function PulseEdge({ id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, style, data }: EdgeProps<Edge<PulseData>>): JSX.Element {
  const [path] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition })
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
      <g className="pointer-events-none" style={{ opacity: 0 }} data-pulse-order={data?.order ?? 0} data-pulse-source={source} data-pulse-target={target} data-testid={`flow-pulse-${id}`}>
        <path d={path} fill="none" stroke="var(--accent)" strokeOpacity={0.12} strokeWidth={6} strokeLinecap="round" data-pulse-stroke="glow" />
        <path d={path} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinecap="round" data-pulse-stroke="core" />
      </g>
    </>
  )
}

/** 连接点：6px 实心，平时隐藏，悬停节点时出现（可编辑画布从这里拉线）。 */
const HANDLE_CLASS = '!size-1.5 !min-h-0 !min-w-0 !border-0 !bg-border-2 !opacity-0 transition-opacity duration-(--dur-fast) group-hover:!opacity-100'

function SkillNodeView({ id, data, selected }: NodeProps<SkillNode>): JSX.Element {
  const { t } = useT()
  const descriptionId = useId()
  return <div className={cn('group relative rounded-sm border bg-card px-3 py-2 shadow-(--shadow) transition-[border-color,box-shadow] duration-(--dur-fast) ease-(--ease-out)', selected ? 'border-(--accent) ring-2 ring-(--accent)/30' : data.status === 'done' ? 'border-green-b' : data.status === 'running' ? 'border-info-b shadow-[0_0_0_3px_var(--info-t)]' : 'border-border', data.entering && 'animate-[flow-in_.3s_var(--ease-out)_both] motion-reduce:animate-none')} style={{ width: NODE_WIDTH, minHeight: data.height }} data-testid={`flow-node-${id}`} data-flow-node={id} data-entering={data.entering || undefined} data-status={data.status ?? undefined}>
    <span className="pointer-events-none absolute -inset-px rounded-sm border border-(--accent) opacity-0" aria-hidden="true" data-pulse-flash="" />
    <Handle type="target" position={Position.Left} className={HANDLE_CLASS} isConnectable={data.editable} />
    <button type="button" className="grid w-full min-w-0 gap-0.5 overflow-hidden text-left outline-none focus-visible:ring-2 focus-visible:ring-(--accent)" title={data.description ?? data.label} aria-label={data.label} aria-describedby={data.description === null ? undefined : descriptionId} data-testid={`flow-open-${id}`} onClick={() => data.onOpen(id)}><span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap font-mono text-caption font-medium text-text" data-testid={`flow-name-${id}`}>{data.source === null ? <Box className="size-3 flex-none text-text-3" aria-hidden="true" /> : <SkillSourceIcon source={data.source} className="size-3" />}<span className="min-w-0 flex-1 truncate">{data.label}</span></span>{data.caption !== null && <span className="block truncate whitespace-nowrap text-micro text-text-3" data-testid={`flow-caption-${id}`}>{data.caption}</span>}{data.status !== null && <span className={cn('mt-0.5 inline-flex items-center gap-1.5 whitespace-nowrap text-micro', data.status === 'done' ? 'text-green-d' : data.status === 'running' ? 'text-info-d' : 'text-text-3')}><i className={cn('size-1.5 rounded-full', data.status === 'done' ? 'bg-green' : data.status === 'running' ? 'bg-info' : 'bg-text-3')} aria-hidden="true" />{data.statusLabel}</span>}</button>
    {data.description !== null && <span id={descriptionId} className="sr-only" data-testid={`flow-desc-${id}`}>{data.description}</span>}
    {data.editable && <button type="button" className="absolute -right-2 -top-2 grid size-5 place-items-center rounded-full border border-border bg-card text-text-3 hover:text-red-d" aria-label={t('workflow.remove_skill', { id })} data-testid={`flow-remove-${id}`} onClick={() => data.onRemove(id)}><X className="size-3" aria-hidden="true" /></button>}
    <Handle type="source" position={Position.Right} className={HANDLE_CLASS} isConnectable={data.editable} />
  </div>
}
const MemoSkillNodeView = memo(SkillNodeView)

const PortNodeView = memo(function PortNodeView({ id, data }: NodeProps<PortNode>): JSX.Element {
  const start = id === 'start'
  return (
    <div className="relative grid place-items-center" style={{ width: PORT_SIZE, height: PORT_SIZE }} data-testid={`flow-${id}`} data-flow-node={id}>
      {!start && <span className="absolute size-2.5 rounded-full border border-(--accent) opacity-0" aria-hidden="true" data-pulse-ring="" />}
      <span className={cn('block size-2.5 rounded-full', start ? 'bg-(--accent)' : 'bg-text-3')} aria-hidden="true" data-pulse-dot={start ? undefined : ''} />
      <span className="absolute top-full mt-1 whitespace-nowrap text-micro text-text-3">{data.label}</span>
      <Handle type={start ? 'source' : 'target'} position={start ? Position.Right : Position.Left} className="!size-1 !border-0 !bg-transparent" isConnectable={false} />
    </div>
  )
})
const GhostNodeView = memo(function GhostNodeView({ data }: NodeProps<GhostNode>): JSX.Element { return <div className="relative rounded-sm border border-dashed border-(--accent) bg-accent-t/60 px-3 py-2 opacity-90" style={{ width: NODE_WIDTH, minHeight: NODE_HEIGHT }} data-testid="flow-ghost" data-mode={data.mode}><Handle type="target" position={Position.Left} className="!size-1 !border-0 !bg-transparent" isConnectable={false} /><span className="block truncate font-mono text-body font-semibold text-(--accent)">{data.label}</span><span className="block text-micro text-(--accent)">{data.mode}</span><Handle type="source" position={Position.Right} className="!size-1 !border-0 !bg-transparent" isConnectable={false} /></div> })
const LabelNodeView = memo(function LabelNodeView({ data }: NodeProps<LabelNode>): JSX.Element { return <span className="whitespace-nowrap font-sans text-micro tabular-nums text-text-3" data-testid="flow-wave-label">{data.label}</span> })
const JunctionNodeView = memo(function JunctionNodeView(): JSX.Element { return <div className="relative" style={{ width: 2, height: 2 }} data-testid="flow-junction"><Handle type="target" position={Position.Left} className="!size-1 !border-0 !bg-transparent" isConnectable={false} /><Handle type="source" position={Position.Right} className="!size-1 !border-0 !bg-transparent" isConnectable={false} /></div> })

export const NODE_TYPES = { skill: MemoSkillNodeView, port: PortNodeView, label: LabelNodeView, ghost: GhostNodeView, junction: JunctionNodeView }
export const EDGE_TYPES = { pulse: PulseEdge }

export function isVirtualId(id: string): boolean { return id === 'start' || id === 'end' || id === 'ghost' || id.startsWith('label-') || /^j\d+$/.test(id) }
