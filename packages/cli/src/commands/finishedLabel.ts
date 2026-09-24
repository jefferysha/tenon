/**
 * 已完结任务在 check / status / list 里的同一句话。
 *
 * 「已归档」只对 OpenSpec 治理的工作流成立：完结后 `openspec archive` 把目录搬进
 * `openspec/changes/archive/`。simple 这类不走 OpenSpec 的工作流完结后目录原地不动——真机第四轮：
 * simple 终态 check 说「已完结（已归档）」，目录却还在 `openspec/changes/<c>/`。
 */
import type { PipelineState } from '@tenon/kernel'
import type { CliDeps } from '../deps.js'
import { effectiveWorkflowForState } from './effective-workflow.js'

export const FINISHED = '已完结'
export const FINISHED_ARCHIVED = '已完结（已归档）'

/** `relocated` = 目录已在归档目录里（那就是归档的物证，不再问工作流）。 */
export function finishedLabel(deps: CliDeps, state: PipelineState, relocated: boolean): string {
  if (relocated) return FINISHED_ARCHIVED
  let governed = false
  try {
    governed = effectiveWorkflowForState(deps, state)?.capabilities.documents.governed === true
  } catch {
    // 工作流读不到时不声称归档：少说一句比说错一句好。
    governed = false
  }
  return governed ? FINISHED_ARCHIVED : FINISHED
}
