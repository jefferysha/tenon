import { useT } from '../i18n'
import type { AgentSource, AgentSummary } from '../api/agentClient'
import { CommandLine } from '../shared/CommandLine'
import { CountRoll } from '../shared/CountRoll'
import { LIST_ROW, LIST_ROW_NAME, ListSkeleton } from './libraryChrome'

/** 新建在终端：空态给出这条可复制的命令。 */
export const AGENT_NEW_COMMAND = 'tenon agent new'

/** 列表分段：文件声明的身份；解析不了的条目没有身份，单列在最后。 */
type Group = 'executor' | 'reviewer' | 'invalid'
const GROUPS: readonly Group[] = ['executor', 'reviewer', 'invalid']

export const groupOf = (agent: AgentSummary): Group => agent.role ?? 'invalid'

/** 行尾要不要写来源与版本：官方（内建）是常态不写；被覆盖的官方条目要写，划线的来源词就是「被覆盖」的记号。 */
const showsOrigin = (agent: AgentSummary): boolean => agent.source !== 'builtin' || agent.shadowedBy !== undefined

/** 来源词：官方 / 项目 / 自定义（与 CLI 同一口径）。 */
export const SOURCE_KEY: Readonly<Record<AgentSource, string>> = {
  builtin: 'library.official',
  project: 'library.project',
  custom: 'library.custom',
}

/**
 * 中列：按身份（文件里的 role）分段的 agent 列表。一行 = 名称 + 行尾来源与版本（纯文字、不换行）；
 * 说明在悬停提示里。官方条目是常态，行尾不写「官方 1.0.0」——来源与版本只给自定义 / 项目来源
 * （详情头仍写全）；官方条目被项目级同名覆盖时才保留来源并置灰划线，原因在提示里。
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
              <CountRoll value={rows.length} className="tabular-nums text-text-3" />
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
                      {showsOrigin(agent) && (
                        <span
                          className={agent.shadowedBy === 'project' ? 'text-text-3 line-through' : 'text-text-3'}
                          data-testid={`lib-agent-source-${agent.source}-${agent.name}`}
                        >
                          {t(SOURCE_KEY[agent.source])}
                        </span>
                      )}
                      {showsOrigin(agent) && agent.version !== undefined && (
                        <span className="tabular-nums text-text-3" data-testid={`lib-agent-version-${agent.name}`}>{agent.version}</span>
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
