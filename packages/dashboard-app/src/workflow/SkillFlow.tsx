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
import { EDGE_STYLE, EDGE_TYPES, MARKER, NODE_HEIGHT, NODE_TYPES, NODE_WIDTH, PORT_SIZE, isVirtualId, pulseModeOf, useFlowAriaLabels, type FlowNode, type GhostNode, type JunctionNode, type LabelNode, type PortNode, type PulseData, type SkillNode, type SkillRunState } from './skillFlowNodes'
import { addSkillAt, appendSerial, canvasHeight, CONTROLS_BAND, dropTargetFor, edgesOf, graphToSkills, isColumnLink, editViewport, lanesOf, layoutSkills, nodeHeightFor, readOnlyViewport, rowGapFor, skillsSignature, wouldCycle, type DropTarget } from './skillFlowGraph'
import { prefersReducedMotion, usePulseTimeline, type PulseMode } from './flowPulse'
import { cn } from '@/lib/utils'

export { addSkillAt, appendSerial, canvasHeight, CONTROLS_BAND, dropTargetFor, edgesOf, editViewport, graphToSkills, isColumnLink, lanesOf, layoutSkills, readOnlyViewport, skillsSignature, wouldCycle }
export { NODE_WIDTH, SkillRunState }

const COLUMN_GAP = 300
const PORT_GAP = 72
/** 容器尺寸变化后重新取景的节流窗口。 */
export const RESIZE_THROTTLE_MS = 120
/** 尺寸变化与编辑后重新取景的补间时长（ms）；挂载后的第一次取景为 0。 */
export const REFIT_MS = 200
/** 只读画布恒为 1:1；可编辑画布（编辑器里）允许缩放，但取景不缩到字看不清。 */
export const READ_ONLY_ZOOM = { min: 1, max: 1 } as const
export const EDIT_ZOOM = { min: 0.75, max: 1.5 } as const
/** Controls 的暗色 / 点击区外观：底色与描边走 token，按钮 40px。 */
export const CONTROLS_CLASS = '!overflow-hidden !rounded-sm !border !border-border !bg-card !shadow-none [&>button]:!size-10 [&>button]:!border-border [&>button]:!bg-card [&>button]:!text-text-2 [&>button:hover]:!bg-fill [&>button:hover]:!text-text [&>button>svg]:!fill-current'

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
  ariaLabel?: string
  /** 可编辑画布为空时的提示；缺省 = 拖入技能。 */
  emptyText?: string
  /** 由 OpenSpec 文档契约注入、未在阶段声明的技能 id（节点换契约图标）。 */
  injected?: readonly string[]
  className?: string
}

