import { useEffect, useState } from 'react'
import { aliasesForSkill } from '@tenon/kernel/workflow/document-contract-validation'
import { BUILTIN_WORKFLOW_IDS } from '@tenon/kernel/workflow/identifier'
import { bareSkillId } from '@tenon/kernel/workflow/skill-order'
import { fetchWorkflow, fetchWorkflowIndex } from '../api/client'
import { fetchWorkflowOrchestration, type DefinitionOrchestration } from '../api/workflowOrchestrationClient'

/** 一处引用：哪个工作流的哪个阶段会用到这个技能；同一阶段在几条轨道里都用到，仍是一处，轨道收在 `tracks`。 */
export interface SkillReference {
  readonly workflow: string
  /** 阶段 label（没有 label 用 id）。 */
  readonly stage: string
  /** 用到它的轨道 label（没有 label 用 id），按轨道顺序；没有轨道的工作流为空。 */
  readonly tracks: readonly string[]
}

export type SkillReferenceMap = ReadonlyMap<string, readonly SkillReference[]>

/** 一条分支的编排（服务端 buildOrchestration 的结果）和它的展示名。 */
export interface BranchOrchestration {
  readonly workflow: string
  readonly track: string | null
  readonly orchestration: DefinitionOrchestration
}

const nameOf = (label: string | undefined, id: string): string => (label !== undefined && label !== '' ? label : id)

/** 技能 token（`a|b` 备选、`tenon:` 前缀、`opsx:propose` 之类别名）能对上的技能 id 集合。 */
function keysOf(token: string): readonly string[] {
  const keys = new Set<string>()
  for (const alternative of token.split('|').map((part) => part.trim()).filter((part) => part !== '')) {
    keys.add(bareSkillId(alternative))
    for (const alias of aliasesForSkill(alternative)) keys.add(bareSkillId(alias))
  }
  return [...keys]
}

/**
 * 纯投影：技能 id → 引用它的（工作流 · 阶段）。数据来自服务端的编排——阶段里声明的技能、OpenSpec 文档契约
 * 注入的技能、manifest 叠加的必需技能都在里面——这里不再自己从定义里拼一份。按工作流、分支与阶段顺序；
 * 同一工作流同一阶段名在多条轨道里都出现时合成一处，轨道依次收进 `tracks`。
 */
export function skillReferences(branches: readonly BranchOrchestration[]): SkillReferenceMap {
  const out = new Map<string, SkillReference[]>()
  for (const branch of branches) {
    for (const stage of branch.orchestration.stages) {
      const name = nameOf(stage.label, stage.id)
      for (const entry of stage.entries) {
        if (entry.kind !== 'skill') continue
        for (const key of keysOf(entry.id)) {
          const list = out.get(key) ?? []
          const at = list.findIndex((item) => item.workflow === branch.workflow && item.stage === name)
          const known = at < 0 ? undefined : list[at]
          if (known === undefined) list.push({ workflow: branch.workflow, stage: name, tracks: branch.track === null ? [] : [branch.track] })
          else if (branch.track !== null && !known.tracks.includes(branch.track)) list[at] = { ...known, tracks: [...known.tracks, branch.track] }
          out.set(key, list)
        }
      }
    }
  }
  return out
}

/** 单元格里的一处引用：「工作流 · 阶段」。 */
export function referenceText(reference: SkillReference): string {
  return `${reference.workflow} · ${reference.stage}`
}

/** 悬停提示里的一行：「工作流 · 阶段」，有轨道时后接「 · 轨道 / 轨道」。 */
export function referenceTitle(reference: SkillReference): string {
  return reference.tracks.length === 0 ? referenceText(reference) : `${referenceText(reference)} · ${reference.tracks.join(' / ')}`
}

/**
 * 要读的工作流名：default 与插件内建工作流不在 `/api/workflows` 的列表里（列表只给自定义与模板），
 * 要自己放在最前；其后是列表里的（全局存储的自定义 / 模板）。
 */
export function workflowsToScan(names: readonly string[]): readonly string[] {
  return [...new Set(['default', ...BUILTIN_WORKFLOW_IDS, ...names])]
}

/**
 * 读全部工作流的每条分支编排——内建的 default 与 simple、全局存储（不绑项目）里的自定义与模板——投影成技能引用表。
 * `enabled` 为 false 时不发请求；任何一条分支读取失败只少它一份，整张表读取失败则为空表（引用列显示「—」，不挡技能表）。
 */
export function useSkillReferences(enabled: boolean): SkillReferenceMap {
  const [references, setReferences] = useState<SkillReferenceMap>(new Map())
  useEffect(() => {
    if (!enabled) return
    let active = true
    void (async () => {
      try {
        const { names } = await fetchWorkflowIndex('')
        const perWorkflow = await Promise.all(workflowsToScan(names).map(async (name): Promise<readonly BranchOrchestration[]> => {
          try {
            const definition = await fetchWorkflow(name, '')
            const tracks = Object.entries(definition.tracks ?? {})
            const branches: readonly { readonly id: string | null; readonly label: string | null }[] = tracks.length === 0
              ? [{ id: null, label: null }]
              : tracks.map(([id, branch]) => ({ id, label: nameOf(branch.label, id) }))
            const loaded = await Promise.all(branches.map(async (branch): Promise<BranchOrchestration | null> => {
              try {
                return { workflow: name, track: branch.label, orchestration: await fetchWorkflowOrchestration(name, '', branch.id) }
              } catch {
                return null
              }
            }))
            return loaded.filter((item): item is BranchOrchestration => item !== null)
          } catch {
            return []
          }
        }))
        if (active) setReferences(skillReferences(perWorkflow.flat()))
      } catch {
        if (active) setReferences(new Map())
      }
    })()
    return () => { active = false }
  }, [enabled])
  return references
}
