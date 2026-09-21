/**
 * 一个 agent 被哪些工作流步骤引用。删除前用它给出引用位置。
 *
 * 扫的是全局工作流存储加内建工作流的全部分支；Change 里的冻结副本不扫——删库文件永远不影响
 * 已经开始的任务。任何读不动或解析不了的工作流一律跳过：删除提示不该因为别处一个坏文件而失败。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BUILTIN_WORKFLOW_IDS, DEFAULT_WORKFLOW_SOURCE, builtinWorkflow, loadAgentLibrary, parseWorkflow,
  workflowBranches, workflowNamesUnder, workflowsDirUnder,
  type WorkflowDef,
} from '@tenon/kernel'
import { repoRootForSkills } from './serverSupport.js'
import type { ServerPaths } from './types.js'

export interface AgentReference {
  readonly workflow: string
  readonly track: string | null
  readonly step: string
  readonly label: string
  readonly role: 'executor' | 'reviewer'
}

function referencesIn(name: string, definition: WorkflowDef, agent: string): AgentReference[] {
  const found: AgentReference[] = []
  for (const branch of workflowBranches(definition)) {
    for (const step of branch.steps) {
      const roles = [
        ['executor' as const, (step.agents?.executors ?? []).map((ref) => ref.agent)],
        ['reviewer' as const, (step.agents?.reviewers ?? []).map((ref) => ref.agent)],
      ] as const
      for (const [role, names] of roles) {
        if (!names.includes(agent)) continue
        found.push({
          workflow: name,
          track: branch.track === '' ? null : branch.track,
          step: step.id,
          label: step.label,
          role,
        })
      }
    }
  }
  return found
}

function parsed(source: string | undefined): WorkflowDef | undefined {
  if (source === undefined) return undefined
  try {
    return parseWorkflow(source)
  } catch {
    return undefined
  }
}

function readGlobal(root: string, name: string): string | undefined {
  try {
    return readFileSync(join(workflowsDirUnder(root), `${name}.yaml`), 'utf8')
  } catch {
    return undefined
  }
}

/** 全局存储里的工作流 + 未被覆盖的内建工作流（default 与 simple）。 */
export function agentReferences(paths: ServerPaths, agent: string): readonly AgentReference[] {
  const root = join(paths.configRoot, 'workflows')
  const stored = workflowNamesUnder(root)
  const found: AgentReference[] = []
  for (const name of stored) {
    const definition = parsed(readGlobal(root, name))
    if (definition !== undefined) found.push(...referencesIn(name, definition, agent))
  }
  if (!stored.includes('default')) {
    const definition = parsed(DEFAULT_WORKFLOW_SOURCE)
    if (definition !== undefined) found.push(...referencesIn('default', definition, agent))
  }
  for (const name of BUILTIN_WORKFLOW_IDS) {
    if (stored.includes(name)) continue
    const definition = builtinWorkflow(name)
    if (definition !== null) found.push(...referencesIn(name, definition, agent))
  }
  return found
}

/** 一份工作流定义里引用到、但库中没有的 agent 名；保存时据此 400。 */
export async function missingWorkflowAgents(
  paths: ServerPaths,
  workflow: WorkflowDef,
  payloadRoot?: string,
): Promise<readonly string[]> {
  const names = new Set<string>()
  for (const branch of workflowBranches(workflow)) {
    for (const step of branch.steps) {
      for (const ref of step.agents?.executors ?? []) names.add(ref.agent)
      for (const ref of step.agents?.reviewers ?? []) names.add(ref.agent)
    }
  }
  if (names.size === 0) return []
  const library = await loadAgentLibrary({
    payloadRoot: payloadRoot ?? repoRootForSkills(),
    configRoot: paths.configRoot,
  })
  const usable = new Set(library.entries.filter((entry) => entry.definition !== undefined).map((entry) => entry.name))
  return [...names].filter((name) => !usable.has(name)).sort()
}
