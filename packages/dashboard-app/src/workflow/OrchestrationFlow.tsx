import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ControlButton, Controls, ReactFlow, ReactFlowProvider, useReactFlow, type Edge, type NodeChange } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Maximize2, Minimize2 } from 'lucide-react'
import type { OrchestrationFlow as OutputFlow, OrchestrationKind, OrchestrationReturn } from '@tenon/kernel/workflow/orchestration'
import type { FlowEntry, FlowStage } from '../api/workflowOrchestrationClient'
import { useT } from '../i18n'
import { prefersReducedMotion, usePulseTimeline } from './flowPulse'
import { layoutOrchestration, type FlowMode, type OrchestrationLayout } from './orchestrationLayout'
import { CANVAS_EDGE_TYPES, CANVAS_NODE_TYPES, CanvasContext, type CanvasNode, type LaneAction, type OrchestrationCanvasContext } from './orchestrationNodes'
import { CONTROLS_BAND, CONTROLS_CLASS, READ_ONLY_ZOOM, RESIZE_THROTTLE_MS, readOnlyViewport } from './SkillFlow'
import { EDGE_STYLE, MARKER, pulseModeOf, useFlowAriaLabels } from './skillFlowNodes'
import { cn } from '@/lib/utils'

/** 总览可缩放的范围；阶段画布恒为 1:1。 */
export const OVERVIEW_ZOOM = { min: 0.3, max: 1.5 } as const
const FIT_PADDING = 0.08

export interface OrchestrationFlowProps {
  stages: readonly FlowStage[]
  returns?: readonly OrchestrationReturn[]
  flows?: readonly OutputFlow[]
  mode: FlowMode
  /** 任务当前所在阶段（工作台高亮）。 */
  current?: string | null
  /** 节点带运行状态（工作台）。 */
  withStatus?: boolean
  /** 阶段画布里每条泳道旁的动作（可编辑时四条泳道都在）。 */
  laneActions?: Partial<Record<OrchestrationKind, LaneAction>>
  onOpenEntry?: (stage: string, entry: FlowEntry) => void
  /** 哪些条目点得开（缺省 = 全部）。 */
  openable?: (entry: FlowEntry) => boolean
  onOpenStage?: (stage: string) => void
  ariaLabel: string
  className?: string
}

function nodesOf(layout: OrchestrationLayout, startLabel: string, endLabel: string): CanvasNode[] {
  const fixed = { draggable: false, selectable: false, deletable: false, connectable: false, focusable: false }
  const sized = (width: number, height: number) => ({ width, height, measured: { width, height } })
  return [
    ...layout.stages.map((stage): CanvasNode => ({ id: stage.id, type: 'stage', position: { x: stage.x, y: stage.y }, data: { stage: stage.stage, index: stage.index, width: stage.width, height: stage.height }, zIndex: 0, ...fixed, ...sized(stage.width, stage.height) })),
    ...layout.lanes.map((lane): CanvasNode => ({ id: lane.id, type: 'lane', position: { x: lane.x, y: lane.y }, data: { kind: lane.kind, count: lane.count, width: lane.width, height: lane.height }, zIndex: 1, ...fixed, ...sized(lane.width, lane.height) })),
    { id: 'start', type: 'port', position: { x: layout.ports.start.x, y: layout.ports.start.y }, data: { label: startLabel }, zIndex: 1, ...fixed, ...sized(12, 12) },
    { id: 'end', type: 'port', position: { x: layout.ports.end.x, y: layout.ports.end.y }, data: { label: endLabel }, zIndex: 1, ...fixed, ...sized(12, 12) },
    ...layout.junctions.map((point): CanvasNode => ({ id: point.id, type: 'junction', position: { x: point.x, y: point.y }, data: {}, zIndex: 1, ...fixed, ...sized(2, 2) })),
    ...layout.entries.map((entry): CanvasNode => ({ id: entry.id, type: 'entry', position: { x: entry.x, y: entry.y }, data: { stage: entry.stage, entry: entry.entry, width: entry.width, height: entry.height }, zIndex: 1, ...fixed, ...sized(entry.width, entry.height) })),
  ]
}

