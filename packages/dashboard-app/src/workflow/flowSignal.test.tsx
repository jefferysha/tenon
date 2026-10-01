import { useRef } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import gsap from 'gsap'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AMBIENT, ARRIVE, STREAK_LAYERS, STREAK_REACH, RUNNING, arrivalGlow, createSignalRuntime, headOnEdge, iconGlow, offsetsFor, parkedAt, planSignal,
  portGlow, ringFrame, signalModeOf, signalParams, useSignal, type SignalEdgeInput, type SignalMode, type SignalNodeInput,
} from './flowSignal'

const edge = (id: string, source: string, target: string, length: number, lead?: number): SignalEdgeInput => ({ id, source, target, length, ...(lead === undefined ? {} : { lead }) })
const node = (id: string, transit = 0): SignalNodeInput => ({ id, transit })

describe('planSignal · 到达距离', () => {
  it('串行：a(e) = arrival(源) + transit(源)；arrival(节点) = 入边 a + 边长；routeLen = 最晚到达', () => {
    const plan = planSignal(
      [edge('s>a', 'start', 'a', 40), edge('a>b', 'a', 'b', 26), edge('b>end', 'b', 'end', 190)],
      [node('start', 12), node('a', 32), node('b', 32), node('end', 12)],
    )
    expect(plan.a.get('s>a')).toBe(12)
    expect(plan.arrival.get('a')).toBe(52)
    expect(plan.a.get('a>b')).toBe(52 + 32)
    expect(plan.arrival.get('b')).toBe(84 + 26)
    expect(plan.a.get('b>end')).toBe(110 + 32)
    expect(plan.arrival.get('end')).toBe(142 + 190)
    expect(plan.routeLen).toBe(332)
  })

  it('恒速：无论边多长多短，头部走完这条边都恰好是 边长 / v——26px 的边与 190px 的边没有 8 倍的速度差', () => {
    const plan = planSignal([edge('short', 'a', 'b', 26), edge('long', 'b', 'c', 190)], [node('a', 0), node('b', 0), node('c', 0)])
    // 头部从 a(e) 走到目标的到达距离，恰是边长：时间 = 边长 / v，没有 PULSE_MIN_LEG 那样的下限把短边拉慢。
    expect((plan.arrival.get('b') ?? 0) - (plan.a.get('short') ?? 0)).toBe(26)
    expect((plan.arrival.get('c') ?? 0) - (plan.a.get('long') ?? 0)).toBe(190)
    const speed = 140
    expect((plan.arrival.get('c') ?? 0) / speed).toBeCloseTo((26 + 190) / speed)
  })

  it('分叉：同一源出发的各支共享同一个 a，各自按自己的边长到达', () => {
    const plan = planSignal(
      [edge('r>a', 'r', 'a', 100), edge('r>b', 'r', 'b', 30), edge('r>c', 'r', 'c', 240)],
      [node('r', 20), node('a', 20), node('b', 20), node('c', 20)],
    )
    expect(new Set(['r>a', 'r>b', 'r>c'].map((id) => plan.a.get(id))).size).toBe(1)
    expect([plan.arrival.get('a'), plan.arrival.get('b'), plan.arrival.get('c')]).toEqual([120, 50, 260])
  })

  it('汇合：汇合点等最慢的一支；汇合后的出边从最慢那支到达之后开始', () => {
    const plan = planSignal(
      [edge('r>a', 'r', 'a', 100), edge('r>b', 'r', 'b', 30), edge('a>j', 'a', 'j', 10), edge('b>j', 'b', 'j', 10), edge('j>z', 'j', 'z', 50)],
      [node('r', 0), node('a', 20), node('b', 20), node('j', 2), node('z', 0)],
    )
    expect(plan.arrival.get('a')).toBe(100)
    expect(plan.arrival.get('b')).toBe(30)
    // a 支：100 + 20 + 10 = 130；b 支：30 + 20 + 10 = 60 → 汇合点 130。
    expect(plan.arrival.get('j')).toBe(130)
    expect(plan.a.get('j>z')).toBe(132)
    expect(plan.arrival.get('z')).toBe(182)
  })

  it('到达顺序：沿任何一条边，目标的到达距离都大于源；无入边的起点是 0', () => {
    const edges = [edge('s>a', 's', 'a', 20), edge('a>b', 'a', 'b', 20), edge('a>c', 'a', 'c', 60), edge('b>d', 'b', 'd', 20), edge('c>d', 'c', 'd', 20), edge('d>e', 'd', 'e', 20)]
    const plan = planSignal(edges, ['s', 'a', 'b', 'c', 'd', 'e'].map((id) => node(id, 8)))
    expect(plan.arrival.get('s')).toBe(0)
    for (const item of edges) expect(plan.arrival.get(item.target)!).toBeGreaterThan(plan.arrival.get(item.source)!)
    const order = ['s', 'a', 'b', 'c', 'd', 'e'].map((id) => plan.arrival.get(id)!)
    expect(order.every((value, index) => index === 0 || value >= order[index - 1]!)).toBe(true)
    expect(plan.arrival.get('d')).toBe(Math.max((plan.arrival.get('b') ?? 0) + 8 + 20, (plan.arrival.get('c') ?? 0) + 8 + 20))
  })

  it('lead 覆盖源节点的 transit（标题往下走的那一跳只算一个标题高度）', () => {
    const plan = planSignal([edge('h>x', 'h', 'x', 30, 40), edge('h>n', 'h', 'n', 40)], [node('h', 216), node('x', 0), node('n', 0)])
    expect(plan.a.get('h>x')).toBe(40)
    expect(plan.a.get('h>n')).toBe(216)
  })

  it('after：主线的下一跳等上一列走完——信号一列一列过，总路线是各列之和，而不是并行取最长', () => {
    const plan = planSignal(
      [edge('h1>c1', 'h1', 'c1', 40, 30), edge('c1>c2', 'c1', 'c2', 60), { ...edge('h1>h2', 'h1', 'h2', 40), after: ['c2'] }, edge('h2>c3', 'h2', 'c3', 50, 30)],
      [node('h1', 100), node('c1', 32), node('c2', 32), node('h2', 100), node('c3', 32)],
    )
    // 列 1：h1 → c1 → c2 在 162 到达；主线那一跳从 162 + 32 开始，而不是从 h1 的出口（100）。
    expect(plan.arrival.get('c2')).toBe(30 + 40 + 32 + 60)
    expect(plan.a.get('h1>h2')).toBe(194)
    expect(plan.arrival.get('h2')).toBe(194 + 40)
    expect(plan.a.get('h2>c3')).toBe(234 + 30)
    expect(plan.arrival.get('c3')).toBe(264 + 50)
  })

  it('有环不会死循环', () => {
    const plan = planSignal([edge('a>b', 'a', 'b', 10), edge('b>a', 'b', 'a', 10)], [node('a'), node('b')])
    expect(Number.isFinite(plan.routeLen)).toBe(true)
  })
})

