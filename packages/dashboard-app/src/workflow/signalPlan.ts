/**
 * Signal 的纯规划与时间线（不碰 DOM、不碰 React）：到达距离、彗星几何、评审门停靠、节点到达反馈的包络。
 * 运行时（读 DOM、挂 ticker）在 flowSignal.ts。
 */

export type SignalMode = 'off' | 'ambient' | 'running' | 'still'

export interface StreakLayer {
  readonly id: 'halo' | 'trail-long' | 'trail-short' | 'core'
  /** dash 长度（px）：头部对齐，越长拖尾越远。 */
  readonly length: number
  readonly width: number
  readonly opacity: number
  readonly tone: 'halo' | 'streak'
  readonly cap: 'butt' | 'round'
}

export const STREAK_LAYERS: readonly StreakLayer[] = [
  { id: 'halo', length: 72, width: 4, opacity: 0.14, tone: 'halo', cap: 'butt' },
  { id: 'trail-long', length: 48, width: 1.5, opacity: 0.3, tone: 'streak', cap: 'butt' },
  { id: 'trail-short', length: 26, width: 2, opacity: 0.55, tone: 'streak', cap: 'butt' },
  { id: 'core', length: 10, width: 2.5, opacity: 1, tone: 'streak', cap: 'round' },
]
/** 彗星最长的一层（光晕）：热边判定用它。 */
export const STREAK_REACH = 72

/** 空闲：慢速环境流，间距随路线长度取 clamp(routeLen / 3, 320, 720)，整体 ×0.7。运行：从未完成的边向终点，快而密。 */
export const AMBIENT = { speed: 140, opacity: 0.7, minSpacing: 320, maxSpacing: 720 } as const
export const RUNNING = { speed: 300, spacing: 360, opacity: 1 } as const

/** 节点到达反馈的时间线（s）：边框 + 光晕 90ms 升、520ms 降；顶端端口点亮 300ms；图标转强调色 200ms；起 / 终点光环 600ms。 */
export const ARRIVE = { rise: 0.09, decay: 0.52, port: 0.3, icon: 0.2, ring: 0.6 } as const
export const ARRIVE_TOTAL = ARRIVE.rise + ARRIVE.decay
/** 光环外扩到的倍数与起始不透明度。 */
const RING_SCALE = 2.2
const RING_ALPHA = 0.35

export interface SignalParams { readonly speed: number; readonly spacing: number; readonly opacity: number }

export const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))
export const mod = (value: number, base: number): number => ((value % base) + base) % base

export function signalParams(mode: 'ambient' | 'running', routeLen: number): SignalParams {
  if (mode === 'running') return RUNNING
  return { speed: AMBIENT.speed, spacing: clamp(routeLen / 3, AMBIENT.minSpacing, AMBIENT.maxSpacing), opacity: AMBIENT.opacity }
}

/** 画布该不该动：看不见就停；阻塞或减少动态效果只留静态高亮；有节点在跑用运行流，否则环境流。 */
export function signalModeOf({ visible, running, blocked, reduced = false }: { visible: boolean; running: boolean; blocked: boolean; reduced?: boolean }): SignalMode {
  if (!visible) return 'off'
  if (blocked || reduced) return 'still'
  return running ? 'running' : 'ambient'
}

export interface SignalEdgeInput {
  readonly id: string
  readonly source: string
  readonly target: string
  /** 路径长度（px）。 */
  readonly length: number
  /** 从源节点「到达」到这条边开始之间信号在节点里走的距离；缺省 = 源节点的 transit。 */
  readonly lead?: number
  /** 这条边要等这些节点走完才开始（总览里主线的下一跳等上一列走完）：a(e) 取它们「到达 + transit」的最大值。 */
  readonly after?: readonly string[]
}
export interface SignalNodeInput {
  readonly id: string
  /** 信号穿过节点走的距离（沿流向的尺寸）：节点不透明，彗星从后面穿过，但速度不能因此突变。 */
  readonly transit: number
}
export interface SignalPlan {
  /** 每条边的起点距离（沿路线，px）。 */
  readonly a: ReadonlyMap<string, number>
  /** 每个节点的到达距离：头部走到它时已走的路线长度 = 各入边 (a + 边长) 的最大值；没有入边 = 0。 */
  readonly arrival: ReadonlyMap<string, number>
  /** 整条路线长度（最晚的到达距离）。 */
  readonly routeLen: number
}

/**
 * 相位规划（纯函数）：arrival(node) = max over 入边 (a(e) + len(e))；a(e) = arrival(source) + transit(source)，
 * 带 after 的边再等那些节点走完。同一源出发的边共享 a（分叉同步）；汇合后的出边从最慢那支到达之后开始；沿路线的速度处处是同一个 v。
 * 有环时环上的边按第一次访问的距离算，不会死循环。
 */
