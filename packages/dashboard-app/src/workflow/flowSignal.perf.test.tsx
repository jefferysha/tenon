import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FlowStage } from '../api/workflowOrchestrationClient'
import { STREAK_LAYERS, createSignalRuntime, type SignalMode, type SignalRuntime } from './flowSignal'
import { layoutOrchestration } from './orchestrationLayout'

/** 彗星头部位置每被算一次记一次：每帧的纯计算量是确定性的，不看时钟（计数器本身只是一次加法，不影响下面的耗时批）。 */
const counted = vi.hoisted(() => ({ headOnEdge: 0 }))
vi.mock('./signalPlan', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./signalPlan')>()
  return { ...actual, headOnEdge: (...args: Parameters<typeof actual.headOnEdge>) => { counted.headOnEdge += 1; return actual.headOnEdge(...args) } }
})

/**
 * Signal 每帧脚本的规模护栏：在 8 列、约 50 个节点的前端总览布局上，把真实的 layoutOrchestration 画成与画布同构的 DOM
 * （每条边 4 层 path，节点带到达反馈层），然后让运行时连跑 10 秒的帧。
 *
 * 护栏分两层，都不依赖 jsdom 的墙钟绝对值：
 *   1. 确定性断言（不看时钟）：每帧的 DOM 写入次数、写入对象、有没有布局读取、每条边每帧只算一次彗星位置，以及输入 ×8 时写入只线性增长。
 *   2. 耗时只量 step 本身：每批连跑 120 帧，取最快一批的每帧均值（并行的测试进程、GC 与调度只会让某一批变慢）；
 *      绝对线 2ms 约是本机的 20 倍以上，增长倍数线 16 比线性实测（约 5 到 7）高出一倍多、又在平方级退化之下。
 * 真实 Chromium 里每帧的脚本 / 样式 / 布局耗时（CDP Performance.getMetrics，中位数预算 + p95 报告）在 e2e/dashboard/workflow.spec.ts：
 * jsdom 里的单帧耗时在慢 CI 上会飘出数倍，p95 在那里没有意义。
 */
const SVG = 'http://www.w3.org/2000/svg'
const EDGE_SELECTOR = 'g[data-signal-edge]'
/** 输入放大的倍数（线性输入 ×8；平方级的退化会涨到 ×64）。 */
const WIDE = 8
/** 一批连跑的帧数、量几批；预热两批不计。 */
const BATCH_FRAMES = 120
const ROUNDS = 9
/** 每帧 step 耗时的绝对线（毫秒）与输入 ×8 时的增长倍数线。 */
const FRAME_BUDGET_MS = 2
const GROWTH_CEILING = 16

function entry(kind: 'executor' | 'skill' | 'test' | 'reviewer', id: string, wave: number, dependsOn: string[] = []) {
  return { kind, id, label: id, wave, dependsOn, required: true, source: 'declared' as const }
}

/**
 * 八列：立项 1、调研 5、规格 2、设计 6、实现 7、验证 12、交付 9、完结 8 —— scale 为 1 时合计 50 个条目，含并行与汇合。
 * scale 把每一列的链长与并行块的份数都放大同样的倍数。
 */
function frontendStages(scale = 1): FlowStage[] {
  const chain = (prefix: string, count: number): FlowStage['entries'] => Array.from({ length: count }, (_unused, index) => entry('skill', `${prefix}${index}`, index, index === 0 ? [] : [`${prefix}${index - 1}`]))
  const parallel = (prefix: string): FlowStage['entries'] => [
    entry('skill', `${prefix}a`, 0), entry('skill', `${prefix}b`, 1, [`${prefix}a`]), entry('skill', `${prefix}c`, 1, [`${prefix}a`]),
    entry('test', `${prefix}t1`, 2), entry('test', `${prefix}t2`, 2), entry('reviewer', `${prefix}r1`, 3), entry('reviewer', `${prefix}r2`, 3),
    entry('reviewer', `${prefix}r3`, 4, [`${prefix}r1`, `${prefix}r2`]),
  ]
  const sizes = [1, 5, 2, 6, 7, 12, 9, 8]
  return sizes.map((count, index): FlowStage => ({
    id: `s${index}`,
    label: `阶段 ${index}`,
    gate: index % 2 === 0 ? 'auto' : 'review',
    entries: index === 5
      ? [...chain('v', 4 * scale), ...Array.from({ length: scale }, (_unused, copy) => parallel(`w${copy}_`)).flat()]
      : chain(`n${index}_`, count * scale),
  }))
}

