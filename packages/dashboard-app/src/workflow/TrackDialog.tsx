import { useRef, useState } from 'react'
import type { WbTrackSpec } from '../api/governanceTypes'
import { useT } from '../i18n'
import { FormDialog, FormField } from '../shared/FormDialog'
import { handleRadioKey } from '../shared/radioKeyboard'
import { SEGMENT_SLIDE_S, SEGMENT_THUMB_CLS, useSlidingIndicator } from '../shared/useSlidingIndicator'
import { INPUT } from '../shared/uiRecipes'
import { parseTrackKeywords } from '../workbench/trackSettings'

const TRACK_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/
const SPECS: readonly WbTrackSpec[] = ['openspec', 'none']
const SEGMENT = 'relative inline-flex min-h-10 flex-1 items-center justify-center whitespace-nowrap rounded-sm px-3 text-caption font-semibold text-text-2 outline-none transition-colors duration-(--dur-fast) hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent) aria-checked:text-text motion-reduce:transition-none'

/** 提交的内容：新建带 id 与名称；改已有轨道时 id 是那条轨道的，名称为空（不改）。 */
export interface TrackDialogValue {
  id: string
  label: string
  spec: WbTrackSpec
  keywords: string[]
}

export interface TrackDialogProps {
  open: boolean
  existing: readonly string[]
  /** 新建时「规范」的初始值：来源分支的规范。 */
  defaultSpec: WbTrackSpec
  /** 给了就是改这条轨道的设置（规范与关键词）：没有 id / 名称输入，没改动时不能保存。 */
  editing?: { id: string; spec: WbTrackSpec; keywords: readonly string[] } | null
  onClose: () => void
  onSubmit: (value: TrackDialogValue) => void
}

/** 规范单选：OpenSpec / 无。与门禁分段控件同一配方（fill 轨道 + 共享滑块）。 */
function SpecSegment({ value, onChange }: { value: WbTrackSpec; onChange: (next: WbTrackSpec) => void }): JSX.Element {
  const { t } = useT()
  const { containerRef, indicatorRef } = useSlidingIndicator<HTMLDivElement>({ duration: SEGMENT_SLIDE_S })
  return (
    <div ref={containerRef} className="relative isolate flex w-full gap-0.5 rounded-md bg-fill p-0.5" role="radiogroup" aria-label={t('workflow.track_spec')} data-testid="track-dialog-spec">
      {SPECS.map((spec, index) => (
        <button
          key={spec}
          type="button"
          role="radio"
          aria-checked={value === spec}
          tabIndex={value === spec ? 0 : -1}
          className={SEGMENT}
          data-testid={`track-dialog-spec-${spec}`}
          onClick={() => onChange(spec)}
          onKeyDown={(event) => handleRadioKey(event, index, SPECS.length, (next) => onChange(SPECS[next] ?? spec))}
        >
          <span className="relative">{spec === 'openspec' ? t('workflow.openspec') : t('workflow.track_spec_none')}</span>
        </button>
      ))}
      <span ref={indicatorRef} className={SEGMENT_THUMB_CLS} aria-hidden="true" />
    </div>
  )
}

/**
 * 轨道对话框：新建一条轨道（id + 可选名称），或改已有轨道的设置；两种都有「规范」单选（OpenSpec / 无）与
 * 「关键词」输入（逗号分隔，写入 `route.keywords`，路由据此把请求分到这条轨道）。分支内容复制通用分支。
 * 外壳是共享的 FormDialog（Enter 提交、有输入时关闭先二次确认、主体固定高度），校验错误贴在字段下方。
 */
export function TrackDialog({ open, existing, defaultSpec, editing = null, onClose, onSubmit }: TrackDialogProps): JSX.Element | null {
  const { t } = useT()
  const [id, setId] = useState('')
  const [label, setLabel] = useState('')
  const [spec, setSpec] = useState<WbTrackSpec | null>(null)
  const [keywordsText, setKeywordsText] = useState<string | null>(null)
  const idRef = useRef<HTMLInputElement>(null)
  if (!open) return null
  const shownSpec = spec ?? editing?.spec ?? defaultSpec
  const shownKeywords = keywordsText ?? (editing === null ? '' : editing.keywords.join(', '))
  const trimmed = id.trim()
  const parsed = parseTrackKeywords(shownKeywords)
  const idInvalid = editing === null && trimmed !== '' && !TRACK_ID_RE.test(trimmed)
  const duplicate = editing === null && trimmed !== '' && existing.includes(trimmed)
  const idError = idInvalid ? t('workflow.track_id_invalid') : duplicate ? t('workflow.track_id_dup') : null
  const keywordsError = parsed.ok ? null : t('workflow.track_keywords_invalid')
  const changed = editing === null
    ? id !== '' || label !== '' || spec !== null || keywordsText !== null
    : shownSpec !== editing.spec || (parsed.ok && parsed.keywords.join('\u0000') !== editing.keywords.join('\u0000'))
  const canSubmit = parsed.ok && (editing === null ? trimmed !== '' && idError === null : changed)
  function reset(): void {
    setId('')
    setLabel('')
    setSpec(null)
    setKeywordsText(null)
  }
  return (
    <FormDialog
      title={editing === null ? t('workflow.new_track') : t('workflow.track_settings')}
      testid="track-dialog"
      dirty={changed}
      canSubmit={canSubmit}
      submitLabel={editing === null ? t('workflow.create_submit') : t('workflow.save')}
      onSubmit={() => {
        if (!parsed.ok) return
        onSubmit({ id: editing === null ? trimmed : editing.id, label: editing === null ? label.trim() : '', spec: shownSpec, keywords: parsed.keywords })
        reset()
      }}
      onClose={() => { reset(); onClose() }}
      {...(editing === null ? { initialFocusRef: idRef } : {})}
      panelClassName="w-[min(460px,92vw)]"
      bodyClassName={editing === null ? 'h-[300px]' : 'h-[168px]'}
    >
      <div className="grid content-start gap-4">
        {editing === null && (
          <>
            <FormField label={t('workflow.track_id')} htmlFor="track-dialog-id" error={idError} testid="track-dialog-id-field">
              <input
                ref={idRef}
                id="track-dialog-id"
                className={`${INPUT} font-mono`}
                value={id}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={idError !== null}
                aria-describedby={idError === null ? undefined : 'track-dialog-id-error'}
                data-testid="track-dialog-id"
                onChange={(event) => setId(event.target.value)}
              />
            </FormField>
            <FormField label={t('workflow.track_label')} htmlFor="track-dialog-label">
              <input
                id="track-dialog-label"
                className={INPUT}
                value={label}
                autoComplete="off"
                data-testid="track-dialog-label"
                onChange={(event) => setLabel(event.target.value)}
              />
            </FormField>
          </>
        )}
        <FormField label={t('workflow.track_spec')}>
          <SpecSegment value={shownSpec} onChange={setSpec} />
        </FormField>
        <FormField label={t('workflow.track_keywords')} htmlFor="track-dialog-keywords" error={keywordsError} testid="track-dialog-keywords-field">
          <input
            id="track-dialog-keywords"
            className={INPUT}
            value={shownKeywords}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={keywordsError !== null}
            aria-describedby={keywordsError === null ? undefined : 'track-dialog-keywords-error'}
            data-testid="track-dialog-keywords"
            onChange={(event) => setKeywordsText(event.target.value)}
          />
        </FormField>
      </div>
    </FormDialog>
  )
}