describe('彗星几何', () => {
  it('四层的 dash 长度是 72 / 48 / 26 / 10，光晕最长', () => {
    expect(STREAK_LAYERS.map((layer) => layer.length)).toEqual([72, 48, 26, 10])
    expect(STREAK_REACH).toBe(72)
    expect(STREAK_LAYERS.map((layer) => layer.width)).toEqual([4, 1.5, 2, 2.5])
    expect(STREAK_LAYERS.map((layer) => layer.opacity)).toEqual([0.14, 0.3, 0.55, 1])
  })

  it('offsetsFor：把 dash 的亮段对到 [head − L, head]——边上的点亮，当且仅当它的路线坐标落在彗星窗口里', () => {
    const spacing = 360
    const a = 500
    const length = 120
    const head = 540
    const offsets = offsetsFor(a, length, head, spacing)
    expect(offsets).not.toBeNull()
    STREAK_LAYERS.forEach((layer, index) => {
      for (let s = 0; s <= length; s += 3) {
        const lit = (((s + offsets![index]!) % spacing) + spacing) % spacing < layer.length
        const inside = a + s >= head - layer.length && a + s <= head
        expect(lit, `层 ${layer.id} s=${s}`).toBe(inside)
      }
    })
  })

  it('offsetsFor：头部还没到边起点，或光晕整个越过边终点 = 冷边', () => {
    expect(offsetsFor(100, 50, 99, 360)).toBeNull()
    expect(offsetsFor(100, 50, 100, 360)).not.toBeNull()
    expect(offsetsFor(100, 50, 150 + STREAK_REACH, 360)).not.toBeNull()
    expect(offsetsFor(100, 50, 150 + STREAK_REACH + 1, 360)).toBeNull()
  })

  it('headOnEdge：传送带每隔一个间距一颗彗星；只返回还碰着这条边的那一颗（头部到过起点、光晕未越过终点）', () => {
    const spacing = 320
    expect(headOnEdge(100, 40, 130, spacing)).toBe(130)
    // 下一颗头部在 340，光晕 268–340 碰不到 [100, 140]。
    expect(headOnEdge(100, 40, 20, spacing)).toBeNull()
    expect(headOnEdge(300, 40, 20, spacing)).toBe(340)
    expect(headOnEdge(400, 40, 20, spacing)).toBeNull()
    // 头部已越过边终点，但光晕的尾巴还在边上。
    expect(headOnEdge(100, 40, 140 + STREAK_REACH, spacing)).toBe(140 + STREAK_REACH)
    expect(headOnEdge(100, 40, 141 + STREAK_REACH, spacing)).toBeNull()
  })

  it('速度与间距：空闲 140px/s、间距 clamp(路线 / 3, 320, 720)、×0.7；运行 300px/s、间距 360、×1', () => {
    expect(signalParams('ambient', 2600)).toEqual({ speed: 140, spacing: 720, opacity: 0.7 })
    expect(signalParams('ambient', 500).spacing).toBe(320)
    expect(signalParams('ambient', 1200).spacing).toBe(400)
    expect(signalParams('running', 2600)).toEqual({ speed: 300, spacing: 360, opacity: 1 })
    expect(AMBIENT.speed).toBe(140)
    expect(RUNNING.speed).toBe(300)
  })
})