function edgesOf(layout: OrchestrationLayout, returns: readonly OrchestrationReturn[], mode: FlowMode, labelOf: (stage: string) => string, backLabel: (from: string, to: string) => string): Edge[] {
  const fixed = { deletable: false, selectable: false, focusable: false }
  const flow = layout.edges.map((edge): Edge => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle,
    targetHandle: edge.targetHandle,
    type: 'pulse',
    data: { order: edge.order },
    style: edge.arrow ? EDGE_STYLE : { ...EDGE_STYLE, opacity: 0.7 },
    ...(edge.arrow ? { markerEnd: MARKER } : {}),
    ...fixed,
  }))
  if (mode !== 'overview') return flow
  const known = new Set(layout.stages.map((stage) => stage.stage.id))
  const arcs = returns
    .filter((item) => known.has(item.from) && known.has(item.to))
    .map((item): Edge => ({
      id: `return:${item.from}->${item.to}`,
      source: `s:${item.from}`,
      target: `s:${item.to}`,
      sourceHandle: 'arc-out',
      targetHandle: 'arc-in',
      type: 'return',
      data: { label: backLabel(labelOf(item.from), labelOf(item.to)) },
      markerEnd: MARKER,
      ...fixed,
    }))
  return [...flow, ...arcs]
}

