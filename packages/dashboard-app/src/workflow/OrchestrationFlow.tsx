import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ControlButton, Controls, ReactFlow, ReactFlowProvider, useReactFlow, useStore, type Edge, type NodeChange } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import gsap from 'gsap'
import { Maximize2, Minimize2 } from 'lucide-react'
import type { OrchestrationFlow as OutputFlow, OrchestrationKind, OrchestrationReturn } from '@tenon/kernel/workflow/orchestration'
import type { FlowEntry, FlowStage } from '../api/workflowOrchestrationClient'
import { useT } from '../i18n'
import { prefersReducedMotion, signalModeOf, useOnScreen, useReducedMotion, useSignal } from './flowSignal'
import { KIND_ORDER, layoutOrchestration, returnHeadroom, type FlowMode, type LaidEdge, type OrchestrationLayout } from './orchestrationLayout'
import { FIT_PADDING, FOCUS_MS, OVERVIEW_ZOOM, STAGE_PAD, overviewMinZoom, overviewViewport, stageFocusViewport, stageViewport, zoomLevelOf } from './orchestrationViewport'
import { CANVAS_EDGE_TYPES, CANVAS_NODE_TYPES, CanvasContext, type CanvasNode, type LaneAction, type OrchestrationCanvasContext } from './orchestrationNodes'
import { edgeStates, holdTarget } from './orchestrationSignal'
import { CONTROLS_BAND, CONTROLS_CLASS, READ_ONLY_ZOOM, RESIZE_THROTTLE_MS } from './SkillFlow'
import { MARKER, markerFor, useFlowAriaLabels, type EdgeState } from './skillFlowNodes'
import { cn } from '@/lib/utils'

export { OVERVIEW_ZOOM } from './orchestrationViewport'
/** 「适应」按钮：把全部装进容器（最小缩放放开，不受交互下限约束），不放大过 1。 */
const FIT_OPTIONS = { padding: FIT_PADDING, minZoom: 0.05, maxZoom: 1 } as const
/** 点列头放大：--ease-in-out 对位 GSAP power2.inOut。 */
const FOCUS_EASE = gsap.parseEase('power2.inOut')

export interface OrchestrationFlowProps {
  stages: readonly FlowStage[]
  returns?: readonly OrchestrationReturn[]
  flows?: readonly OutputFlow[]
  mode: FlowMode
  /** 任务当前所在阶段（工作台高亮）。 */
  current?: string | null
  /** 节点带运行状态（工作台）。 */
  withStatus?: boolean
  /** 评审门未放行的阶段（工作台）：信号停在门前，线尽头一个琥珀短横。 */
  holding?: string | null
  /** 阶段画布里每条泳道旁的动作（可编辑时有动作的泳道即使是空的也留一个「＋」）。 */
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
    // 列带有实色底，必须在所有连线之下（z = -1），否则带内的线被它盖住。
    ...layout.stages.map((stage): CanvasNode => ({ id: stage.id, type: 'stage', position: { x: stage.x, y: stage.y }, data: { stage: stage.stage, index: stage.index, width: stage.width, height: stage.height }, zIndex: -1, ...fixed, ...sized(stage.width, stage.height) })),
    ...layout.lanes.map((lane): CanvasNode => ({ id: lane.id, type: 'lane', position: { x: lane.x, y: lane.y }, data: { kind: lane.kind, count: lane.count, width: lane.width, height: lane.height }, zIndex: 1, ...fixed, ...sized(lane.width, lane.height) })),
    ...layout.ghosts.map((ghost): CanvasNode => ({ id: ghost.id, type: 'ghost', position: { x: ghost.x, y: ghost.y }, data: { kind: ghost.kind, width: ghost.width, height: ghost.height }, zIndex: 1, ...fixed, ...sized(ghost.width, ghost.height) })),
    { id: 'start', type: 'port', position: { x: layout.ports.start.x, y: layout.ports.start.y }, data: { label: startLabel }, zIndex: 1, ...fixed, ...sized(12, 12) },
    { id: 'end', type: 'port', position: { x: layout.ports.end.x, y: layout.ports.end.y }, data: { label: endLabel }, zIndex: 1, ...fixed, ...sized(12, 12) },
    ...layout.junctions.map((point): CanvasNode => ({ id: point.id, type: point.spine === true ? 'spine' : 'junction', position: { x: point.x, y: point.y }, data: {}, zIndex: 1, ...fixed, ...sized(2, 2) })),
    // 括号条在连线之下（z = 0）：脊柱上的彗星从它上面走，不被盖住。
    ...layout.brackets.map((bracket): CanvasNode => ({ id: bracket.id, type: 'bracket', position: { x: bracket.x, y: bracket.y }, data: { height: bracket.height }, zIndex: 0, ...fixed, ...sized(bracket.width, bracket.height) })),
    ...layout.entries.map((entry): CanvasNode => ({ id: entry.id, type: 'entry', position: { x: entry.x, y: entry.y }, data: { stage: entry.stage, entry: entry.entry, width: entry.width, height: entry.height }, zIndex: 1, ...fixed, ...sized(entry.width, entry.height) })),
  ]
}