describe('评审门停住', () => {
  const edges = [edge('s>a', 's', 'a', 60), edge('a>g', 'a', 'g', 40), edge('g>z', 'g', 'z', 80), edge('a>y', 'a', 'y', 30)]
  const plan = planSignal(edges, ['s', 'a', 'g', 'z', 'y'].map((id) => node(id, 10)))

  it('彗星停在门的到达距离上：通向门的那条边亮着，门之后的边永远拿不到偏移', () => {
    const parked = parkedAt(plan, edges, 'g', 320)
    expect(parked.has('a>g')).toBe(true)
    expect(parked.has('g>z')).toBe(false)
    // 头部在门的到达距离上；它的偏移把亮核对在这条边的末端。
    const head = plan.arrival.get('g')!
    expect(parked.get('a>g')).toEqual(offsetsFor(plan.a.get('a>g')!, 40, head, 320))
  })

  it('旁支不受牵连地保持冷：不在光晕范围内的边没有偏移', () => {
    const parked = parkedAt(plan, edges, 'g', 320)
    expect(parked.has('a>y')).toBe(false)
  })

  it('不存在的门 = 没有任何亮边', () => {
    expect(parkedAt(plan, edges, 'nope', 320).size).toBe(0)
  })
})

describe('节点到达反馈', () => {
  it('边框 + 光晕：90ms 升到 1，520ms 降回 0，共 610ms', () => {
    expect(arrivalGlow(0)).toBe(0)
    expect(arrivalGlow(ARRIVE.rise)).toBeCloseTo(1)
    expect(arrivalGlow(ARRIVE.rise / 2)).toBeGreaterThan(0.5)
    expect(arrivalGlow(ARRIVE.rise + ARRIVE.decay / 2)).toBeLessThan(0.3)
    expect(arrivalGlow(ARRIVE.rise + ARRIVE.decay)).toBe(0)
    expect(arrivalGlow(-0.1)).toBe(0)
  })

  it('端口点亮 300ms；图标 200ms 转强调色后随光晕退去；光环 600ms 内外扩到 2.2 倍并淡出', () => {
    expect(portGlow(0.29)).toBe(1)
    expect(portGlow(0.3)).toBe(0)
    expect(iconGlow(ARRIVE.icon)).toBeCloseTo(1)
    expect(iconGlow(0.61)).toBe(0)
    expect(ringFrame(0)).toEqual({ scale: 1, opacity: 0.35 })
    const late = ringFrame(0.599)!
    expect(late.scale).toBeGreaterThan(2.1)
    expect(late.opacity).toBeLessThan(0.01)
    expect(ringFrame(0.6)).toBeNull()
  })
})

