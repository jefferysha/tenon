import { memo, useEffect, useId, useRef } from 'react'
import { BaseEdge, Handle, MarkerType, Position, getBezierPath, type Edge, type EdgeProps, type Node, type NodeProps } from '@xyflow/react'
import gsap from 'gsap'
import { Box, X } from 'lucide-react'
import type { WbSkillEntry } from '../api/governanceTypes'
import { useT } from '../i18n'
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

/** off = 不播；loop = 运行中循环；once = 刚编辑后从起点到终点走一遍。 */
export type PulseMode = 'off' | 'loop' | 'once'
/** order / total 决定这一段在整条传递里的先后；run 变了就重播（每次编辑 +1）。 */
export type PulseData = { order: number; total: number; mode: PulseMode; run: number }
const PULSE_STEP = 0.55

/** 画布级脉冲模式：看不见时不播；有技能在跑就循环；否则只在编辑过后走一遍。 */
export function pulseModeOf({ visible, running, edits }: { visible: boolean; running: boolean; edits: number }): PulseMode {
  if (!visible) return 'off'
  if (running) return 'loop'
  return edits > 0 ? 'once' : 'off'
}

/**
 * 边 + 叠在上面的一段强调色描边：GSAP 把 stroke-dashoffset 从 length + segment 推到 −segment，高亮段沿线
 * 从源流到目标；各段按 order 依次延迟，整体从起点传到终点。减少动态效果时不播，偏好中途变化即时跟随；
 * mode = off 时什么都不做。
 */
export function PulseEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, style, data }: EdgeProps<Edge<PulseData>>): JSX.Element {
  const [path] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition })
  const glowRef = useRef<SVGPathElement>(null)
  const order = data?.order ?? 0
  const total = data?.total ?? 1
  const mode = data?.mode ?? 'off'
  const run = data?.run ?? 0
  useEffect(() => {
    const glow = glowRef.current
    if (glow === null || mode === 'off' || typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const length = typeof glow.getTotalLength === 'function' ? glow.getTotalLength() : 0
    if (!Number.isFinite(length) || length === 0) return
    // 偏好在播放中途变了也要跟：每次变化都重新判断，减少动态效果时停在不可见。
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)')
    let tween: gsap.core.Tween | null = null
    const play = (): void => {
      tween?.kill()
      tween = null
      if (reduce.matches) { gsap.set(glow, { opacity: 0 }); return }
      const segment = Math.max(24, Math.min(length * 0.6, 120))
      glow.setAttribute('stroke-dasharray', `${segment} ${length + segment}`)
      tween = gsap.fromTo(glow, { strokeDashoffset: length + segment, opacity: 0.9 }, {
        strokeDashoffset: -segment,
        duration: PULSE_STEP,
        ease: 'none',
        delay: order * PULSE_STEP,
        repeat: mode === 'loop' ? -1 : 0,
        repeatDelay: Math.max(0, total - 1) * PULSE_STEP,
      })
    }
    play()
    reduce.addEventListener?.('change', play)
    return () => { reduce.removeEventListener?.('change', play); tween?.kill() }
  }, [path, order, total, mode, run])
  return <><BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} /><path ref={glowRef} d={path} fill="none" stroke="var(--accent)" strokeWidth={2.5} strokeLinecap="round" className="pointer-events-none" style={{ opacity: 0 }} data-testid={`flow-pulse-${id}`} data-mode={mode} /></>
}

