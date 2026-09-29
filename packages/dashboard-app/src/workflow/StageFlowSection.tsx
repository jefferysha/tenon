import { useMemo } from 'react'
import { Pencil } from 'lucide-react'
import type { OrchestrationKind, OrchestrationStage } from '@tenon/kernel/workflow/orchestration'
import type { FlowEntry } from '../api/workflowOrchestrationClient'
import { useT } from '../i18n'
import { OrchestrationFlow } from './OrchestrationFlow'
import type { LaneAction } from './orchestrationNodes'
import { HEAD_ACTION, SectionHead } from './SectionHead'

export interface StageFlowSectionProps {
  stage: OrchestrationStage | undefined
  editable: boolean
  onEditSkills: () => void
  onEditAgents: (role: 'executors' | 'reviewers') => void
  onOpenSkill: (id: string) => void
}

/** 旧的步骤测试在这里只读：点它没有抽屉，转成目录套件的命令在门禁段的测试表单里。 */
const openable = (entry: FlowEntry): boolean => entry.kind !== 'test'

/**
 * 「技能」段：与总览同一张画布的单列形态，泳道依次是 执行者 → 技能 → 测试 → 评审者（runner 的真实顺序）。
 * 段头的「编辑」改技能；执行者、评审者的动作在各自泳道旁。测试泳道只读地列出旧的步骤测试，
 * 测试策略（结构化表单）归门禁段。
 */
export function StageFlowSection({ stage, editable, onEditSkills, onEditAgents, onOpenSkill }: StageFlowSectionProps): JSX.Element {
  const { t } = useT()
  const stages = useMemo(() => stage === undefined ? [] : [stage], [stage])
  const skills = stage?.entries.filter((entry) => entry.kind === 'skill').length ?? 0
  const laneActions = useMemo((): Partial<Record<OrchestrationKind, LaneAction>> | undefined => editable ? {
    executor: { icon: 'edit', label: `${t('workflow.edit_skills')} ${t('workflow.executors_title')}`, testId: 'wb-executors-edit', onClick: () => onEditAgents('executors') },
    reviewer: { icon: 'edit', label: `${t('workflow.edit_skills')} ${t('workflow.reviewers_title')}`, testId: 'wb-reviewers-edit', onClick: () => onEditAgents('reviewers') },
  } : undefined, [editable, t, onEditAgents])
  function open(_stage: string, entry: FlowEntry): void {
    if (entry.kind === 'skill') onOpenSkill(entry.id)
    else if (entry.kind !== 'test' && editable) onEditAgents(entry.kind === 'executor' ? 'executors' : 'reviewers')
  }
  const empty = (stage?.entries.length ?? 0) === 0
  return (
    <section className="grid gap-3.5 py-6" data-testid="stage-skills">
      <SectionHead
        title={t('workflow.skills_title')}
        count={skills}
        action={editable ? (
          <button type="button" className={HEAD_ACTION} data-testid="wb-skills-edit" onClick={onEditSkills}>
            <Pencil className="size-3.5" aria-hidden="true" />
            {t('workflow.edit_skills')}
          </button>
        ) : undefined}
      />
      {empty && !editable
        ? <p className="text-body text-text-3" data-testid="stage-skills-empty">{t('workflow.no_skills')}</p>
        : <OrchestrationFlow mode="stage" stages={stages} laneActions={laneActions} onOpenEntry={open} openable={openable} ariaLabel={t('workflow.skills_title')} />}
    </section>
  )
}
