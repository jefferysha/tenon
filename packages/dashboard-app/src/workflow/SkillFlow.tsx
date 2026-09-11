import { memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Box, X } from 'lucide-react'
import type { WbSkillEntry, WbSkillRef } from '../api/governanceTypes'
import { useT } from '../i18n'
import { wavesOf } from '../workbench/skillWaves'
import { SkillSourceIcon } from './SkillSourceIcon'
import { cn } from '@/lib/utils'

export const NODE_WIDTH = 224
const NODE_HEIGHT = 60
const COLUMN_GAP = 300
const ROW_GAP = 92
const PADDING = 24
/** 起点 / 终点小圆到首列 / 末列的水平距离。 */
const PORT_GAP = 72
const PORT_SIZE = 12

type SkillNodeData = {
  label: string
  description: string | null
  source: WbSkillEntry['source'] | null
  editable: boolean
  /** 刚加入的节点：入场动画。 */
  entering: boolean
  onOpen: (id: string) => void
  onRemove: (id: string) => void
}
type SkillNode = Node<SkillNodeData, 'skill'>
type PortNode = Node<{ label: string }, 'port'>
type LabelNode = Node<{ label: string }, 'label'>
type GhostNode = Node<{ label: string; mode: string }, 'ghost'>
type JunctionNode = Node<Record<string, never>, 'junction'>
type FlowNode = SkillNode | PortNode | LabelNode | GhostNode | JunctionNode

/** 技能 → 节点坐标：列 = 波次（depends_on 深度），行 = 波次内序；各列围绕同一条中线纵向居中，首列左侧留出起点。 */
export function layoutSkills(skills: readonly WbSkillRef[]): Array<{ id: string; x: number; y: number }> {
  const out: Array<{ id: string; x: number; y: number }> = []
  const waves = wavesOf(skills)
  const tallest = Math.max(0, ...waves.map((wave) => wave.length))
  waves.forEach((wave, column) => {
    const offset = ((tallest - wave.length) * ROW_GAP) / 2
    wave.forEach((id, row) => out.push({ id, x: PADDING + PORT_GAP + column * COLUMN_GAP, y: PADDING + 28 + offset + row * ROW_GAP }))
  })
  return out
}

/** 相邻两波是否构成完整的列依赖：下一波每个节点都恰好依赖上一波全部节点，且上一波没有别的后继。 */
export function isColumnLink(previous: readonly string[], next: readonly string[], edges: readonly Pick<Edge, 'source' | 'target'>[]): boolean {
  if (previous.length === 0 || next.length === 0) return false
  const previousSet = new Set(previous)
  const nextSet = new Set(next)
  for (const id of next) {
    const deps = edges.filter((edge) => edge.target === id).map((edge) => edge.source)
    if (deps.length !== previous.length || !deps.every((dep) => previousSet.has(dep))) return false
  }
  return edges.filter((edge) => previousSet.has(edge.source)).every((edge) => nextSet.has(edge.target))
}

/** depends_on → 边（只保留两端都在本阶段的依赖）。 */
export function edgesOf(skills: readonly WbSkillRef[]): Edge[] {
  const ids = new Set(skills.map((skill) => skill.id))
  const edges: Edge[] = []
  for (const skill of skills) {
    for (const dependency of skill.depends_on ?? []) {
      if (ids.has(dependency)) edges.push({ id: `${dependency}->${skill.id}`, source: dependency, target: skill.id })
    }
  }
  return edges
}

/** 加一条 source→target 是否成环（含自环）。 */
export function wouldCycle(edges: readonly Pick<Edge, 'source' | 'target'>[], source: string, target: string): boolean {
  if (source === target) return true
  const next = new Map<string, string[]>()
  for (const edge of edges) next.set(edge.source, [...(next.get(edge.source) ?? []), edge.target])
  const seen = new Set<string>()
  const stack = [target]
  while (stack.length > 0) {
    const current = stack.pop()!
    if (current === source) return true
    if (seen.has(current)) continue
    seen.add(current)
    stack.push(...(next.get(current) ?? []))
  }
  return false
}

