import { useState, type ReactNode } from 'react'
import { useT } from '../../i18n'
import { DetailEmpty, ThreeColumns } from '../../shell/ThreeColumns'
import { matchesQuery } from '../../shell/GlobalSearch'
import { Dialog } from '../../shared/Dialog'
import { BUTTON_DANGER, BUTTON_GHOST } from '../../shared/uiRecipes'
import { ResourceDetail } from './ResourceDetail'
import { ResourceEditorDrawer } from './ResourceEditorDrawer'
import { ResourceList } from './ResourceList'
import { resourceSkeleton } from './resourceLabels'
import { useResourceCatalog } from './useResourceCatalog'

const NEW_ID = 'new-resource'

/** 资源目录：左列种类（库的导轨由调用方给）/ 中列条目列表 / 右列条目详情。 */
export function ResourceCatalog({
  rail, railCollapsed, today, onToast,
}: {
  rail: ReactNode
  railCollapsed: boolean
  /** 新条目骨架里的核验日期；调用方注入，渲染保持确定。 */
  today: string
  onToast?: (message: string) => void
}): JSX.Element {
  const { t } = useT()
  const catalog = useResourceCatalog()
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<'none' | 'existing' | 'new'>('none')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const rows = catalog.rows.filter((row) => matchesQuery(search, row.entry.id, row.entry.name, row.entry.use ?? ''))
  const document = catalog.document

  const onSave = (text: string): void => {
    void (async () => {
      const id = editing === 'new' ? (/^id:\s*(\S+)/mu.exec(text)?.[1] ?? NEW_ID) : document?.entry.id ?? ''
      const revision = editing === 'new' ? undefined : document?.revision
      if (await catalog.save(id, text, revision)) {
        setEditing('none')
        onToast?.(t('common.done_saved'))
      }
    })()
  }

  return (
    <>
      <ThreeColumns
        testId="resource-view"
        railCollapsed={railCollapsed}
        rail={rail}
        list={(
          <ResourceList
            rows={rows}
            errors={catalog.list.errors}
            loading={catalog.loading}
            search={search}
            query={catalog.query}
            selected={catalog.selected}
            busy={catalog.busy}
            onSearch={setSearch}
            onQuery={catalog.setQuery}
            onSelect={catalog.select}
            onNew={() => setEditing('new')}
          />
        )}
        detail={document === null ? (
          <DetailEmpty label={t('resources.empty_detail')} testId="res-detail-empty" />
        ) : (
          <ResourceDetail
            document={document}
            busy={catalog.busy}
            errorKey={catalog.errorKey}
            onCopy={() => { void (async () => { if (await catalog.copy()) onToast?.(t('common.done_copied')) })() }}
            onEdit={() => setEditing('existing')}
            onDelete={() => setConfirmDelete(true)}
            onReload={() => { void catalog.reload() }}
          />
        )}
      />
      {editing !== 'none' && (
        <ResourceEditorDrawer
          open
          id={editing === 'new' ? NEW_ID : document?.entry.id ?? ''}
          yaml={editing === 'new' ? resourceSkeleton(NEW_ID, today) : document?.yaml ?? ''}
          busy={catalog.busy}
          errors={catalog.errorList}
          errorKey={catalog.errorKey}
          onSave={onSave}
          onClose={() => setEditing('none')}
          onReload={() => { void catalog.reload(); setEditing('none') }}
        />
      )}
      {confirmDelete && document !== null && (
        <Dialog
          title={t('resources.delete_title', { name: document.entry.name })}
          testid="res-delete-dialog"
          role="alertdialog"
          onClose={() => setConfirmDelete(false)}
          actions={(
            <>
              <button type="button" className={BUTTON_GHOST} data-testid="res-delete-cancel" onClick={() => setConfirmDelete(false)}>
                {t('resources.cancel')}
              </button>
              <button
                type="button"
                className={BUTTON_DANGER}
                data-testid="res-delete-confirm"
                disabled={catalog.busy}
                onClick={() => {
                  setConfirmDelete(false)
                  const name = document.entry.id
                  void (async () => { if (await catalog.remove()) onToast?.(t('common.done_deleted', { name })) })()
                }}
              >
                {t('resources.delete')}
              </button>
            </>
          )}
        >
          <p className="text-base text-text-2">{document.entry.id}</p>
        </Dialog>
      )}
    </>
  )
}
