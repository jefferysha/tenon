import { useEffect, useState } from 'react'
import { useT } from '../i18n'
import { getToken } from '../api/transport'
import type { AgentDocument, AgentReference, AgentRun, AgentSummary } from '../api/agentClient'
import { DetailColumn } from '../shell/ThreeColumns'
import { SheetTabs, type SheetDef } from '../shared/DetailSheets'
import { Markdown } from '../shared/Markdown'
import { BUTTON_SOLID, TEXTAREA } from '../shared/uiRecipes'
import { ConfirmDeleteDialog } from './ConfirmDeleteDialog'
import { SOURCE_KEY } from './AgentList'
import { CopyAsCustomButton, DeleteMenu, DetailTitle, ReadOnlyNote } from './libraryChrome'

type Sheet = 'preview' | 'edit'

const where = (item: AgentReference): string =>
  [item.workflow, item.track, item.label].filter((part) => part !== null && part !== '').join(' / ')

const RUN_WORD: Readonly<Record<NonNullable<AgentRun['result']>, string>> = {
  pass: 'workspace.agent_pass', fail: 'workspace.agent_fail', done: 'workspace.agent_done', failed: 'workspace.agent_failed',
}

const CELL = 'truncate py-2 pr-3 font-mono text-caption whitespace-nowrap text-text-2'

