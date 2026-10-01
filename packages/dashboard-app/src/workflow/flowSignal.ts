import { useEffect, useState, type RefObject } from 'react'
import gsap from 'gsap'
import {
  ARRIVE, ARRIVE_TOTAL, STREAK_LAYERS, arrivalGlow, headOnEdge, iconGlow, mod, parkedAt, planSignal, portGlow, ringFrame, signalParams,
  type SignalMode,
} from './signalPlan'

export * from './signalPlan'

/**
 * Signal：画布上的流动。一条恒速传送带贯穿全图——每条边的相位由「到达距离」算出（planSignal），
 * 所以速度处处一致，分叉的各支同步出发、汇合点等最慢的一支。彗星 = 同一条边路径的四个克隆共用一个 dashoffset：
 * 头部对齐，靠不同的 dash 长度叠出拖尾，不用渐变、不用滤镜。
 *
 * 一个 gsap.ticker 回调驱动全部：每帧只写「热边」（彗星窗口碰到的边，至多几条）的 4 个 dashoffset，其余边保持 hidden；
 * 路径长度只在建时量一次；画布离屏、标签页隐藏、减少动态效果时都不挂 ticker。
 */

/** 边与节点的布局要一两帧才落定；晚一点再量路径长度。 */
const BUILD_DELAY_MS = 120
const RETRY_LIMIT = 25

/** 用户是否要求减少动态效果；没有 matchMedia（非浏览器环境）按「否」处理。 */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

interface EdgeRecord {
  readonly group: SVGGElement
  readonly layers: readonly SVGPathElement[]
  readonly a: number
  readonly length: number
  hot: boolean
}
interface NodeRecord {
  readonly arrival: number
  readonly flash: HTMLElement | null
  readonly port: HTMLElement | null
  readonly icon: HTMLElement | null
  readonly ring: HTMLElement | null
  active: boolean
}

export interface SignalRuntime {
  /** DOM 里量得到路径长度的边数 / 其中参与流动（未完成）的边数 / 当前是热边的边数（测试与性能测量用）。 */
  readonly total: number
  readonly edgeCount: number
  hotCount: () => number
  /** 推进 dt 秒并写热边；静止（still）的 runtime 没有这一步。 */
  step: (dt: number) => void
  readonly animated: boolean
  dispose: () => void
}

const LAYER_SELECTOR = (id: string): string => `path[data-signal-layer="${id}"]`

function resetNode(node: NodeRecord): void {
  for (const el of [node.flash, node.port]) if (el !== null) el.style.opacity = ''
  if (node.icon !== null) node.icon.style.color = ''
  if (node.ring !== null) { node.ring.style.opacity = ''; node.ring.style.transform = '' }
  node.active = false
}

/**
 * 从画布 DOM 建一次运行时：边 = `g[data-signal-edge]`（data-signal-source / -target / -lead / -after / -state，内含四层 path；
 * 带 data-signal-static 的短线没有 path，长度在 data-signal-length），
 * 节点 = `[data-flow-node]`（data-transit；内含可选的 data-signal-flash / -port / -icon / -ring）。
 * state=done 的边不参与流动（已完成线是实线）。mode=still + hold：不动，一颗彗星停在 hold 节点的到达距离上。
 * 没有可量的边时返回 null。
 */