function SkillNodeView({ id, data, selected }: NodeProps<SkillNode>): JSX.Element {
  const { t } = useT()
  const descriptionId = useId()
  return <div className={cn('relative rounded-sm border bg-card px-3 py-2 shadow-xs transition-[border-color,box-shadow]', selected ? 'border-(--accent) shadow-sm' : data.status === 'done' ? 'border-green-b' : data.status === 'running' ? 'border-info-b shadow-[0_0_0_3px_var(--info-t)]' : 'border-border-2', data.entering && 'animate-[flow-in_.3s_var(--ease-out)_both] motion-reduce:animate-none')} style={{ width: NODE_WIDTH, minHeight: data.height }} data-testid={`flow-node-${id}`} data-entering={data.entering || undefined} data-status={data.status ?? undefined}>
    <Handle type="target" position={Position.Left} className="!size-2 !border-border-2 !bg-card" isConnectable={data.editable} />
    <button type="button" className="grid w-full min-w-0 gap-0.5 overflow-hidden text-left outline-none focus-visible:ring-2 focus-visible:ring-(--accent)" title={data.description ?? data.label} aria-label={data.label} aria-describedby={data.description === null ? undefined : descriptionId} data-testid={`flow-open-${id}`} onClick={() => data.onOpen(id)}><span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap font-mono text-caption font-semibold text-text">{data.source === null ? <Box className="size-3 flex-none text-text-3" aria-hidden="true" /> : <SkillSourceIcon source={data.source} className="size-3" />}<span className="min-w-0 flex-1 truncate">{data.label}</span></span>{data.caption !== null && <span className="block truncate whitespace-nowrap text-micro text-text-3" data-testid={`flow-caption-${id}`}>{data.caption}</span>}{data.status !== null && <span className={cn('mt-0.5 inline-flex items-center gap-1.5 whitespace-nowrap text-micro', data.status === 'done' ? 'text-green-d' : data.status === 'running' ? 'text-info-d' : 'text-text-3')}><i className={cn('size-1.5 rounded-full', data.status === 'done' ? 'bg-green' : data.status === 'running' ? 'bg-info' : 'bg-text-3')} aria-hidden="true" />{data.statusLabel}</span>}</button>
    {data.description !== null && <span id={descriptionId} className="sr-only" data-testid={`flow-desc-${id}`}>{data.description}</span>}
    {data.editable && <button type="button" className="absolute -right-2 -top-2 grid size-5 place-items-center rounded-full border border-border bg-card text-text-3 hover:text-red-d" aria-label={t('workflow.remove_skill', { id })} data-testid={`flow-remove-${id}`} onClick={() => data.onRemove(id)}><X className="size-3" aria-hidden="true" /></button>}
    <Handle type="source" position={Position.Right} className="!size-2 !border-border-2 !bg-card" isConnectable={data.editable} />
  </div>
}
const MemoSkillNodeView = memo(SkillNodeView)

const PortNodeView = memo(function PortNodeView({ id, data }: NodeProps<PortNode>): JSX.Element { const start = id === 'start'; return <div className="relative grid place-items-center" style={{ width: PORT_SIZE, height: PORT_SIZE }} data-testid={`flow-${id}`}><span className={cn('block size-2.5 rounded-full', start ? 'bg-(--accent)' : 'bg-text-3')} aria-hidden="true" /><span className="absolute top-full mt-1 whitespace-nowrap text-micro text-text-3">{data.label}</span><Handle type={start ? 'source' : 'target'} position={start ? Position.Right : Position.Left} className="!size-1 !border-0 !bg-transparent" isConnectable={false} /></div> })
const GhostNodeView = memo(function GhostNodeView({ data }: NodeProps<GhostNode>): JSX.Element { return <div className="relative rounded-sm border border-dashed border-(--accent) bg-accent-t/60 px-3 py-2 opacity-90" style={{ width: NODE_WIDTH, minHeight: NODE_HEIGHT }} data-testid="flow-ghost" data-mode={data.mode}><Handle type="target" position={Position.Left} className="!size-1 !border-0 !bg-transparent" isConnectable={false} /><span className="block truncate font-mono text-body font-semibold text-(--accent)">{data.label}</span><span className="block text-micro text-(--accent)">{data.mode}</span><Handle type="source" position={Position.Right} className="!size-1 !border-0 !bg-transparent" isConnectable={false} /></div> })
const LabelNodeView = memo(function LabelNodeView({ data }: NodeProps<LabelNode>): JSX.Element { return <span className="whitespace-nowrap font-mono text-micro text-text-3" data-testid="flow-wave-label">{data.label}</span> })
const JunctionNodeView = memo(function JunctionNodeView(): JSX.Element { return <div className="relative" style={{ width: 2, height: 2 }} data-testid="flow-junction"><Handle type="target" position={Position.Left} className="!size-1 !border-0 !bg-transparent" isConnectable={false} /><Handle type="source" position={Position.Right} className="!size-1 !border-0 !bg-transparent" isConnectable={false} /></div> })

export const NODE_TYPES = { skill: MemoSkillNodeView, port: PortNodeView, label: LabelNodeView, ghost: GhostNodeView, junction: JunctionNodeView }
export const EDGE_TYPES = { pulse: PulseEdge }

export function isVirtualId(id: string): boolean { return id === 'start' || id === 'end' || id === 'ghost' || id.startsWith('label-') || /^j\d+$/.test(id) }
