import { useT } from '../i18n'
import type { InstructionPreviewFile } from '../api/instructionsDecoders'
import { Drawer } from '../shared/Drawer'
import { BUTTON_GHOST, BUTTON_SOLID } from '../shared/uiRecipes'
import { lineDiff } from '../shared/lineDiff'

const OP_CLASS = {
  add: 'bg-green-t text-green-d',
  del: 'bg-red-t text-red-d',
  eq: 'text-text-2',
} as const

/** 应用前的差异抽屉：每个目标文件一段，逐行标出新增与删除，确认后才写盘。 */
export function DiffDrawer({
  files, busy, onClose, onConfirm,
}: {
  files: readonly InstructionPreviewFile[]
  busy: boolean
  onClose: () => void
  onConfirm: () => void
}): JSX.Element {
  const { t } = useT()
  return (
    <Drawer
      open
      onClose={onClose}
      title={t('projects.diff_title')}
      ariaLabel={t('projects.diff_title')}
      testId="proj-diff"
      width="lg"
      actions={(
        <>
          <button type="button" className={BUTTON_GHOST} data-testid="proj-diff-cancel" onClick={onClose}>
            {t('projects.cancel')}
          </button>
          <button type="button" className={BUTTON_SOLID} data-testid="proj-diff-confirm" disabled={busy} onClick={onConfirm}>
            {t('projects.confirm')}
          </button>
        </>
      )}
    >
      <div className="grid gap-5">
        {files.map((file) => (
          <section key={file.id} data-testid={`proj-diff-${file.id}`}>
            <h3 className="pb-2 font-mono text-caption whitespace-nowrap overflow-x-auto text-text">{file.path}</h3>
            <ol className="grid overflow-x-auto rounded-md border border-border">
              {lineDiff(file.current ?? '', file.next).map((row, index) => (
                <li
                  key={`${file.id}-${index}`}
                  className={`px-3 py-0.5 font-mono text-caption whitespace-pre ${OP_CLASS[row.op]}`}
                  data-op={row.op}
                >
                  {`${row.op === 'add' ? '+' : row.op === 'del' ? '-' : ' '} ${row.text}`}
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>
    </Drawer>
  )
}