export function createSignalRuntime(root: Element, mode: Exclude<SignalMode, 'off'>, hold: string | null = null): SignalRuntime | null {
  const lengths = new Map<string, number>()
  const records: Array<EdgeRecord & { id: string; source: string; target: string; eligible: boolean; lead: number | undefined; after: readonly string[] }> = []
  for (const group of root.querySelectorAll<SVGGElement>('g[data-signal-edge]')) {
    const layers: SVGPathElement[] = []
    let length: number | undefined
    if (group.dataset.signalStatic !== undefined) {
      // 短线：只登记长度（条目的到达反馈按它算），不带彗星层。
      length = Number(group.dataset.signalLength)
    } else {
      for (const layer of STREAK_LAYERS) {
        const path = group.querySelector<SVGPathElement>(LAYER_SELECTOR(layer.id))
        if (path !== null) layers.push(path)
      }
      const base = layers[0]
      if (base === undefined || layers.length !== STREAK_LAYERS.length) continue
      const d = base.getAttribute('d') ?? ''
      length = lengths.get(d)
      if (length === undefined) {
        length = typeof base.getTotalLength === 'function' ? base.getTotalLength() : 0
        lengths.set(d, length)
      }
    }
    if (!Number.isFinite(length) || length <= 0) continue
    const lead = group.dataset.signalLead === undefined ? undefined : Number(group.dataset.signalLead)
    const after = (group.dataset.signalAfter ?? '').split(' ').filter((id) => id !== '')
    records.push({ group, layers, a: 0, length, hot: false, id: group.dataset.signalEdge ?? '', source: group.dataset.signalSource ?? '', target: group.dataset.signalTarget ?? '', eligible: group.dataset.signalState !== 'done', lead: lead !== undefined && Number.isFinite(lead) ? lead : undefined, after })
  }
  if (records.length === 0) return null

  const nodeEls = [...root.querySelectorAll<HTMLElement>('[data-flow-node]')]
  const plan = planSignal(
    records.map((record) => ({ id: record.id, source: record.source, target: record.target, length: record.length, after: record.after, ...(record.lead === undefined ? {} : { lead: record.lead }) })),
    nodeEls.map((el) => ({ id: el.dataset.flowNode ?? '', transit: Number(el.dataset.transit ?? 0) || 0 })),
  )
  const edges: EdgeRecord[] = records.map((record) => ({ group: record.group, layers: record.layers, a: plan.a.get(record.id) ?? 0, length: record.length, hot: false }))
  const params = signalParams(mode === 'running' ? 'running' : 'ambient', plan.routeLen)
  const { spacing } = params

  const hide = (edge: EdgeRecord): void => { if (edge.hot) { edge.group.setAttribute('visibility', 'hidden'); edge.hot = false } }
  const show = (edge: EdgeRecord): void => { if (!edge.hot) { edge.group.setAttribute('visibility', 'visible'); edge.hot = true } }
  STREAK_LAYERS.forEach((layer, index) => {
    for (const record of records) {
      const path = record.layers[index]
      if (path === undefined) continue
      path.setAttribute('stroke-dasharray', `${layer.length} ${spacing - layer.length}`)
      path.setAttribute('stroke-opacity', String(layer.opacity * params.opacity))
    }
  })
  const writeOffsets = (edge: EdgeRecord, offsets: readonly number[]): void => {
    for (let index = 0; index < edge.layers.length; index += 1) edge.layers[index]?.setAttribute('stroke-dashoffset', String(offsets[index]))
  }

  if (mode === 'still') {
    if (hold !== null) {
      const parked = parkedAt(plan, records, hold, spacing)
      records.forEach((record, index) => {
        const offsets = parked.get(record.id)
        const edge = edges[index]
        if (offsets === undefined || edge === undefined || edge.layers.length === 0) return
        writeOffsets(edge, offsets)
        show(edge)
      })
    }
    return { total: edges.length, edgeCount: edges.length, hotCount: () => edges.filter((edge) => edge.hot).length, step: () => undefined, animated: false, dispose: () => { for (const edge of edges) hide(edge) } }
  }

  // 参与流动的边（未完成）；以及有入边被点亮的节点（到达反馈只给它们），和起点（每发射一颗彗星放一圈光环）。
  const live = edges.filter((edge, index) => edge.layers.length > 0 && records[index]?.eligible === true)
  const reached = new Set(records.filter((record) => record.eligible).map((record) => record.target))
  const hasIncoming = new Set(records.map((record) => record.target))
  const emitting = new Set(records.filter((record) => record.eligible && !hasIncoming.has(record.source)).map((record) => record.source))
  const nodes: NodeRecord[] = []
  for (const el of nodeEls) {
    const id = el.dataset.flowNode ?? ''
    if (!reached.has(id) && !emitting.has(id)) continue
    const flash = el.querySelector<HTMLElement>('[data-signal-flash]')
    const port = el.querySelector<HTMLElement>('[data-signal-port]')
    const icon = el.querySelector<HTMLElement>('[data-signal-icon]')
    const ring = el.querySelector<HTMLElement>('[data-signal-ring]')
    if (flash === null && port === null && icon === null && ring === null) continue
    nodes.push({ arrival: plan.arrival.get(id) ?? 0, flash, port, icon, ring, active: false })
  }

  let elapsed = 0
  const step = (dt: number): void => {
    elapsed += dt
    const travelled = elapsed * params.speed
    const phase = travelled % spacing
    for (const edge of live) {
      const head = headOnEdge(edge.a, edge.length, phase, spacing)
      if (head === null) { hide(edge); continue }
      show(edge)
      const layers = edge.layers
      for (let index = 0; index < layers.length; index += 1) layers[index]?.setAttribute('stroke-dashoffset', String(mod(edge.a + (STREAK_LAYERS[index]?.length ?? 0) - phase, spacing)))
    }
    for (const node of nodes) {
      if (travelled < node.arrival) { if (node.active) resetNode(node); continue }
      const since = ((travelled - node.arrival) % spacing) / params.speed
      if (since >= Math.max(ARRIVE_TOTAL, ARRIVE.ring)) { if (node.active) resetNode(node); continue }
      node.active = true
      if (node.flash !== null) node.flash.style.opacity = String(arrivalGlow(since) * params.opacity)
      if (node.port !== null) node.port.style.opacity = String(portGlow(since))
      if (node.icon !== null) {
        const mix = Math.round(iconGlow(since) * 100)
        node.icon.style.color = mix === 0 ? '' : `color-mix(in srgb, var(--accent) ${mix}%, var(--text-3))`
      }
      if (node.ring !== null) {
        const frame = ringFrame(since)
        node.ring.style.opacity = frame === null ? '0' : String(frame.opacity * params.opacity)
        node.ring.style.transform = frame === null ? '' : `scale(${frame.scale})`
      }
    }
  }
  return {
    total: edges.length,
    edgeCount: live.length,
    hotCount: () => live.filter((edge) => edge.hot).length,
    step,
    animated: true,
    dispose: () => { for (const edge of edges) hide(edge); for (const node of nodes) resetNode(node) },
  }
}

