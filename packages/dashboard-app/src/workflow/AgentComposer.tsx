import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { GripVertical, Plus, Search } from 'lucide-react'
import type { AgentSummary } from '../api/agentClient'
import type { WbAgentSeverity, WbExecutorRef, WbReviewerRef, WbSkillRef, WbStepTest } from '../api/governanceTypes'
import { useT } from '../i18n'
import { Dialog } from '../shared/Dialog'
import { agentEntries, refsToSkills, skillsToExecutors, skillsToReviewers } from './agentFlow'
import { appendSerial, SkillFlow } from './SkillFlow'
import { SkillSourceIcon } from './SkillSourceIcon'
import { cn } from '@/lib/utils'

const SEVERITIES: readonly WbAgentSeverity[] = ['critical', 'high', 'medium', 'low']

export interface AgentComposerProps {
  open: boolean
  role: 'executors' | 'reviewers'
  stageLabel: string
  executors: readonly WbExecutorRef[]
  reviewers: readonly WbReviewerRef[]
  tests: readonly WbStepTest[]
  agents: readonly AgentSummary[] | null
  onClose: () => void
  onSave: (patch: { executors?: WbExecutorRef[]; reviewers?: WbReviewerRef[] }) => void
}

/**
 * agent 编辑器，三栏：agent 库（拖到画布或点「+」加入）/ React Flow 画布（连线 = depends_on）/
 * 选中项设置（评审者才有 必需 · 阻断 · 测试）。保存才写回步骤定义。
 */
