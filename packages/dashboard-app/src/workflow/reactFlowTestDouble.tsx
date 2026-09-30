import type { ComponentType, ReactNode } from 'react'

/**
 * jsdom 里没有 ResizeObserver / 布局，@xyflow/react 无法真渲染。测试用这份替身：按 nodeTypes 真渲染每个节点
 * （节点内的按钮、testid 都是真的），边只暴露数量；连线 / 拖拽属于 React Flow 自身行为，不在本仓测试范围。
 */
type AnyNode = { id: string; type?: string; data: Record<string, unknown>; selected?: boolean }
type AnyEdge = { id: string; source: string; target: string }
type Change = { type: string; id?: string }

export const Position = { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' } as const
export const BackgroundVariant = { Dots: 'dots', Lines: 'lines', Cross: 'cross' } as const
export const MarkerType = { Arrow: 'arrow', ArrowClosed: 'arrowclosed' } as const
export function Background({ gap, color }: { gap?: number; color?: string }): JSX.Element { return <div data-testid="flow-background" data-gap={gap} data-color={color} /> }
export function BaseEdge(): null { return null }
export function getBezierPath(): [string, number, number] { return ['M0 0 L1 1', 0, 0] }
export function getSmoothStepPath(): [string, number, number] { return ['M0 0 L1 1', 0, 0] }
/** 测试可改的缩放（默认 1 = 「名称」档）与记录下来的 setViewport 调用。 */
const view = { zoom: 1 }
export function setTestZoom(zoom: number): void { view.zoom = zoom }
export const viewportCalls: Array<{ viewport: { x: number; y: number; zoom: number }; options?: { duration?: number; ease?: unknown } }> = []
export function useStore<T>(selector: (state: { transform: [number, number, number] }) => T): T { return selector({ transform: [0, 0, view.zoom] }) }
export function Controls({ className, showZoom = true, orientation, position, children }: { className?: string; showZoom?: boolean; orientation?: string; position?: string; children?: ReactNode }): JSX.Element {
  return <div data-testid="flow-controls" className={className} data-show-zoom={showZoom} data-orientation={orientation} data-position={position}>{children}</div>
}
export function ControlButton({ children, ...props }: { children?: ReactNode } & Record<string, unknown>): JSX.Element {
  return <button type="button" {...props}>{children}</button>
}
export function Handle({ type, children }: { type: string; children?: ReactNode }): JSX.Element { return <span data-handle={type}>{children}</span> }
export function ReactFlowProvider({ children }: { children: ReactNode }): JSX.Element { return <>{children}</> }
const INSTANCE = {
  screenToFlowPosition: (p: { x: number; y: number }) => p,
  fitView: async (_options?: Record<string, unknown>) => true,
  getNodes: (): AnyNode[] => [],
  getNodesBounds: (_nodes: AnyNode[]) => ({ x: 0, y: 0, width: 600, height: 120 }),
  fitBounds: async (_bounds: Record<string, number>, _options?: Record<string, unknown>) => true,
  setViewport: async (viewport: { x: number; y: number; zoom: number }, options?: { duration?: number; ease?: unknown }) => { viewportCalls.push({ viewport, ...(options === undefined ? {} : { options }) }); return true },
}
/** 与真库一致：实例引用稳定，否则依赖它的 effect 会每次渲染重跑。 */
export function useReactFlow(): typeof INSTANCE { return INSTANCE }
export function applyNodeChanges<N extends AnyNode>(changes: Change[], nodes: N[]): N[] {
  const removed = new Set(changes.filter((change) => change.type === 'remove').map((change) => change.id))
  return nodes.filter((node) => !removed.has(node.id))
}
export function applyEdgeChanges<E extends AnyEdge>(changes: Change[], edges: E[]): E[] {
  const removed = new Set(changes.filter((change) => change.type === 'remove').map((change) => change.id))
  return edges.filter((edge) => !removed.has(edge.id))
}
type AnyEdgeWithData = AnyEdge & { data?: Record<string, unknown>; markerEnd?: unknown }
export function ReactFlow({ nodes, edges, nodeTypes, ariaLabelConfig, minZoom, maxZoom, children }: { nodes: AnyNode[]; edges: AnyEdgeWithData[]; nodeTypes: Record<string, ComponentType<{ id: string; data: Record<string, unknown>; selected: boolean }>>; ariaLabelConfig?: Record<string, string>; minZoom?: number; maxZoom?: number; children?: ReactNode }): JSX.Element {
  return (
    <div data-testid="react-flow" data-edges={edges.map((edge) => edge.id).join(',')} data-edge-states={edges.map((edge) => String(edge.data?.state ?? '')).join(',')} data-edge-arrows={edges.map((edge) => (edge.markerEnd === undefined ? '0' : '1')).join(',')} data-edge-holds={edges.filter((edge) => edge.data?.hold === true).map((edge) => edge.id).join(',')} data-edge-signals={edges.filter((edge) => edge.data?.signal === true).length} data-aria-labels={JSON.stringify(ariaLabelConfig ?? {})} data-min-zoom={minZoom} data-max-zoom={maxZoom}>
      {nodes.map((node) => {
        const Type = nodeTypes[node.type ?? 'default']
        return Type === undefined ? null : <Type key={node.id} id={node.id} data={node.data} selected={node.selected ?? false} />
      })}
      {children}
    </div>
  )
}
