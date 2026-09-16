import { requireTrack } from '../tracks/registry.js'
import { resolveTrackForBranch } from '../tracks/branch-track.js'
import type { TrackDefinition, TrackRegistry } from '../tracks/types.js'
import { globalWorkflowRoot } from './global-store.js'
import { TEMPLATE_WORKFLOW_NAMES } from './identifier.js'
import { workflowNamesUnder } from '../infrastructure/workflow-global-store.js'
import { loadWorkflow } from './loadWorkflow.js'
import type { WorkflowDef } from './types.js'

/** 项目语境可加载的工作流名：随插件发布的模板恒在，其余来自项目 `.pipeline/workflows/*.yaml` 与全局存储。 */
export function projectWorkflowNames(repoRoot: string): string[] {
  return [...new Set<string>([
    ...TEMPLATE_WORKFLOW_NAMES,
    ...workflowNamesUnder(repoRoot),
    ...workflowNamesUnder(globalWorkflowRoot()),
  ])]
}

/**
 * change 语境下的 track 定义：registry 已登记 → 原定义；否则在所选工作流（未指定时按 default →
 * 项目其余工作流的顺序）里找同名分支并合成缺省定义；都没有 → 与 requireTrack 同样的未知 track 错误。
 * 工作流读取失败（YAML 损坏）不在此吞掉：原样上抛，避免把「文件坏了」伪装成「未知 track」。
 */
export function requireTrackForRoot(
  registry: TrackRegistry,
  trackId: string,
  repoRoot: string,
  workflowName?: string,
): TrackDefinition {
  const registered = registry.byId.get(trackId)
  if (registered !== undefined) return registered
  const candidates = workflowName === undefined || workflowName === '' ? projectWorkflowNames(repoRoot) : [workflowName]
  for (const name of candidates) {
    const def: WorkflowDef | null = loadWorkflow(repoRoot, name)
    const synthesized = resolveTrackForBranch(registry, trackId, def)
    if (synthesized !== undefined) return synthesized
  }
  return requireTrack(registry, trackId)
}
