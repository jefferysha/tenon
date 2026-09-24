import { useT } from '../i18n'
import type { InstructionPreviewFile } from '../api/instructionsDecoders'
import { Drawer } from '../shared/Drawer'
import { StatusPill } from '../shell/ThreeColumns'
import { BUTTON_SOLID } from '../shared/uiRecipes'
import { lineDiff } from '../shared/lineDiff'

const OP_CLASS = {
  add: 'bg-green-t text-green-d',
  del: 'bg-red-t text-red-d',
  eq: 'text-text-2',
} as const

/** 段标题：项目内的文件显示相对项目根的路径，其余（用户级）显示文件名；完整路径放在 title 与副行。 */
export function diffFileLabel(path: string, root: string): string {
  const base = root.replace(/\/+$/u, '')
  if (base !== '' && path.startsWith(`${base}/`)) return path.slice(base.length + 1)
  return path.split('/').filter(Boolean).pop() ?? path
}

/** 应用前的差异抽屉：每个目标文件一段，标新建 / 修改，逐行标出新增与删除；关闭只有标题栏的 ×，确认后才写盘。 */
export function DiffDrawer({
  files, root, busy, onClose, onConfirm,
}: {
  files: readonly InstructionPreviewFile[]
  /** 项目根；'' = 用户级。 */
  root: string
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
        <button type="button" className={BUTTON_SOLID} data-testid="proj-diff-confirm" disabled={busy} onClick={onConfirm}>
          {t('projects.apply')}
        </button>
      )}
    >
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
        {files.map((file) => (
          <section key={file.id} className="min-w-0" data-testid={`proj-diff-${file.id}`}>
            <div className="flex min-w-0 items-center gap-2">
              <h3 className="min-w-0 truncate whitespace-nowrap font-mono text-body font-semibold text-text" title={file.path} data-testid={`proj-diff-name-${file.id}`}>
                {diffFileLabel(file.path, root)}
              </h3>
              <StatusPill tone={file.current === null ? 'running' : 'pending'} testId={`proj-diff-kind-${file.id}`} className="flex-none">
                {t(file.current === null ? 'projects.change_new' : 'projects.change_modify')}
              </StatusPill>
            </div>
            <p className="truncate pb-2 font-mono text-caption text-text-3" title={file.path}>{file.path}</p>
            {/* 长行不折：整块横向滚动；每行至少占满宽度，底色随最长行延伸。 */}
            <ol className="overflow-x-auto rounded-md border border-border" data-testid={`proj-diff-lines-${file.id}`}>
              {lineDiff(file.current ?? '', file.next).map((row, index) => (
                <li
                  key={`${file.id}-${index}`}
                  className={`min-w-full w-max px-3 py-0.5 font-mono text-caption whitespace-pre ${OP_CLASS[row.op]}`}
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
