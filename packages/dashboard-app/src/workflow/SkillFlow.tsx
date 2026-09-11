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
const NODE_HEIGHT = 52
const COLUMN_GAP = 300
const ROW_GAP = 84
const PADDING = 24
/** 起点 / 终点小圆到首列 / 末列的水平距离。 */
const PORT_GAP = 72
const PORT_SIZE = 12

type SkillNodeData = {
  label: string
  description: string | null
  source: WbSkillEntry['source'] | null
  editable: boolean
  onOpen: (id: string) => void
  onRemove: (id: string) => void
}
type SkillNode = Node<SkillNodeData, 'skill'>
type PortNode = Node<{ label: string }, 'port'>
type LabelNode = Node<{ label: string }, 'label'>
type FlowNode = SkillNode | PortNode | LabelNode

/** 技能 → 节点坐标：列 = 波次（depends_on 深度），行 = 波次内序；首列左侧留出起点的位置。 */
export function layoutSkills(skills: readonly WbSkillRef[]): Array<{ id: string; x: number; y: number }> {
  const out: Array<{ id: string; x: number; y: number }> = []
  wavesOf(skills).forEach((wave, column) => {
    wave.forEach((id, row) => out.push({ id, x: PADDING + PORT_GAP + column * COLUMN_GAP, y: PADDING + 28 + row * ROW_GAP }))
  })
  return out
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
      className={cn('relative rounded-sm border bg-card px-3 py-2 shadow-xs transition-[border-color,box-shadow]', selected ? 'border-(--accent) shadow-sm' : 'border-border-2')}
      style={{ width: NODE_WIDTH, minHeight: NODE_HEIGHT }}
      data-testid={`flow-node-${id}`}
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

/** 起点 / 终点：一枚实心小圆，只有一个端口方向。 */
const PortNodeView = memo(function PortNodeView({ id, data }: NodeProps<PortNode>): JSX.Element {
  const start = id === 'start'
  return (
    <div className="grid place-items-center" style={{ width: PORT_SIZE, height: PORT_SIZE }} title={data.label} data-testid={`flow-${id}`}>
      <span className="block size-3 rounded-full border-2 border-border-2 bg-card" aria-hidden="true" />
      <Handle type={start ? 'source' : 'target'} position={start ? Position.Right : Position.Left} className="!size-1 !border-0 !bg-transparent" isConnectable={false} />
    </div>
  )
})

/** 波次标签：第 n 步（· 并行 k）。 */
const LabelNodeView = memo(function LabelNodeView({ data }: NodeProps<LabelNode>): JSX.Element {
  return <span className="whitespace-nowrap font-mono text-micro text-text-3" data-testid="flow-wave-label">{data.label}</span>
})

const NODE_TYPES = { skill: SkillNodeView, port: PortNodeView, label: LabelNodeView }

export interface SkillFlowProps {
  skills: readonly WbSkillRef[]
  registry: readonly WbSkillEntry[] | null
  editable: boolean
  /** 可编辑时，图与传入技能的签名不同才回调完整技能数组。 */
  onChange?: (skills: WbSkillRef[]) => void
  onOpen: (id: string) => void
  className?: string
}

function SkillFlowInner({ skills, registry, editable, onChange, onOpen, className }: SkillFlowProps): JSX.Element {
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
      data: { label: id, description: entry?.description ?? null, source: entry?.source ?? null, editable, onOpen: (target) => onOpenRef.current(target), onRemove: removeNode },
      draggable: editable,
      selectable: editable,
    }
  }, [editable, removeNode])

  // 技能内容变了（切换阶段 / 打开编辑器 / 外部改写）→ 按波次重新布局；引用变化不触发。
  useEffect(() => {
    setNodes(layoutSkills(skillsRef.current).map(({ id, x, y }) => makeNode(id, x, y)))
    setEdges(edgesOf(skillsRef.current))
    const frame = requestAnimationFrame(() => { void flowRef.current.fitView({ padding: 0.2, maxZoom: 1 }) })
    return () => cancelAnimationFrame(frame)
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
    const position = new Map(nodes.map((node) => [node.id, node.position]))
    const xs = nodes.map((node) => node.position.x)
    const minX = Math.min(...xs)
    const maxX = Math.max(...xs)
    const centerY = (ids: readonly string[]): number => ids.reduce((sum, id) => sum + (position.get(id)?.y ?? 0), 0) / Math.max(1, ids.length) + NODE_HEIGHT / 2 - PORT_SIZE / 2
    const first = waves[0] ?? []
    const last = waves[waves.length - 1] ?? []
    const hasDependent = new Set(edges.map((edge) => edge.source))
    const ports: PortNode[] = [
      { id: 'start', type: 'port', position: { x: minX - PORT_GAP, y: centerY(first) }, data: { label: t('workflow.flow_start') }, draggable: false, selectable: false, deletable: false, connectable: false },
      { id: 'end', type: 'port', position: { x: maxX + NODE_WIDTH + PORT_GAP - PORT_SIZE, y: centerY(last) }, data: { label: t('workflow.flow_end') }, draggable: false, selectable: false, deletable: false, connectable: false },
    ]
    const labels: LabelNode[] = waves.map((wave, index) => {
      const x = Math.min(...wave.map((id) => position.get(id)?.x ?? 0))
      const y = Math.min(...wave.map((id) => position.get(id)?.y ?? 0)) - 22
      const text = wave.length > 1 ? `${t('workflow.step_n', { n: index + 1 })} · ${t('workflow.parallel_n', { n: wave.length })}` : t('workflow.step_n', { n: index + 1 })
      return { id: `label-${index}`, type: 'label', position: { x, y }, data: { label: text }, draggable: false, selectable: false, deletable: false, connectable: false }
    })
    const virtual: Edge[] = [
      ...first.map((id) => ({ id: `start->${id}`, source: 'start', target: id, deletable: false, selectable: false })),
      ...nodes.filter((node) => !hasDependent.has(node.id)).map((node) => ({ id: `${node.id}->end`, source: node.id, target: 'end', deletable: false, selectable: false })),
    ]
    return { nodes: [...labels, ...ports, ...nodes], edges: [...edges, ...virtual] }
  }, [nodes, edges, graph, t])

  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => setNodes((current) => applyNodeChanges(changes.filter((change) => !('id' in change) || (change.id !== 'start' && change.id !== 'end' && !String(change.id).startsWith('label-'))) as NodeChange<SkillNode>[], current)), [])
  const onEdgesChange = useCallback((changes: EdgeChange[]) => setEdges((current) => applyEdgeChanges(changes, current)), [])
  const onConnect = useCallback((connection: Connection) => {
    if (connection.source === null || connection.target === null || connection.source === 'start' || connection.target === 'end') return
    setEdges((current) => {
      if (wouldCycle(current, connection.source, connection.target)) return current
      if (current.some((edge) => edge.source === connection.source && edge.target === connection.target)) return current
      return [...current, { id: `${connection.source}->${connection.target}`, source: connection.source, target: connection.target }]
    })
  }, [])
  const onDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    const id = event.dataTransfer.getData('text/skill')
    if (id === '') return
    const point = flowRef.current.screenToFlowPosition({ x: event.clientX, y: event.clientY })
    setNodes((current) => current.some((node) => node.id === id) ? current : [...current, makeNode(id, point.x - NODE_WIDTH / 2, point.y - NODE_HEIGHT / 2)])
  }, [makeNode])

  return (
    <div
      className={cn('relative overflow-hidden rounded-md border border-border bg-card', className)}
      aria-label={t('workflow.skills_title')}
      data-testid="skill-flow"
      data-editable={editable}
      data-nodes={nodes.length}
      data-edges={edges.length}
      onDragOver={editable ? (event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move' } : undefined}
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
 * 边 = depends_on（带箭头、脉冲虚线），列 = 波次并带「第 n 步 · 并行 k」标签——一波多技能就是起点扇出，
 * 多波就是链式箭头。只读时不可拖不可连；可编辑时接受技能库拖放（dataTransfer `text/skill`）、拉线建依赖
 * （拒绝成环）、Backspace 删边、× 删点，并在图与传入技能签名不同时回写技能数组。
 */
export function SkillFlow(props: SkillFlowProps): JSX.Element {
  return <ReactFlowProvider><SkillFlowInner {...props} /></ReactFlowProvider>
}
