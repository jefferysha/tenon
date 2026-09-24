import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useT } from '../i18n'
import { getToken } from '../api/transport'
import type { InstructionPreviewFile, InstructionTarget } from '../api/instructionsDecoders'
import { Dialog } from '../shared/Dialog'
import type { SheetDef } from '../shared/DetailSheets'
import { Markdown } from '../shared/Markdown'
import { BUTTON_DANGER, BUTTON_GHOST, BUTTON_SOLID } from '../shared/uiRecipes'
import { DetailColumn, StatusPill } from '../shell/ThreeColumns'
import { MenuButton } from '../shared/MenuButton'
import { DiffDrawer } from './DiffDrawer'
import { SegmentTabs } from './SegmentTabs'
import { COUNT_BADGE, Hinted, STATUS_KEY, STATUS_TONE } from './projectBits'
import type { FileStatus } from './clientModel'

type Sheet = 'edit' | 'render'

/** 正文编辑区：无拖拽角、随内容增高（最少 420px），卡片底 + 细边。 */
const EDITOR = 'block min-h-[420px] w-full resize-none overflow-hidden rounded-md border border-border bg-card p-4 font-mono text-body leading-[22px] text-text outline-none transition-[border-color,box-shadow] hover:border-border-2 focus-visible:border-(--accent) focus-visible:ring-[3px] focus-visible:ring-(--accent)/20'

/** 文本域高度跟随内容：每次内容变化先归零再取 scrollHeight（CSS 的 min-h 兜底下限）。 */
function useAutoHeight(value: string | null): RefObject<HTMLTextAreaElement> {
  const ref = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (element === null || value === null) return
    element.style.height = 'auto'
    element.style.height = `${element.scrollHeight}px`
  }, [value])
  return ref
}

/**
 * 右列：当前客户端 / 作用域下的一个指令文件。标题旁是状态点与受管块数；动作在标题右侧：「预览变更」打开差异抽屉、
 * 在抽屉里确认「应用」；删除收在 ⋯ 菜单里，先确认受管块处理。正文与盘上一致时「预览变更」禁用。
 */
export function InstructionEditor({
  title, target, root, controls, status, tooLarge, text, onText, external, busy, errorKey, onPreview, onApply, onDelete, onReload, extraAction,
}: {
  title: string
  target: InstructionTarget
  /** 差异抽屉里相对它显示路径；'' = 用户级。 */
  root: string
  /** 标题下一行：作用域与读者分段控件。 */
  controls: ReactNode
  status: FileStatus
  /** 超过 Codex 的 32 KiB 读取上限。 */
  tooLarge: boolean
  text: string
  onText: (next: string) => void
  external: boolean
  busy: boolean
  errorKey: string | null
  onPreview: () => Promise<readonly InstructionPreviewFile[] | null>
  onApply: (files: readonly InstructionPreviewFile[]) => Promise<boolean>
  onDelete: () => Promise<void>
  onReload: () => void
  /** 标题行里「预览变更」之前的额外动作（如「用 @AGENTS.md 引用创建」）。 */
  extraAction?: ReactNode
}): JSX.Element {
  const { t } = useT()
  const sheets: SheetDef<Sheet>[] = [
    { id: 'edit', label: t('projects.edit') },
    { id: 'render', label: t('projects.render') },
  ]
  const [sheet, setSheet] = useState<Sheet>('edit')
  const [diff, setDiff] = useState<readonly InstructionPreviewFile[] | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const editorRef = useAutoHeight(sheet === 'edit' ? text : null)
  const canWrite = getToken() !== ''
  const kept = target.managed.length
  // 缺失的文件且正文为空：没有要写的内容，不预览（进页面、切换都不会新建文件）。
  const nothingToWrite = status === 'same' || status === 'error' || (status === 'missing' && text === '')

  return (
    <>
      <DetailColumn
        testId="proj-detail"
        panelId="proj-panel"
        labelledBy={`proj-tab-${sheet}`}
        header={(
          <div className="grid gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <h1 className="min-w-0 truncate whitespace-nowrap text-page font-bold tracking-[-.01em] text-text" title={title} data-testid="proj-title">{title}</h1>
              <StatusPill tone={STATUS_TONE[status]} testId="proj-status" className="flex-none">{t(STATUS_KEY[status])}</StatusPill>
              {kept > 0 && (
                <Hinted hint={t('projects.managed')} label={`${t('projects.managed')} ${kept}`} testId="proj-managed">
                  <span className={COUNT_BADGE}>{kept}</span>
                </Hinted>
              )}
              {tooLarge && (
                <Hinted hint={t('projects.errors.too_large')} testId="proj-size">
                  <span className={COUNT_BADGE}>32KiB</span>
                </Hinted>
              )}
              <div className="ml-auto flex flex-none items-center gap-2 whitespace-nowrap">
                {!canWrite && <span className="text-caption text-text-3" data-testid="proj-no-token">{t('projects.no_token')}</span>}
                {extraAction}
                <button
                  type="button"
                  className={BUTTON_SOLID}
                  data-testid="proj-apply"
                  disabled={!canWrite || busy || nothingToWrite}
                  onClick={() => { void (async () => { const files = await onPreview(); if (files !== null) setDiff(files) })() }}
                >
                  {t('projects.preview_changes')}
                </button>
                <MenuButton
                  label={t('projects.more')}
                  testId="proj-more"
                  disabled={!canWrite || busy || !target.exists}
                  items={[{ id: 'delete', label: t('projects.delete'), danger: true, onSelect: () => setConfirmDelete(true) }]}
                />
              </div>
            </div>
            <div className="flex min-w-0 items-center gap-3">{controls}</div>
          </div>
        )}
        sheets={<div className="mt-5"><SegmentTabs sheets={sheets} active={sheet} onChange={setSheet} ariaLabel={t('projects.file')} idPrefix="proj" /></div>}
      >
        {/* 正在编辑的文件：编辑区顶部固定一行完整路径（截断 + title），编辑 / 渲染都在。 */}
        <p className="mb-3 truncate whitespace-nowrap font-mono text-caption text-text-3" title={target.path} data-testid="proj-path">{target.path}</p>
        {external && (
          <div className="mb-4 flex flex-wrap items-center gap-3 rounded-md border border-amber-b bg-amber-t px-4 py-3" role="status" data-testid="proj-external">
            <span className="text-body font-semibold text-amber-d">{t('projects.external')}</span>
            <button
              type="button"
              className={BUTTON_GHOST}
              data-testid="proj-external-reload"
              onClick={onReload}
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
            ref={editorRef}
            className={EDITOR}
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
          role="alertdialog"
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
            <p className="truncate whitespace-nowrap font-mono text-caption text-text" title={target.path} data-testid="proj-delete-file">{target.path}</p>
            {kept > 0 && (
              <p className="text-body text-text-2" data-testid="proj-delete-managed">{t('projects.managed_kept', { n: kept })}</p>
            )}
          </div>
        </Dialog>
      )}
    </>
  )
}
