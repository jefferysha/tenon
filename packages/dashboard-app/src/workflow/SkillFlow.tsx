import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { WbSkillEntry, WbSkillRef } from '../api/governanceTypes'
import { useT } from '../i18n'
import { wavesOf } from '../workbench/skillWaves'
import { EDGE_STYLE, EDGE_TYPES, MARKER, NODE_HEIGHT, NODE_TYPES, NODE_WIDTH, PORT_SIZE, isVirtualId, type FlowNode, type GhostNode, type JunctionNode, type LabelNode, type PortNode, type PulseData, type SkillNode, type SkillRunState } from './skillFlowNodes'
import { addSkillAt, appendSerial, dropTargetFor, edgesOf, graphToSkills, isColumnLink, layoutSkills, skillsSignature, wouldCycle, type DropTarget } from './skillFlowGraph'
import { cn } from '@/lib/utils'

export { addSkillAt, appendSerial, dropTargetFor, edgesOf, graphToSkills, isColumnLink, layoutSkills, skillsSignature, wouldCycle }
export { NODE_WIDTH, SkillRunState }

const COLUMN_GAP = 300
const ROW_GAP = 92
const PORT_GAP = 72

export interface SkillFlowProps {
  skills: readonly WbSkillRef[]
  registry: readonly WbSkillEntry[] | null
  editable: boolean
  /** 可编辑时，图与传入技能的签名不同才回调完整技能数组。 */
  onChange?: (skills: WbSkillRef[]) => void
  onOpen: (id: string) => void
  /** 正在从技能库拖过来的技能名（dragover 阶段读不到 dataTransfer 数据，由父级告知），用于幽灵节点。 */
  dragLabel?: string | null
  /** 工作台：每个技能的运行状态与文字；不给则节点不显示状态。 */
  statusOf?: (id: string) => { state: SkillRunState; label: string } | null
  /** 节点名下的一行小字（agent 段落用）；不给则不渲染。 */
  captionOf?: (id: string) => string | null
  /** 画布的可访问名称；缺省 = 技能。agent 画布传 执行者 / 评审者。 */
  label?: string
  /** 可编辑画布为空时的提示；缺省 = 拖入技能。 */
  emptyText?: string
  className?: string
}