export function AgentComposer({
  open, role, stageLabel, executors, reviewers, tests, agents, onClose, onSave,
}: AgentComposerProps): JSX.Element | null {
  const { t } = useT()
  const reviewing = role === 'reviewers'
  const [draft, setDraft] = useState<WbSkillRef[]>([])
  const [settings, setSettings] = useState<WbReviewerRef[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [dragging, setDragging] = useState<string | null>(null)
  // 草稿只在打开（或切换角色）的那一刻取自 props。父组件每次重渲染都会传来新的数组引用，
  // 若把 executors / reviewers 放进依赖，编辑中的草稿会被反复清空：加上的评审者存不下来，「+」也像点不动。
  const initial = useRef({ executors, reviewers })
  initial.current = { executors, reviewers }
  useEffect(() => {
    if (!open) return
    const current = initial.current
    const refs = reviewing ? current.reviewers : current.executors
    setDraft(refsToSkills(refs))
    setSettings([...current.reviewers])
    setSelected(refs[0]?.agent ?? null)
  }, [open, reviewing])
  const registry = useMemo(() => agentEntries(agents), [agents])
  const placed = useMemo(() => new Set(draft.map((ref) => ref.id)), [draft])
  const listed = useMemo(() => (agents ?? [])
    .filter((agent) => agent.name.toLowerCase().includes(search.trim().toLowerCase()))
    .sort((a, b) => Number(placed.has(a.name)) - Number(placed.has(b.name)) || a.name.localeCompare(b.name)), [agents, placed, search])
  if (!open) return null

  // 画布上刚加进来的评审者还不在 settings 里：先按缺省补齐，设置面板才有东西可改。
  const effective = reviewing ? skillsToReviewers(draft, settings) : []
  const current = selected === null ? null : effective.find((ref) => ref.agent === selected) ?? null
  const patch = (name: string, change: Partial<WbReviewerRef>): void => {
    setSettings(effective.map((ref) => ref.agent === name ? { ...ref, ...change } : ref))
  }
  const save = (): void => {
    onSave(reviewing ? { reviewers: effective } : { executors: skillsToExecutors(draft) })
    onClose()
  }

  return (
    <Dialog
      title={`${stageLabel} · ${t(reviewing ? 'workflow.reviewers_title' : 'workflow.executors_title')}`}
      onClose={onClose}
      variant="workspace"
      testid="agent-composer"
      closeLabel={t('workflow.cancel')}
      closeTestid="agent-composer-close"
      panelClassName="h-[min(90vh,60rem)] w-[min(97vw,96rem)]"
      actions={(
        <>
          <button type="button" className="min-h-10 rounded-md px-3 text-base text-text-2 hover:bg-fill" data-testid="agent-composer-cancel" onClick={onClose}>
            {t('workflow.cancel')}
          </button>
          <button type="button" className="min-h-10 rounded-md bg-(--accent) px-4 text-base font-semibold text-btn-fg hover:bg-accent-d" data-testid="agent-composer-save" onClick={save}>
            {t('workflow.composer_save')}
          </button>
        </>
      )}
    >
      <div className="grid h-full min-h-0 grid-cols-[17rem_minmax(0,1fr)_minmax(18rem,22rem)] gap-4 max-[1100px]:grid-cols-[16rem_minmax(0,1fr)] max-[900px]:grid-cols-1">
        <section className="flex min-h-0 flex-col gap-2 rounded-lg border border-border bg-bg p-2" data-testid="agent-palette" aria-label={t('library.agents')}>
          <label className="flex h-9 flex-none items-center gap-2 rounded-md border border-border bg-card px-2 text-text-3 focus-within:border-accent-b">
            <Search className="size-3.5 flex-none" aria-hidden="true" />
            <span className="sr-only">{t('workflow.search_agents')}</span>
            <input
              type="search"
              value={search}
              placeholder={t('workflow.search_agents')}
              className="min-w-0 flex-1 bg-transparent text-body text-text outline-none placeholder:text-text-3"
              data-testid="agent-palette-search"
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          {agents === null ? (
            <p className="px-1 text-caption text-text-3" role="status">{t('common.loading')}</p>
          ) : listed.length === 0 ? (
            <p className="px-1 text-caption text-text-3" role="status">{t('library.agent_empty')}</p>
          ) : (
            <ul className="grid min-h-0 flex-1 grid-cols-1 content-start gap-0.5 overflow-y-auto pr-0.5">
              {listed.map((agent) => (
                <PaletteItem
                  key={agent.name}
                  agent={agent}
                  placed={placed.has(agent.name)}
                  active={selected === agent.name}
                  onOpen={setSelected}
                  onAdd={(name) => setDraft((refs) => appendSerial(refs, name))}
                  onDragging={setDragging}
                />
              ))}
            </ul>
          )}
        </section>
        <SkillFlow
          skills={draft}
          registry={registry}
          editable
          onChange={setDraft}
          onOpen={setSelected}
          dragLabel={dragging}
          label={t(reviewing ? 'workflow.reviewers_title' : 'workflow.executors_title')}
          emptyText={t(reviewing ? 'workflow.drop_reviewer' : 'workflow.drop_executor')}
          className="min-h-0"
        />
        <aside className="flex min-h-0 flex-col gap-4 overflow-y-auto rounded-lg border border-border bg-card p-4 max-[1100px]:hidden" data-testid="agent-composer-detail">
          {selected === null ? (
            <p className="text-body text-text-3" role="status">{t('workflow.pick_agent')}</p>
          ) : (
            <>
              <p className="font-mono text-title font-semibold text-text">{selected}</p>
              <p className="text-body text-text-2">{(agents ?? []).find((agent) => agent.name === selected)?.description ?? ''}</p>
              {reviewing && current !== null && (
                <>
                  <div className="grid gap-1.5" role="radiogroup" aria-label={t('workflow.agent_required')} data-testid={`wb-agent-required-${selected}`}>
                    <span className="text-caption font-semibold text-text-2">{t('workflow.agent_required')}</span>
                    <div className="flex gap-2">
                      {[true, false].map((value) => (
                        <button
                          key={String(value)}
                          type="button"
                          role="radio"
                          aria-checked={current.required === value}
                          className={cn('min-h-9 flex-1 rounded-sm border px-3 text-body outline-none focus-visible:ring-2 focus-visible:ring-(--accent)', current.required === value ? 'border-accent-b bg-accent-t font-semibold text-(--accent)' : 'border-border bg-card text-text')}
                          data-testid={`wb-agent-required-${selected}-${value ? 'yes' : 'no'}`}
                          onClick={() => patch(selected, { required: value })}
                        >
                          {t(value ? 'workflow.agent_required' : 'workflow.agent_advisory')}
                        </button>
                      ))}
                    </div>
                  </div>
                  <label className="grid gap-1.5 text-caption font-semibold text-text-2">
                    {t('workflow.agent_block_at')}
                    <select
                      className="min-h-9 rounded-sm border border-border bg-card px-2 text-body text-text outline-none focus-visible:ring-2 focus-visible:ring-(--accent)"
                      value={current.block_at}
                      data-testid={`wb-agent-block-${selected}`}
                      onChange={(event) => patch(selected, { block_at: SEVERITIES.find((value) => value === event.target.value) ?? 'high' })}
                    >
                      {SEVERITIES.map((value) => (
                        <option key={value} value={value}>{t(`workflow.severity_${value}`)}</option>
                      ))}
                    </select>
                  </label>
                  {tests.length > 0 && (
                    <div className="grid gap-1.5" data-testid={`wb-agent-tests-${selected}`}>
                      <span className="text-caption font-semibold text-text-2">{t('workflow.agent_tests')}</span>
                      <div className="flex flex-wrap gap-1">
                        {tests.map((test) => {
                          const on = (current.reads_tests ?? []).includes(test.id)
                          return (
                            <button
                              key={test.id}
                              type="button"
                              aria-pressed={on}
                              className={cn('min-h-8 rounded-full border px-2.5 font-mono text-caption outline-none focus-visible:ring-2 focus-visible:ring-(--accent)', on ? 'border-accent-b bg-accent-t text-(--accent)' : 'border-border bg-card text-text-2')}
                              data-testid={`wb-agent-test-${selected}-${test.id}`}
                              onClick={() => patch(selected, {
                                reads_tests: on
                                  ? (current.reads_tests ?? []).filter((id) => id !== test.id)
                                  : [...(current.reads_tests ?? []), test.id],
                              })}
                            >
                              {test.id}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </aside>
      </div>
    </Dialog>
  )
}

function PaletteItem({ agent, placed, active, onOpen, onAdd, onDragging }: {
  agent: AgentSummary
  placed: boolean
  active: boolean
  onOpen: (name: string) => void
  onAdd: (name: string) => void
  onDragging: (name: string | null) => void
}): JSX.Element {
  const { t } = useT()
  function onDragStart(event: DragEvent<HTMLLIElement>): void {
    event.dataTransfer.setData('text/skill', agent.name)
    event.dataTransfer.effectAllowed = 'move'
    onDragging(agent.name)
  }
  return (
    <li
      className={cn('flex min-w-0 items-center gap-1 rounded-md border px-1 py-1', active ? 'border-accent-b bg-accent-t' : 'border-transparent hover:border-border hover:bg-card', placed ? 'opacity-45' : 'cursor-grab active:cursor-grabbing')}
      draggable={!placed}
      onDragStart={placed ? undefined : onDragStart}
      onDragEnd={() => onDragging(null)}
      data-testid={`palette-agent-${agent.name}`}
      data-placed={placed}
    >
      <span className="grid size-6 flex-none place-items-center text-text-3" aria-hidden="true"><GripVertical className="size-3.5" /></span>
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 py-0.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-(--accent)"
        aria-pressed={active}
        data-testid={`palette-agent-open-${agent.name}`}
        onClick={() => onOpen(agent.name)}
      >
        <span className={cn('truncate font-mono text-body', active ? 'font-semibold text-(--accent)' : 'text-text')}>{agent.name}</span>
        <span className="ml-auto flex flex-none items-center"><SkillSourceIcon source={agent.source === 'builtin' ? 'builtin' : 'user'} /></span>
      </button>
      <button
        type="button"
        className="grid size-6 flex-none place-items-center rounded-xs text-text-3 outline-none hover:bg-fill hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent) disabled:invisible"
        aria-label={t('workflow.add_skill', { id: agent.name })}
        disabled={placed}
        data-testid={`palette-agent-add-${agent.name}`}
        onClick={() => onAdd(agent.name)}
      >
        <Plus className="size-3.5" aria-hidden="true" />
      </button>
    </li>
  )
}
