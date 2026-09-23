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
export function Background(): null { return null }
export function BaseEdge(): null { return null }
export function getBezierPath(): [string, number, number] { return ['M0 0 L1 1', 0, 0] }
export function Controls(): null { return null }
export function Handle({ type }: { type: string }): JSX.Element { return <span data-handle={type} /> }
export function ReactFlowProvider({ children }: { children: ReactNode }): JSX.Element { return <>{children}</> }
const INSTANCE = { screenToFlowPosition: (p: { x: number; y: number }) => p, fitView: async () => true }
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
export function ReactFlow({ nodes, edges, nodeTypes, ariaLabelConfig, children }: { nodes: AnyNode[]; edges: AnyEdge[]; nodeTypes: Record<string, ComponentType<{ id: string; data: Record<string, unknown>; selected: boolean }>>; ariaLabelConfig?: Record<string, string>; children?: ReactNode }): JSX.Element {
  return (
    <div data-testid="react-flow" data-edges={edges.map((edge) => edge.id).join(',')} data-aria-labels={JSON.stringify(ariaLabelConfig ?? {})}>
      {nodes.map((node) => {
        const Type = nodeTypes[node.type ?? 'default']
        return Type === undefined ? null : <Type key={node.id} id={node.id} data={node.data} selected={node.selected ?? false} />
      })}
      {children}
    </div>
  )
}
