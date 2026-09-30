import { afterEach, describe, expect, it } from 'vitest'
import type { FlowStage } from '../api/workflowOrchestrationClient'
import { COMET_LAYERS, createSignalRuntime, type SignalMode } from './flowSignal'
import { layoutOrchestration } from './orchestrationLayout'

/**
 * Signal 每帧脚本耗时（目标 < 2ms）：在 8 列、约 50 个节点的前端总览布局上，把真实的 layoutOrchestration 画成与画布同构的 DOM
 * （每条边 4 层 path，节点带到达反馈层），然后让运行时连跑 10 秒的帧，量每帧 step 的耗时。
 * 这里量的是脚本（jsdom 里的 setAttribute / style 写入）；样式重算与绘制在真浏览器里另量（e2e 用 CDP 的 ScriptDuration）。
 */
const SVG = 'http://www.w3.org/2000/svg'

function entry(kind: 'executor' | 'skill' | 'test' | 'reviewer', id: string, wave: number, dependsOn: string[] = []) {
  return { kind, id, label: id, wave, dependsOn, required: true, source: 'declared' as const }
}

/** 八列：立项 1、调研 5、规格 2、设计 6、实现 7、验证 12、交付 9、完结 8 —— 合计 50 个条目，含并行与汇合。 */
function frontendStages(): FlowStage[] {
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
    entries: index === 5 ? [...chain('v', 4), ...parallel('w')] : chain(`n${index}_`, count),
  }))
}

function build(): { root: HTMLElement; nodes: number; edges: number } {
  const layout = layoutOrchestration(frontendStages(), 'overview')
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
    for (const layer of COMET_LAYERS) {
      const path = document.createElementNS(SVG, 'path')
      path.setAttribute('d', `M${from.x} ${from.y} L${to.x} ${to.y} #${edge.id}`)
      path.setAttribute('data-length', String(length))
      path.setAttribute('data-signal-layer', layer.id)
      group.append(path)
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
  return { root, nodes: layout.entries.length, edges: layout.edges.length }
}

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0
}

describe('Signal 性能 · 8 列 ~50 节点的前端总览', () => {
  afterEach(() => { Reflect.deleteProperty(SVGElement.prototype, 'getTotalLength') })

  for (const mode of ['ambient', 'running'] as Array<Exclude<SignalMode, 'off' | 'still'>>) {
    it(`${mode}：每帧 step 的脚本耗时 < 2ms（均值与 p95 都算）`, () => {
      Object.defineProperty(SVGElement.prototype, 'getTotalLength', { configurable: true, value(this: SVGElement) { return Number(this.getAttribute('data-length') ?? 0) } })
      const { root, nodes, edges } = build()
      expect(nodes).toBeGreaterThanOrEqual(48)
      expect(nodes).toBeLessThanOrEqual(56)
      const runtime = createSignalRuntime(root, mode)!
      expect(runtime.edgeCount).toBe(edges)
      // 预热 JIT，再量 10 秒的帧（600 帧 × 1/60s）。
      for (let frame = 0; frame < 120; frame += 1) runtime.step(1 / 60)
      const samples: number[] = []
      let hottest = 0
      for (let frame = 0; frame < 600; frame += 1) {
        const started = performance.now()
        runtime.step(1 / 60)
        samples.push(performance.now() - started)
        hottest = Math.max(hottest, runtime.hotCount())
      }
      const sorted = [...samples].sort((a, b) => a - b)
      const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length
      console.info(`[signal-perf] ${mode}: ${nodes} 节点 / ${edges} 条边，均值 ${mean.toFixed(3)}ms，p95 ${percentile(sorted, 0.95).toFixed(3)}ms，最大 ${sorted[sorted.length - 1]!.toFixed(3)}ms，同时最多 ${hottest} 条热边`)
      expect(mean).toBeLessThan(2)
      expect(percentile(sorted, 0.95)).toBeLessThan(2)
      // 只写热边：同一帧里总有冷边不被碰（每条热边 4 次 dashoffset 写入）。
      expect(hottest).toBeLessThan(edges)
      runtime.dispose()
    })
  }
})