function SkillFlowInner({ skills, registry, editable, onChange, onOpen, dragLabel = null, statusOf, captionOf, label, emptyText, className }: SkillFlowProps): JSX.Element {
  const { t } = useT()
  // React Flow 控件自带英文 aria-label（Zoom In …），跟随界面语言改写。
  const ariaLabelConfig = useMemo(() => ({
    'controls.ariaLabel': t('workflow.flow_controls'),
    'controls.zoomIn.ariaLabel': t('workflow.zoom_in'),
    'controls.zoomOut.ariaLabel': t('workflow.zoom_out'),
    'controls.fitView.ariaLabel': t('workflow.fit_view'),
  }), [t])
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
  const statusRef = useRef(statusOf)
  statusRef.current = statusOf
  const captionRef = useRef(captionOf)
  captionRef.current = captionOf
  const [nodes, setNodes] = useState<SkillNode[]>([])
  const [edges, setEdges] = useState<Edge[]>([])
  const [ghost, setGhost] = useState<{ x: number; y: number; label: string; target: DropTarget } | null>(null)
  // 起点 / 终点 / 标签 / 汇合点不在 nodes state 里，React Flow 量到的尺寸要单独记下并回填，否则它会认为这些节点
  // 未测量：连到它们的边不渲染，且每帧重复上报尺寸。
  const [virtualMeasured, setVirtualMeasured] = useState<Record<string, { width: number; height: number }>>({})
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
      data: { label: id, description: entry?.description ?? null, caption: captionRef.current?.(id) ?? null, source: entry?.source ?? null, editable, entering: enteringRef.current === id, status: statusRef.current?.(id)?.state ?? null, statusLabel: statusRef.current?.(id)?.label ?? null, onOpen: (target) => onOpenRef.current(target), onRemove: removeNode },
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
    const centerY = (ids: readonly string[]): number => {
      const firstId = ids[0]
      const lastId = ids[ids.length - 1]
      return firstId === undefined || lastId === undefined ? 0 : (middleOf(firstId) + middleOf(lastId)) / 2
    }
    const first = waves[0] ?? []
    const last = waves[waves.length - 1] ?? []
    const portEdge = { deletable: false, selectable: false, style: { ...EDGE_STYLE, opacity: 0.7 } }
    /** 段序：起点→首波 0，第 k 波→汇合 2k+1，汇合→第 k+1 波 2k+2，末波→终点 2N-1（N = 波数）。 */
    const depth = new Map<string, number>()
    waves.forEach((wave, index) => wave.forEach((id) => depth.set(id, index)))
    const total = 2 * waves.length
    const pulse = (order: number): { data: PulseData } => ({ data: { order, total } })
    const sized = (id: string, width: number, height: number) => ({ width, height, measured: virtualMeasured[id] ?? { width, height } })
    const ports: PortNode[] = [
      { id: 'start', type: 'port', position: { x: minX - PORT_GAP, y: centerY(first) - PORT_SIZE / 2 }, data: { label: t('workflow.flow_start') }, draggable: false, selectable: false, deletable: false, connectable: false, ...sized('start', PORT_SIZE, PORT_SIZE) },
      { id: 'end', type: 'port', position: { x: maxX + NODE_WIDTH + PORT_GAP - PORT_SIZE, y: centerY(last) - PORT_SIZE / 2 }, data: { label: t('workflow.flow_end') }, draggable: false, selectable: false, deletable: false, connectable: false, ...sized('end', PORT_SIZE, PORT_SIZE) },
    ]
    const labels: LabelNode[] = waves.map((wave, index) => {
      const x = Math.min(...wave.map((id) => byId.get(id)?.position.x ?? 0))
      const y = Math.min(...wave.map((id) => byId.get(id)?.position.y ?? 0)) - 22
      const text = wave.length > 1 ? `${t('workflow.step_n', { n: index + 1 })} · ${t('workflow.parallel_n', { n: wave.length })}` : t('workflow.step_n', { n: index + 1 })
      return { id: `label-${index}`, type: 'label', position: { x, y }, data: { label: text }, draggable: false, selectable: false, deletable: false, connectable: false, ...sized(`label-${index}`, 120, 17) }
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
      junctions.push({ id: junctionId, type: 'junction', position: { x: (rightEdge + leftEdge) / 2 - 1, y: (centerY(wave) + centerY(next)) / 2 - 1 }, data: {}, draggable: false, selectable: false, deletable: false, connectable: false, ...sized(junctionId, 2, 2) })
      for (const id of wave) { junctionEdges.push({ id: `${id}->${junctionId}`, source: id, target: junctionId, ...portEdge, markerEnd: undefined, ...pulse(2 * index + 1) }) }
      for (const id of next) { junctionEdges.push({ id: `${junctionId}->${id}`, source: junctionId, target: id, deletable: false, selectable: false, ...pulse(2 * index + 2) }) }
      for (const edge of edges) if (wave.includes(edge.source) && next.includes(edge.target)) replaced.add(edge.id)
    })
    const hasDependent = new Set(edges.map((edge) => edge.source))
    const virtual: Edge[] = [
      ...first.map((id) => ({ id: `start->${id}`, source: 'start', target: id, ...portEdge, ...pulse(0) })),
      ...nodes.filter((node) => !hasDependent.has(node.id)).map((node) => ({ id: `${node.id}->end`, source: node.id, target: 'end', ...portEdge, markerEnd: undefined, ...pulse(2 * waves.length - 1) })),
    ]
    const direct = edges.filter((edge) => !replaced.has(edge.id)).map((edge) => ({ ...edge, ...pulse(2 * (depth.get(edge.source) ?? 0) + 1) }))
    const ghostNodes: GhostNode[] = ghost === null ? [] : [{ id: 'ghost', type: 'ghost', position: { x: ghost.x, y: ghost.y }, data: { label: ghost.label, mode: ghost.target.kind === 'join' ? t('workflow.parallel_n', { n: (waves[ghost.target.wave]?.length ?? 0) + 1 }) : t('workflow.serial') }, draggable: false, selectable: false, deletable: false, connectable: false, ...sized('ghost', NODE_WIDTH, NODE_HEIGHT) }]
    const ghostEdges: Edge[] = ghost === null ? [] : (
      ghost.target.kind === 'after' ? last.map((id) => ({ id: `${id}->ghost`, source: id, target: 'ghost' }))
        : ghost.target.kind === 'before' ? first.map((id) => ({ id: `ghost->${id}`, source: 'ghost', target: id }))
          : (waves[ghost.target.wave - 1] ?? []).map((id) => ({ id: `${id}->ghost`, source: id, target: 'ghost' }))
    ).map((edge) => ({ ...edge, deletable: false, selectable: false, style: { stroke: 'var(--accent-b)', strokeWidth: 1.5, strokeDasharray: '4 4' } }))
    // defaultEdgeOptions 只作用于 onConnect 新建的边；props 传入的边要显式指定类型。
    const typed = (list: Edge[]): Edge[] => list.map((edge) => ({ ...edge, type: 'pulse', style: edge.style ?? EDGE_STYLE, markerEnd: 'markerEnd' in edge ? edge.markerEnd : MARKER }))
    return {
      nodes: [...labels, ...ports, ...junctions, ...nodes, ...ghostNodes],
      edges: [...typed(direct), ...typed(junctionEdges), ...typed(virtual), ...typed(ghostEdges)],
    }
  }, [nodes, edges, graph, ghost, virtualMeasured, t])

  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => {
    const own: NodeChange<SkillNode>[] = []
    for (const change of changes) {
      const id = 'id' in change ? String(change.id) : null
      if (id !== null && isVirtualId(id)) {
        if (change.type === 'dimensions' && change.dimensions !== undefined) {
          const dims = change.dimensions
          setVirtualMeasured((current) => current[id]?.width === dims.width && current[id]?.height === dims.height ? current : { ...current, [id]: { width: dims.width, height: dims.height } })
        }
        continue
      }
      own.push(change as NodeChange<SkillNode>)
    }
    if (own.length > 0) setNodes((current) => applyNodeChanges(own, current))
  }, [])
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
      aria-label={label ?? t('workflow.skills_title')}
      data-testid="skill-flow"
      data-editable={editable}
      data-nodes={nodes.length}
      data-edges={edges.length}
      onDragOver={editable ? onDragOver : undefined}
      onDragLeave={editable ? (event) => { if (!event.currentTarget.contains(event.relatedTarget as globalThis.Node | null)) setGhost(null) } : undefined}
      onDrop={editable ? onDrop : undefined}
    >
      {nodes.length === 0 && <p className="pointer-events-none absolute inset-0 z-10 grid place-items-center text-body text-text-3" role="status" data-testid="skill-flow-empty">{editable ? (emptyText ?? t('workflow.drop_skill')) : t('workflow.no_skills')}</p>}
      <ReactFlow<FlowNode>
        nodes={decorated.nodes}
        edges={decorated.edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
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
        defaultEdgeOptions={{ type: 'pulse', style: EDGE_STYLE, markerEnd: MARKER }}
        deleteKeyCode={editable ? ['Backspace', 'Delete'] : null}
        ariaLabelConfig={ariaLabelConfig}
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
