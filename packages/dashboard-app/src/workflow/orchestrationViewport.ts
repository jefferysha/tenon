/**
 * 总览画布的取景（纯函数）。总览很宽（七列），整幅缩进容器字就看不清，所以进来时不缩到「适应」，
 * 而是取一个能读清的缩放（不小于 0.85），第一列靠左留一点边，其余靠横向平移看；「适应」按钮仍然把全部装进容器。
 */

/** 用户可缩放的范围；最小 0.5，再小字就看不清。 */
export const OVERVIEW_ZOOM = { min: 0.5, max: 1.5 } as const
/** 进来时的缩放范围：按高度装得下就用，但不小于 0.85（读得清）、不大于 1。 */
export const OVERVIEW_READABLE = { min: 0.85, max: 1 } as const
/** 「适应」按钮的留白（占容器比例）。 */
export const FIT_PADDING = 0.1
/** 进来时贴边的留白（px）。 */
export const EDGE_PAD = 16

export interface Bounds { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export interface Size { readonly width: number; readonly height: number }
export interface Viewport { readonly x: number; readonly y: number; readonly zoom: number }

/** 放宽最小缩放时的下限：再小的画布不值得画。 */
const MIN_FLOOR = 0.1
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

/** 进来时的视口：缩放按高度取（读得清优先），左边贴 bounds 左缘留 EDGE_PAD，竖向装得下就居中、装不下就顶对齐。 */
export function overviewViewport(bounds: Bounds, size: Size): Viewport {
  const byHeight = (size.height - 2 * EDGE_PAD) / Math.max(bounds.height, 1)
  const zoom = clamp(byHeight, OVERVIEW_READABLE.min, OVERVIEW_READABLE.max)
  const height = bounds.height * zoom
  return {
    x: EDGE_PAD - bounds.x * zoom,
    y: height + 2 * EDGE_PAD <= size.height ? (size.height - height) / 2 - bounds.y * zoom : EDGE_PAD - bounds.y * zoom,
    zoom,
  }
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