interface EdgeContext {
  readonly states: ReadonlyMap<string, EdgeState>
  /** 彗星层要不要渲染（画布在流动、或停着一颗彗星）。 */
  readonly signal: boolean
  /** 评审门把线拦在哪个节点前：通向它的线尽头画琥珀短横。 */
  readonly hold: string | null
}

function edgesOf(layout: OrchestrationLayout, returns: readonly OrchestrationReturn[], mode: FlowMode, drawing: EdgeContext, labelOf: (stage: string) => string, backLabel: (from: string, to: string) => string): Edge[] {
  const fixed = { deletable: false, selectable: false, focusable: false }
  const flow = layout.edges.map((edge: LaidEdge): Edge => {
    const state = drawing.states.get(edge.id) ?? 'todo'
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle,
      targetHandle: edge.targetHandle,
      type: 'signal',
      data: { state, signal: drawing.signal, ...(edge.lead === undefined ? {} : { lead: edge.lead }), ...(edge.after === undefined ? {} : { after: edge.after }), ...(edge.stub === true ? { stub: true } : {}), ...(drawing.hold === edge.target ? { hold: true } : {}) },
      ...(edge.arrow ? { markerEnd: markerFor(state) } : {}),
      ...fixed,
    }
  })
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
  const { stages, returns = [], flows = [], mode, current = null, withStatus = false, holding = null, laneActions, onOpenEntry, openable, onOpenStage, ariaLabel, className } = props
  const { t } = useT()
  const ariaLabelConfig = useFlowAriaLabels()
  const flow = useReactFlow()
  const flowRef = useRef(flow)
  flowRef.current = flow
  const containerRef = useRef<HTMLDivElement>(null)
  const overview = mode === 'overview'
  // 有动作的泳道，空着也留一个「＋」占位；没有动作的空泳道不画。
  const emptyKinds = useMemo(() => (laneActions === undefined ? [] : KIND_ORDER.filter((kind) => laneActions[kind] !== undefined)), [laneActions])
  const layout = useMemo(
    () => layoutOrchestration(stages, mode, { showEmpty: emptyKinds }),
    [stages, mode, emptyKinds],
  )
  const labelOf = useCallback((id: string): string => stages.find((stage) => stage.id === id)?.label ?? id, [stages])
  const baseNodes = useMemo(() => nodesOf(layout, t('workflow.flow_start'), t('workflow.flow_end')), [layout, t])
  // 虚拟节点不在任何 state 里：React Flow 量到的尺寸回填进来，否则它认为节点未测量、连到它的边不画。
  const [measured, setMeasured] = useState<Record<string, { width: number; height: number }>>({})
  const nodes = useMemo(() => baseNodes.map((node) => {
    const size = measured[node.id]
    return size === undefined ? node : { ...node, measured: size }
  }), [baseNodes, measured])

  // Signal：空闲慢速环境流；有节点在跑换成运行流（只走未完成的线）；评审门拦住就停，线尽头一个琥珀短横；离屏 / 减少动态效果只留静态高亮。
  const visible = useOnScreen(containerRef)
  const reduced = useReducedMotion()
  const states = useMemo(() => edgeStates(layout, { withStatus, current }), [layout, withStatus, current])
  const hold = useMemo(() => (withStatus ? holdTarget(layout, mode, holding) : null), [layout, mode, withStatus, holding])
  const running = withStatus && layout.entries.some((item) => item.entry.status === 'running')
  const signalMode = signalModeOf({ visible, running, blocked: hold !== null, reduced })
  const drawing = signalMode === 'ambient' || signalMode === 'running' || (signalMode === 'still' && hold !== null)
  const edges = useMemo(
    () => edgesOf(layout, returns, mode, { states, signal: drawing, hold }, labelOf, (from, to) => t('workflow.back_arc', { from, to })),
    [layout, returns, mode, states, drawing, hold, labelOf, t],
  )
  const onNodesChange = useCallback((changes: NodeChange<CanvasNode>[]) => {
    for (const change of changes) {
      if (change.type !== 'dimensions' || change.dimensions === undefined) continue
      const { id, dimensions } = change
      setMeasured((now) => now[id]?.width === dimensions.width && now[id]?.height === dimensions.height ? now : { ...now, [id]: { width: dimensions.width, height: dimensions.height } })
    }
  }, [])

  // 取景：总览按宽度适配（缩放 0.6–1），点列头再缓动放大到那一阶段；阶段画布 1:1、内容左对齐。挂载后第一次瞬时，之后 200ms。
  const [expanded, setExpanded] = useState(false)
  const [minZoom, setMinZoom] = useState<number>(OVERVIEW_ZOOM.min)
  const framed = useRef(false)
  const headroom = useMemo(() => returnHeadroom(layout, returns), [layout, returns])
  const refit = useCallback(() => {
    const duration = prefersReducedMotion() || !framed.current ? 0 : 200
    framed.current = true
    const element = containerRef.current
    if (element === null) return
    if (overview) {
      // 回流弧拱在列带上方，算进取景的上界；底部让出控件那一行。
      const bounds = { x: 0, y: -headroom, width: layout.width, height: layout.height + headroom }
      const size = { width: element.clientWidth, height: Math.max(0, element.clientHeight - CONTROLS_BAND) }
      setMinZoom(overviewMinZoom(bounds, size))
      void flowRef.current.setViewport(overviewViewport(bounds, size), { duration })
      return
    }
    void flowRef.current.setViewport(stageViewport(), { duration })
  }, [overview, layout, headroom])
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

  const signature = useMemo(() => `${layout.edges.map((edge) => edge.id).join('|')}#${[...states.values()].join(',')}#${expanded ? 1 : 0}`, [layout, states, expanded])
  useSignal(containerRef, signalMode, { hold: signalMode === 'still' ? hold : null, signature, expected: layout.edges.length })

  // 语义缩放：只在跨过档位时更新（选择器返回档位字符串，缩放过程中不逐帧重渲染）。
  const zoomLevel = useStore((state) => zoomLevelOf(state.transform[2]))
  const level = overview ? zoomLevel : 'name'
  const onHeader = useCallback((id: string) => {
    const band = layout.stages.find((item) => item.stage.id === id)
    const element = containerRef.current
    if (band === undefined || element === null) return
    // 缩得很小（只剩符号）时点列头 = 放大到这一阶段；已经能读清时点列头 = 进入这一阶段。
    if (level !== 'glyph' && onOpenStage !== undefined) { onOpenStage(id); return }
    const size = { width: element.clientWidth, height: Math.max(0, element.clientHeight - CONTROLS_BAND) }
    void flowRef.current.setViewport(stageFocusViewport(band, size, headroom), { duration: prefersReducedMotion() ? 0 : FOCUS_MS, ease: FOCUS_EASE })
  }, [layout, level, onOpenStage, headroom])

  const [hovered, setHovered] = useState<string | null>(null)
  const context = useMemo((): OrchestrationCanvasContext => ({
    mode, current, hovered, setHovered, flows, labelOf, zoomLevel: level, holding: withStatus ? holding : null, onHeader,
    ...(onOpenEntry === undefined ? {} : { onOpenEntry }),
    ...(openable === undefined ? {} : { openable }),
    ...(laneActions === undefined ? {} : { laneActions }),
  }), [mode, current, hovered, flows, labelOf, level, withStatus, holding, onHeader, onOpenEntry, openable, laneActions])

  return (
    <CanvasContext.Provider value={context}>
      <div
        ref={containerRef}
        role="group"
        className={cn('relative overflow-hidden rounded-md border border-border bg-card', expanded && 'fixed inset-0 z-50 rounded-none border-0', className)}
        style={overview ? undefined : { height: layout.height + 2 * STAGE_PAD }}
        aria-label={ariaLabel}
        data-testid={overview ? 'orchestration-overview' : 'orchestration-stage'}
        data-signal={signalMode}
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
          minZoom={overview ? minZoom : READ_ONLY_ZOOM.min}
          maxZoom={overview ? OVERVIEW_ZOOM.max : READ_ONLY_ZOOM.max}
          proOptions={{ hideAttribution: true }}
          ariaLabelConfig={ariaLabelConfig}
        >
          {overview && (
            <Controls showInteractive={false} showZoom showFitView fitViewOptions={FIT_OPTIONS} orientation="horizontal" position="bottom-left" className={CONTROLS_CLASS}>
              <ControlButton
                aria-label={t(expanded ? 'workflow.exit_fullscreen' : 'workflow.fullscreen')}
                title={t(expanded ? 'workflow.exit_fullscreen' : 'workflow.fullscreen')}
                data-testid="orchestration-fullscreen"
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
              </ControlButton>
            </Controls>
          )}
        </ReactFlow>
      </div>
    </CanvasContext.Provider>
  )
}

/**
 * 编排画布（React Flow）：总览 = 每阶段一条列带（无边框，标题行 + 4% 底，高度贴内容，门禁图标在标题行，
 * 回流为标题之间的虚线弧，悬停标题看输出流向），列内按 runner 真实顺序 执行者 → 技能 → 测试 → 评审者；
 * 阶段 = 同一组件的单列形态，泳道名是节点上方的分组标题（可带动作）。Signal 沿线从起点流向终点：空闲慢速环境流，
 * 运行中只走未完成的线，评审门拦住就停在门前。总览默认按宽度适配、可缩放、点列头放大、全屏。
 */
export function OrchestrationFlow(props: OrchestrationFlowProps): JSX.Element {
  return <ReactFlowProvider><OrchestrationFlowInner {...props} /></ReactFlowProvider>
}