/** 节点 + 边 → 技能引用：depends_on = 指向它的边的起点；其它字段从 existing 带回；顺序按波次拍平，同波保持原序。 */
export function graphToSkills(nodeIds: readonly string[], edges: readonly Pick<Edge, 'source' | 'target'>[], existing: readonly WbSkillRef[]): WbSkillRef[] {
  const byId = new Map(existing.map((skill) => [skill.id, skill]))
  const ids = new Set(nodeIds)
  const rank = (id: string): number => { const index = existing.findIndex((skill) => skill.id === id); return index === -1 ? existing.length : index }
  const ordered = [...nodeIds].sort((a, b) => rank(a) - rank(b))
  const draft: WbSkillRef[] = ordered.map((id) => {
    const { depends_on: _dropped, ...rest } = byId.get(id) ?? { id }
    const deps = edges.filter((edge) => edge.target === id && ids.has(edge.source)).map((edge) => edge.source)
    return deps.length > 0 ? { ...rest, id, depends_on: deps } : { ...rest, id }
  })
  const order = wavesOf(draft).flat()
  return order.map((id) => draft.find((skill) => skill.id === id)!)
}

/** 落点语义：并入第 k 波（并行）/ 追加为新一步（串行）/ 插到最前（串行）。 */
export type DropTarget = { kind: 'join'; wave: number } | { kind: 'after' } | { kind: 'before' }

/** 由指针 x 与各波列的 x 判定落点：落在某列附近 = 并入该波；末列右侧 = 新一步；首列左侧 = 新首步。 */
export function dropTargetFor(x: number, columnXs: readonly number[]): DropTarget {
  if (columnXs.length === 0) return { kind: 'after' }
  const first = columnXs[0]!
  const last = columnXs[columnXs.length - 1]!
  if (x > last + NODE_WIDTH + PORT_GAP / 2) return { kind: 'after' }
  if (x < first - PORT_GAP / 2) return { kind: 'before' }
  let best = 0
  let bestDistance = Number.POSITIVE_INFINITY
  columnXs.forEach((columnX, index) => {
    const distance = Math.abs(x - (columnX + NODE_WIDTH / 2))
    if (distance < bestDistance) { bestDistance = distance; best = index }
  })
  return { kind: 'join', wave: best }
}

/** 按落点把技能加进图：并入第 k 波 = 依赖第 k-1 波、被第 k+1 波依赖；新一步 = 依赖末波；新首步 = 首波依赖它。 */
export function addSkillAt(skills: readonly WbSkillRef[], id: string, target: DropTarget): WbSkillRef[] {
  if (skills.some((skill) => skill.id === id)) return [...skills]
  const waves = wavesOf(skills)
  const withDeps = (deps: readonly string[]): WbSkillRef => deps.length > 0 ? { id, depends_on: [...deps] } : { id }
  const addDep = (skill: WbSkillRef, dep: string): WbSkillRef => ({ ...skill, depends_on: [...new Set([...(skill.depends_on ?? []), dep])] })
  if (target.kind === 'after' || waves.length === 0) return [...skills, withDeps(waves[waves.length - 1] ?? [])]
  if (target.kind === 'before') {
    const firstWave = new Set(waves[0] ?? [])
    return [withDeps([]), ...skills.map((skill) => firstWave.has(skill.id) ? addDep(skill, id) : skill)]
  }
  const wave = Math.max(0, Math.min(target.wave, waves.length - 1))
  const nextWave = new Set(waves[wave + 1] ?? [])
  const out = skills.map((skill) => nextWave.has(skill.id) ? addDep(skill, id) : skill)
  const anchor = waves[wave]![waves[wave]!.length - 1]!
  const at = out.findIndex((skill) => skill.id === anchor) + 1
  out.splice(at, 0, withDeps(waves[wave - 1] ?? []))
  return out
}

/** 技能库「+」：串行追加为新一步。 */
export function appendSerial(skills: readonly WbSkillRef[], id: string): WbSkillRef[] {
  return addSkillAt(skills, id, { kind: 'after' })
}

