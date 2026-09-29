import { useT } from '../i18n'
import type { AgentSource, AgentSummary } from '../api/agentClient'
import { CommandLine } from '../shared/CommandLine'
import { LIST_ROW, LIST_ROW_NAME, ListSkeleton } from './libraryChrome'

/** 新建在终端：空态给出这条可复制的命令。 */
export const AGENT_NEW_COMMAND = 'tenon agent new'

/** 列表分段：文件声明的身份；解析不了的条目没有身份，单列在最后。 */
type Group = 'executor' | 'reviewer' | 'invalid'
const GROUPS: readonly Group[] = ['executor', 'reviewer', 'invalid']

export const groupOf = (agent: AgentSummary): Group => agent.role ?? 'invalid'

/** 来源词：官方 / 项目 / 自定义（与 CLI 同一口径）。 */
export const SOURCE_KEY: Readonly<Record<AgentSource, string>> = {
  builtin: 'library.official',
  project: 'library.project',
  custom: 'library.custom',
}

/**
 * 中列：按身份（文件里的 role）分段的 agent 列表。一行 = 名称 + 行尾来源与版本（纯文字、不换行）；
 * 说明在悬停提示里。被项目级同名覆盖的自定义条目来源置灰，原因在提示里。
 */
export function AgentList({
  agents, loading, selected, onSelect,
}: {
  agents: readonly AgentSummary[]
  loading: boolean
  selected: string | null
  onSelect: (name: string) => void
}): JSX.Element {
  const { t } = useT()

  if (loading) return <ListSkeleton testId="lib-agent-loading" />
  if (agents.length === 0) {
    return (
      <div className="grid gap-3" data-testid="lib-agent-empty">
        <p className="text-base whitespace-nowrap text-text-2">{t('library.agent_empty')}</p>
        <CommandLine command={AGENT_NEW_COMMAND} testId="lib-agent-new-command" truncate />
      </div>
    )
  }
  return (
    <div className="grid gap-5" data-testid="lib-agents">
      {GROUPS.map((group) => {
        const rows = agents.filter((agent) => groupOf(agent) === group)
        if (rows.length === 0) return null
        return (
          <section key={group} className="grid gap-1" data-testid={`lib-agents-${group}`}>
            <h2 className="flex items-baseline gap-2 px-3 pb-1 text-caption font-semibold whitespace-nowrap text-text-2">
              {t(group === 'invalid' ? 'library.agent_invalid' : `library.agent_${group}`)}
              <span className="tabular-nums text-text-3">{rows.length}</span>
            </h2>
            <ul className="grid gap-1">
              {rows.map((agent) => (
                <li key={`${agent.source}/${agent.name}`}>
                  <button
                    type="button"
                    className={LIST_ROW}
                    aria-current={selected === agent.name && agent.shadowedBy === undefined ? 'true' : undefined}
                    title={agent.error ?? (agent.shadowedBy === 'project' ? t('library.agent_shadowed') : agent.description)}
                    data-testid={`lib-agent-${agent.source}-${agent.name}`}
                    onClick={() => onSelect(agent.name)}
                  >
                    <span className={LIST_ROW_NAME}>{agent.name}</span>
                    <span className="flex items-baseline gap-2 text-caption whitespace-nowrap">
                      {agent.error !== undefined && (
                        <span className="text-red-d" data-testid={`lib-agent-invalid-${agent.name}`}>{t('library.agent_invalid')}</span>
                      )}
                      <span
                        className={agent.shadowedBy === 'project' ? 'text-text-4 line-through' : 'text-text-3'}
                        data-testid={`lib-agent-source-${agent.source}-${agent.name}`}
                      >
                        {t(SOURCE_KEY[agent.source])}
                      </span>
                      {agent.version !== undefined && (
                        <span className="font-mono tabular-nums text-text-4" data-testid={`lib-agent-version-${agent.name}`}>{agent.version}</span>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}