function build(scale = 1): { root: HTMLElement; nodes: number; edges: number; streaks: number } {
  const layout = layoutOrchestration(frontendStages(scale), 'overview')
  const root = document.createElement('div')
  const svg = document.createElementNS(SVG, 'svg')
  root.append(svg)
  const point = (id: string): { x: number; y: number } => {
    const box = [...layout.stages, ...layout.entries].find((item) => item.id === id)
    if (box !== undefined) return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    const junction = layout.junctions.find((item) => item.id === id)
    if (junction !== undefined) return { x: junction.x, y: junction.y }
    const port = id === 'start' ? layout.ports.start : layout.ports.end
    return { x: port.x, y: port.y }
  }
  for (const edge of layout.edges) {
    const group = document.createElementNS(SVG, 'g')
    group.setAttribute('data-signal-edge', edge.id)
    group.setAttribute('data-signal-source', edge.source)
    group.setAttribute('data-signal-target', edge.target)
    group.setAttribute('data-signal-state', 'todo')
    group.setAttribute('visibility', 'hidden')
    if (edge.lead !== undefined) group.setAttribute('data-signal-lead', String(edge.lead))
    if (edge.after !== undefined && edge.after.length > 0) group.setAttribute('data-signal-after', edge.after.join(' '))
    const from = point(edge.source)
    const to = point(edge.target)
    const length = Math.max(1, Math.abs(to.x - from.x) + Math.abs(to.y - from.y))
    if (edge.stub === true) {
      // 总览脊柱通向条目的短线：只登记长度，不带彗星层。
      group.setAttribute('data-signal-static', '')
      group.setAttribute('data-signal-length', String(length))
    } else {
      for (const layer of STREAK_LAYERS) {
        const path = document.createElementNS(SVG, 'path')
        path.setAttribute('d', `M${from.x} ${from.y} L${to.x} ${to.y} #${edge.id}`)
        path.setAttribute('data-length', String(length))
        path.setAttribute('data-signal-layer', layer.id)
        group.append(path)
      }
    }
    svg.append(group)
  }
  const ids = ['start', 'end', ...layout.stages.map((stage) => stage.id), ...layout.entries.map((item) => item.id), ...layout.junctions.map((item) => item.id)]
  for (const id of ids) {
    const node = document.createElement('div')
    node.setAttribute('data-flow-node', id)
    node.setAttribute('data-transit', '32')
    for (const attribute of ['data-signal-flash', 'data-signal-port', 'data-signal-icon', 'data-signal-ring']) {
      const layer = document.createElement('span')
      layer.setAttribute(attribute, '')
      node.append(layer)
    }
    root.append(node)
  }
  return { root, nodes: layout.entries.length, edges: layout.edges.length, streaks: layout.edges.filter((edge) => edge.stub !== true).length }
}

type Mode = Exclude<SignalMode, 'off' | 'still'>

/** 建一张画布并起运行时（getTotalLength 由 beforeEach 装好）。 */
function mount(mode: Mode, scale = 1): { runtime: SignalRuntime; root: HTMLElement; nodes: number; edges: number; streaks: number } {
  const built = build(scale)
  const runtime = createSignalRuntime(built.root, mode)
  if (runtime === null) throw new Error('画布上没有可量的边')
  expect(runtime.total).toBe(built.edges)
  expect(runtime.edgeCount).toBe(built.streaks)
  return { runtime, ...built }
}

interface FrameAudit {
  /** 每帧里不符合「只写热边」的地方；空数组 = 全部合规。 */
  readonly violations: string[]
  /** 单帧里最多的 DOM 写入（属性 + 内联样式）与同时最多的热边。 */
  readonly maxWrites: number
  readonly hottest: number
}

/**
 * 连跑 frames 帧，每帧后用 MutationObserver 收这一帧的全部 DOM 写入，逐帧核对：
 *   · 每条在这一帧后可见（热）的边恰好写 4 次 stroke-dashoffset（每层一次）——多了说明在写冷边或重复写；
 *   · visibility 只在边冷热切换的那一帧写一次；
 *   · 冷边（这一帧后不可见）上没有任何 dashoffset 写入。
 * 节点的到达反馈走内联样式，只计入 maxWrites。
 */
