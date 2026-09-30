/**
 * 编排画布上 Signal 的状态语义（纯函数）：每条边是「已走过 / 正接入运行节点 / 还没到」，以及评审门把信号拦在哪里。
 * 布局只管几何，这里只管「哪些线是实线强调色、哪条线尽头有琥珀短横」；流动本身在 flowSignal。
 */
import type { FlowMode, LaidEdge, OrchestrationLayout } from './orchestrationLayout'
import type { EdgeState } from './skillFlowNodes'

/**
 * 每条边的线态。withStatus=false（工作流定义）一律 todo。
 * · 接入条目：条目已完成 = done，正在运行 = live，其余 todo；
 * · 接入阶段标题：任务已进入（或走过）该阶段 = done；
 * · 接入汇合点 / 终点：它的源已完成（汇合点 = 所有入边都完成；标题 = 该阶段已走过）。
 */
export function edgeStates(layout: OrchestrationLayout, options: { withStatus: boolean; current: string | null }): Map<string, EdgeState> {
  const states = new Map<string, EdgeState>()
  if (!options.withStatus) {
    for (const edge of layout.edges) states.set(edge.id, 'todo')
    return states
  }
  const entryStatus = new Map(layout.entries.map((item) => [item.id, item.entry.status]))
  const stageIndex = new Map(layout.stages.map((stage) => [stage.id, stage.index]))
  const currentIndex = options.current === null ? -1 : layout.stages.findIndex((stage) => stage.stage.id === options.current)
  const incoming = new Map<string, LaidEdge[]>()
  for (const edge of layout.edges) incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge])
  const lastStage = layout.stages[layout.stages.length - 1]
  const lastDone = lastStage !== undefined && currentIndex === lastStage.index
    && layout.entries.filter((item) => item.stage === lastStage.stage.id).every((item) => item.entry.status === 'done')
  const started = (stage: string | null): boolean => layout.entries.some((item) => (stage === null || item.stage === stage) && item.entry.status !== undefined && item.entry.status !== 'waiting')
  const memo = new Map<string, boolean>()
  /** 信号已经走过这个节点、可以从它出发了？标题 = 前面的阶段，或当前阶段里已经有条目动起来。 */
  const passed = (id: string): boolean => {
    const status = entryStatus.get(id)
    if (status !== undefined) return status === 'done'
    const index = stageIndex.get(id)
    if (index !== undefined) return index < currentIndex || (index === currentIndex && started(layout.stages[index]?.stage.id ?? null))
    if (id === 'start') return layout.stages.length > 0 || started(null)
    const known = memo.get(id)
    if (known !== undefined) return known
    memo.set(id, false)
    const inputs = incoming.get(id) ?? []
    const done = inputs.length > 0 && inputs.every((edge) => passed(edge.source))
    memo.set(id, done)
    return done
  }
  for (const edge of layout.edges) {
    const status = entryStatus.get(edge.target)
    const index = stageIndex.get(edge.target)
    if (status !== undefined) states.set(edge.id, status === 'done' ? 'done' : status === 'running' ? 'live' : 'todo')
    else if (index !== undefined) states.set(edge.id, index <= currentIndex ? 'done' : 'todo')
    else if (edge.target === 'end' && stageIndex.has(edge.source)) states.set(edge.id, lastDone ? 'done' : 'todo')
    else states.set(edge.id, passed(edge.source) ? 'done' : 'todo')
  }
  return states
}

/**
 * 评审门拦在哪：`holding` 是评审门未放行的阶段，信号停在它之后的下一个节点前（下一阶段标题；最后一阶段 = 终点）。
 * 阶段画布只有这一个阶段，被拦时停在终点前。总览里找不到这个阶段返回 null。
 */
export function holdTarget(layout: OrchestrationLayout, mode: FlowMode, holding: string | null): string | null {
  if (holding === null) return null
  if (mode === 'stage') return 'end'
  const index = layout.stages.findIndex((stage) => stage.stage.id === holding)
  if (index < 0) return null
  return layout.stages[index + 1]?.id ?? 'end'
}