describe('signalModeOf', () => {
  it('看不见就停；阻塞或减少动态效果只留静态；在跑用运行流，否则环境流', () => {
    expect(signalModeOf({ visible: false, running: true, blocked: false })).toBe('off')
    expect(signalModeOf({ visible: true, running: false, blocked: true })).toBe('still')
    expect(signalModeOf({ visible: true, running: true, blocked: false, reduced: true })).toBe('still')
    expect(signalModeOf({ visible: true, running: true, blocked: false })).toBe('running')
    expect(signalModeOf({ visible: true, running: false, blocked: false })).toBe('ambient')
  })
})

interface Stub { id: string; source: string; target: string; length: number; state?: string; lead?: number; stub?: boolean }

function stubLengths(): void {
  Object.defineProperty(SVGElement.prototype, 'getTotalLength', { configurable: true, value(this: SVGElement) { return Number(this.getAttribute('data-length') ?? 0) } })
}

/** 与画布同构的 DOM：每条边一组四层 path（长度由 data-length 给出），每个节点带 data-transit 与到达反馈层。 */
function Canvas({ mode, edges, nodes, hold = null, expected = edges.length }: { mode: SignalMode; edges: readonly Stub[]; nodes: readonly SignalNodeInput[]; hold?: string | null; expected?: number }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useSignal(ref, mode, { hold, expected })
  return (
    <div ref={ref}>
      <svg>
        {edges.map((item) => (
          <g key={item.id} data-signal-edge={item.id} data-signal-source={item.source} data-signal-target={item.target} data-signal-state={item.state ?? 'todo'} data-signal-lead={item.lead} data-signal-static={item.stub === true ? '' : undefined} data-signal-length={item.stub === true ? item.length : undefined} visibility="hidden">
            {item.stub !== true && STREAK_LAYERS.map((layer) => <path key={layer.id} d={`M0 0 L${item.length} 0 #${item.id}`} data-length={item.length} data-signal-layer={layer.id} />)}
          </g>
        ))}
      </svg>
      {nodes.map((item) => (
        <div key={item.id} data-flow-node={item.id} data-transit={item.transit}>
          <span data-signal-flash="" />
          <span data-signal-port="" />
          <span data-signal-ring="" />
        </div>
      ))}
    </div>
  )
}

const EDGES: Stub[] = [
  { id: 'start>a', source: 'start', target: 'a', length: 50 },
  { id: 'a>b', source: 'a', target: 'b', length: 60 },
  { id: 'b>end', source: 'b', target: 'end', length: 500 },
]
const NODES: SignalNodeInput[] = [node('start', 12), node('a', 32), node('b', 32), node('end', 12)]

function mount(mode: SignalMode = 'ambient', edges: readonly Stub[] = EDGES, extra: { hold?: string | null } = {}) {
  return render(<Canvas mode={mode} edges={edges} nodes={NODES} {...extra} />)
}

function stubMatchMedia(reduce: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('reduce') ? reduce : !reduce,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }))
}

