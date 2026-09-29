import { useMemo } from 'react'
import { Pencil } from 'lucide-react'
import type { OrchestrationKind, OrchestrationStage } from '@tenon/kernel/workflow/orchestration'
import type { WbStepTest } from '../api/governanceTypes'
import type { FlowEntry } from '../api/workflowOrchestrationClient'
import { useT } from '../i18n'
import { OrchestrationFlow } from './OrchestrationFlow'
import type { LaneAction } from './orchestrationNodes'
import { HEAD_ACTION, SectionHead } from './SectionHead'
import { TestAddMenu } from './TestAddMenu'

export interface StageFlowSectionProps {
  stage: OrchestrationStage | undefined
  tests: readonly WbStepTest[]
  editable: boolean
  onEditSkills: () => void
  onEditAgents: (role: 'executors' | 'reviewers') => void
  onAddTest: (test: WbStepTest) => void
  onOpenSkill: (id: string) => void
  onOpenTest: (id: string) => void
}

/**
 * 「技能」段：与总览同一张画布的单列形态，泳道依次是 执行者 → 技能 → 测试 → 评审者（runner 的真实顺序）。
 * 段头的「编辑」改技能；执行者、测试、评审者的动作在各自泳道旁。测试策略表单归门禁段。
 */
export function StageFlowSection({ stage, tests, editable, onEditSkills, onEditAgents, onAddTest, onOpenSkill, onOpenTest }: StageFlowSectionProps): JSX.Element {
  const { t } = useT()
  const stages = useMemo(() => stage === undefined ? [] : [stage], [stage])
  const skills = stage?.entries.filter((entry) => entry.kind === 'skill').length ?? 0
  const laneActions = useMemo((): Partial<Record<OrchestrationKind, LaneAction>> | undefined => editable ? {
    executor: { icon: 'edit', label: `${t('workflow.edit_skills')} ${t('workflow.executors_title')}`, testId: 'wb-executors-edit', onClick: () => onEditAgents('executors') },
    test: { icon: 'add', label: t('workflow.test_add'), testId: 'wb-tests-add', onClick: () => undefined, render: () => <TestAddMenu tests={tests} onAdd={onAddTest} /> },
    reviewer: { icon: 'edit', label: `${t('workflow.edit_skills')} ${t('workflow.reviewers_title')}`, testId: 'wb-reviewers-edit', onClick: () => onEditAgents('reviewers') },
  } : undefined, [editable, t, tests, onAddTest, onEditAgents])
  function open(_stage: string, entry: FlowEntry): void {
    if (entry.kind === 'skill') onOpenSkill(entry.id)
    else if (entry.kind === 'test') onOpenTest(entry.id)
    else if (editable) onEditAgents(entry.kind === 'executor' ? 'executors' : 'reviewers')
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
        : <OrchestrationFlow mode="stage" stages={stages} laneActions={laneActions} onOpenEntry={open} ariaLabel={t('workflow.skills_title')} />}
    </section>
  )
}
