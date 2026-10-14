import { workflowNamesUnder } from '../infrastructure/workflow-global-store.js'
import { compileDefaultWorkflow, compileWorkflow } from './compile.js'
import { globalWorkflowRoot } from './global-store.js'
import { isDefaultWorkflowName, isValidWorkflowName, TEMPLATE_WORKFLOW_NAMES } from './identifier.js'
import type { WorkflowIR } from './ir.js'
import { loadWorkflow } from './loadWorkflow.js'
import { listTracks, resolveTrack, UnknownTrackError, type TrackBranch } from './resolve-track.js'
import type { WorkflowDef } from './types.js'

/** 项目语境可加载的工作流名：随插件发布的模板恒在，其余来自项目 `.pipeline/workflows/*.yaml` 与全局存储。 */
export function projectWorkflowNames(repoRoot: string): string[] {
  return [...new Set<string>([
    ...TEMPLATE_WORKFLOW_NAMES,
    ...workflowNamesUnder(repoRoot),
    ...workflowNamesUnder(globalWorkflowRoot()),
  ])]
}

/** 定义 → 编译产物。default 带 phase policy artifact，走它自己的编译入口；其余工作流走通用入口。 */
export function compileLoadedWorkflow(name: string, definition: WorkflowDef): WorkflowIR {
  return isDefaultWorkflowName(name) ? compileDefaultWorkflow(definition) : compileWorkflow(definition)
}

/**
 * 项目 → 全局存储 → 插件模板的顺序加载并编译；都没有 → null。YAML 损坏原样上抛，不伪装成「没有这个工作流」。
 * 工作流名会拼进文件路径（`.pipeline/workflows/<名>.yaml`），先过名字闭集校验，`../` 之类不会走出工作流目录。
 */
export function loadCompiledWorkflow(repoRoot: string, name: string): WorkflowIR | null {
  if (!isValidWorkflowName(name)) throw new Error(`非法 workflow 名 '${name}'`)
  const definition = loadWorkflow(repoRoot, name)
  return definition === null ? null : compileLoadedWorkflow(name, definition)
}

/**
 * 新建任务前：这个工作流要不要指定轨道？平铺工作流只有一条隐式分支 → null（不用 `--track`）；
 * 有分支 → 全部分支 id（须选其一）。工作流不存在或写坏 → 抛错。
 */
export function requiredTrackChoices(repoRoot: string, workflowName: string): readonly string[] | null {
  const workflow = loadCompiledWorkflow(repoRoot, workflowName)
  if (workflow === null) throw new Error(`workflow '${workflowName}' 未找到`)
  try {
    resolveTrack(workflow)
    return null
  } catch (e) {
    if (e instanceof UnknownTrackError) return e.available
    throw e
  }
}

export interface WorkflowTrackEntry {
  readonly workflow: string
  readonly branch: TrackBranch
}

export interface WorkflowTrackListing {
  readonly entries: readonly WorkflowTrackEntry[]
  /** 加载或编译失败的工作流：不让一个写坏的文件挡住其余工作流的列出。 */
  readonly skipped: readonly { readonly workflow: string; readonly reason: string }[]
}

/** 项目可用的全部工作流（项目 → 全局存储 → 插件模板）里的全部轨道；default 排最前。 */
export function listWorkflowTracks(repoRoot: string): WorkflowTrackListing {
  const entries: WorkflowTrackEntry[] = []
  const skipped: { workflow: string; reason: string }[] = []
  const names = projectWorkflowNames(repoRoot).sort((a, b) => Number(!isDefaultWorkflowName(a)) - Number(!isDefaultWorkflowName(b)))
  for (const workflow of names) {
    try {
      const compiled = loadCompiledWorkflow(repoRoot, workflow)
      if (compiled === null) continue
      for (const branch of listTracks(compiled)) entries.push({ workflow, branch })
    } catch (e) {
      skipped.push({ workflow, reason: e instanceof Error ? e.message : String(e) })
    }
  }
  return { entries, skipped }
}

export interface LoadedTrack {
  readonly workflow: WorkflowIR
  readonly branch: TrackBranch
}

/**
 * 新任务入口（init、`tenon tracks`、server 新建）：加载工作流并解析轨道。
 * 工作流不存在 → 抛错；轨道不存在，或有分支却没指定轨道 → `UnknownTrackError`，不创建任何东西。
 */
export function loadTrack(repoRoot: string, workflowName: string, trackId?: string): LoadedTrack {
  const workflow = loadCompiledWorkflow(repoRoot, workflowName)
  if (workflow === null) throw new Error(`workflow '${workflowName}' 未找到`)
  return { workflow, branch: resolveTrack(workflow, trackId) }
}
