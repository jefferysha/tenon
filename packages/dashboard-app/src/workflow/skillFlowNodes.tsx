import { memo, useId, useMemo } from 'react'
import { BaseEdge, Handle, MarkerType, Position, getSmoothStepPath, type Edge, type EdgeProps, type HandleProps, type Node, type NodeProps } from '@xyflow/react'
import { Box, FileCheck, X } from 'lucide-react'
import type { WbSkillEntry } from '../api/governanceTypes'
import { useT } from '../i18n'
import { COMET_LAYERS, type SignalMode } from './flowSignal'
import { MiddleText, StateGlyph } from './flowGlyphs'
import { SkillSourceIcon } from './SkillSourceIcon'
import { cn } from '@/lib/utils'

export const NODE_WIDTH = 260
export const NODE_HEIGHT = 40
export const PORT_SIZE = 12
/** 转角半径：所有画布的连线都是平滑直角。 */
export const EDGE_RADIUS = 8
/** 从端口沿出口方向直走多远再转弯（汇合点轨道离条目只有 12px，所以比默认的 20 小）。 */
const EDGE_OFFSET = 8

export type EdgeState = 'todo' | 'done' | 'live'
export const EDGE_STYLE = { stroke: 'var(--flow-line)', strokeWidth: 1.25 }
/** 线三态：未到 = 中性线；已完成 = 强调色实线（55% 不透明度）；正接入运行节点的一段 = 强调色实线。 */
const EDGE_STYLES: Record<EdgeState, { stroke: string; strokeWidth: number; opacity?: number }> = {
  todo: EDGE_STYLE,
  done: { stroke: 'var(--flow-done)', strokeWidth: 1.5, opacity: 0.55 },
  live: { stroke: 'var(--flow-done)', strokeWidth: 1.5 },
}
/** 箭头 5px（markerUnits 随线宽：4 × 1.25）；只放在汇入处与终点。 */
export const MARKER = { type: MarkerType.ArrowClosed, width: 4, height: 4, color: 'var(--flow-line)' }
export const MARKER_DONE = { ...MARKER, color: 'var(--flow-done)' }
export const markerFor = (state: EdgeState) => (state === 'todo' ? MARKER : MARKER_DONE)

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
  /** OpenSpec 文档契约注入（未在阶段里声明）：换成契约图标，悬停说明。 */
  injected: boolean
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

export type { SignalMode }
/**
 * 边上带的画布状态：state = 线三态；signal = 渲染彗星层（画布在流动或停着一颗彗星时才有）；
 * lead = 信号从源节点到达到这条边开始之间在节点里走的距离；after = 这条边要等这些节点走完才开始；
 * stub = 总览里脊柱通向条目的短线：只登记长度（条目的到达反馈按它算），不带彗星层；hold = 评审门把这条线拦在尽头（琥珀短横）。
 */
export type SignalEdgeData = { state?: EdgeState; signal?: boolean; lead?: number; after?: readonly string[]; stub?: boolean; hold?: boolean }

function holdTick(x: number, y: number, position: Position): string {
  return position === Position.Left || position === Position.Right ? `M${x} ${y - 3} L${x} ${y + 3}` : `M${x - 3} ${y} L${x + 3} ${y}`
}

/**
 * 边：平滑直角底线（三态样式）+ 四层彗星克隆（同一条 d，平时 hidden，由 flowSignal 的 ticker 只对热边写 dashoffset）。
 * 节点不透明且在边上层，彗星从节点后面穿过。
 */
export function SignalEdge({ id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, data }: EdgeProps<Edge<SignalEdgeData>>): JSX.Element {
  const [path] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: EDGE_RADIUS, offset: EDGE_OFFSET })
  const state = data?.state ?? 'todo'
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={EDGE_STYLES[state]} />
      {data?.signal === true && (
        <g className="pointer-events-none" visibility="hidden" data-signal-edge={id} data-signal-source={source} data-signal-target={target} data-signal-state={state} data-signal-lead={data.lead} data-signal-after={data.after === undefined || data.after.length === 0 ? undefined : data.after.join(' ')} data-signal-static={data.stub === true ? '' : undefined} data-signal-length={data.stub === true ? Math.hypot(targetX - sourceX, targetY - sourceY) : undefined} data-testid={`flow-signal-${id}`}>
          {data.stub !== true && COMET_LAYERS.map((layer) => (
            <path key={layer.id} d={path} fill="none" stroke={layer.tone === 'halo' ? 'var(--flow-halo)' : 'var(--flow-comet)'} strokeOpacity={layer.opacity} strokeWidth={layer.width} strokeLinecap={layer.cap} data-signal-layer={layer.id} />
          ))}
        </g>
      )}
      {data?.hold === true && <path className="pointer-events-none" d={holdTick(targetX, targetY, targetPosition)} stroke="var(--flow-hold)" strokeWidth={2} fill="none" data-testid={`flow-hold-${id}`} />}
    </>
  )
}

