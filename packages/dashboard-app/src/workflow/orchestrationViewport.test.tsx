import { describe, expect, it } from 'vitest'
import {
  EDGE_PAD, OVERVIEW_READABLE, OVERVIEW_ZOOM, overviewFitZoom, overviewMinZoom, overviewViewport,
} from './orchestrationViewport'

/** 七列的总览：宽 ~2000、高 ~830（含回流弧的上界）。 */
const WIDE = { x: 0, y: -90, width: 2000, height: 830 }

describe('overviewViewport · 总览进来时的取景', () => {
  it('缩放不小于 0.85（读得清）、不大于 1：容器再矮也不缩到 0.85 以下，再高也不放大过 1', () => {
    expect(overviewViewport(WIDE, { width: 1060, height: 400 }).zoom).toBe(OVERVIEW_READABLE.min)
    expect(overviewViewport(WIDE, { width: 1060, height: 712 }).zoom).toBe(OVERVIEW_READABLE.min)
    expect(overviewViewport(WIDE, { width: 1060, height: 3000 }).zoom).toBe(OVERVIEW_READABLE.max)
    const mid = overviewViewport({ ...WIDE, height: 700 }, { width: 1060, height: 700 }).zoom
    expect(mid).toBeGreaterThan(OVERVIEW_READABLE.min)
    expect(mid).toBeLessThan(OVERVIEW_READABLE.max)
  })

  it('第一列靠左：起点 / 第一阶段落在容器左缘内一点点，靠横向平移看其余', () => {
    const view = overviewViewport(WIDE, { width: 1060, height: 712 })
    expect(view.x).toBe(EDGE_PAD - WIDE.x * view.zoom)
    // 整幅比容器宽得多，仍然在左边起头，而不是居中把两头都裁掉。
    expect(WIDE.width * view.zoom).toBeGreaterThan(1060)
    expect(view.x).toBeGreaterThan(0)
  })

  it('竖向：装得下就居中，装不下就顶对齐（回流弧的上界也算）', () => {
    const roomy = overviewViewport({ x: 0, y: 0, width: 2000, height: 300 }, { width: 1000, height: 800 })
    expect(roomy.y).toBeCloseTo((800 - 300 * roomy.zoom) / 2, 5)
    const tall = overviewViewport(WIDE, { width: 1060, height: 500 })
    expect(tall.y).toBe(EDGE_PAD - WIDE.y * tall.zoom)
  })
})

describe('overviewMinZoom / overviewFitZoom', () => {
  it('最小缩放是 0.5；适应需要更小时放宽到适应的缩放（适应之后再缩小不会弹回去）', () => {
    expect(OVERVIEW_ZOOM.min).toBe(0.5)
    expect(overviewMinZoom(WIDE, { width: 3000, height: 1200 })).toBe(0.5)
    const narrow = { width: 700, height: 640 }
    const fit = overviewFitZoom(WIDE, narrow)
    expect(fit).toBeLessThan(0.5)
    expect(overviewMinZoom(WIDE, narrow)).toBeCloseTo(fit, 5)
  })

  it('适应 = 全部装进容器（含留白），不放大过 1；没量到容器尺寸时不改最小缩放', () => {
    const size = { width: 1060, height: 712 }
    const fit = overviewFitZoom(WIDE, size)
    expect(WIDE.width * fit).toBeLessThanOrEqual(size.width)
    expect(WIDE.height * fit).toBeLessThanOrEqual(size.height)
    expect(overviewFitZoom({ x: 0, y: 0, width: 100, height: 100 }, size)).toBe(1)
    expect(overviewMinZoom(WIDE, { width: 0, height: 0 })).toBe(OVERVIEW_ZOOM.min)
  })
})
