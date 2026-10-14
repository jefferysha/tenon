import { FileText } from 'lucide-react'
import type { WbStepIoFile } from '../api/governanceTypes'
import { useT } from '../i18n'
import { StatusPill } from '../shell/ThreeColumns'
import { isReadableFile } from './stageIo'
import { cn } from '@/lib/utils'
import { LIST_SELECTED } from '../shared/uiRecipes'

const CHANGE_KEY = {
  added: 'workspace.change_added',
  modified: 'workspace.change_modified',
  deleted: 'workspace.change_deleted',
} as const

/** 输入四列、输出三列，各列等分；整行不换行，单元格各自截断。 */
const COLS = {
  inputs: 'grid grid-cols-4',
  outputs: 'grid grid-cols-3',
} as const
const ROW = 'items-center gap-4 whitespace-nowrap'
const CELL = 'min-w-0 truncate'

export interface StageIoPanelProps {
  /** 当前 sheet 显示哪一侧。 */
  direction: 'inputs' | 'outputs'
  items: readonly WbStepIoFile[]
  activePath: string | null
  onOpen: (path: string) => void
  definitionState: 'loading' | 'ready' | 'error'
  /** 来源阶段的显示名：有 label 写 label，没有写 id。 */
  labelOf: (stepId: string) => string
}

/** 文件名在前，目录在后：目录先被截断，文件名尽量留住。 */
function splitPath(path: string): { name: string; dir: string } {
  const slash = path.lastIndexOf('/')
  const name = path.slice(slash + 1)
  return name === '' ? { name: path, dir: '' } : { name, dir: path.slice(0, slash + 1) }
}

/**
 * 所选阶段的一张 IO sheet（输入或输出）：等分的带表头的表，行间一条细分隔线。
 * 输入 文件 · 来源阶段 · 来源技能 · 已读；输出 文件 · 变化 · 来源技能。来源技能推断不出来写「未知」，旧任务没有的格写「—」。
 * 可阅读的行整行可点开抽屉（文件格里的按钮承担键盘路径）。标题由 sheet 页签承担。
 */
export function StageIoPanel({ direction, items, activePath, onOpen, definitionState, labelOf }: StageIoPanelProps): JSX.Element {
  const { t } = useT()
  const single = direction === 'outputs' ? 'output' : 'input'
  const gridClass = cn(COLS[direction], ROW)

  function textCell(text: string, muted: boolean): JSX.Element {
    return <span className={cn(CELL, 'text-caption', muted ? 'text-text-3' : 'text-text-2')} role="cell" title={text}>{text}</span>
  }

  function skillCell(file: WbStepIoFile): JSX.Element {
    return file.skill === null ? textCell(t('workspace.io_unknown'), true) : textCell(file.skill, false)
  }

  function row(file: WbStepIoFile): JSX.Element {
    const { name, dir } = splitPath(file.path)
    const readable = isReadableFile(file)
    return (
      <div
        key={file.path}
        className={cn(gridClass, 'min-h-11 border-b border-border px-1 py-1.5 text-body', readable && 'cursor-pointer hover:bg-fill', activePath === file.path && LIST_SELECTED)}
        role="row"
        title={file.path}
        data-testid={`stage-${single}-${file.path}`}
        {...(file.change === undefined ? {} : { 'data-change': file.change })}
        {...(file.read === undefined ? {} : { 'data-read': String(file.read) })}
        onClick={readable ? () => onOpen(file.path) : undefined}
      >
        <span className="flex min-w-0 items-baseline gap-2" role="cell">
          <FileText className="size-4 flex-none self-center text-text-3" aria-hidden="true" />
          {readable ? (
            <button
              type="button"
              className="min-w-0 shrink truncate rounded-xs text-left font-semibold text-text outline-none focus-visible:ring-2 focus-visible:ring-(--accent)"
              aria-pressed={activePath === file.path}
              data-testid={`stage-${single}-open-${file.path}`}
              onClick={(event) => { event.stopPropagation(); onOpen(file.path) }}
            >
              {name}
            </button>
          ) : (
            <span className="min-w-0 shrink truncate font-semibold text-text-2">{name}</span>
          )}
          {dir !== '' && <span className="min-w-0 shrink-[4] truncate text-caption text-text-3">{dir}</span>}
        </span>
        {direction === 'inputs'
          ? (
            <>
              {file.fromStep === undefined ? textCell('—', true) : textCell(labelOf(file.fromStep), false)}
              {skillCell(file)}
              <span className={CELL} role="cell">
                {file.read === undefined
                  ? <span className="text-caption text-text-3">—</span>
                  : <StatusPill tone={file.read ? 'done' : 'pending'}>{t(file.read ? 'workspace.io_read' : 'workspace.io_unread')}</StatusPill>}
              </span>
            </>
          )
          : (
            <>
              {file.change === undefined ? textCell('—', true) : textCell(t(CHANGE_KEY[file.change]), false)}
              {skillCell(file)}
            </>
          )}
      </div>
    )
  }

  return (
    <section data-testid={`stage-${direction}`}>
      {definitionState === 'loading' ? (
        <p className="text-body text-text-3" role="status">{t('common.loading')}</p>
      ) : definitionState === 'error' ? (
        <p className="text-body text-red-d" role="alert">{t('workspace.definition_error')}</p>
      ) : items.length === 0 ? (
        <p className="py-3 text-body text-text-3" role="status">{t(direction === 'inputs' ? 'workspace.no_inputs' : 'workspace.no_outputs')}</p>
      ) : (
        <div className="grid min-w-0" role="table" aria-label={t(`workspace.${direction}`)}>
          <div className={cn(gridClass, 'border-b border-border px-1 pb-2 text-caption text-text-3')} role="row" data-testid={`stage-${direction}-head`}>
            <span className={CELL} role="columnheader">{t('workspace.io_col_file')}</span>
            {direction === 'inputs'
              ? (
                <>
                  <span className={CELL} role="columnheader">{t('workspace.io_col_stage')}</span>
                  <span className={CELL} role="columnheader">{t('workspace.io_col_skill')}</span>
                  <span className={CELL} role="columnheader">{t('workspace.io_col_read')}</span>
                </>
              )
              : (
                <>
                  <span className={CELL} role="columnheader">{t('workspace.io_col_change')}</span>
                  <span className={CELL} role="columnheader">{t('workspace.io_col_skill')}</span>
                </>
              )}
          </div>
          {items.map(row)}
        </div>
      )}
    </section>
  )
}
