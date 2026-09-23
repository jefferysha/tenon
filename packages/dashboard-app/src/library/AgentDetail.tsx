import { useEffect, useState } from 'react'
import { useT } from '../i18n'
import { getToken } from '../api/transport'
import type { AgentDocument, AgentReference, AgentSummary } from '../api/agentClient'
import { DetailColumn, StatusPill } from '../shell/ThreeColumns'
import { SheetTabs, type SheetDef } from '../shared/DetailSheets'
import { Markdown } from '../shared/Markdown'
import { BUTTON_DANGER, BUTTON_GHOST, BUTTON_SOLID, TEXTAREA } from '../shared/uiRecipes'
import { ConfirmDeleteDialog } from './ConfirmDeleteDialog'

type Sheet = 'preview' | 'edit'

const where = (item: AgentReference): string =>
  [item.workflow, item.track, item.label].filter((part) => part !== null && part !== '').join(' / ')

/** 右列：agent 正文（预览 / 编辑）、frontmatter 表、被哪些步骤引用，底部动作条。内建只有「复制」。 */
export function AgentDetail({
  document, summary, draft, busy, error, blockedBy, onDraft, onSave, onCopy, onDelete,
}: {
  document: AgentDocument
  summary: AgentSummary | null
  draft: string
  busy: boolean
  error: string | null
  blockedBy: readonly AgentReference[]
  onDraft: (content: string) => void
  onSave: () => void
  onCopy: () => void
  onDelete: () => void
}): JSX.Element {
  const { t } = useT()
  const custom = document.source === 'custom'
  const sheets: SheetDef<Sheet>[] = custom
    ? [{ id: 'preview', label: t('library.preview') }, { id: 'edit', label: t('library.edit') }]
    : [{ id: 'preview', label: t('library.preview') }]
  const [sheet, setSheet] = useState<Sheet>('preview')
  const [confirmDelete, setConfirmDelete] = useState(false)
  useEffect(() => { setSheet('preview'); setConfirmDelete(false) }, [document.name])
  const canWrite = getToken() !== ''
  const dirty = draft !== document.content
  // 引用来自两处：打开时扫到的，和删除被拒时 409 带回的（后者更新，优先）。
  const blocked = blockedBy.length > 0
  const references = blocked ? blockedBy : document.references
  const fields: readonly (readonly [string, string])[] = summary === null ? [] : [
    ['description', summary.description],
    ['skills', summary.skills.join(' ')],
    ['tools', summary.tools.join(' ')],
    ['model', summary.model ?? ''],
    ['hosts', (summary.hosts ?? []).join(' ')],
  ]

  return (
    <DetailColumn
      testId="lib-agent-detail"
      panelId="lib-agent-panel"
      labelledBy={`lib-agent-tab-${sheet}`}
      header={(
        <div className="grid gap-2">
          <p className="text-caption font-semibold uppercase tracking-[.08em] text-(--accent)" data-testid="lib-agent-eyebrow">
            {t('library.agents')}
          </p>
          <h1 className="text-page font-bold tracking-[-.01em] text-text" data-testid="lib-agent-title">{document.name}</h1>
          <StatusPill tone={custom ? 'running' : 'neutral'} testId="lib-agent-source">
            {t(custom ? 'library.custom' : 'library.builtin')}
          </StatusPill>
        </div>
      )}
      sheets={<SheetTabs sheets={sheets} active={sheet} onChange={setSheet} ariaLabel={t('library.agents')} idPrefix="lib-agent" />}
      footer={(
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={BUTTON_GHOST} data-testid="lib-agent-copy" disabled={!canWrite || busy} onClick={onCopy}>
            {t('library.copy')}
          </button>
          {custom && (
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
              <button type="button" className={BUTTON_DANGER} data-testid="lib-agent-delete" disabled={!canWrite || busy} onClick={() => setConfirmDelete(true)}>
                {t('library.delete')}
              </button>
            </>
          )}
          {!canWrite && <span className="text-caption text-text-3" data-testid="lib-agent-no-token">{t('library.no_token')}</span>}
        </div>
      )}
    >
      {error !== null && (
        <p className="mb-4 whitespace-pre-wrap rounded-md border border-red-b bg-red-t px-4 py-3 text-body font-semibold text-red-d" role="alert" data-testid="lib-agent-error">
          {error}
        </p>
      )}
      {sheet === 'edit' && custom ? (
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
                    <th scope="row" className="w-24 py-2 text-left text-caption font-semibold text-text-3">{t(`library.${key}`)}</th>
                    <td className="truncate py-2 font-mono text-caption text-text-2">{value === '' ? '—' : value}</td>
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
              <li key={`${item.workflow}/${item.track ?? ''}/${item.step}/${item.role}`} className="truncate font-mono text-caption text-text-2">
                {`${where(item)} · ${t(`library.agent_${item.role}`)}`}
              </li>
            ))}
          </ul>
        </div>
      )}
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
