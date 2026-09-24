import { useState } from 'react'
import { useT } from '../i18n'
import type { AgentSummary } from '../api/agentClient'
import { Dialog } from '../shared/Dialog'
import { BUTTON_GHOST, BUTTON_SOLID, FIELD_LABEL, INPUT } from '../shared/uiRecipes'
import { StatusPill } from '../shell/ThreeColumns'
import { BuiltinLock, LIST_ROW, LIST_ROW_NAME, ListSkeleton } from './libraryChrome'

/** 与 kernel 的 AGENT_NAME_RE 同形：名字即文件名，写之前就挡掉不合法的。 */
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/

/** 新建自定义 agent 的起始骨架：合法 frontmatter + 空正文，保存后即可编辑。 */
export const agentSkeleton = (name: string): string =>
  `---\nname: ${name}\ndescription: ${name}\ntools: [Read, Grep, Glob]\n---\n\n## ${name}\n\n- \n`

/**
 * 列表分段用的身份：能写文件（Write / Edit）的是执行者，只读的是评审者。文件里不写身份
 * （由工作流步骤决定），这里只按工具做展示分组，内建的执行者 builder / researcher 与各评审者都落在对的段里。
 */
export function agentRole(agent: AgentSummary): 'executor' | 'reviewer' {
  return agent.tools.some((tool) => tool === 'Write' || tool === 'Edit') ? 'executor' : 'reviewer'
}

/** 中列：按执行者 / 评审者分两段的 agent 列表（「新建」由 ListColumn 的 action 放在标题右侧）。内建条目带锁。 */
export function AgentList({
  agents, loading, selected, onSelect,
}: {
  agents: readonly AgentSummary[]
  loading: boolean
  selected: string | null
  onSelect: (name: string) => void
}): JSX.Element {
  const { t } = useT()

  return (
    <>
      {loading ? (
        <ListSkeleton testId="lib-agent-loading" />
      ) : agents.length === 0 ? (
        <p className="text-base text-text-2" data-testid="lib-agent-empty">{t('library.agent_empty')}</p>
      ) : (
        <div className="grid gap-5" data-testid="lib-agents">
          {(['executor', 'reviewer'] as const).map((role) => {
            const rows = agents.filter((agent) => agentRole(agent) === role)
            if (rows.length === 0) return null
            return (
              <section key={role} className="grid gap-1" data-testid={`lib-agents-${role}`}>
                <h2 className="flex items-baseline gap-2 px-3 pb-1 text-caption font-semibold whitespace-nowrap text-text-2">
                  {t(`library.agent_${role}`)}
                  <span className="tabular-nums text-text-3">{rows.length}</span>
                </h2>
                <ul className="grid gap-1">
                  {rows.map((agent) => (
                    <li key={`${agent.source}/${agent.name}`}>
                      <button
                        type="button"
                        className={LIST_ROW}
                        aria-current={selected === agent.name ? 'true' : undefined}
                        data-testid={`lib-agent-${agent.name}`}
                        onClick={() => onSelect(agent.name)}
                      >
                        <span className="min-w-0">
                          <span className={`block ${LIST_ROW_NAME}`}>{agent.name}</span>
                          <span className="block truncate text-caption text-text-3">{agent.description}</span>
                        </span>
                        <span className="flex items-center gap-2 whitespace-nowrap">
                          {agent.error !== undefined && (
                            <StatusPill tone="blocked" testId={`lib-agent-invalid-${agent.name}`}>{t('library.agent_invalid')}</StatusPill>
                          )}
                          {agent.source === 'builtin' && <BuiltinLock quiet testId={`lib-agent-builtin-${agent.name}`} />}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )
          })}
        </div>
      )}
    </>
  )
}

/** 新建 agent：只问名字（即文件名），写之前按 kernel 规则挡掉非法与重名。 */
export function NewAgentDialog({ agents, busy, onClose, onCreate }: {
  agents: readonly AgentSummary[]
  busy: boolean
  onClose: () => void
  onCreate: (name: string) => void
}): JSX.Element {
  const { t } = useT()
  const [name, setName] = useState('')
  const taken = agents.some((agent) => agent.name === name)
  const valid = NAME.test(name) && !taken
  return (
    <Dialog
      title={t('library.agent_new')}
      onClose={onClose}
      testid="lib-agent-new-dialog"
      actions={(
        <>
          <button type="button" className={BUTTON_GHOST} data-testid="lib-agent-new-cancel" onClick={onClose}>
            {t('library.cancel')}
          </button>
          <button
            type="button"
            className={BUTTON_SOLID}
            data-testid="lib-agent-new-confirm"
            disabled={!valid || busy}
            onClick={() => { onClose(); onCreate(name) }}
          >
            {t('library.confirm')}
          </button>
        </>
      )}
    >
      <label className={FIELD_LABEL}>
        {t('library.name')}
        <input
          className={INPUT}
          value={name}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={name !== '' && !valid}
          data-testid="lib-agent-new-name"
          onChange={(event) => setName(event.target.value)}
        />
      </label>
    </Dialog>
  )
}
