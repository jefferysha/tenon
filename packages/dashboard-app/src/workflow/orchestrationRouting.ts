/**
 * 编排画布的连线路由（纯函数）：把「上一组的末端」接到「下一组的起点」。
 * 同一位次的并行条目在列内纵向堆叠，所以多对一 / 一对多的连线不能走条目中间：走列外的两条轨道——
 * 左轨接入（汇合点朝下、连到各条目的左侧），右轨接出（各条目的右侧连到汇合点、再朝下）。
 * 一对一直接相连。每条连线的先后由 order 给出，脉冲按它依次传递。
 */

/** 汇合点离列边的距离：落在阶段框的内边距里，连线永远不穿过条目。 */
export const RAIL = 10
/** 汇合点离它服务的那一组多远（px）：扇出的贴在上一组下面，汇入的贴在下一组上面；空隙不够就取空隙的一半 / 三分之一。 */
const NEAR = 14
const NEAR_BOTH = 10

export interface LaidPoint { readonly id: string; readonly x: number; readonly y: number }
export interface LaidEdge {
  readonly id: string
  readonly source: string
  readonly target: string
  readonly sourceHandle: string
  readonly targetHandle: string
  /** 脉冲段序：同段序同时出发，下一段等本段走完。 */
  readonly order: number
  readonly arrow: boolean
}

/** 连线的一端：节点的几何与它朝下出、朝上入的把手名。 */
export interface Anchor {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  /** 从它出发用的把手（条目 bottom、阶段标题 down、起点 out）。 */
  readonly out: string
  /** 连进它用的把手（条目 top、终点 in）。 */
  readonly into: string
}

export interface Connection {
  readonly edges: LaidEdge[]
  readonly junctions: LaidPoint[]
  /** 这次连线占几个脉冲段序。 */
  readonly hops: number
}

interface ConnectInput {
  readonly from: readonly Anchor[]
  readonly to: readonly Anchor[]
  /** 汇合点 id 的前缀（同一列内唯一）。 */
  readonly junction: string
  /** 第一段的段序；后续段依次 +1。 */
  readonly order: number
  readonly leftRail: number
  readonly rightRail: number
}

function edge(source: string, sourceHandle: string, target: string, targetHandle: string, order: number, arrow: boolean): LaidEdge {
  return { id: `${source}->${target}`, source, target, sourceHandle, targetHandle, order, arrow }
}

const NONE: Connection = { edges: [], junctions: [], hops: 0 }

/**
 * 一对一直连；一对多经左轨汇合点扇出；多对一经右轨汇合点汇入；多对多先汇入右轨、横穿空隙、再从左轨扇出。
 * from 或 to 为空时什么都不连。
 */
export function connect(input: ConnectInput): Connection {
  const { from, to, order } = input
  const first = from[0]
  const last = to[0]
  if (first === undefined || last === undefined) return NONE
  if (from.length === 1 && to.length === 1) return { edges: [edge(first.id, first.out, last.id, last.into, order, true)], junctions: [], hops: 1 }
  const bottom = Math.max(...from.map((item) => item.y + item.height))
  const top = Math.min(...to.map((item) => item.y))
  const gap = top - bottom
  const point = (side: 'in' | 'out', y: number): LaidPoint => ({
    id: `${input.junction}:${side}`,
    x: (side === 'in' ? input.leftRail : input.rightRail) - 1,
    y: y - 1,
  })
  const edges: LaidEdge[] = []
  const junctions: LaidPoint[] = []
  if (from.length === 1) {
    const fan = point('in', bottom + Math.min(gap / 2, NEAR))
    junctions.push(fan)
    edges.push(edge(first.id, first.out, fan.id, 'top', order, false))
    for (const target of to) edges.push(edge(fan.id, 'bottom', target.id, 'left', order + 1, true))
    return { edges, junctions, hops: 2 }
  }
  if (to.length === 1) {
    const merge = point('out', top - Math.min(gap / 2, NEAR))
    junctions.push(merge)
    for (const source of from) edges.push(edge(source.id, 'right', merge.id, 'top', order, false))
    edges.push(edge(merge.id, 'bottom', last.id, last.into, order + 1, true))
    return { edges, junctions, hops: 2 }
  }
  const merge = point('out', bottom + Math.min(gap * 0.35, NEAR_BOTH))
  const fan = point('in', top - Math.min(gap * 0.35, NEAR_BOTH))
  junctions.push(merge, fan)
  for (const source of from) edges.push(edge(source.id, 'right', merge.id, 'top', order, false))
  edges.push(edge(merge.id, 'bottom', fan.id, 'top', order + 1, false))
  for (const target of to) edges.push(edge(fan.id, 'bottom', target.id, 'left', order + 2, true))
  return { edges, junctions, hops: 3 }
}