function OrchestrationFlowInner(props: OrchestrationFlowProps): JSX.Element {
  const { stages, returns = [], flows = [], mode, current = null, withStatus = false, laneActions, onOpenEntry, openable, onOpenStage, ariaLabel, className } = props
  const { t } = useT()
  const ariaLabelConfig = useFlowAriaLabels()
  const flow = useReactFlow()
  const flowRef = useRef(flow)
  flowRef.current = flow
  const containerRef = useRef<HTMLDivElement>(null)
  const showEmpty = laneActions !== undefined
  const layout = useMemo(
    () => layoutOrchestration(stages, mode, { withStatus, showEmpty }),
    [stages, mode, withStatus, showEmpty],
  )
  const labelOf = useCallback((id: string): string => stages.find((stage) => stage.id === id)?.label ?? id, [stages])
  const baseNodes = useMemo(() => nodesOf(layout, t('workflow.flow_start'), t('workflow.flow_end')), [layout, t])
  // 虚拟节点不在任何 state 里：React Flow 量到的尺寸回填进来，否则它认为节点未测量、连到它的边不画。
  const [measured, setMeasured] = useState<Record<string, { width: number; height: number }>>({})
  const nodes = useMemo(() => baseNodes.map((node) => {
    const size = measured[node.id]
    return size === undefined ? node : { ...node, measured: size }
  }), [baseNodes, measured])
  const edges = useMemo(
    () => edgesOf(layout, returns, mode, labelOf, (from, to) => t('workflow.back_arc', { from, to })),
    [layout, returns, mode, labelOf, t],
  )
  const onNodesChange = useCallback((changes: NodeChange<CanvasNode>[]) => {
    for (const change of changes) {
      if (change.type !== 'dimensions' || change.dimensions === undefined) continue
      const { id, dimensions } = change
      setMeasured((now) => now[id]?.width === dimensions.width && now[id]?.height === dimensions.height ? now : { ...now, [id]: { width: dimensions.width, height: dimensions.height } })
    }
  }, [])

  // 取景：总览适应容器（可缩放、可平移）；阶段画布 1:1、按内容居中。挂载后第一次瞬时，之后 200ms。
  const [expanded, setExpanded] = useState(false)
  const framed = useRef(false)
  const refit = useCallback(() => {
    const duration = prefersReducedMotion() || !framed.current ? 0 : 200
    framed.current = true
    const element = containerRef.current
    if (element === null) return
    if (mode === 'overview') {
      void flowRef.current.fitView({ padding: FIT_PADDING, minZoom: OVERVIEW_ZOOM.min, maxZoom: 1, duration })
      return
    }
    const size = { width: element.clientWidth, height: Math.max(0, element.clientHeight - CONTROLS_BAND) }
    void flowRef.current.setViewport(readOnlyViewport({ x: 0, y: 0, width: layout.width, height: layout.height }, size), { duration })
  }, [mode, layout])
  const refitRef = useRef(refit)
  refitRef.current = refit
  useEffect(() => {
    const timer = setTimeout(() => refitRef.current(), 60)
    return () => clearTimeout(timer)
  }, [layout, expanded])
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
  useEffect(() => {
    if (!expanded) return
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') setExpanded(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [expanded])

  // 脉冲：画布在视口里就从起点到终点持续循环（与运行与否无关），离开视口就停。
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
  const pulseMode = pulseModeOf({ visible, running: false, edits: 0 })
  const signature = useMemo(() => layout.edges.map((edge) => edge.id).join('|'), [layout])
  usePulseTimeline(containerRef, pulseMode, 0, `${signature}#${expanded ? 1 : 0}`)

  const [hovered, setHovered] = useState<string | null>(null)
  const context = useMemo((): OrchestrationCanvasContext => ({
    mode, current, hovered, setHovered, flows, labelOf,
    ...(onOpenEntry === undefined ? {} : { onOpenEntry }),
    ...(openable === undefined ? {} : { openable }),
    ...(onOpenStage === undefined ? {} : { onOpenStage }),
    ...(laneActions === undefined ? {} : { laneActions }),
  }), [mode, current, hovered, flows, labelOf, onOpenEntry, openable, onOpenStage, laneActions])

  const overview = mode === 'overview'
  return (
    <CanvasContext.Provider value={context}>
      <div
        ref={containerRef}
        role="group"
        className={cn('relative overflow-hidden rounded-md border border-border bg-card', expanded && 'fixed inset-0 z-50 rounded-none border-0', className)}
        style={overview ? undefined : { height: layout.height + CONTROLS_BAND }}
        aria-label={ariaLabel}
        data-testid={overview ? 'orchestration-overview' : 'orchestration-stage'}
        data-pulse={pulseMode}
        data-nodes={layout.entries.length}
        data-expanded={expanded || undefined}
      >
        <ReactFlow<CanvasNode>
          nodes={nodes}
          edges={edges}
          nodeTypes={CANVAS_NODE_TYPES}
          edgeTypes={CANVAS_EDGE_TYPES}
          onNodesChange={onNodesChange}
          nodesDraggable={false}
          nodesConnectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          elementsSelectable={false}
          panOnDrag
          zoomOnScroll={overview}
          zoomOnPinch={overview}
          zoomOnDoubleClick={false}
          preventScrolling={overview}
          minZoom={overview ? OVERVIEW_ZOOM.min : READ_ONLY_ZOOM.min}
          maxZoom={overview ? OVERVIEW_ZOOM.max : READ_ONLY_ZOOM.max}
          proOptions={{ hideAttribution: true }}
          ariaLabelConfig={ariaLabelConfig}
        >
          <Controls showInteractive={false} showZoom={overview} showFitView position="bottom-right" className={CONTROLS_CLASS}>
            {overview && (
              <ControlButton
                aria-label={t(expanded ? 'workflow.exit_fullscreen' : 'workflow.fullscreen')}
                title={t(expanded ? 'workflow.exit_fullscreen' : 'workflow.fullscreen')}
                data-testid="orchestration-fullscreen"
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
              </ControlButton>
            )}
          </Controls>
        </ReactFlow>
      </div>
    </CanvasContext.Provider>
  )
}

/**
 * 编排画布（React Flow）：总览 = 每阶段一列（单线框分组，列头带序号、名称与门禁图标，回流为列头之间的虚线弧，
 * 悬停列头看输出流向），列内按 runner 真实顺序 执行者 → 技能 → 测试 → 评审者；阶段 = 同一组件的单列形态，
 * 左侧泳道标签（可带动作）。GSAP 脉冲从起点到终点依次传递、持续循环。总览可缩放、适应视图、全屏。
 */
export function OrchestrationFlow(props: OrchestrationFlowProps): JSX.Element {
  return <ReactFlowProvider><OrchestrationFlowInner {...props} /></ReactFlowProvider>
}
