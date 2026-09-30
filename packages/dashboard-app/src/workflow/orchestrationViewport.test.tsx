import { describe, expect, it } from 'vitest'
import {
  EDGE_PAD, FOCUS_MS, FOCUS_ZOOM, OVERVIEW_READABLE, OVERVIEW_ZOOM, STAGE_PAD, overviewFitZoom, overviewMinZoom, overviewViewport, stageFocusViewport, stageViewport, zoomLevelOf,
} from './orchestrationViewport'

/** 八列的总览：宽 ~1900、高 ~830（含回流弧的上界）。 */
const WIDE = { x: 0, y: -90, width: 1900, height: 830 }

describe('overviewViewport · 总览默认按宽度适配', () => {
  it('缩放 = 容器宽度 / 内容宽度，不小于 0.6、不大于 1', () => {
    expect(OVERVIEW_READABLE).toEqual({ min: 0.6, max: 1 })
    // 1060 宽装不下 1900：按宽度只需 0.54，取下限 0.6。
    expect(overviewViewport(WIDE, { width: 1060, height: 712 }).zoom).toBe(0.6)
    expect(overviewViewport(WIDE, { width: 3000, height: 712 }).zoom).toBe(1)
    const mid = overviewViewport(WIDE, { width: 1400, height: 712 }).zoom
    expect(mid).toBeCloseTo((1400 - 2 * EDGE_PAD) / 1900, 5)
    expect(mid).toBeGreaterThan(0.6)
    expect(mid).toBeLessThan(1)
  })

  it('第一列靠左；竖向装得下就居中（含回流弧的上界），装不下就顶对齐不裁弧', () => {
    const tall = overviewViewport(WIDE, { width: 1060, height: 500 })
    expect(tall.x).toBe(EDGE_PAD - WIDE.x * tall.zoom)
    expect(tall.y).toBe(EDGE_PAD - WIDE.y * tall.zoom)
    const short = overviewViewport({ x: 0, y: -90, width: 1900, height: 300 }, { width: 1060, height: 800 })
    expect(short.y + (-90) * short.zoom).toBeCloseTo((800 - 300 * short.zoom) / 2, 5)
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

describe('语义缩放', () => {
  it('< 0.7 只画符号，0.7–1.25 画名称，≥ 1.25 再画元信息', () => {
    expect(zoomLevelOf(0.6)).toBe('glyph')
    expect(zoomLevelOf(0.69)).toBe('glyph')
    expect(zoomLevelOf(0.7)).toBe('name')
    expect(zoomLevelOf(1)).toBe('name')
    expect(zoomLevelOf(1.24)).toBe('name')
    expect(zoomLevelOf(1.25)).toBe('meta')
    expect(zoomLevelOf(1.5)).toBe('meta')
  })
})

describe('点列头放大到阶段', () => {
  const band = { x: 800, y: 0, width: 216, height: 500 }

  it('320ms、缩放 1（名称可读）；列带水平居中、列头贴顶', () => {
    expect(FOCUS_MS).toBe(320)
    const view = stageFocusViewport(band, { width: 1000, height: 600 })
    expect(view.zoom).toBe(FOCUS_ZOOM)
    expect(view.x + (band.x + band.width / 2) * view.zoom).toBeCloseTo(500, 5)
    expect(view.y).toBe(EDGE_PAD)
  })

  it('回流弧的 headroom 算进列头上方的留白，弧不被裁', () => {
    expect(stageFocusViewport(band, { width: 1000, height: 600 }, 90).y).toBe(EDGE_PAD + 90)
  })

  it('容器比列带还窄：靠左留边，不居中把两头裁掉', () => {
    const view = stageFocusViewport(band, { width: 220, height: 600 })
    expect(view.x + band.x * view.zoom).toBe(EDGE_PAD)
  })
})

describe('阶段画布取景', () => {
  it('1:1，内容左上角落在 (24, 24)：左对齐、上下各留 24', () => {
    expect(STAGE_PAD).toBe(24)
    expect(stageViewport()).toEqual({ x: 24, y: 24, zoom: 1 })
  })
})
