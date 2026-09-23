import { useState } from 'react'
import { useT } from '../i18n'
import { getToken } from '../api/transport'
import type { InstructionPreviewFile, InstructionTarget } from '../api/instructionsDecoders'
import { Dialog } from '../shared/Dialog'
import { SheetTabs, type SheetDef } from '../shared/DetailSheets'
import { Markdown } from '../shared/Markdown'
import { BUTTON_DANGER, BUTTON_GHOST, BUTTON_SOLID, TEXTAREA } from '../shared/uiRecipes'
import { DetailColumn } from '../shell/ThreeColumns'
import { DiffDrawer } from './DiffDrawer'
import { managedCount } from './instructionModel'

type Sheet = 'edit' | 'preview'

/** 右列：一份正文写进所选的全部目标文件；应用前先看差异，删除前先确认受管块处理。 */
export function InstructionEditor({
  level, title, root, targets, targetIds, text, onText, external, busy, errorKey, onPreview, onApply, onDelete, onReload, onDismissExternal,
}: {
  level: 'project' | 'user'
  title: string
  root: string
  targets: readonly InstructionTarget[]
  targetIds: readonly string[]
  text: string
  onText: (next: string) => void
  external: boolean
  busy: boolean
  errorKey: string | null
  onPreview: () => Promise<readonly InstructionPreviewFile[] | null>
  onApply: (files: readonly InstructionPreviewFile[]) => Promise<boolean>
  onDelete: () => Promise<void>
  onReload: () => void
  onDismissExternal: () => void
}): JSX.Element {
  const { t } = useT()
  const sheets: SheetDef<Sheet>[] = [
    { id: 'edit', label: t('projects.edit') },
    { id: 'preview', label: t('projects.preview') },
  ]
  const [sheet, setSheet] = useState<Sheet>('edit')
  const [diff, setDiff] = useState<readonly InstructionPreviewFile[] | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const canWrite = getToken() !== ''
  const kept = managedCount(targets, targetIds)

  return (
    <>
      <DetailColumn
        testId="proj-detail"
        panelId="proj-panel"
        labelledBy={`proj-tab-${sheet}`}
        header={(
          <div className="grid gap-2">
            <p className="text-caption font-semibold uppercase tracking-[.08em] text-(--accent)" data-testid="proj-eyebrow">
              {t(level === 'project' ? 'projects.project_level' : 'projects.user_level')}
            </p>
            <h1 className="text-page font-bold tracking-[-.01em] text-text" data-testid="proj-title">{title}</h1>
            {root !== '' && (
              <p className="font-mono text-caption whitespace-nowrap overflow-x-auto text-text-3" data-testid="proj-root">{root}</p>
            )}
          </div>
        )}
        sheets={<SheetTabs sheets={sheets} active={sheet} onChange={setSheet} ariaLabel={t('projects.file')} idPrefix="proj" />}
        footer={(
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={BUTTON_SOLID}
              data-testid="proj-apply"
              disabled={!canWrite || busy || targetIds.length === 0}
              onClick={() => { void (async () => { const files = await onPreview(); if (files !== null) setDiff(files) })() }}
            >
              {t('projects.apply')}
            </button>
            <button
              type="button"
              className={BUTTON_DANGER}
              data-testid="proj-delete"
              disabled={!canWrite || busy || targetIds.length === 0}
              onClick={() => setConfirmDelete(true)}
            >
              {t('projects.delete')}
            </button>
            {!canWrite && <span className="text-caption text-text-3" data-testid="proj-no-token">{t('projects.no_token')}</span>}
          </div>
        )}
      >
        {external && (
          <div className="mb-4 flex flex-wrap items-center gap-3 rounded-md border border-amber-b bg-amber-t px-4 py-3" role="status" data-testid="proj-external">
            <span className="text-body font-semibold text-amber-d">{t('projects.external')}</span>
            <button
              type="button"
              className={BUTTON_GHOST}
              data-testid="proj-external-reload"
              onClick={() => { onDismissExternal(); onReload() }}
            >
              {t('projects.reload')}
            </button>
          </div>
        )}
        {errorKey !== null && (
          <p className="mb-4 rounded-md border border-red-b bg-red-t px-4 py-3 text-body font-semibold text-red-d" role="alert" data-testid="proj-error">
            {t(`projects.errors.${errorKey}`)}
          </p>
        )}
        {sheet === 'edit' ? (
          <textarea
            className={`${TEXTAREA} min-h-[420px] font-mono text-caption`}
            value={text}
            spellCheck={false}
            data-testid="proj-editor"
            onChange={(event) => onText(event.target.value)}
          />
        ) : (
          <Markdown text={text} testId="proj-preview" density="compact" />
        )}
      </DetailColumn>
      {diff !== null && (
        <DiffDrawer
          files={diff}
          root={root}
          busy={busy}
          onClose={() => setDiff(null)}
          onConfirm={() => { void (async () => { if (await onApply(diff)) setDiff(null) })() }}
        />
      )}
      {confirmDelete && (
        <Dialog
          title={t('projects.delete')}
          onClose={() => setConfirmDelete(false)}
          testid="proj-delete-dialog"
          actions={(
            <>
              <button type="button" className={BUTTON_GHOST} data-testid="proj-delete-cancel" onClick={() => setConfirmDelete(false)}>
                {t('projects.cancel')}
              </button>
              <button
                type="button"
                className={BUTTON_DANGER}
                data-testid="proj-delete-confirm"
                disabled={busy}
                onClick={() => { void (async () => { await onDelete(); setConfirmDelete(false) })() }}
              >
                {t('projects.confirm')}
              </button>
            </>
          )}
        >
          <div className="grid gap-2">
            <ul className="grid gap-1">
              {targetIds.map((id) => (
                <li key={id} className="font-mono text-caption whitespace-nowrap text-text">{id}</li>
              ))}
            </ul>
            {kept > 0 && (
              <p className="text-body text-text-2" data-testid="proj-delete-managed">{t('projects.managed_kept', { n: kept })}</p>
            )}
          </div>
        </Dialog>
      )}
    </>
  )
}