function SkillFlowInner({ skills, registry, editable, onChange, onOpen, dragLabel = null, statusOf, captionOf, ariaLabel, emptyText, injected, className }: SkillFlowProps): JSX.Element {
  const { t } = useT()
  const ariaLabelConfig = useFlowAriaLabels()
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
  const injectedRef = useRef(injected)
  injectedRef.current = injected
  const [nodes, setNodes] = useState<SkillNode[]>([])
  const [edges, setEdges] = useState<Edge[]>([])
  const [ghost, setGhost] = useState<{ x: number; y: number; label: string; target: DropTarget } | null>(null)
  // 起点 / 终点 / 标签 / 汇合点不在 nodes state 里，React Flow 量到的尺寸要单独记下并回填，否则它会认为这些节点
  // 未测量：连到它们的边不渲染，且每帧重复上报尺寸。
  const [virtualMeasured, setVirtualMeasured] = useState<Record<string, { width: number; height: number }>>({})
  const enteringRef = useRef<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const signature = skillsSignature(skills)
  // 节点只放名称 + 可选的设置行 / 状态行：行数定节点高，节点高定行距与只读画布的高度。
  const lines = 1 + (captionOf === undefined ? 0 : 1) + (statusOf === undefined ? 0 : 1)
  const linesRef = useRef(lines)
  linesRef.current = lines

  /**
   * 取景：只读 = 1:1 + 按内容定位；可编辑 = 缩放到 [0.75, 1]，仍放不下时靠左可平移。挂载后的第一次取景（切换阶段、
   * 打开编辑器）瞬时完成，不从默认视口「扫」过来；之后的尺寸变化与编辑才用 200ms。减少动态效果时一律瞬时。
   */
  const framedRef = useRef(false)
  const refit = useCallback(() => {
    const duration = prefersReducedMotion() || !framedRef.current ? 0 : REFIT_MS
    framedRef.current = true
    const instance = flowRef.current
    const element = containerRef.current
    if (element === null) return
    const bounds = instance.getNodesBounds(instance.getNodes())
    const size = { width: element.clientWidth, height: editable ? element.clientHeight : Math.max(0, element.clientHeight - CONTROLS_BAND) }
    void instance.setViewport(editable ? editViewport(bounds, size, { min: EDIT_ZOOM.min, max: 1 }) : readOnlyViewport(bounds, size), { duration })
  }, [editable])
  const refitRef = useRef(refit)
  refitRef.current = refit

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
      data: { label: id, description: entry?.description ?? null, height: nodeHeightFor(linesRef.current), caption: captionRef.current?.(id) ?? null, source: entry?.source ?? null, injected: injectedRef.current?.includes(id) === true, editable, entering: enteringRef.current === id, status: statusRef.current?.(id)?.state ?? null, statusLabel: statusRef.current?.(id)?.label ?? null, onOpen: (target) => onOpenRef.current(target), onRemove: removeNode },
      draggable: editable,
      selectable: editable,
    }
  }, [editable, removeNode])

  // nodes 是按哪一版技能（签名）布局出来的；见下方写回 effect。
  const [layoutFor, setLayoutFor] = useState<string | null>(null)
  // 技能内容变了（切换阶段 / 打开编辑器 / 外部改写）→ 按波次重新布局；引用变化不触发。
  useEffect(() => {
    setNodes(layoutSkills(skillsRef.current, linesRef.current).map(({ id, x, y }) => makeNode(id, x, y)))
    setEdges(edgesOf(skillsRef.current))
    setLayoutFor(signature)
    // 等 React Flow 量完节点尺寸再取景，否则按未测量的位置取景会把末列切掉。
    const timer = setTimeout(() => refitRef.current(), 60)
    return () => clearTimeout(timer)
  }, [signature, makeNode])

  // 容器尺寸变了（窗口缩放、侧栏开合）→ 节流后重新取景。首次回调是 observe 本身触发的，交给上面的布局取景。
  useEffect(() => {
    const element = containerRef.current
    if (element === null || typeof ResizeObserver === 'undefined') return
    let initial = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const observer = new ResizeObserver(() => {
      if (initial) { initial = false; return }
      if (timer !== null) return
      timer = setTimeout(() => { timer = null; refitRef.current() }, RESIZE_THROTTLE_MS)
    })
    observer.observe(element)
    return () => { observer.disconnect(); if (timer !== null) clearTimeout(timer) }
  }, [])

  // 脉冲只在该动的时候动：有技能在运行就循环；技能被编辑过（签名变了）就走一遍；画布不在视口里就停。
  const [visible, setVisible] = useState(true)
  useEffect(() => {
    const element = containerRef.current
    if (element === null || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1]
      if (entry !== undefined) setVisible(entry.isIntersecting)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const [edits, setEdits] = useState(0)
  const mountedSignature = useRef(signature)
  useEffect(() => {
    if (signature !== mountedSignature.current) setEdits((count) => count + 1)
  }, [signature])
  const running = statusOf !== undefined && skills.some((skill) => statusOf(skill.id)?.state === 'running')
  const pulseMode: PulseMode = pulseModeOf({ visible, running, edits })

  // 可编辑：图的签名与传入技能不同才回写。nodes 还不是当前技能的布局（挂载那一拍、父级刚换技能）时不回写，
  // 否则空图会回写 []，持有状态的父组件清空技能、再布局、再回写，无限循环。
  const graph = useMemo(() => graphToSkills(nodes.map((node) => node.id), edges, skillsRef.current), [nodes, edges])
  const graphSignature = skillsSignature(graph)
  useEffect(() => {
    if (!editable || layoutFor !== signature) return
    if (nodes.length === 0 && skillsRef.current.length === 0) return
    if (graphSignature !== signature) onChangeRef.current?.(graph)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphSignature, layoutFor])

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
    const pulse = (order: number): { data: PulseData } => ({ data: { order } })
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
  usePulseTimeline(containerRef, pulseMode, edits, `${signature}#${decorated.edges.length}`)

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
    setNodes(layoutSkills(next, linesRef.current).map(({ id, x, y }) => makeNode(id, x, y)))
    setEdges(edgesOf(next))
    setTimeout(() => refitRef.current(), 60)
  }, [makeNode])

  const ghostFor = useCallback((label: string, point: { x: number; y: number }) => {
    const target = dropTargetFor(point.x, columnXs)
    const waves = wavesOf(graph)
    const position = new Map(nodes.map((node) => [node.id, node.position]))
    const centerY = (ids: readonly string[]): number => ids.length === 0 ? point.y - NODE_HEIGHT / 2 : ids.reduce((sum, id) => sum + (position.get(id)?.y ?? 0), 0) / ids.length
    const rowGap = rowGapFor(linesRef.current)
    if (target.kind === 'after') {
      const lastX = columnXs[columnXs.length - 1]
      return { x: lastX === undefined ? point.x - NODE_WIDTH / 2 : lastX + COLUMN_GAP, y: centerY(waves[waves.length - 1] ?? []), label, target }
    }
    if (target.kind === 'before') return { x: (columnXs[0] ?? point.x) - COLUMN_GAP, y: centerY(waves[0] ?? []), label, target }
    const wave = waves[target.wave] ?? []
    const bottom = Math.max(...wave.map((id) => position.get(id)?.y ?? 0))
    return { x: columnXs[target.wave] ?? point.x, y: bottom + rowGap, label, target }
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
      ref={containerRef}
      role="group"
      className={cn('relative overflow-hidden rounded-md border border-border bg-card', className)}
      style={editable ? undefined : { height: canvasHeight(lanesOf(skills), lines) + CONTROLS_BAND }}
      aria-label={ariaLabel ?? t('workflow.skills_title')}
      data-testid="skill-flow"
      data-editable={editable}
      data-nodes={nodes.length}
      data-edges={edges.length}
      data-pulse={pulseMode}
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
        panOnDrag
        zoomOnScroll={editable}
        zoomOnPinch={editable}
        zoomOnDoubleClick={false}
        preventScrolling={editable}
        fitView={editable}
        minZoom={editable ? EDIT_ZOOM.min : READ_ONLY_ZOOM.min}
        maxZoom={editable ? EDIT_ZOOM.max : READ_ONLY_ZOOM.max}
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{ type: 'pulse', style: EDGE_STYLE, markerEnd: MARKER }}
        deleteKeyCode={editable ? ['Backspace', 'Delete'] : null}
        ariaLabelConfig={ariaLabelConfig}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="var(--border)" />
        <Controls showInteractive={false} showZoom={editable} position="bottom-right" className={CONTROLS_CLASS} />
      </ReactFlow>
    </div>
  )
}

/**
 * 技能流程画布（React Flow）：起点 → 第一波技能 → … → 终点。节点 = 技能（来源图标 + 名称 + description），
 * 边 = depends_on（带箭头；运行中 / 刚编辑后由一条 GSAP timeline 把高亮段从起点依次传到终点），列 = 波次并带「第 n 步 · 并行 k」标签，各列围绕中线居中；相邻两波构成
 * 完整列依赖时先汇合到中线一点再连下一步，一波多技能就是起点扇出。只读时不可拖不可连；可编辑时接受技能库拖放（dataTransfer `text/skill`）、拉线建依赖
 * （拒绝成环）、Backspace 删边、× 删点，并在图与传入技能签名不同时回写技能数组。
 */
export function SkillFlow(props: SkillFlowProps): JSX.Element {
  return <ReactFlowProvider><SkillFlowInner {...props} /></ReactFlowProvider>
}
