import { Lock } from 'lucide-react'
import { useT } from '../i18n'
import { BUTTON_GHOST } from '../shared/uiRecipes'
import type { TestDirectionLibrary } from './useTestDirections'

const ROW = 'grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md border border-transparent px-3 py-2.5 text-left outline-none hover:bg-fill focus-visible:ring-2 focus-visible:ring-(--accent) aria-[current=true]:border-accent-b aria-[current=true]:bg-accent-t'

/** 库页的测试方向：左列列表 / 右列 YAML 与预览。内建只读，复制成自定义再改。 */
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
}): JSX.Element {
  const { t } = useT()
  if (slot === 'list') {
    return (
      <ul className="grid gap-1" data-testid="lib-directions">
        {library.directions.map((direction) => (
          <li key={`${direction.source}/${direction.id}`}>
            <button
              type="button"
              className={ROW}
              aria-current={library.selected?.id === direction.id ? 'true' : undefined}
              data-testid={`lib-dir-${direction.id}`}
              onClick={() => library.select(direction.id)}
            >
              <span className="min-w-0">
                <span className="block truncate text-base font-semibold text-text">{direction.label}</span>
                <span className="block truncate font-mono text-caption text-text-3">{direction.id}</span>
              </span>
              <span className="flex items-center gap-2 whitespace-nowrap">
                {direction.source === 'builtin' && <Lock className="size-3.5 text-text-3" aria-label={t('library.direction_builtin')} />}
                <span className="rounded-full bg-fill px-2 py-0.5 text-micro font-bold text-text-2">{t(`library.${direction.source}`)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    )
  }
  const selected = library.selected
  if (selected === null) {
    return <p className="text-base text-text-2" data-testid="lib-dir-empty">{t('library.empty_detail')}</p>
  }
  const definition = selected.definition
  const builtin = selected.source === 'builtin'
  return (
    <div className="grid gap-4" data-testid="lib-dir-detail">
      <table className="w-full border-collapse text-left text-caption">
        <tbody>
          {[
            [t('workflow.test_command'), definition.command],
            [t('workflow.test_cwd'), definition.cwd ?? '.'],
            [t('workflow.test_timeout'), String(definition.timeout_s ?? 900)],
            [t('workflow.test_inputs'), String(definition.inputs?.length ?? 0)],
            [t('workflow.test_outputs'), String(definition.outputs?.length ?? 0)],
          ].map(([label, value]) => (
            <tr key={label} className="border-b border-border last:border-0">
              <th className="w-24 whitespace-nowrap py-1.5 font-normal text-text-3">{label}</th>
              <td className="truncate py-1.5 font-mono text-text-2">{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <textarea
        className="min-h-64 w-full rounded-sm border border-border bg-card p-3 font-mono text-caption text-text outline-none focus-visible:ring-2 focus-visible:ring-(--accent) disabled:opacity-60"
        data-testid="lib-dir-yaml"
        spellCheck={false}
        readOnly={builtin}
        disabled={builtin}
        value={library.draft}
        onChange={(event) => library.setDraft(event.target.value)}
      />
      {library.error !== null && (
        <p className="whitespace-pre-wrap text-caption text-red-d" role="alert" data-testid="lib-dir-error">{library.error}</p>
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          className={`${BUTTON_GHOST} min-h-9 px-3`}
          data-testid={`lib-dir-copy-${selected.id}`}
          disabled={!canWrite || library.busy}
          onClick={() => { void library.copy().then((ok) => { if (ok) onToast?.(t('library.copy')) }) }}
        >
          {t('library.direction_copy')}
        </button>
        {!builtin && (
          <>
            <button
              type="button"
              className={`${BUTTON_GHOST} min-h-9 px-3`}
              data-testid="lib-dir-save"
              disabled={!canWrite || library.busy}
              onClick={() => { void library.save().then((ok) => { if (ok) onToast?.(t('library.direction_save')) }) }}
            >
              {t('library.direction_save')}
            </button>
            <button
              type="button"
              className={`${BUTTON_GHOST} ml-auto min-h-9 px-3 text-red-d`}
              data-testid={`lib-dir-delete-${selected.id}`}
              disabled={!canWrite || library.busy}
              onClick={() => { void library.remove().then((ok) => { if (ok) onToast?.(t('library.direction_delete')) }) }}
            >
              {t('library.direction_delete')}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
