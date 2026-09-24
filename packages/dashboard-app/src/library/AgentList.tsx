import { useState } from 'react'
import { useT } from '../i18n'
import type { AgentSummary } from '../api/agentClient'
import { Dialog } from '../shared/Dialog'
import { BUTTON_GHOST, BUTTON_SOLID, FIELD_LABEL, INPUT } from '../shared/uiRecipes'
import { BuiltinLock, ListSkeleton, ListTitleAction } from './libraryChrome'

/** 与 kernel 的 AGENT_NAME_RE 同形：名字即文件名，写之前就挡掉不合法的。 */
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/

const ROW = 'grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md border border-transparent px-3 py-2.5 text-left outline-none hover:bg-fill focus-visible:ring-2 focus-visible:ring-(--accent) aria-[current=true]:border-accent-b aria-[current=true]:bg-accent-t'

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

/** 中列：按执行者 / 评审者分两段的 agent 列表；「新建」在标题右侧。内建条目带锁。 */
export function AgentList({
  agents, loading, selected, busy, canWrite, onSelect, onCreate,
}: {
  agents: readonly AgentSummary[]
  loading: boolean
  selected: string | null
  busy: boolean
  canWrite: boolean
  onSelect: (name: string) => void
  onCreate: (name: string) => void
}): JSX.Element {
  const { t } = useT()
  const [dialog, setDialog] = useState(false)
  const [name, setName] = useState('')
  const taken = agents.some((agent) => agent.name === name)
  const valid = NAME.test(name) && !taken

  return (
    <>
      {!loading && (
        <ListTitleAction>
          <button
            type="button"
            className={BUTTON_GHOST}
            data-testid="lib-agent-new"
            disabled={!canWrite || busy}
            onClick={() => { setName(''); setDialog(true) }}
          >
            {t('library.agent_new')}
          </button>
        </ListTitleAction>
      )}
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
                  <span className="font-mono text-text-3">{rows.length}</span>
                </h2>
                <ul className="grid gap-1">
                  {rows.map((agent) => (
                    <li key={`${agent.source}/${agent.name}`}>
                      <button
                        type="button"
                        className={ROW}
                        aria-current={selected === agent.name ? 'true' : undefined}
                        data-testid={`lib-agent-${agent.name}`}
                        onClick={() => onSelect(agent.name)}
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-base font-semibold text-text">{agent.name}</span>
                          <span className="block truncate text-caption text-text-3">{agent.description}</span>
                        </span>
                        <span className="flex items-center gap-2 whitespace-nowrap">
                          {agent.error !== undefined && (
                            <span className="rounded-full bg-red-t px-2 py-0.5 text-micro font-bold text-red-d" data-testid={`lib-agent-invalid-${agent.name}`}>
                              {t('library.agent_invalid')}
                            </span>
                          )}
                          {agent.source === 'builtin' && <BuiltinLock testId={`lib-agent-builtin-${agent.name}`} />}
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
      {dialog && (
        <Dialog
          title={t('library.agent_new')}
          onClose={() => setDialog(false)}
          testid="lib-agent-new-dialog"
          actions={(
            <>
              <button type="button" className={BUTTON_GHOST} data-testid="lib-agent-new-cancel" onClick={() => setDialog(false)}>
                {t('library.cancel')}
              </button>
              <button
                type="button"
                className={BUTTON_SOLID}
                data-testid="lib-agent-new-confirm"
                disabled={!valid || busy}
                onClick={() => { setDialog(false); onCreate(name) }}
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
      )}
    </>
  )
}