export interface SignalOptions {
  /** 阻塞在这个节点前（评审门）：静态停一颗彗星，不流动。 */
  readonly hold?: string | null
  /** 图 / 状态变了就换一个值：换了就重建运行时。 */
  readonly signature?: string
  /** 画布上应有的可流动的边数：DOM 里的边还没画全（React Flow 量完节点才画边）就先等等再建。 */
  readonly expected?: number
}

/**
 * 画布的 Signal：mode / hold / signature 任一变化就丢掉旧运行时、晚一拍重建。off、卸载时什么都不留；
 * 减少动态效果一律按 still（只留静态高亮）；标签页隐藏时摘掉 ticker，回来接着走。
 */
export function useSignal(container: RefObject<HTMLElement | null>, mode: SignalMode, options: SignalOptions = {}): void {
  const { hold = null, signature = '', expected } = options
  useEffect(() => {
    const root = container.current
    if (root === null || mode === 'off') return
    const query = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null
    let runtime: SignalRuntime | null = null
    let attached = false
    let attempts = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = (_time: number, deltaMs: number): void => { runtime?.step(Math.min(deltaMs, 100) / 1000) }
    const detach = (): void => { if (attached) { gsap.ticker.remove(tick); attached = false } }
    const attach = (): void => { if (!attached && runtime?.animated === true && !document.hidden) { gsap.ticker.add(tick); attached = true } }
    const stop = (): void => { detach(); runtime?.dispose(); runtime = null }
    const start = (): void => {
      clearTimeout(timer)
      stop()
      const still = mode === 'still' || prefersReducedMotion()
      if (still && hold === null) return
      runtime = createSignalRuntime(root, still ? 'still' : mode, hold)
      // React Flow 量完节点才画边：边没画全就先放掉这一版，隔一会儿再建（最多等 RETRY_LIMIT 次）。
      if ((runtime?.total ?? 0) < (expected ?? 1) && attempts < RETRY_LIMIT) {
        attempts += 1
        stop()
        timer = setTimeout(start, BUILD_DELAY_MS)
        return
      }
      attach()
    }
    const onVisibility = (): void => { if (document.hidden) detach(); else attach() }
    timer = setTimeout(start, BUILD_DELAY_MS)
    query?.addEventListener?.('change', start)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      clearTimeout(timer)
      query?.removeEventListener?.('change', start)
      document.removeEventListener('visibilitychange', onVisibility)
      stop()
    }
  }, [container, mode, hold, signature, expected])
}

/** 用户的减少动态效果偏好（随系统设置实时变化）。 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion)
  useEffect(() => {
    const query = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null
    const update = (): void => setReduced(prefersReducedMotion())
    query?.addEventListener?.('change', update)
    return () => query?.removeEventListener?.('change', update)
  }, [])
  return reduced
}

/** 容器是否在视口里（没有 IntersectionObserver 的环境按「在」处理）。 */
export function useOnScreen(container: RefObject<HTMLElement | null>): boolean {
  const [visible, setVisible] = useState(true)
  useEffect(() => {
    const element = container.current
    if (element === null || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1]
      if (entry !== undefined) setVisible(entry.isIntersecting)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [container])
  return visible
}