/** 只有 1px 的句柄：连线正好落在节点边框上，自己不可见。 */
export const HIDDEN_HANDLE = '!size-px !min-h-0 !min-w-0 !border-0 !bg-transparent'
/** 可拉线的句柄要有抓得住的热区：8px（圆点 6px 画在它里面）。 */
const CONNECT_HANDLE = '!size-2 !min-h-0 !min-w-0 !border-0 !bg-transparent'

/** 只读画布的节点四边中点各一个 6px 圆点：一层背景图、悬停淡入（比每个句柄一个子元素省 DOM）。 */
export const PORT_DOTS = [
  'radial-gradient(circle at 50% 3px, var(--flow-line) 2.5px, transparent 3px)',
  'radial-gradient(circle at 50% calc(100% - 3px), var(--flow-line) 2.5px, transparent 3px)',
  'radial-gradient(circle at 3px 50%, var(--flow-line) 2.5px, transparent 3px)',
  'radial-gradient(circle at calc(100% - 3px) 50%, var(--flow-line) 2.5px, transparent 3px)',
].join(', ')

/**
 * 端口：悬停节点时出现的 6px 圆点，是 Handle 的子元素，随外层 `group` 的悬停淡入。
 * 只读画布的 Handle 只有 1px（连线落在边框上）；可编辑画布的 Handle 8px，从这里拉线。
 */
export function PortHandle(props: HandleProps): JSX.Element {
  return (
    <Handle {...props} className={props.isConnectable === false ? HIDDEN_HANDLE : CONNECT_HANDLE}>
      <span className="pointer-events-none absolute left-1/2 top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-(--flow-line) opacity-0 transition-opacity duration-(--dur-fast) group-hover:opacity-100" aria-hidden="true" />
    </Handle>
  )
}

/** 到达反馈的三个预渲染层（只动 opacity）：边框 + 4px 光晕、顶端端口点、图标的强调色叠层。 */
export function ArrivalMarks({ round = false }: { round?: boolean }): JSX.Element {
  return (
    <>
      <span className={cn('pointer-events-none absolute -inset-px border border-(--accent) opacity-0 shadow-[0_0_0_4px_color-mix(in_srgb,var(--accent)_16%,transparent)]', round ? 'rounded-md' : 'rounded-sm')} aria-hidden="true" data-signal-flash="" />
      <span className="pointer-events-none absolute left-1/2 top-0 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-(--accent) opacity-0" aria-hidden="true" data-signal-port="" />
    </>
  )
}

function SkillNodeView({ id, data, selected }: NodeProps<SkillNode>): JSX.Element {
  const { t } = useT()
  const descriptionId = useId()
  const status = data.status === null ? null : data.status === 'running' ? 'running' : data.status === 'done' ? 'done' : 'waiting'
  return <div className={cn('group relative rounded-sm border bg-card px-3 py-2 transition-[border-color,box-shadow] duration-(--dur-fast) ease-(--ease-out)', selected ? 'border-(--accent) ring-2 ring-(--accent)/30' : data.status === 'running' ? 'border-(--accent) shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_12%,transparent)]' : 'border-(--flow-node-border)', data.entering && 'animate-[flow-in_.3s_var(--ease-out)_both] motion-reduce:animate-none')} style={{ width: NODE_WIDTH, minHeight: data.height }} data-testid={`flow-node-${id}`} data-flow-node={id} data-transit={NODE_WIDTH} data-entering={data.entering || undefined} data-status={data.status ?? undefined}>
    <ArrivalMarks />
    <PortHandle type="target" position={Position.Left} isConnectable={data.editable} />
    <button type="button" className="pointer-events-auto grid w-full min-w-0 gap-0.5 overflow-hidden text-left outline-none focus-visible:ring-2 focus-visible:ring-(--accent)" title={data.description ?? data.label} aria-label={data.label} aria-describedby={data.description === null ? undefined : descriptionId} data-testid={`flow-open-${id}`} onClick={() => data.onOpen(id)}><span className="flex min-w-0 items-center gap-2 whitespace-nowrap font-sans text-caption font-medium text-text" data-testid={`flow-name-${id}`}>{status !== null && <StateGlyph state={status} label={data.statusLabel ?? status} />}{data.injected ? <span className="inline-flex flex-none text-(--accent)" role="img" aria-label={t('workflow.skill_injected')} title={t('workflow.skill_injected')} data-testid={`flow-injected-${id}`}><FileCheck className="size-3.5" aria-hidden="true" /></span> : data.source === null ? <Box className="size-3.5 flex-none text-text-3" aria-hidden="true" /> : <SkillSourceIcon source={data.source} className="size-3.5" />}<MiddleText text={data.label} /></span>{data.caption !== null && <span className="block truncate whitespace-nowrap text-micro text-text-3" data-testid={`flow-caption-${id}`}>{data.caption}</span>}</button>
    {data.description !== null && <span id={descriptionId} className="sr-only" data-testid={`flow-desc-${id}`}>{data.description}</span>}
    {data.editable && <button type="button" className="absolute -right-2 -top-2 grid size-5 place-items-center rounded-full border border-border bg-card text-text-3 hover:text-red-d" aria-label={t('workflow.remove_skill', { id })} data-testid={`flow-remove-${id}`} onClick={() => data.onRemove(id)}><X className="size-3" aria-hidden="true" /></button>}
    <PortHandle type="source" position={Position.Right} isConnectable={data.editable} />
  </div>
}
const MemoSkillNodeView = memo(SkillNodeView)

