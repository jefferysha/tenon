import type { WbStepDef } from '../api/governanceTypes'

export interface PipelineEdge {
  from: string
  to: string
  event: string
}

export interface PipelineEdges {
  /** 指向更后阶段的边：画连接线。 */
  forward: PipelineEdge[]
  /** 指向更前（或同）阶段的边：画带事件标签的回流。 */
  back: PipelineEdge[]
}

export function pipelineEdges(steps: readonly Pick<WbStepDef, 'id' | 'transitions'>[]): PipelineEdges {
  const index = new Map(steps.map((step, position) => [step.id, position]))
  const forward: PipelineEdge[] = []
  const back: PipelineEdge[] = []
  steps.forEach((step, position) => {
    for (const transition of step.transitions) {
      const target = index.get(transition.to)
      if (target === undefined) continue
      const edge = { from: step.id, to: transition.to, event: transition.event }
      if (target > position) forward.push(edge)
      else back.push(edge)
    }
  })
  return { forward, back }
}

/** 某阶段出发的回流边（渲染在该阶段节点下方）。 */
export function backEdgesFrom(edges: PipelineEdges, stepId: string): PipelineEdge[] {
  return edges.back.filter((edge) => edge.from === stepId)
}

/** 相邻两阶段之间是否有直连前向边（无则连接线画成虚线）。 */
export function linkedToNext(edges: PipelineEdges, stepId: string, nextId: string | undefined): boolean {
  if (nextId === undefined) return false
  return edges.forward.some((edge) => edge.from === stepId && edge.to === nextId)
}
