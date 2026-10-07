import type { Page } from 'playwright/test'

/** 连续这么多帧页面都没有变化，才算落定。 */
export const SETTLE_QUIET_FRAMES: number
/** 等落定的墙钟上限（毫秒）；帧不走时靠它收场。 */
export const SETTLE_TIMEOUT_MS: number

export interface SettleOptions {
  readonly quietFrames?: number
  readonly timeoutMs?: number
}

/** 等 page 落定；超时抛出仍在变化的东西。判据见 settle.mjs。 */
export function settlePage(page: Page, options?: SettleOptions): Promise<void>

export interface WhileStillOptions {
  /** 最多跑几轮；每一轮被新动画打断就作废重来。默认 8。 */
  readonly attempts?: number
}

/** 在页面全程没有新动画的条件下跑 run（先落定、跑完检查）；被打断就整轮重来，attempts 轮都被打断就抛错。 */
export function whileStill<T>(page: Page, run: () => Promise<T>, options?: WhileStillOptions): Promise<T>