/** 技能数组的内容签名：id 与 depends_on；引用变了但内容没变时不重排、不回写。 */
export function skillsSignature(skills: readonly WbSkillRef[]): string {
  return skills.map((skill) => `${skill.id}<${[...(skill.depends_on ?? [])].sort().join(',')}`).join('|')
}

const EDGE_STYLE = { stroke: 'var(--border-2)', strokeWidth: 1.5 }
const MARKER = { type: MarkerType.ArrowClosed, width: 16, height: 16, color: 'var(--border-2)' }

const SkillNodeView = memo(function SkillNodeView({ id, data, selected }: NodeProps<SkillNode>): JSX.Element {
  const { t } = useT()
  return (
    <div
      className={cn('relative rounded-sm border bg-card px-3 py-2 shadow-xs transition-[border-color,box-shadow]', selected ? 'border-(--accent) shadow-sm' : 'border-border-2', data.entering && 'animate-[flow-in_.3s_var(--ease-out)_both] motion-reduce:animate-none')}
      style={{ width: NODE_WIDTH, minHeight: NODE_HEIGHT }}
      data-testid={`flow-node-${id}`}
      data-entering={data.entering || undefined}
    >
      <Handle type="target" position={Position.Left} className="!size-2 !border-border-2 !bg-card" isConnectable={data.editable} />
      <button type="button" className="grid w-full gap-0.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-(--accent)" data-testid={`flow-open-${id}`} onClick={() => data.onOpen(id)}>
        <span className="flex items-center gap-1.5 font-mono text-body font-semibold text-text">
          {data.source === null ? <Box className="size-3 flex-none text-text-3" aria-hidden="true" /> : <SkillSourceIcon source={data.source} className="size-3" />}
          <span className="min-w-0 flex-1 truncate">{data.label}</span>
        </span>
        {data.description !== null && <span className="block truncate text-micro text-text-2">{data.description}</span>}
      </button>
      {data.editable && (
        <button type="button" className="absolute -right-2 -top-2 grid size-5 place-items-center rounded-full border border-border bg-card text-text-3 hover:text-red-d" aria-label={t('workflow.remove_skill', { id })} data-testid={`flow-remove-${id}`} onClick={() => data.onRemove(id)}>
          <X className="size-3" aria-hidden="true" />
        </button>
      )}
      <Handle type="source" position={Position.Right} className="!size-2 !border-border-2 !bg-card" isConnectable={data.editable} />
    </div>
  )
})

/** 起点 / 终点：实心小点（起点强调色、终点灰）+ 下方一字标签；只有一个端口方向。 */
const PortNodeView = memo(function PortNodeView({ id, data }: NodeProps<PortNode>): JSX.Element {
  const start = id === 'start'
  return (
    <div className="relative grid place-items-center" style={{ width: PORT_SIZE, height: PORT_SIZE }} data-testid={`flow-${id}`}>
      <span className={cn('block size-2.5 rounded-full', start ? 'bg-(--accent)' : 'bg-text-3')} aria-hidden="true" />
      <span className="absolute top-full mt-1 whitespace-nowrap text-micro text-text-3">{data.label}</span>
      <Handle type={start ? 'source' : 'target'} position={start ? Position.Right : Position.Left} className="!size-1 !border-0 !bg-transparent" isConnectable={false} />
    </div>
  )
})

/** 拖放预览：半透明虚线节点 + 语义字（并行 / 串行）。 */
const GhostNodeView = memo(function GhostNodeView({ data }: NodeProps<GhostNode>): JSX.Element {
  return (
    <div className="relative rounded-sm border border-dashed border-(--accent) bg-accent-t/60 px-3 py-2 opacity-90" style={{ width: NODE_WIDTH, minHeight: NODE_HEIGHT }} data-testid="flow-ghost" data-mode={data.mode}>
      <Handle type="target" position={Position.Left} className="!size-1 !border-0 !bg-transparent" isConnectable={false} />
      <span className="block truncate font-mono text-body font-semibold text-(--accent)">{data.label}</span>
      <span className="block text-micro text-(--accent)">{data.mode}</span>
      <Handle type="source" position={Position.Right} className="!size-1 !border-0 !bg-transparent" isConnectable={false} />
    </div>
  )
})

