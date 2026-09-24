import { useState } from 'react'
import { useT } from '../i18n'
import { getToken } from '../api/transport'
import type { InstructionPreviewFile, InstructionTarget } from '../api/instructionsDecoders'
import { Dialog } from '../shared/Dialog'
import { SheetTabs, type SheetDef } from '../shared/DetailSheets'
import { Markdown } from '../shared/Markdown'
import { BUTTON_DANGER, BUTTON_GHOST, BUTTON_SOLID, TEXTAREA } from '../shared/uiRecipes'
import { DetailColumn } from '../shell/ThreeColumns'
import { MenuButton } from '../shared/MenuButton'
import { DiffDrawer } from './DiffDrawer'
import { fileStatus, managedCount } from './instructionModel'

type Sheet = 'edit' | 'render'

/**
 * 右列：一份正文写进所选的全部目标文件。动作在标题右侧：「预览变更」打开差异抽屉、在抽屉里确认「应用」；
 * 删除收在 ⋯ 菜单里，先确认受管块处理。所选文件都与正文一致时没有可写的变更，「预览变更」禁用。
 */
export function InstructionEditor({
  title, root, targets, targetIds, text, onText, external, busy, errorKey, onPreview, onApply, onDelete, onReload, onDismissExternal,
}: {
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
    { id: 'render', label: t('projects.render') },
  ]
  const [sheet, setSheet] = useState<Sheet>('edit')
  const [diff, setDiff] = useState<readonly InstructionPreviewFile[] | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const canWrite = getToken() !== ''
  const kept = managedCount(targets, targetIds)
  const changed = targetIds.some((id) => {
    const target = targets.find((candidate) => candidate.id === id)
    return target === undefined || fileStatus(target, text) !== 'same'
  })

  return (
    <>
      <DetailColumn
        testId="proj-detail"
        panelId="proj-panel"
        labelledBy={`proj-tab-${sheet}`}
        header={(
          <div className="grid gap-2">
            <div className="flex min-w-0 items-center gap-3">
              <h1 className="min-w-0 truncate text-page font-bold tracking-[-.01em] text-text" title={title} data-testid="proj-title">{title}</h1>
              <div className="ml-auto flex flex-none items-center gap-2 whitespace-nowrap">
                {!canWrite && <span className="text-caption text-text-3" data-testid="proj-no-token">{t('projects.no_token')}</span>}
                <button
                  type="button"
                  className={BUTTON_SOLID}
                  data-testid="proj-apply"
                  disabled={!canWrite || busy || targetIds.length === 0 || !changed}
                  onClick={() => { void (async () => { const files = await onPreview(); if (files !== null) setDiff(files) })() }}
                >
                  {t('projects.preview_changes')}
                </button>
                <MenuButton
                  label={t('projects.more')}
                  testId="proj-more"
                  disabled={!canWrite || busy || targetIds.length === 0}
                  items={[{ id: 'delete', label: t('projects.delete'), danger: true, onSelect: () => setConfirmDelete(true) }]}
                />
              </div>
            </div>
            {root !== '' && (
              <p className="font-mono text-caption whitespace-nowrap overflow-x-auto text-text-3" data-testid="proj-root">{root}</p>
            )}
          </div>
        )}
        sheets={<SheetTabs sheets={sheets} active={sheet} onChange={setSheet} ariaLabel={t('projects.file')} idPrefix="proj" />}
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
          <Markdown text={text} testId="proj-render" density="compact" />
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