describe('createSignalRuntime · 只写热边', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('每帧只有彗星窗口碰到的边是 visible，其余保持 hidden；亮着的边 4 层 dashoffset 都被写', () => {
    stubLengths()
    const { container } = mount('off')
    const runtime = createSignalRuntime(container, 'ambient')!
    expect(runtime.animated).toBe(true)
    expect(runtime.total).toBe(3)
    runtime.step(0.05)
    const groups = [...container.querySelectorAll<SVGGElement>('g[data-signal-edge]')]
    const visible = groups.filter((group) => group.getAttribute('visibility') === 'visible')
    expect(visible.length).toBe(runtime.hotCount())
    expect(visible.length).toBeLessThan(groups.length)
    for (const group of visible) expect([...group.querySelectorAll('path')].every((path) => path.hasAttribute('stroke-dashoffset'))).toBe(true)
    for (const group of groups.filter((item) => !visible.includes(item))) expect(group.getAttribute('visibility')).toBe('hidden')
    runtime.dispose()
    expect(groups.every((group) => group.getAttribute('visibility') === 'hidden')).toBe(true)
  })

  it('dasharray = "L, 间距 − L"；描边不透明度 = 层不透明度 × 模式系数（环境 ×0.7、运行 ×1）', () => {
    stubLengths()
    const { container } = mount('off')
    createSignalRuntime(container, 'ambient')
    const core = container.querySelector('g[data-signal-edge="a>b"] path[data-signal-layer="core"]')!
    // 路线 686px（12 + 50 + 32 + 60 + 32 + 500）→ 间距取下限 320。
    expect(core.getAttribute('stroke-dasharray')).toBe('10 310')
    expect(Number(core.getAttribute('stroke-opacity'))).toBeCloseTo(0.7)
    createSignalRuntime(container, 'running')
    expect(container.querySelector('g[data-signal-edge="a>b"] path[data-signal-layer="core"]')!.getAttribute('stroke-dasharray')).toBe('10 350')
    expect(Number(container.querySelector('g[data-signal-edge="a>b"] path[data-signal-layer="core"]')!.getAttribute('stroke-opacity'))).toBe(1)
  })

  it('已完成的边（state=done）不参与流动，永远 hidden', () => {
    stubLengths()
    const { container } = mount('off', EDGES.map((item) => (item.id === 'start>a' ? { ...item, state: 'done' } : item)))
    const runtime = createSignalRuntime(container, 'running')!
    expect(runtime.edgeCount).toBe(2)
    for (let frame = 0; frame < 120; frame += 1) runtime.step(1 / 60)
    expect(container.querySelector('g[data-signal-edge="start>a"]')!.getAttribute('visibility')).toBe('hidden')
  })

  it('传送带跑起来后每一条边都会被彗星扫过（信号从起点一路到终点）', () => {
    stubLengths()
    const { container } = mount('off')
    const runtime = createSignalRuntime(container, 'ambient')!
    const seen = new Set<string>()
    for (let frame = 0; frame < 60 * 12; frame += 1) {
      runtime.step(1 / 60)
      for (const group of container.querySelectorAll<SVGGElement>('g[data-signal-edge]')) if (group.getAttribute('visibility') === 'visible') seen.add(group.dataset.signalEdge ?? '')
    }
    expect([...seen].sort()).toEqual(['a>b', 'b>end', 'start>a'])
  })

  it('节点收到彗星时到达反馈层亮起、随后退回 0（只写 opacity）；起点每放出一颗放一圈光环', () => {
    stubLengths()
    const { container } = mount('off')
    const runtime = createSignalRuntime(container, 'running')!
    const flashOf = (id: string): HTMLElement => container.querySelector<HTMLElement>(`[data-flow-node="${id}"] [data-signal-flash]`)!
    const ringOf = (id: string): HTMLElement => container.querySelector<HTMLElement>(`[data-flow-node="${id}"] [data-signal-ring]`)!
    // 节点 a 的到达距离 = 起点 transit 12 + 边长 50 = 62；运行速度 300px/s。
    const glow: number[] = []
    let ringed = false
    for (let frame = 0; frame < 60 * 2; frame += 1) {
      runtime.step(1 / 60)
      glow.push(Number(flashOf('a').style.opacity || 0))
      if (ringOf('start').style.opacity !== '' && Number(ringOf('start').style.opacity) > 0) ringed = true
    }
    expect(Math.max(...glow)).toBeGreaterThan(0.5)
    expect(glow.some((value) => value === 0)).toBe(true)
    expect(ringed).toBe(true)
  })

  it('still + hold：不动，一颗彗星停在门前；门之后的边保持 hidden', () => {
    stubLengths()
    const { container } = mount('off')
    const runtime = createSignalRuntime(container, 'still', 'b')!
    expect(runtime.animated).toBe(false)
    expect(container.querySelector('g[data-signal-edge="a>b"]')!.getAttribute('visibility')).toBe('visible')
    expect(container.querySelector('g[data-signal-edge="b>end"]')!.getAttribute('visibility')).toBe('hidden')
    runtime.step(5)
    expect(container.querySelector('g[data-signal-edge="a>b"]')!.getAttribute('visibility')).toBe('visible')
  })

  it('短线（stub）只登记长度：算进规划与到达反馈，但没有彗星层、永远 hidden', () => {
    stubLengths()
    const withStub: Stub[] = [
      { id: 'start>sp', source: 'start', target: 'sp', length: 60 },
      { id: 'sp>sp2', source: 'sp', target: 'sp2', length: 80 },
      { id: 'sp>a', source: 'sp', target: 'a', length: 8, stub: true },
      { id: 'sp2>b', source: 'sp2', target: 'b', length: 8, stub: true },
    ]
    const nodes: SignalNodeInput[] = [node('start', 12), node('sp', 0), node('sp2', 0), node('a', 32), node('b', 32)]
    const { container } = render(<Canvas mode="off" edges={withStub} nodes={nodes} />)
    const runtime = createSignalRuntime(container, 'running')!
    expect(runtime.total).toBe(4)
    expect(runtime.edgeCount).toBe(2)
    const flashOf = (id: string): HTMLElement => container.querySelector<HTMLElement>(`[data-flow-node="${id}"] [data-signal-flash]`)!
    const glow = { a: 0, b: 0 }
    for (let frame = 0; frame < 60 * 3; frame += 1) {
      runtime.step(1 / 60)
      glow.a = Math.max(glow.a, Number(flashOf('a').style.opacity || 0))
      glow.b = Math.max(glow.b, Number(flashOf('b').style.opacity || 0))
      for (const id of ['sp>a', 'sp2>b']) expect(container.querySelector(`g[data-signal-edge="${id}"]`)!.getAttribute('visibility')).toBe('hidden')
    }
    // 彗星只走脊柱，经过汇合点时条目收到反馈。
    expect(glow.a).toBeGreaterThan(0.5)
    expect(glow.b).toBeGreaterThan(0.5)
    runtime.dispose()
  })

  it('没有可量的边（jsdom 没有 getTotalLength）返回 null', () => {
    expect(createSignalRuntime(document.createElement('div'), 'ambient')).toBeNull()
  })
})