/** 波次标签：第 n 步（· 并行 k）。 */
const LabelNodeView = memo(function LabelNodeView({ data }: NodeProps<LabelNode>): JSX.Element {
  return <span className="whitespace-nowrap font-mono text-micro text-text-3" data-testid="flow-wave-label">{data.label}</span>
})

/** 汇合点：并行波在中线收敛成一点再连下一步；本身不可见，只有两侧端口。 */
const JunctionNodeView = memo(function JunctionNodeView(): JSX.Element {
  return (
    <div className="relative" style={{ width: 2, height: 2 }} data-testid="flow-junction">
      <Handle type="target" position={Position.Left} className="!size-1 !border-0 !bg-transparent" isConnectable={false} />
      <Handle type="source" position={Position.Right} className="!size-1 !border-0 !bg-transparent" isConnectable={false} />
    </div>
  )
})

const NODE_TYPES = { skill: SkillNodeView, port: PortNodeView, label: LabelNodeView, ghost: GhostNodeView, junction: JunctionNodeView }

export interface SkillFlowProps {
  skills: readonly WbSkillRef[]
  registry: readonly WbSkillEntry[] | null
  editable: boolean
  /** 可编辑时，图与传入技能的签名不同才回调完整技能数组。 */
  onChange?: (skills: WbSkillRef[]) => void
  onOpen: (id: string) => void
  /** 正在从技能库拖过来的技能名（dragover 阶段读不到 dataTransfer 数据，由父级告知），用于幽灵节点。 */
  dragLabel?: string | null
  className?: string
}

