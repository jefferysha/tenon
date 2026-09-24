import { Pencil } from 'lucide-react'
import type { AgentSummary } from '../api/agentClient'
import type { WbExecutorRef, WbReviewerRef } from '../api/governanceTypes'
import { useT } from '../i18n'
import { agentEntries, refsToSkills } from './agentFlow'
import { SkillFlow } from './SkillFlow'

const HEAD_ACTION = 'inline-flex items-center gap-1.5 whitespace-nowrap text-body text-text-2 outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent)'

export type AgentSectionProps = {
  stepId: string
  agents: readonly AgentSummary[] | null
  editable: boolean
  onEdit: () => void
} & ({ role: 'executors'; refs: readonly WbExecutorRef[] } | { role: 'reviewers'; refs: readonly WbReviewerRef[] })

/** 阶段面板里的一段 agent：段头（标题 · 计数 · 编辑）+ 只读画布。评审者节点名下带一行设置摘要。 */
export function AgentSection(props: AgentSectionProps): JSX.Element {
  const { t } = useT()
  const { stepId, role, refs, agents, editable, onEdit } = props
  const reviewers = props.role === 'reviewers' ? props.refs : null
  const caption = (id: string): string | null => {
    const ref = reviewers?.find((candidate) => candidate.agent === id)
    if (ref === undefined || ref === null) return null
    const tests = ref.reads_tests ?? []
    return [
      t(ref.required ? 'workflow.agent_required' : 'workflow.agent_advisory'),
      t(`workflow.severity_${ref.block_at}`),
      ...(tests.length === 0 ? [] : [`${t('workflow.agent_tests')} ${tests.length}`]),
    ].join(' · ')
  }
  return (
    <section className="grid gap-3.5 py-6" data-testid={`stage-${role}`}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-title font-semibold text-text">
          {t(reviewers === null ? 'workflow.executors_title' : 'workflow.reviewers_title')}
          <span className="ml-2 font-mono text-caption font-normal text-text-3">{refs.length}</span>
        </h2>
        {editable && (
          <button type="button" className={HEAD_ACTION} data-testid={`wb-${role}-edit`} onClick={onEdit}>
            <Pencil className="size-3.5" aria-hidden="true" />
            {t('workflow.edit_skills')}
          </button>
        )}
      </div>
      {refs.length === 0 ? (
        <p className="text-body text-text-3" data-testid={`stage-${role}-empty`}>{t('workflow.no_agents')}</p>
      ) : (
        <SkillFlow
          key={`${stepId}-${role}`}
          skills={refsToSkills(refs)}
          registry={agentEntries(agents)}
          editable={false}
          onOpen={() => undefined}
          captionOf={reviewers === null ? undefined : caption}
          ariaLabel={t(reviewers === null ? 'workflow.executors_title' : 'workflow.reviewers_title')}
        />
      )}
    </section>
  )
}