/** 最近运行：任务 · 阶段 · 结论 · 问题 · 子代理 · 时间，一行一次，不换行。 */
function RecentRuns({ runs }: { runs: readonly AgentRun[] }): JSX.Element {
  const { t } = useT()
  const heads = ['run_change', 'run_step', 'run_result', 'run_findings', 'run_subagent', 'run_time'] as const
  return (
    <section className="mt-5 grid gap-1" data-testid="lib-agent-runs">
      <h2 className="text-caption font-semibold whitespace-nowrap text-text-2">{t('library.runs')}</h2>
      <table className="w-full table-fixed border-collapse">
        <thead>
          <tr className="border-b border-border">
            {heads.map((head) => (
              <th key={head} scope="col" className="truncate py-2 pr-3 text-left text-caption font-semibold whitespace-nowrap text-text-3">{t(`library.${head}`)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={`${run.change}/${run.startedAt}`} className="border-b border-border" data-testid="lib-agent-run">
              <td className={CELL} title={run.change}>{run.change}</td>
              <td className={CELL}>{run.step}</td>
              <td className={CELL}>{t(run.result === null ? 'workspace.agent_running' : RUN_WORD[run.result])}</td>
              <td className={`${CELL} tabular-nums`}>{run.findings}</td>
              <td className={CELL} title={run.subagent ?? undefined}>{run.subagent ?? '—'}</td>
              <td className={`${CELL} tabular-nums`} title={run.finishedAt ?? run.startedAt}>{(run.finishedAt ?? run.startedAt).slice(0, 16).replace('T', ' ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

/**
 * 右列：字段表、正文、被哪些工作流步骤使用、最近运行。动作在标题右侧：官方只有「复制为自定义」；
 * 自定义与项目级多出预览 / 编辑页签、「保存」与 ⋯ 里的删除。只有一个视图时不渲染页签。
 */
export function AgentDetail({
  document, summary, draft, busy, error, blockedBy, editOnOpen = false, onDraft, onSave, onCopy, onDelete,
}: {
  document: AgentDocument
  summary: AgentSummary | null
  draft: string
  busy: boolean
  error: string | null
  blockedBy: readonly AgentReference[]
  /** 刚「复制为自定义」出来的副本：打开即进入编辑页签。 */
  editOnOpen?: boolean
  onDraft: (content: string) => void
  onSave: () => void
  onCopy: () => void
  onDelete: () => void
}): JSX.Element {
  const { t } = useT()
  const editable = document.source !== 'builtin'
  const sheets: SheetDef<Sheet>[] = [{ id: 'preview', label: t('library.preview') }, { id: 'edit', label: t('library.edit') }]
  const [sheet, setSheet] = useState<Sheet>('preview')
  const [confirmDelete, setConfirmDelete] = useState(false)
  useEffect(() => { setSheet(editOnOpen && editable ? 'edit' : 'preview'); setConfirmDelete(false) }, [document.name, editOnOpen, editable])
  const canWrite = getToken() !== ''
  const dirty = draft !== document.content
  // 引用来自两处：打开时扫到的，和删除被拒时 409 带回的（后者更新，优先）。
  const blocked = blockedBy.length > 0
  const references = blocked ? blockedBy : document.references
  const fields: readonly (readonly [string, string])[] = summary === null ? [] : [
    ['description', summary.description],
    ['role', summary.role === undefined ? '' : t(`library.agent_${summary.role}`)],
    ['version', summary.version ?? ''],
    ['skills', summary.skills.join(' ')],
    ['tools', summary.tools.join(' ')],
    ['model', summary.model ?? ''],
    ['hosts', (summary.hosts ?? []).join(' ')],
  ]

  return (
    <DetailColumn
      testId="lib-agent-detail"
      panelId="lib-agent-panel"
      labelledBy={editable ? `lib-agent-tab-${sheet}` : undefined}
      header={(
        <DetailTitle
          testId="lib-agent"
          title={document.name}
          custom={document.source === 'custom'}
          meta={(
            <span className="flex flex-none items-baseline gap-2 text-caption whitespace-nowrap" data-testid="lib-agent-meta">
              <span className="text-text-3" data-testid="lib-agent-source">{t(SOURCE_KEY[document.source])}</span>
              {summary?.version !== undefined && <span className="tabular-nums text-text-4">{summary.version}</span>}
            </span>
          )}
          actions={(
            <>
              {!canWrite && <ReadOnlyNote testId="lib-agent-no-token" />}
              <CopyAsCustomButton testId="lib-agent-copy" disabled={!canWrite || busy} onClick={onCopy} />
              {editable && (
                <>
                  <button
                    type="button"
                    className={BUTTON_SOLID}
                    data-testid="lib-agent-save"
                    disabled={!canWrite || busy || !dirty}
                    onClick={onSave}
                  >
                    {t('library.save')}
                  </button>
                  <DeleteMenu testId="lib-agent-more" disabled={!canWrite || busy} onDelete={() => setConfirmDelete(true)} />
                </>
              )}
            </>
          )}
        />
      )}
      sheets={editable ? <SheetTabs sheets={sheets} active={sheet} onChange={setSheet} ariaLabel={t('library.agents')} idPrefix="lib-agent" /> : undefined}
    >
      {error !== null && (
        <p className="mb-4 whitespace-pre-wrap rounded-md border border-red-b bg-red-t px-4 py-3 text-body font-semibold text-red-d" role="alert" data-testid="lib-agent-error">
          {error}
        </p>
      )}
      {sheet === 'edit' && editable ? (
        <textarea
          className={`${TEXTAREA} min-h-[420px] font-mono text-caption`}
          value={draft}
          spellCheck={false}
          data-testid="lib-agent-content"
          onChange={(event) => onDraft(event.target.value)}
        />
      ) : (
        <>
          {fields.length > 0 && (
            <table className="mb-5 w-full table-fixed border-collapse text-base" data-testid="lib-agent-fields">
              <tbody>
                {fields.map(([key, value]) => (
                  <tr key={key} className="border-b border-border" data-testid={`lib-agent-field-${key}`}>
                    <th scope="row" className="w-24 py-2 text-left text-caption font-semibold whitespace-nowrap text-text-3">{t(`library.${key}`)}</th>
                    <td className="truncate py-2 font-mono text-caption whitespace-nowrap text-text-2" title={value}>{value === '' ? '—' : value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <Markdown text={document.content} testId="lib-agent-preview" density="compact" />
        </>
      )}
      {references.length > 0 && (
        <div
          className={`mt-5 grid gap-1 rounded-md border px-4 py-3 ${blocked ? 'border-red-b bg-red-t' : 'border-border'}`}
          data-testid="lib-agent-references"
        >
          <span className={`text-caption font-semibold ${blocked ? 'text-red-d' : 'text-text-2'}`}>{t('library.references')}</span>
          <ul className="grid gap-1">
            {references.map((item) => (
              <li key={`${item.workflow}/${item.track ?? ''}/${item.step}/${item.role}`} className="truncate font-mono text-caption whitespace-nowrap text-text-2">
                {`${where(item)} · ${t(`library.agent_${item.role}`)}`}
              </li>
            ))}
          </ul>
        </div>
      )}
      {sheet === 'preview' && document.runs.length > 0 && <RecentRuns runs={document.runs} />}
      {confirmDelete && (
        <ConfirmDeleteDialog
          name={document.name}
          detail={document.name}
          busy={busy}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => { setConfirmDelete(false); onDelete() }}
        />
      )}
    </DetailColumn>
  )
}
