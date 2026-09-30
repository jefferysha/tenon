/**
 * 一个 agent 被哪些工作流步骤引用。删除前用它给出引用位置（CLI `tenon agent rm` 与 Dashboard 共用）。
 *
 * 扫的是项目库 `.pipeline/workflows`（给出项目根时）、全局工作流存储加内建工作流的全部分支；
 * Change 里的冻结副本不扫——删库文件永远不影响已经开始的任务。读不动或解析不了的工作流一律跳过：
 * 删除提示不该因为别处一个坏文件而失败。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { builtinWorkflow } from '../workflow/builtin-workflows.js'
import { DEFAULT_WORKFLOW_SOURCE } from '../workflow/default-workflow.generated.js'
import { workflowsDirUnder } from '../workflow/global-store.js'
import { BUILTIN_WORKFLOW_IDS } from '../workflow/identifier.js'
import { parseWorkflow } from '../workflow/parse.js'
import type { WorkflowDef } from '../workflow/types.js'
import { workflowBranches } from '../workflow/validate.js'
import { workflowNamesUnder } from './workflow-global-store.js'

export interface AgentWorkflowReference {
  readonly workflow: string
  readonly track: string | null
  readonly step: string
  readonly label: string
  readonly role: 'executor' | 'reviewer'
}

function referencesIn(name: string, definition: WorkflowDef, agent: string): AgentWorkflowReference[] {
  const found: AgentWorkflowReference[] = []
  for (const branch of workflowBranches(definition)) {
    for (const step of branch.steps) {
      const roles = [
        ['executor' as const, (step.agents?.executors ?? []).map((ref) => ref.agent)],
        ['reviewer' as const, (step.agents?.reviewers ?? []).map((ref) => ref.agent)],
      ] as const
      for (const [role, names] of roles) {
        if (!names.includes(agent)) continue
        found.push({ workflow: name, track: branch.track === '' ? null : branch.track, step: step.id, label: step.label, role })
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

function readUnder(root: string, name: string): string | undefined {
  try {
    return readFileSync(join(workflowsDirUnder(root), `${name}.yaml`), 'utf8')
  } catch {
    return undefined
  }
}

/**
 * 项目库（`<项目>/.pipeline/workflows`，解析顺序里排在全局之前）、全局存储（`<configRoot>/workflows`）里的
 * 工作流 + 没有被任何一层覆盖的内建工作流（default 与 simple）。两层各扫一遍、不互相遮蔽：项目里
 * 覆盖了同名工作流，全局那份仍被别的项目用着，删 agent 前两处引用都要列出。
 */
export function agentWorkflowReferences(
  input: { readonly configRoot: string; readonly projectRoot?: string },
  agent: string,
): readonly AgentWorkflowReference[] {
  const found: AgentWorkflowReference[] = []
  const overridden = new Set<string>()
  const roots = [...(input.projectRoot === undefined ? [] : [input.projectRoot]), join(input.configRoot, 'workflows')]
  for (const root of roots) {
    for (const name of workflowNamesUnder(root)) {
      overridden.add(name)
      const definition = parsed(readUnder(root, name))
      if (definition === undefined) continue
      for (const reference of referencesIn(name, definition, agent)) {
        if (!found.some((item) => sameReference(item, reference))) found.push(reference)
      }
    }
  }
  if (!overridden.has('default')) {
    const definition = parsed(DEFAULT_WORKFLOW_SOURCE)
    if (definition !== undefined) found.push(...referencesIn('default', definition, agent))
  }
  for (const name of BUILTIN_WORKFLOW_IDS) {
    if (overridden.has(name)) continue
    const definition = builtinWorkflow(name)
    if (definition !== null) found.push(...referencesIn(name, definition, agent))
  }
  return found
}

function sameReference(left: AgentWorkflowReference, right: AgentWorkflowReference): boolean {
  return left.workflow === right.workflow && left.track === right.track && left.step === right.step && left.role === right.role
}

/** 一份工作流定义（全部分支）里引用到的 agent 名，去重排序。 */
export function workflowAgentNames(workflow: WorkflowDef): readonly string[] {
  const names = new Set<string>()
  for (const branch of workflowBranches(workflow)) {
    for (const step of branch.steps) {
      for (const ref of step.agents?.executors ?? []) names.add(ref.agent)
      for (const ref of step.agents?.reviewers ?? []) names.add(ref.agent)
    }
  }
  return [...names].sort()
}
