import { useState } from 'react'
import { useT } from '../i18n'
import { BUTTON_SOLID } from '../shared/uiRecipes'
import { ConfirmDeleteDialog } from './ConfirmDeleteDialog'
import { CustomMark, CopyAsCustomButton, LIST_ROW, LIST_ROW_NAME, DeleteMenu, DetailTitle, ListSkeleton, ReadOnlyNote } from './libraryChrome'
import type { TestDirectionLibrary } from './useTestDirections'

/**
 * 库页的测试方向：中列列表（只显示名称，标识在悬停提示里）/ 右列属性表。
 * 内建只读：属性表 + 折叠的只读 YAML，只能「复制为自定义」；自定义才有可编辑的 YAML、保存与删除。
 */
export function TestDirectionsPane({
  slot,
  library,
  canWrite,
  onToast,
}: {
  slot: 'list' | 'detail'
  library: TestDirectionLibrary
  canWrite: boolean
  onToast?: (message: string) => void
}): JSX.Element | null {
  const { t } = useT()
  const [confirmDelete, setConfirmDelete] = useState(false)
  if (slot === 'list') {
    if (library.loading) return <ListSkeleton testId="lib-dir-loading" />
    return (
      <ul className="grid gap-1" data-testid="lib-directions">
        {library.directions.map((direction) => (
          <li key={`${direction.source}/${direction.id}`}>
            <button
              type="button"
              className={LIST_ROW}
              aria-current={library.selected?.id === direction.id ? 'true' : undefined}
              title={direction.id}
              data-testid={`lib-dir-${direction.id}`}
              onClick={() => library.select(direction.id)}
            >
              <span className={LIST_ROW_NAME}>{direction.label}</span>
              {direction.source === 'custom' ? <CustomMark quiet testId={`lib-dir-mark-${direction.id}`} /> : <span />}
            </button>
          </li>
        ))}
      </ul>
    )
  }
  const selected = library.selected
  if (selected === null) return null
  const definition = selected.definition
  const builtin = selected.source === 'builtin'
  const dirty = library.draft !== selected.yaml
  return (
    <div className="grid gap-4" data-testid="lib-dir-detail">
      <DetailTitle
        testId="lib-dir"
        title={selected.label}
        hint={selected.id}
        custom={!builtin}
        actions={(
          <>
            {!canWrite && <ReadOnlyNote testId="lib-dir-no-token" />}
            <CopyAsCustomButton
              testId={`lib-dir-copy-${selected.id}`}
              disabled={!canWrite || library.busy}
              onClick={() => { void library.copy(t('library.copy_suffix')).then((ok) => { if (ok) onToast?.(t('common.done_copied')) }) }}
            />
            {!builtin && (
              <>
                <button
                  type="button"
                  className={BUTTON_SOLID}
                  data-testid="lib-dir-save"
                  disabled={!canWrite || library.busy || !dirty}
                  onClick={() => { void library.save().then((ok) => { if (ok) onToast?.(t('common.done_saved')) }) }}
                >
                  {t('library.direction_save')}
                </button>
                <DeleteMenu testId="lib-dir-more" disabled={!canWrite || library.busy} onDelete={() => setConfirmDelete(true)} />
              </>
            )}
          </>
        )}
      />
      <table className="w-full border-collapse text-left text-caption" data-testid="lib-dir-fields">
        <tbody>
          {[
            ['id', t('library.id'), selected.id],
            ['command', t('workflow.test_command'), definition.command],
            ['cwd', t('workflow.test_cwd'), definition.cwd ?? '.'],
            ['timeout', t('workflow.test_timeout'), String(definition.timeout_s ?? 900)],
            ['inputs', t('workflow.test_inputs'), String(definition.inputs?.length ?? 0)],
            ['outputs', t('workflow.test_outputs'), String(definition.outputs?.length ?? 0)],
          ].map(([key, label, value]) => (
            <tr key={key} className="border-b border-border last:border-0" data-testid={`lib-dir-field-${key}`}>
              <th className="w-24 whitespace-nowrap py-1.5 font-normal text-text-3">{label}</th>
              <td className="truncate py-1.5 font-mono text-text-2">{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {builtin ? (
        <details className="rounded-sm border border-border bg-card" data-testid="lib-dir-yaml-details">
          <summary className="cursor-pointer px-3 py-2 font-mono text-caption text-text-2">YAML</summary>
          <pre className="overflow-x-auto border-t border-border p-3 font-mono text-caption text-text" data-testid="lib-dir-yaml">{selected.yaml}</pre>
        </details>
      ) : (
        <textarea
          className="min-h-64 w-full rounded-sm border border-border bg-card p-3 font-mono text-caption text-text outline-none focus-visible:ring-2 focus-visible:ring-(--accent)"
          data-testid="lib-dir-yaml"
          spellCheck={false}
          value={library.draft}
          onChange={(event) => library.setDraft(event.target.value)}
        />
      )}
      {library.error !== null && (
        <p className="whitespace-pre-wrap text-caption text-red-d" role="alert" data-testid="lib-dir-error">{library.error}</p>
      )}
      {confirmDelete && (
        <ConfirmDeleteDialog
          name={selected.label}
          detail={selected.id}
          busy={library.busy}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => {
            setConfirmDelete(false)
            void library.remove().then((ok) => { if (ok) onToast?.(t('common.done_deleted', { name: selected.label })) })
          }}
        />
      )}
    </div>
  )
}