function SkillFlowInner({ skills, registry, editable, onChange, onOpen, dragLabel = null, className }: SkillFlowProps): JSX.Element {
  const { t } = useT()
  const flow = useReactFlow()
  const flowRef = useRef(flow)
  flowRef.current = flow
  const skillsRef = useRef(skills)
  skillsRef.current = skills
  const registryRef = useRef(registry)
  registryRef.current = registry
  const onOpenRef = useRef(onOpen)
  onOpenRef.current = onOpen
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const [nodes, setNodes] = useState<SkillNode[]>([])
  const [edges, setEdges] = useState<Edge[]>([])
  const [ghost, setGhost] = useState<{ x: number; y: number; label: string; target: DropTarget } | null>(null)
  const enteringRef = useRef<string | null>(null)
  const signature = skillsSignature(skills)

  const removeNode = useCallback((id: string) => {
    setNodes((current) => current.filter((node) => node.id !== id))
    setEdges((current) => current.filter((edge) => edge.source !== id && edge.target !== id))
  }, [])

  const makeNode = useCallback((id: string, x: number, y: number): SkillNode => {
    const entry = registryRef.current?.find((candidate) => candidate.name === id)
    return {
      id,
      type: 'skill',
      position: { x, y },
      data: { label: id, description: entry?.description ?? null, source: entry?.source ?? null, editable, entering: enteringRef.current === id, onOpen: (target) => onOpenRef.current(target), onRemove: removeNode },
      draggable: editable,
      selectable: editable,
    }
  }, [editable, removeNode])

  // 技能内容变了（切换阶段 / 打开编辑器 / 外部改写）→ 按波次重新布局；引用变化不触发。
  useEffect(() => {
    setNodes(layoutSkills(skillsRef.current).map(({ id, x, y }) => makeNode(id, x, y)))
    setEdges(edgesOf(skillsRef.current))
    // 等 React Flow 量完节点尺寸再 fitView，否则按未测量的位置取景会把末列切掉。
    const timer = setTimeout(() => { void flowRef.current.fitView({ padding: 0.2, maxZoom: 1, duration: 200 }) }, 60)
    return () => clearTimeout(timer)
  }, [signature, makeNode])

  // 可编辑：图的签名与传入技能不同才回写，回写一次后等父级把新技能传回来。
  const graph = useMemo(() => graphToSkills(nodes.map((node) => node.id), edges, skillsRef.current), [nodes, edges])
  const graphSignature = skillsSignature(graph)
  useEffect(() => {
    if (!editable || nodes.length === 0 && skillsRef.current.length === 0) return
    if (graphSignature !== signature) onChangeRef.current?.(graph)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphSignature])

  // 起点 / 终点 / 波次标签只是画法，从当前技能节点推出来，不进 state。
  const decorated = useMemo((): { nodes: FlowNode[]; edges: Edge[] } => {
    if (nodes.length === 0) return { nodes: [], edges: [] }
    const waves = wavesOf(graph)
    const byId = new Map(nodes.map((node) => [node.id, node]))
    const heightOf = (id: string): number => byId.get(id)?.measured?.height ?? NODE_HEIGHT
    const middleOf = (id: string): number => (byId.get(id)?.position.y ?? 0) + heightOf(id) / 2
    const xs = nodes.map((node) => node.position.x)
    const minX = Math.min(...xs)
    const maxX = Math.max(...xs)
    /** 一波的中线 y：首末节点中心的中点。 */
    const centerY = (ids: readonly string[]): number => ids.length === 0 ? 0 : (middleOf(ids[0]!) + middleOf(ids[ids.length - 1]!)) / 2
    const first = waves[0] ?? []
    const last = waves[waves.length - 1] ?? []
    const portEdge = { deletable: false, selectable: false, animated: false, style: { ...EDGE_STYLE, opacity: 0.7 } }
    const ports: PortNode[] = [
      { id: 'start', type: 'port', position: { x: minX - PORT_GAP, y: centerY(first) - PORT_SIZE / 2 }, data: { label: t('workflow.flow_start') }, draggable: false, selectable: false, deletable: false, connectable: false },
      { id: 'end', type: 'port', position: { x: maxX + NODE_WIDTH + PORT_GAP - PORT_SIZE, y: centerY(last) - PORT_SIZE / 2 }, data: { label: t('workflow.flow_end') }, draggable: false, selectable: false, deletable: false, connectable: false },
    ]
    const labels: LabelNode[] = waves.map((wave, index) => {
      const x = Math.min(...wave.map((id) => byId.get(id)?.position.x ?? 0))
      const y = Math.min(...wave.map((id) => byId.get(id)?.position.y ?? 0)) - 22
      const text = wave.length > 1 ? `${t('workflow.step_n', { n: index + 1 })} · ${t('workflow.parallel_n', { n: wave.length })}` : t('workflow.step_n', { n: index + 1 })
      return { id: `label-${index}`, type: 'label', position: { x, y }, data: { label: text }, draggable: false, selectable: false, deletable: false, connectable: false }
    })
    // 相邻两波构成完整列依赖 → 用汇合点：上一波所有节点 → 汇合点（无箭头）→ 下一波每个节点。
    const junctions: JunctionNode[] = []
    const junctionEdges: Edge[] = []
    const replaced = new Set<string>()
    waves.forEach((wave, index) => {
      const next = waves[index + 1]
      if (next === undefined || !isColumnLink(wave, next, edges)) return
      const rightEdge = Math.max(...wave.map((id) => byId.get(id)?.position.x ?? 0)) + NODE_WIDTH
      const leftEdge = Math.min(...next.map((id) => byId.get(id)?.position.x ?? 0))
      const junctionId = `j${index}`
      junctions.push({ id: junctionId, type: 'junction', position: { x: (rightEdge + leftEdge) / 2 - 1, y: (centerY(wave) + centerY(next)) / 2 - 1 }, data: {}, draggable: false, selectable: false, deletable: false, connectable: false })
      for (const id of wave) { junctionEdges.push({ id: `${id}->${junctionId}`, source: id, target: junctionId, ...portEdge, markerEnd: undefined, animated: true }) }
      for (const id of next) { junctionEdges.push({ id: `${junctionId}->${id}`, source: junctionId, target: id, deletable: false, selectable: false }) }
      for (const edge of edges) if (wave.includes(edge.source) && next.includes(edge.target)) replaced.add(edge.id)
    })
    const hasDependent = new Set(edges.map((edge) => edge.source))
    const virtual: Edge[] = [
      ...first.map((id) => ({ id: `start->${id}`, source: 'start', target: id, ...portEdge })),
      ...nodes.filter((node) => !hasDependent.has(node.id)).map((node) => ({ id: `${node.id}->end`, source: node.id, target: 'end', ...portEdge, markerEnd: undefined })),
    ]
    const ghostNodes: GhostNode[] = ghost === null ? [] : [{ id: 'ghost', type: 'ghost', position: { x: ghost.x, y: ghost.y }, data: { label: ghost.label, mode: ghost.target.kind === 'join' ? t('workflow.parallel_n', { n: (waves[ghost.target.wave]?.length ?? 0) + 1 }) : t('workflow.serial') }, draggable: false, selectable: false, deletable: false, connectable: false }]
    const ghostEdges: Edge[] = ghost === null ? [] : (
      ghost.target.kind === 'after' ? last.map((id) => ({ id: `${id}->ghost`, source: id, target: 'ghost' }))
        : ghost.target.kind === 'before' ? first.map((id) => ({ id: `ghost->${id}`, source: 'ghost', target: id }))
          : (waves[ghost.target.wave - 1] ?? []).map((id) => ({ id: `${id}->ghost`, source: id, target: 'ghost' }))
    ).map((edge) => ({ ...edge, deletable: false, selectable: false, style: { stroke: 'var(--accent-b)', strokeWidth: 1.5, strokeDasharray: '4 4' } }))
    return {
      nodes: [...labels, ...ports, ...junctions, ...nodes, ...ghostNodes],
      edges: [...edges.filter((edge) => !replaced.has(edge.id)), ...junctionEdges, ...virtual, ...ghostEdges],
    }
  }, [nodes, edges, graph, ghost, t])

  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => setNodes((current) => applyNodeChanges(changes.filter((change) => !('id' in change) || (change.id !== 'start' && change.id !== 'end' && change.id !== 'ghost' && !String(change.id).startsWith('label-') && !/^j\d+$/.test(String(change.id)))) as NodeChange<SkillNode>[], current)), [])
  const onEdgesChange = useCallback((changes: EdgeChange[]) => setEdges((current) => applyEdgeChanges(changes, current)), [])
  const onConnect = useCallback((connection: Connection) => {
    if (connection.source === null || connection.target === null || connection.source === 'start' || connection.target === 'end') return
    setEdges((current) => {
      if (wouldCycle(current, connection.source, connection.target)) return current
      if (current.some((edge) => edge.source === connection.source && edge.target === connection.target)) return current
      return [...current, { id: `${connection.source}->${connection.target}`, source: connection.source, target: connection.target }]
    })
  }, [])
  /** 各波列的 x（取该波节点的最小 x），按波次顺序。 */
  const columnXs = useMemo(() => {
    const position = new Map(nodes.map((node) => [node.id, node.position.x]))
    return wavesOf(graph).map((wave) => Math.min(...wave.map((id) => position.get(id) ?? 0)))
  }, [nodes, graph])

  /** 结构性变更（加节点）后整体重排，并给新节点入场动画。 */
  const relayout = useCallback((next: WbSkillRef[], entering: string | null) => {
    enteringRef.current = entering
    setNodes(layoutSkills(next).map(({ id, x, y }) => makeNode(id, x, y)))
    setEdges(edgesOf(next))
    setTimeout(() => { void flowRef.current.fitView({ padding: 0.2, maxZoom: 1, duration: 200 }) }, 60)
  }, [makeNode])

  const ghostFor = useCallback((label: string, point: { x: number; y: number }) => {
    const target = dropTargetFor(point.x, columnXs)
    const waves = wavesOf(graph)
    const position = new Map(nodes.map((node) => [node.id, node.position]))
    const centerY = (ids: readonly string[]): number => ids.length === 0 ? point.y - NODE_HEIGHT / 2 : ids.reduce((sum, id) => sum + (position.get(id)?.y ?? 0), 0) / ids.length
    if (target.kind === 'after') {
      const lastX = columnXs[columnXs.length - 1]
      return { x: lastX === undefined ? point.x - NODE_WIDTH / 2 : lastX + COLUMN_GAP, y: centerY(waves[waves.length - 1] ?? []), label, target }
    }
    if (target.kind === 'before') return { x: (columnXs[0] ?? point.x) - COLUMN_GAP, y: centerY(waves[0] ?? []), label, target }
    const wave = waves[target.wave] ?? []
    const bottom = Math.max(...wave.map((id) => position.get(id)?.y ?? 0))
    return { x: columnXs[target.wave] ?? point.x, y: bottom + ROW_GAP, label, target }
  }, [columnXs, graph, nodes])

  const onDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    if (!event.dataTransfer.types.includes('text/skill')) return
    setGhost(ghostFor(dragLabel ?? '…', flowRef.current.screenToFlowPosition({ x: event.clientX, y: event.clientY })))
  }, [ghostFor, dragLabel])
  const onDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setGhost(null)
    const id = event.dataTransfer.getData('text/skill')
    if (id === '' || nodes.some((node) => node.id === id)) return
    const point = flowRef.current.screenToFlowPosition({ x: event.clientX, y: event.clientY })
    relayout(addSkillAt(graph, id, dropTargetFor(point.x, columnXs)), id)
  }, [nodes, graph, columnXs, relayout])

  // 父级通过签名变化把新技能传进来（技能库「+」）：定位新加入的那个做入场动画。
  const previousIds = useRef<Set<string>>(new Set())
  useEffect(() => {
    const current = new Set(skills.map((skill) => skill.id))
    const added = [...current].filter((id) => !previousIds.current.has(id))
    previousIds.current = current
    if (previousIds.current.size > 0 && added.length === 1 && editable) {
      enteringRef.current = added[0]!
      setNodes((now) => now.map((node) => node.id === added[0] ? { ...node, data: { ...node.data, entering: true } } : node))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature])

  return (
    <div
      className={cn('relative overflow-hidden rounded-md border border-border bg-card', className)}
      aria-label={t('workflow.skills_title')}
      data-testid="skill-flow"
      data-editable={editable}
      data-nodes={nodes.length}
      data-edges={edges.length}
      onDragOver={editable ? onDragOver : undefined}
      onDragLeave={editable ? (event) => { if (!event.currentTarget.contains(event.relatedTarget as globalThis.Node | null)) setGhost(null) } : undefined}
      onDrop={editable ? onDrop : undefined}
    >
      {nodes.length === 0 && <p className="pointer-events-none absolute inset-0 z-10 grid place-items-center text-body text-text-3" role="status" data-testid="skill-flow-empty">{t(editable ? 'workflow.drop_skill' : 'workflow.no_skills')}</p>}
      <ReactFlow<FlowNode>
        nodes={decorated.nodes}
        edges={decorated.edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={editable ? onConnect : undefined}
        nodesDraggable={editable}
        nodesConnectable={editable}
        elementsSelectable={editable}
        panOnDrag={editable}
        zoomOnScroll={editable}
        zoomOnDoubleClick={false}
        preventScrolling={editable}
        fitView
        minZoom={0.5}
        maxZoom={1.5}
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{ type: 'default', animated: true, style: EDGE_STYLE, markerEnd: MARKER }}
        deleteKeyCode={editable ? ['Backspace', 'Delete'] : null}
      >
        <Background variant={BackgroundVariant.Dots} gap={14} size={1} color="var(--border-2)" />
        <Controls showInteractive={false} position="bottom-right" />
      </ReactFlow>
    </div>
  )
}

/**
 * 技能流程画布（React Flow）：起点 → 第一波技能 → … → 终点。节点 = 技能（来源图标 + 名称 + description），
 * 边 = depends_on（带箭头、脉冲虚线），列 = 波次并带「第 n 步 · 并行 k」标签，各列围绕中线居中；相邻两波构成
 * 完整列依赖时先汇合到中线一点再连下一步，一波多技能就是起点扇出。只读时不可拖不可连；可编辑时接受技能库拖放（dataTransfer `text/skill`）、拉线建依赖
 * （拒绝成环）、Backspace 删边、× 删点，并在图与传入技能签名不同时回写技能数组。
 */
export function SkillFlow(props: SkillFlowProps): JSX.Element {
  return <ReactFlowProvider><SkillFlowInner {...props} /></ReactFlowProvider>
}
