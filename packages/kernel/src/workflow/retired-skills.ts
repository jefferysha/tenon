/**
 * 已删除的 Tenon 自有 skill：工作流数据里再引用它们，任务就跑不动了。
 *
 * 七个阶段 skill 与 simple-task / learn-record / tenon-researcher 的行为已全部由工作流数据
 * （技能、agent、测试、文档契约）与单个 `tenon` skill 承担。冻结快照仍指向这些 id 的旧任务
 * 没有兼容层：在计划期一次认出来、明确拒绝，好过后面报一堆不相干的错。
 */
import type { EffectiveWorkflowPlan } from './effective-plan-types.js'
import type { WorkflowIR } from './ir.js'

export const RETIRED_SKILL_IDS: readonly string[] = [
  'tenon-open', 'tenon-explore', 'tenon-spec', 'tenon-build', 'tenon-verify', 'tenon-ship',
  'tenon-archive', 'simple-task', 'learn-record', 'tenon-researcher',
]

const RETIRED = new Set(RETIRED_SKILL_IDS)

/** 宿主把插件自有 skill 呈现为 `tenon:<id>`，工作流 YAML 用裸 id；比较前归一这一个命名空间。 */
function bareId(skillId: string): string {
  return skillId.startsWith('tenon:') ? skillId.slice('tenon:'.length) : skillId
}

function collect(ir: WorkflowIR | undefined, found: Set<string>): void {
  if (ir === undefined) return
  const branches = [ir.steps, ...Object.values(ir.tracks ?? {}).map((track) => track.steps)]
  for (const steps of branches) {
    for (const step of steps) {
      for (const skill of step.skills) {
        const id = bareId(skill.id)
        if (RETIRED.has(id)) found.add(id)
      }
    }
  }
}

/** 计划（含全部 track 分支）里引用到的已删除技能 id，去重后按字典序。 */
export function retiredSkillReferences(plan: EffectiveWorkflowPlan): readonly string[] {
  const found = new Set<string>()
  collect(plan.definition, found)
  collect(plan.workflow, found)
  return [...found].sort()
}

/** 任务快照引用已删除技能时的逐字文案（CLI、server 与 skill 同一份）。 */
export function retiredSkillsChangeMessage(change: string, skills: readonly string[]): string {
  return `任务 '${change}' 的工作流快照引用已删除的技能（${skills.join('、')}），无法继续；`
    + '请新建任务，旧任务可在工作台归档或删除。'
}

/** 工作流定义引用已删除技能时的逐字文案。 */
export function retiredSkillsWorkflowMessage(workflow: string, skills: readonly string[]): string {
  return `工作流 '${workflow}' 引用已删除的技能（${skills.join('、')}）；在工作流页移除后重新保存。`
}