function auditFrames(root: HTMLElement, runtime: SignalRuntime, frames: number): FrameAudit {
  const groups = [...root.querySelectorAll<SVGGElement>(EDGE_SELECTOR)]
  const visible = (): Set<Element> => new Set(groups.filter((group) => group.getAttribute('visibility') === 'visible'))
  const observer = new MutationObserver(() => undefined)
  observer.observe(root, { attributes: true, subtree: true })
  const violations: string[] = []
  let maxWrites = 0
  let hottest = 0
  let before = visible()
  for (let frame = 0; frame < frames; frame += 1) {
    runtime.step(1 / 60)
    const records = observer.takeRecords()
    const after = visible()
    let offsets = 0
    let visibility = 0
    for (const record of records) {
      if (record.attributeName === 'stroke-dashoffset') {
        offsets += 1
        const group = record.target instanceof Element ? record.target.closest(EDGE_SELECTOR) : null
        if (group === null || !after.has(group)) violations.push(`第 ${frame} 帧：写了冷边的 dashoffset`)
      } else if (record.attributeName === 'visibility') visibility += 1
    }
    const toggled = groups.filter((group) => before.has(group) !== after.has(group)).length
    if (offsets !== STREAK_LAYERS.length * after.size) violations.push(`第 ${frame} 帧：${after.size} 条热边应写 ${STREAK_LAYERS.length * after.size} 次 dashoffset，实际 ${offsets}`)
    if (visibility !== toggled) violations.push(`第 ${frame} 帧：${toggled} 条边冷热切换，visibility 写了 ${visibility} 次`)
    maxWrites = Math.max(maxWrites, records.length)
    hottest = Math.max(hottest, after.size)
    before = after
  }
  observer.disconnect()
  return { violations: violations.slice(0, 5), maxWrites, hottest }
}

/** 单次 step 的耗时（毫秒）：预热两批，量 ROUNDS 批，取最快一批的每帧均值。 */
function frameCostMs(runtime: SignalRuntime): number {
  const batch = (): number => {
    const started = performance.now()
    for (let frame = 0; frame < BATCH_FRAMES; frame += 1) runtime.step(1 / 60)
    return (performance.now() - started) / BATCH_FRAMES
  }
  batch()
  batch()
  let best = Number.POSITIVE_INFINITY
  for (let round = 0; round < ROUNDS; round += 1) best = Math.min(best, batch())
  return best
}

