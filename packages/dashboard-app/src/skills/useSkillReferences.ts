import { useEffect, useState } from 'react'
import { fetchWorkflow, fetchWorkflowIndex } from '../api/client'
import type { WbStepDef, WbWorkflowDef } from '../api/governanceTypes'

/** 一处引用：哪个工作流（哪条轨道）的哪个阶段把这个技能列进了阶段技能。 */
export interface SkillReference {
  readonly workflow: string
  /** 轨道 label（没有 label 用 id）；通用分支为 null。 */
  readonly track: string | null
  /** 阶段 label（没有 label 用 id）。 */
  readonly stage: string
}

export type SkillReferenceMap = ReadonlyMap<string, readonly SkillReference[]>

const nameOf = (label: string | undefined, id: string): string => (label !== undefined && label !== '' ? label : id)

function collect(out: Map<string, SkillReference[]>, workflow: string, track: string | null, steps: readonly WbStepDef[]): void {
  for (const step of steps) {
    for (const skill of step.skills) {
      const list = out.get(skill.id) ?? []
      list.push({ workflow, track, stage: nameOf(step.label, step.id) })
      out.set(skill.id, list)
    }
  }
}

/** 纯投影：技能 id → 引用它的（工作流 · 轨道 · 阶段），按工作流定义里的顺序。 */
export function skillReferences(definitions: readonly WbWorkflowDef[]): SkillReferenceMap {
  const out = new Map<string, SkillReference[]>()
  for (const definition of definitions) {
    collect(out, definition.name, null, definition.steps)
    for (const [id, branch] of Object.entries(definition.tracks ?? {})) collect(out, definition.name, nameOf(branch.label, id), branch.steps)
  }
  return out
}

/** 一行文字：「工作流 · 轨道 · 阶段」，通用分支不写轨道。 */
export function referenceText(reference: SkillReference): string {
  return [reference.workflow, reference.track, reference.stage].filter((part): part is string => part !== null).join(' · ')
}

/**
 * 读全部工作流（全局存储，不绑项目）并投影成技能引用表。`enabled` 为 false 时不发请求；
 * 任何一个工作流读取失败只少它一份，整张表读取失败则为空表（引用列显示「—」，不挡技能表）。
 */
export function useSkillReferences(enabled: boolean): SkillReferenceMap {
  const [references, setReferences] = useState<SkillReferenceMap>(new Map())
  useEffect(() => {
    if (!enabled) return
    let active = true
    void (async () => {
      try {
        const { names } = await fetchWorkflowIndex('')
        const loaded = await Promise.all(names.map(async (name) => {
          try { return await fetchWorkflow(name, '') } catch { return null }
        }))
        if (active) setReferences(skillReferences(loaded.filter((definition): definition is WbWorkflowDef => definition !== null)))
      } catch {
        if (active) setReferences(new Map())
      }
    })()
    return () => { active = false }
  }, [enabled])
  return references
}