export function planSignal(edges: readonly SignalEdgeInput[], nodes: readonly SignalNodeInput[]): SignalPlan {
  const transit = new Map(nodes.map((node) => [node.id, node.transit]))
  const incoming = new Map<string, SignalEdgeInput[]>()
  for (const edge of edges) incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge])
  const arrival = new Map<string, number>()
  const a = new Map<string, number>()
  const visiting = new Set<string>()
  const arrivalOf = (id: string): number => {
    const known = arrival.get(id)
    if (known !== undefined) return known
    if (visiting.has(id)) return 0
    visiting.add(id)
    let latest = 0
    for (const edge of incoming.get(id) ?? []) {
      let start = arrivalOf(edge.source) + (edge.lead ?? transit.get(edge.source) ?? 0)
      for (const waited of edge.after ?? []) start = Math.max(start, arrivalOf(waited) + (transit.get(waited) ?? 0))
      a.set(edge.id, start)
      latest = Math.max(latest, start + edge.length)
    }
    visiting.delete(id)
    arrival.set(id, latest)
    return latest
  }
  // 每条边都是它目标的入边，所以这一遍会走遍全部边与源节点（含没有入边的起点，arrival = 0）。
  for (const edge of edges) arrivalOf(edge.target)
  let routeLen = 0
  for (const value of arrival.values()) routeLen = Math.max(routeLen, value)
  return { a, arrival, routeLen }
}

/** 彗星头部在一条边上的层偏移（每层一个）；头部还没到边起点、或整个光晕已经越过边终点 = null（这条边是冷的）。 */
export function offsetsFor(a: number, length: number, head: number, spacing: number): number[] | null {
  if (head < a || head - STREAK_REACH > a + length) return null
  return STREAK_LAYERS.map((layer) => mod(a + layer.length - head, spacing))
}

/** 传送带在 phase（= 已走距离 mod 间距）时，落在边 [a, a+length] 上的那颗彗星的头部；没有 = null。 */
export function headOnEdge(a: number, length: number, phase: number, spacing: number): number | null {
  const head = phase + Math.max(0, Math.ceil((a - phase) / spacing)) * spacing
  return head - STREAK_REACH > a + length ? null : head
}

/**
 * 阻塞在评审门：不流动，一颗彗星停在门的到达距离上，只点亮通向门的那些线（旁支即使落在同一段路线坐标里也保持冷）。
 * 返回每条被点亮的边的层偏移；门之后的边永远拿不到偏移——信号在门前停住，不会越过。
 */
export function parkedAt(plan: SignalPlan, edges: readonly SignalEdgeInput[], hold: string, spacing: number): Map<string, number[]> {
  const out = new Map<string, number[]>()
  const limit = plan.arrival.get(hold)
  if (limit === undefined) return out
  const toward = new Set<string>()
  const pending = [hold]
  while (pending.length > 0) {
    const target = pending.pop()
    for (const edge of edges) {
      if (edge.target !== target || toward.has(edge.id)) continue
      toward.add(edge.id)
      pending.push(edge.source, ...(edge.after ?? []))
    }
  }
  for (const edge of edges) {
    const start = plan.a.get(edge.id)
    if (start === undefined || !toward.has(edge.id)) continue
    const offsets = offsetsFor(start, edge.length, limit, spacing)
    if (offsets !== null) out.set(edge.id, offsets)
  }
  return out
}

const powerOut = (x: number): number => 1 - (1 - clamp(x, 0, 1)) ** 2

/** 节点到达后 since 秒时的边框 + 光晕不透明度：90ms power2.out 升到 1，再 520ms 降回 0。 */
export function arrivalGlow(since: number): number {
  if (since < 0 || since >= ARRIVE_TOTAL) return 0
  return since < ARRIVE.rise ? powerOut(since / ARRIVE.rise) : (1 - (since - ARRIVE.rise) / ARRIVE.decay) ** 2
}
/** 顶端端口点：亮 300ms。 */
export function portGlow(since: number): number {
  return since >= 0 && since < ARRIVE.port ? 1 : 0
}
/** 图标的强调色叠层：200ms 升到 1，之后随光晕退去。 */
export function iconGlow(since: number): number {
  if (since < 0 || since >= ARRIVE_TOTAL) return 0
  return since < ARRIVE.icon ? since / ARRIVE.icon : 1 - (since - ARRIVE.icon) / (ARRIVE_TOTAL - ARRIVE.icon)
}
/** 起 / 终点光环：600ms 里 scale 1 → 2.2，不透明度 .35 → 0；窗口外 = null。 */
export function ringFrame(since: number): { scale: number; opacity: number } | null {
  if (since < 0 || since >= ARRIVE.ring) return null
  const progress = powerOut(since / ARRIVE.ring)
  return { scale: 1 + (RING_SCALE - 1) * progress, opacity: RING_ALPHA * (1 - progress) }
}
