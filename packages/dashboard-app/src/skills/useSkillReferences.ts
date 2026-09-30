import { useEffect, useState } from 'react'
import { aliasesForSkill } from '@tenon/kernel/workflow/document-contract-validation'
import { bareSkillId } from '@tenon/kernel/workflow/skill-order'
import { fetchWorkflow, fetchWorkflowIndex } from '../api/client'
import { fetchWorkflowOrchestration, type DefinitionOrchestration } from '../api/workflowOrchestrationClient'

/** 一处引用：哪个工作流（哪条轨道）的哪个阶段会用到这个技能。 */
export interface SkillReference {
  readonly workflow: string
  /** 轨道 label（没有 label 用 id）；通用分支为 null。 */
  readonly track: string | null
  /** 阶段 label（没有 label 用 id）。 */
  readonly stage: string
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
 * 纯投影：技能 id → 引用它的（工作流 · 轨道 · 阶段）。数据来自服务端的编排——阶段里声明的技能、OpenSpec 文档契约
 * 注入的技能、manifest 叠加的必需技能都在里面——这里不再自己从定义里拼一份。按分支与阶段顺序。
 */
export function skillReferences(branches: readonly BranchOrchestration[]): SkillReferenceMap {
  const out = new Map<string, SkillReference[]>()
  for (const branch of branches) {
    for (const stage of branch.orchestration.stages) {
      const reference: SkillReference = { workflow: branch.workflow, track: branch.track, stage: nameOf(stage.label, stage.id) }
      for (const entry of stage.entries) {
        if (entry.kind !== 'skill') continue
        for (const key of keysOf(entry.id)) {
          const list = out.get(key) ?? []
          if (!list.some((item) => item.workflow === reference.workflow && item.track === reference.track && item.stage === reference.stage)) list.push(reference)
          out.set(key, list)
        }
      }
    }
  }
  return out
}

/** 一行文字：「工作流 · 轨道 · 阶段」，通用分支不写轨道。 */
export function referenceText(reference: SkillReference): string {
  return [reference.workflow, reference.track, reference.stage].filter((part): part is string => part !== null).join(' · ')
}

/**
 * 读全部工作流（全局存储，不绑项目）的每条分支编排，投影成技能引用表。`enabled` 为 false 时不发请求；
 * 任何一条分支读取失败只少它一份，整张表读取失败则为空表（引用列显示「—」，不挡技能表）。
 */
export function useSkillReferences(enabled: boolean): SkillReferenceMap {
  const [references, setReferences] = useState<SkillReferenceMap>(new Map())
  useEffect(() => {
    if (!enabled) return
    let active = true
    void (async () => {
      try {
        const { names } = await fetchWorkflowIndex('')
        const perWorkflow = await Promise.all(names.map(async (name): Promise<readonly BranchOrchestration[]> => {
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
