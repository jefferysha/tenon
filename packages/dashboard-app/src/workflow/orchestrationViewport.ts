/**
 * 编排画布的取景（纯函数）。总览默认缩放 = max(按宽度适配, 0.85)：名称永远读得清，放不下的列靠横向平移看；
 * 起点和第一列贴左边 24px、内容顶对齐（顶部留 24px，回流弧算在内）。语义缩放：< 0.5 才只画符号，「适应」可以缩到那以下。
 * 点列头在只剩符号时缓动放大到那一阶段；阶段画布恒 1:1、左对齐。
 */

/** 用户可缩放的范围；最小 0.5，再小连符号都糊了。 */
export const OVERVIEW_ZOOM = { min: 0.5, max: 1.5 } as const
/** 进来时的缩放范围：按宽度装得下就用，但不小于 0.85（名称读得清）、不大于 1。 */
export const OVERVIEW_READABLE = { min: 0.85, max: 1 } as const
/** 「适应」按钮的留白（占容器比例）。 */
export const FIT_PADDING = 0.1
/** 总览贴边的留白（px）：左边与顶部各 24。 */
export const EDGE_PAD = 24
/** 阶段画布的四周留白（px）：左对齐 24，上下各 24（含起点 / 终点标签）。 */
export const STAGE_PAD = 24
/** 点列头缓动放大到那一阶段：时长（ms）与缩放（名称可读的 1）。 */
export const FOCUS_MS = 320
export const FOCUS_ZOOM = 1

/** 语义缩放：< 0.5 只画符号，之上画名称，≥ 1.25 再画元信息。 */
export const ZOOM_GLYPH_BELOW = 0.5
export const ZOOM_META_FROM = 1.25
export type ZoomLevel = 'glyph' | 'name' | 'meta'
export function zoomLevelOf(zoom: number): ZoomLevel {
  return zoom < ZOOM_GLYPH_BELOW ? 'glyph' : zoom >= ZOOM_META_FROM ? 'meta' : 'name'
}

export interface Bounds { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export interface Size { readonly width: number; readonly height: number }
export interface Viewport { readonly x: number; readonly y: number; readonly zoom: number }

/** 放宽最小缩放时的下限：再小的画布不值得画。 */
const MIN_FLOOR = 0.1
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

/** 进来时的视口：缩放 = max(按宽度适配, 0.85)，不大于 1；左上角贴 bounds 留 EDGE_PAD，回流弧拱在 bounds 上界，顶对齐才不被裁。 */
export function overviewViewport(bounds: Bounds, size: Size): Viewport {
  const byWidth = (size.width - 2 * EDGE_PAD) / Math.max(bounds.width, 1)
  const zoom = clamp(byWidth, OVERVIEW_READABLE.min, OVERVIEW_READABLE.max)
  return { x: EDGE_PAD - bounds.x * zoom, y: EDGE_PAD - bounds.y * zoom, zoom }
}

/** 「适应」把全部装进容器所需的缩放（含 FIT_PADDING）；不超过 1。 */
export function overviewFitZoom(bounds: Bounds, size: Size): number {
  const scale = 1 + 2 * FIT_PADDING
  return Math.min(1, size.width / (Math.max(bounds.width, 1) * scale), size.height / (Math.max(bounds.height, 1) * scale))
}

/**
 * 交互的最小缩放：一般是 0.5；内容比容器宽太多、适应需要更小的缩放时，放宽到适应的缩放，
 * 这样「适应」之后再缩小不会反而弹回去放大。
 */
export function overviewMinZoom(bounds: Bounds, size: Size): number {
  if (size.width <= 0 || size.height <= 0) return OVERVIEW_ZOOM.min
  return Math.max(MIN_FLOOR, Math.min(OVERVIEW_ZOOM.min, overviewFitZoom(bounds, size)))
}

/** 点列头放大到那一阶段：缩放 1，列带水平居中（比容器宽就靠左留边），列头贴顶并给回流弧留出 headroom。 */
export function stageFocusViewport(band: Bounds, size: Size, headroom = 0): Viewport {
  const width = band.width * FOCUS_ZOOM
  const x = width + 2 * EDGE_PAD <= size.width ? (size.width - width) / 2 - band.x * FOCUS_ZOOM : EDGE_PAD - band.x * FOCUS_ZOOM
  return { x, y: EDGE_PAD + headroom * FOCUS_ZOOM - band.y * FOCUS_ZOOM, zoom: FOCUS_ZOOM }
}

/** 阶段画布：1:1，内容左上角落在 (24, 24)。 */
export function stageViewport(): Viewport {
  return { x: STAGE_PAD, y: STAGE_PAD, zoom: 1 }
}