/** 起点 / 终点：实心圆点；起点每放出一颗彗星、终点每收到一颗，各放一圈光环（transform + opacity）。 */
const PortNodeView = memo(function PortNodeView({ id, data }: NodeProps<PortNode>): JSX.Element {
  const start = id === 'start'
  return (
    <div className="relative grid place-items-center" style={{ width: PORT_SIZE, height: PORT_SIZE }} data-testid={`flow-${id}`} data-flow-node={id} data-transit={PORT_SIZE}>
      <span className="absolute size-3 rounded-full border border-(--accent) opacity-0" aria-hidden="true" data-signal-ring="" />
      <span className={cn('block size-2.5 rounded-full', start ? 'bg-(--accent)' : 'bg-text-3')} aria-hidden="true" data-testid={`flow-${id}-dot`} />
      <span className="absolute top-full mt-1 whitespace-nowrap text-micro text-text-3">{data.label}</span>
      <Handle type={start ? 'source' : 'target'} position={start ? Position.Right : Position.Left} className={HIDDEN_HANDLE} isConnectable={false} />
    </div>
  )
})
const GhostNodeView = memo(function GhostNodeView({ data }: NodeProps<GhostNode>): JSX.Element { return <div className="relative rounded-sm border border-dashed border-(--accent) bg-accent-t/60 px-3 py-2 opacity-90" style={{ width: NODE_WIDTH, minHeight: NODE_HEIGHT }} data-testid="flow-ghost" data-mode={data.mode}><Handle type="target" position={Position.Left} className={HIDDEN_HANDLE} isConnectable={false} /><span className="block truncate font-sans text-caption font-medium text-(--accent)">{data.label}</span><span className="block text-micro text-(--accent)">{data.mode}</span><Handle type="source" position={Position.Right} className={HIDDEN_HANDLE} isConnectable={false} /></div> })
const LabelNodeView = memo(function LabelNodeView({ data }: NodeProps<LabelNode>): JSX.Element { return <span className="whitespace-nowrap font-sans text-micro tabular-nums text-text-3" data-testid="flow-wave-label">{data.label}</span> })
const JunctionNodeView = memo(function JunctionNodeView({ id }: NodeProps<JunctionNode>): JSX.Element { return <div className="relative" style={{ width: 2, height: 2 }} data-testid="flow-junction" data-flow-node={id} data-transit={0}><Handle type="target" position={Position.Left} className={HIDDEN_HANDLE} isConnectable={false} /><Handle type="source" position={Position.Right} className={HIDDEN_HANDLE} isConnectable={false} /></div> })

export const NODE_TYPES = { skill: MemoSkillNodeView, port: PortNodeView, label: LabelNodeView, ghost: GhostNodeView, junction: JunctionNodeView }
export const EDGE_TYPES = { signal: SignalEdge }

/** React Flow 控件自带英文 aria-label（Zoom In …），跟随界面语言改写。 */
export function useFlowAriaLabels(): Record<string, string> {
  const { t } = useT()
  return useMemo(() => ({
    'controls.ariaLabel': t('workflow.flow_controls'),
    'controls.zoomIn.ariaLabel': t('workflow.zoom_in'),
    'controls.zoomOut.ariaLabel': t('workflow.zoom_out'),
    'controls.fitView.ariaLabel': t('workflow.fit_view'),
  }), [t])
}

export function isVirtualId(id: string): boolean { return id === 'start' || id === 'end' || id === 'ghost' || id.startsWith('label-') || /^j\d+$/.test(id) }
