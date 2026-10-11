/**
 * 已完结任务在 check / status / list 里的同一句话。
 *
 * 任务结束一律归档：状态机走完后 `tenon task finish` 把目录搬进 `openspec/changes/archive/`，不论轨道
 * 走不走 OpenSpec。所以「已归档」只取决于目录有没有搬走——`relocated` 就是那份物证；状态机刚走完、
 * 目录还没搬的这一刻只说「已完结」，不抢在搬移之前声称已归档。
 */
import type { PipelineState } from '@tenon/kernel'
import type { CliDeps } from '../deps.js'

export const FINISHED = '已完结'
export const FINISHED_ARCHIVED = '已完结（已归档）'

/** `relocated` = 目录已在归档目录里（那就是归档的物证）。 */
export function finishedLabel(_deps: CliDeps, _state: PipelineState, relocated: boolean): string {
  return relocated ? FINISHED_ARCHIVED : FINISHED
}