describe('useSignal · 单一时钟', () => {
  afterEach(() => {
    cleanup()
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('ambient：晚一拍建好后向 gsap.ticker 只挂一个回调；卸载摘掉，边全部 hidden', () => {
    vi.useFakeTimers()
    stubLengths()
    stubMatchMedia(false)
    const add = vi.spyOn(gsap.ticker, 'add')
    const remove = vi.spyOn(gsap.ticker, 'remove')
    const view = mount('ambient')
    act(() => { vi.advanceTimersByTime(200) })
    expect(add).toHaveBeenCalledTimes(1)
    view.unmount()
    // gsap.ticker.add 自己会先 remove 一次同一个回调去重，所以看最后一次摘的是不是我们挂的那个。
    expect(remove.mock.calls.at(-1)![0]).toBe(add.mock.calls[0]![0])
  })

  it('off / 减少动态效果 / 没有 hold 的 still 都不挂 ticker', () => {
    vi.useFakeTimers()
    stubLengths()
    const add = vi.spyOn(gsap.ticker, 'add')
    stubMatchMedia(false)
    mount('off').unmount()
    mount('still').unmount()
    stubMatchMedia(true)
    mount('ambient').unmount()
    act(() => { vi.advanceTimersByTime(500) })
    expect(add).not.toHaveBeenCalled()
  })

  it('still + hold：建一次静态停靠的彗星，不挂 ticker', () => {
    vi.useFakeTimers()
    stubLengths()
    stubMatchMedia(false)
    const add = vi.spyOn(gsap.ticker, 'add')
    const view = mount('still', EDGES, { hold: 'b' })
    act(() => { vi.advanceTimersByTime(200) })
    expect(add).not.toHaveBeenCalled()
    expect(view.container.querySelector('g[data-signal-edge="a>b"]')!.getAttribute('visibility')).toBe('visible')
  })

  it('标签页隐藏时摘掉 ticker，回来再挂', () => {
    vi.useFakeTimers()
    stubLengths()
    stubMatchMedia(false)
    const add = vi.spyOn(gsap.ticker, 'add')
    const remove = vi.spyOn(gsap.ticker, 'remove')
    mount('ambient')
    act(() => { vi.advanceTimersByTime(200) })
    expect(add).toHaveBeenCalledTimes(1)
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(remove.mock.calls.at(-1)![0]).toBe(add.mock.calls[0]![0])
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(add).toHaveBeenCalledTimes(2)
  })

  it('边还没画全（expected 大于 DOM 里的边）就等一等再建，画全了才挂 ticker', () => {
    vi.useFakeTimers()
    stubLengths()
    stubMatchMedia(false)
    const add = vi.spyOn(gsap.ticker, 'add')
    const view = render(<Canvas mode="ambient" edges={EDGES.slice(0, 2)} nodes={NODES} expected={3} />)
    act(() => { vi.advanceTimersByTime(130) })
    expect(add).not.toHaveBeenCalled()
    view.rerender(<Canvas mode="ambient" edges={EDGES} nodes={NODES} expected={3} />)
    act(() => { vi.advanceTimersByTime(130) })
    expect(add).toHaveBeenCalledTimes(1)
  })
})
