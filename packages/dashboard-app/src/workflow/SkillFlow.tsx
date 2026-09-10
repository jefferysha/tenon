import { memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
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
const COLUMN_GAP = 272
const ROW_GAP = 88
const PADDING = 24

type SkillNodeData = {
  label: string
  description: string | null
  source: WbSkillEntry['source'] | null
  editable: boolean
  onOpen: (id: string) => void
  onRemove: (id: string) => void
}
type SkillNode = Node<SkillNodeData, 'skill'>

/** 技能 → 节点坐标：列 = 波次（depends_on 深度），行 = 波次内序。 */
export function layoutSkills(skills: readonly WbSkillRef[]): Array<{ id: string; x: number; y: number }> {
  const out: Array<{ id: string; x: number; y: number }> = []
  wavesOf(skills).forEach((wave, column) => {
    wave.forEach((id, row) => out.push({ id, x: PADDING + column * COLUMN_GAP, y: PADDING + row * ROW_GAP }))
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

/** 节点 + 边 → 技能引用：depends_on = 指向它的边的起点；其它字段从 existing 带回；顺序按波次拍平。 */
export function graphToSkills(nodeIds: readonly string[], edges: readonly Pick<Edge, 'source' | 'target'>[], existing: readonly WbSkillRef[]): WbSkillRef[] {
  const byId = new Map(existing.map((skill) => [skill.id, skill]))
  const ids = new Set(nodeIds)
  // 同一波内保持定义里的原顺序，新加入的排在后面；波次顺序由 depends_on 决定。
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

const SkillNodeView = memo(function SkillNodeView({ id, data, selected }: NodeProps<SkillNode>): JSX.Element {
  const { t } = useT()
  return (
    <div
      className={cn('relative rounded-sm border bg-card px-3 py-2 shadow-xs transition-[border-color,box-shadow]', selected ? 'border-(--accent) shadow-sm' : 'border-border-2')}
      style={{ width: NODE_WIDTH }}
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

const NODE_TYPES = { skill: SkillNodeView }

export interface SkillFlowProps {
  skills: readonly WbSkillRef[]
  registry: readonly WbSkillEntry[] | null
  editable: boolean
  /** 可编辑时每次增删节点 / 连线后回调完整技能数组。 */
  onChange?: (skills: WbSkillRef[]) => void
  onOpen: (id: string) => void
  className?: string
}

function SkillFlowInner({ skills, registry, editable, onChange, onOpen, className }: SkillFlowProps): JSX.Element {
  const { t } = useT()
  const flow = useReactFlow()
  const flowRef = useRef(flow)
  flowRef.current = flow
  const [nodes, setNodes] = useState<SkillNode[]>([])
  const [edges, setEdges] = useState<Edge[]>([])
  const entryOf = useCallback((id: string) => registry?.find((entry) => entry.name === id), [registry])

  const removeNode = useCallback((id: string) => {
    setNodes((current) => current.filter((node) => node.id !== id))
    setEdges((current) => current.filter((edge) => edge.source !== id && edge.target !== id))
  }, [])

  const makeNode = useCallback((id: string, x: number, y: number): SkillNode => {
    const entry = entryOf(id)
    return {
      id,
      type: 'skill',
      position: { x, y },
      data: { label: id, description: entry?.description ?? null, source: entry?.source ?? null, editable, onOpen, onRemove: removeNode },
      draggable: editable,
      selectable: editable,
    }
  }, [entryOf, editable, onOpen, removeNode])

  // skills 变化（切换阶段 / 打开编辑器）→ 按波次重新布局。
  useEffect(() => {
    setNodes(layoutSkills(skills).map(({ id, x, y }) => makeNode(id, x, y)))
    setEdges(edgesOf(skills))
    const frame = requestAnimationFrame(() => { void flowRef.current.fitView({ padding: 0.2, maxZoom: 1 }) })
    return () => cancelAnimationFrame(frame)
  }, [skills, makeNode])

  // 可编辑：图变了就回写技能数组。
  const nodeIds = useMemo(() => nodes.map((node) => node.id).join('|'), [nodes])
  const edgeIds = useMemo(() => edges.map((edge) => edge.id).join('|'), [edges])
  useEffect(() => {
    if (!editable || onChange === undefined) return
    const next = graphToSkills(nodes.map((node) => node.id), edges, skills)
    const same = next.length === skills.length && next.every((skill, index) => skill.id === skills[index]?.id && (skill.depends_on ?? []).join(',') === (skills[index]?.depends_on ?? []).join(','))
    if (!same) onChange(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeIds, edgeIds])

  const onNodesChange = useCallback((changes: NodeChange<SkillNode>[]) => setNodes((current) => applyNodeChanges(changes, current)), [])
  const onEdgesChange = useCallback((changes: EdgeChange[]) => setEdges((current) => applyEdgeChanges(changes, current)), [])
  const onConnect = useCallback((connection: Connection) => {
    if (connection.source === null || connection.target === null) return
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
    const position = flowRef.current.screenToFlowPosition({ x: event.clientX, y: event.clientY })
    setNodes((current) => current.some((node) => node.id === id) ? current : [...current, makeNode(id, position.x - NODE_WIDTH / 2, position.y - 20)])
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
      <ReactFlow<SkillNode>
        nodes={nodes}
        edges={edges}
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
        defaultEdgeOptions={{ type: 'default', style: { stroke: 'var(--border-2)', strokeWidth: 1.5 } }}
        deleteKeyCode={editable ? ['Backspace', 'Delete'] : null}
      >
        <Background variant={BackgroundVariant.Dots} gap={14} size={1} color="var(--border-2)" />
        <Controls showInteractive={false} position="bottom-right" />
      </ReactFlow>
    </div>
  )
}

/**
 * 技能流程画布（React Flow）：节点 = 技能（来源图标 + 名称 + description），边 = depends_on，
 * 列 = 波次。只读时不可拖不可连；可编辑时接受技能库的拖放（dataTransfer `text/skill`）、拉线建依赖
 * （拒绝成环）、Backspace 删边、× 删点，并把图回写为技能数组。
 */
export function SkillFlow(props: SkillFlowProps): JSX.Element {
  return <ReactFlowProvider><SkillFlowInner {...props} /></ReactFlowProvider>
}