describe('Signal 性能 · 8 列 ~50 节点的前端总览', () => {
  let measured = 0
  beforeEach(() => {
    measured = 0
    Object.defineProperty(SVGElement.prototype, 'getTotalLength', { configurable: true, value(this: SVGElement) { measured += 1; return Number(this.getAttribute('data-length') ?? 0) } })
  })
  afterEach(() => {
    Reflect.deleteProperty(SVGElement.prototype, 'getTotalLength')
    vi.restoreAllMocks()
  })

  for (const mode of ['ambient', 'running'] as Mode[]) {
    describe(mode, () => {
      it('确定性：10 秒的帧里，每帧只写热边（每条 4 次 dashoffset），冷边零写入，visibility 只在切换时写', () => {
        const { runtime, root, nodes, streaks } = mount(mode)
        expect(nodes).toBeGreaterThanOrEqual(48)
        expect(nodes).toBeLessThanOrEqual(56)
        // 预热 JIT / 让热边集稳定，再逐帧核对 10 秒（600 帧 × 1/60s）。
        for (let frame = 0; frame < 120; frame += 1) runtime.step(1 / 60)
        const audit = auditFrames(root, runtime, 600)
        console.info(`[signal-perf] ${mode}: ${nodes} 节点 / ${streaks} 条带彗星的边，同时最多 ${audit.hottest} 条热边，单帧最多 ${audit.maxWrites} 次 DOM 写入`)
        expect(audit.violations).toEqual([])
        expect(audit.hottest).toBeGreaterThan(0)
        // 只写热边：同一帧里总有冷边不被碰。
        expect(audit.hottest).toBeLessThan(streaks)
        runtime.dispose()
      })

      it('确定性：帧里不量路径长度、不读布局、不查 DOM（路径长度只在建时量一次）', () => {
        const { runtime, edges } = mount(mode)
        // 每组一次建时测量，彗星层共用同一个 d 的长度缓存；之后每帧一次都不该再有。
        const builtWith = measured
        expect(builtWith).toBeGreaterThan(0)
        expect(builtWith).toBeLessThanOrEqual(edges)
        const reads = {
          getBoundingClientRect: vi.spyOn(Element.prototype, 'getBoundingClientRect'),
          querySelector: vi.spyOn(Element.prototype, 'querySelector'),
          querySelectorAll: vi.spyOn(Element.prototype, 'querySelectorAll'),
          getComputedStyle: vi.spyOn(window, 'getComputedStyle'),
        }
        for (let frame = 0; frame < 600; frame += 1) runtime.step(1 / 60)
        expect(measured).toBe(builtWith)
        expect(Object.fromEntries(Object.entries(reads).map(([name, spy]) => [name, spy.mock.calls.length]))).toEqual({ getBoundingClientRect: 0, querySelector: 0, querySelectorAll: 0, getComputedStyle: 0 })
        runtime.dispose()
      })

      it('确定性：每帧对每条参与流动的边只算一次彗星位置（计算量与边数同阶，不随输入平方增长）', () => {
        for (const scale of [1, WIDE]) {
          const { runtime } = mount(mode, scale)
          for (let frame = 0; frame < 30; frame += 1) runtime.step(1 / 60)
          const before = counted.headOnEdge
          for (let frame = 0; frame < 100; frame += 1) runtime.step(1 / 60)
          expect(counted.headOnEdge - before, `scale ×${scale}`).toBe(100 * runtime.edgeCount)
          runtime.dispose()
        }
      })

      it(`规模：输入 ×${WIDE} 时，单帧的 DOM 写入与热边最多线性增长（不是平方）`, () => {
        const base = mount(mode)
        const wide = mount(mode, WIDE)
        expect(wide.streaks).toBeGreaterThan(base.streaks * (WIDE - 2))
        for (const { runtime } of [base, wide]) for (let frame = 0; frame < 120; frame += 1) runtime.step(1 / 60)
        const small = auditFrames(base.root, base.runtime, 300)
        const large = auditFrames(wide.root, wide.runtime, 300)
        expect(small.violations).toEqual([])
        expect(large.violations).toEqual([])
        // 带彗星的边多了几倍，同一帧的热边与写入至多再多这么多倍（再留 50% 余量）；平方级的退化会涨到 ×64。
        const growth = wide.streaks / base.streaks
        expect(large.hottest, `热边 ${small.hottest} → ${large.hottest}，边 ×${growth.toFixed(1)}`).toBeLessThanOrEqual(small.hottest * growth * 1.5)
        expect(large.maxWrites, `单帧写入 ${small.maxWrites} → ${large.maxWrites}，边 ×${growth.toFixed(1)}`).toBeLessThanOrEqual(small.maxWrites * growth * 1.5)
        base.runtime.dispose()
        wide.runtime.dispose()
      })

      it(`耗时（只量 step，不含渲染；最快一批）：每帧 < ${FRAME_BUDGET_MS}ms；输入 ×${WIDE} 时增长 < ${GROWTH_CEILING} 倍`, () => {
        const base = mount(mode)
        const wide = mount(mode, WIDE)
        const baseCost = frameCostMs(base.runtime)
        const wideCost = frameCostMs(wide.runtime)
        console.info(`[signal-perf] ${mode}: ${base.nodes} 节点 每帧 ${baseCost.toFixed(3)}ms，${wide.nodes} 节点 每帧 ${wideCost.toFixed(3)}ms（×${(wideCost / baseCost).toFixed(1)}）`)
        expect(baseCost, `${base.nodes} 节点每帧 ${baseCost.toFixed(3)}ms`).toBeLessThan(FRAME_BUDGET_MS)
        expect(wideCost / baseCost, `${wide.nodes} 节点 ${wideCost.toFixed(3)}ms / ${base.nodes} 节点 ${baseCost.toFixed(3)}ms`).toBeLessThan(GROWTH_CEILING)
        base.runtime.dispose()
        wide.runtime.dispose()
      })
    })
  }
})
