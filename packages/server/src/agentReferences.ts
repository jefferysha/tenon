/**
 * 工作流保存前的 agent 存在性校验：定义里引用到、但库中没有（或不可用）的 agent 名。
 * 引用位置的扫描（删除前列出）在 kernel `agentWorkflowReferences`，CLI 与本 server 共用。
 */
import { loadAgentLibrary, workflowAgentNames, type WorkflowDef } from '@tenon/kernel'
import { repoRootForSkills } from './serverSupport.js'
import type { ServerPaths } from './types.js'

/** 一份工作流定义里引用到、但库中没有的 agent 名；保存时据此 400。 */
export async function missingWorkflowAgents(
  paths: ServerPaths,
  workflow: WorkflowDef,
  payloadRoot?: string,
): Promise<readonly string[]> {
  const names = workflowAgentNames(workflow)
  if (names.length === 0) return []
  const library = await loadAgentLibrary({
    payloadRoot: payloadRoot ?? repoRootForSkills(),
    configRoot: paths.configRoot,
  })
  const usable = new Set(library.entries.filter((entry) => entry.definition !== undefined).map((entry) => entry.name))
  return names.filter((name) => !usable.has(name))
}
