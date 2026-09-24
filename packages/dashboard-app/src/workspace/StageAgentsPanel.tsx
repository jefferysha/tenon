import { useMemo } from 'react'
import type { AgentRunView } from '../types'
import { useT } from '../i18n'
import type { WbSkillRef } from '../api/governanceTypes'
import { SkillFlow } from '../workflow/SkillFlow'

const RESULT_KEY = {
  pass: 'workspace.agent_pass',
  fail: 'workspace.agent_fail',
  done: 'workspace.agent_done',
  failed: 'workspace.agent_failed',
} as const

/** 评审者接在最后一波执行者之后：工作台画的是运行顺序，不是定义里的字面依赖。 */
function agentGraph(agents: readonly AgentRunView[]): WbSkillRef[] {
  const executors = agents.filter((agent) => agent.role === 'executor').map((agent) => agent.agent)
  return agents.map((agent) => {
    const declared = agent.dependsOn.length > 0 ? agent.dependsOn : agent.role === 'reviewer' ? executors : []
    return { id: agent.agent, ...(declared.length === 0 ? {} : { depends_on: [...declared] }) }
  })
}

/** 一个阶段的 agent 段：只读画布，节点显示运行态与结论，点节点打开运行抽屉。 */
export function StageAgentsPanel({
  identity, stepId, agents, onOpen,
}: {
  identity: string
  stepId: string
  agents: readonly AgentRunView[]
  onOpen: (agent: string) => void
}): JSX.Element | null {
  const { t } = useT()
  const skills = useMemo(() => agentGraph(agents), [agents])
  if (agents.length === 0) return null
  const view = (id: string): AgentRunView | undefined => agents.find((agent) => agent.agent === id)
  const statusOf = (id: string): { state: 'idle' | 'running' | 'done'; label: string } | null => {
    const agent = view(id)
    if (agent === undefined) return null
    if (agent.state === 'running') return { state: 'running', label: t('workspace.agent_running') }
    if (agent.state === 'stale') return { state: 'idle', label: t('workspace.agent_stale') }
    if (agent.state === 'idle') return { state: 'idle', label: t('workspace.agent_idle') }
    const label = t(agent.result === null ? 'workspace.agent_done' : RESULT_KEY[agent.result])
    return { state: 'done', label: agent.findings === 0 ? label : `${label} · ${t('workspace.agent_findings', { n: agent.findings })}` }
  }
  const captionOf = (id: string): string | null => {
    const agent = view(id)
    return agent === undefined ? null : t(`workspace.agent_${agent.role}`)
  }
  return (
    <section className="mb-8" data-testid="stage-agents">
      <h2 className="mb-3 text-title font-semibold text-text">
        {t('workspace.agents')}
        <span className="ml-2 font-mono text-caption font-normal text-text-3">{agents.length}</span>
      </h2>
      <SkillFlow
        key={`${identity} ${stepId} agents`}
        skills={skills}
        registry={null}
        editable={false}
        onOpen={onOpen}
        statusOf={statusOf}
        captionOf={captionOf}
      />
    </section>
  )
}
