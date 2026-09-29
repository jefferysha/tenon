import { useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Info } from 'lucide-react'
import { useT } from '../i18n'
import { Dialog } from './Dialog'
import { BUTTON_DANGER, BUTTON_GHOST, BUTTON_SOLID } from './uiRecipes'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

const FIELD_SELECTOR = 'input:not(:disabled):not([type="hidden"]), textarea:not(:disabled), select:not(:disabled)'

export interface FormDialogProps {
  title: string
  testid: string
  /** 有未提交的输入：Esc、点背景、「取消」都先二次确认。 */
  dirty: boolean
  /** 提交进行中：不能关闭，也不能再次提交。 */
  busy?: boolean
  canSubmit: boolean
  submitLabel: string
  onSubmit: () => void
  onClose: () => void
  /** 面板宽度；缺省 560px。 */
  panelClassName?: string
  /** 主体高度固定、内部滚动，切换选项时对话框不跳动；缺省 360px。 */
  bodyClassName?: string
  initialFocusRef?: RefObject<HTMLElement>
  /** 提交按钮左侧的补充内容（例如服务端错误）。 */
  footer?: ReactNode
  children: ReactNode
}

/**
 * 新建类对话框的统一外壳：整个对话框是一个 `<form>`，文本框里 Enter 即提交（原生隐式提交，提交按钮禁用时不提交，
 * textarea 里 Enter 仍是换行）；主体固定高度；关闭经 `dirty` 守卫——有输入时先弹「放弃？」确认。
 * 字段用 `FormField`：标签一行（说明进 Tooltip），校验错误紧贴字段下方。
 */
export function FormDialog({
  title, testid, dirty, busy = false, canSubmit, submitLabel, onSubmit, onClose,
  panelClassName = 'w-[min(560px,92vw)]', bodyClassName = 'h-[360px]', initialFocusRef, footer, children,
}: FormDialogProps): JSX.Element {
  const { t } = useT()
  const [confirming, setConfirming] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  // 缺省聚焦第一个输入控件，而不是标签旁的说明图标（它排在控件前面）。
  const firstField = useMemo<RefObject<HTMLElement>>(() => ({
    get current(): HTMLElement | null { return bodyRef.current?.querySelector<HTMLElement>(FIELD_SELECTOR) ?? null },
  }), [])
  const requestClose = (): void => {
    if (busy) return
    if (dirty) setConfirming(true)
    else onClose()
  }
  return (
    <>
      <Dialog title={title} onClose={requestClose} testid={testid} panelClassName={panelClassName} initialFocusRef={initialFocusRef ?? firstField}>
        <form
          noValidate
          data-testid={`${testid}-form`}
          onSubmit={(event) => {
            event.preventDefault()
            if (canSubmit && !busy) onSubmit()
          }}
        >
          <div ref={bodyRef} className={`${bodyClassName} min-h-0 overflow-y-auto`} data-testid={`${testid}-body`}>{children}</div>
          <div className="mt-5 flex min-w-0 items-center justify-end gap-2">
            {footer !== undefined && <div className="min-w-0 flex-1">{footer}</div>}
            <button type="button" className={BUTTON_GHOST} disabled={busy} data-testid={`${testid}-cancel`} onClick={requestClose}>
              {t('common.cancel')}
            </button>
            <button type="submit" className={BUTTON_SOLID} disabled={!canSubmit || busy} aria-busy={busy || undefined} data-testid={`${testid}-submit`}>
              {submitLabel}
            </button>
          </div>
        </form>
      </Dialog>
      {confirming && (
        <DiscardDialog
          title={t('common.discard_title')}
          testid={`${testid}-discard`}
          onKeep={() => setConfirming(false)}
          onDiscard={() => { setConfirming(false); onClose() }}
        />
      )}
    </>
  )
}

/** 「放弃输入？」确认：只有标题与两个按钮；Esc 等同继续编辑。 */
export function DiscardDialog({ title, testid, onKeep, onDiscard }: {
  title: string
  testid: string
  onKeep: () => void
  onDiscard: () => void
}): JSX.Element {
  const { t } = useT()
  return (
    <Dialog
      title={title}
      role="alertdialog"
      onClose={onKeep}
      testid={testid}
      actions={(
        <>
          <button type="button" className={BUTTON_GHOST} data-testid={`${testid}-keep`} onClick={onKeep}>{t('common.keep_editing')}</button>
          <button type="button" className={BUTTON_DANGER} data-testid={`${testid}-confirm`} onClick={onDiscard}>{t('common.discard')}</button>
        </>
      )}
    >
      {null}
    </Dialog>
  )
}

export interface FormFieldProps {
  label: string
  /** 对应控件的 id；标签点击聚焦它。 */
  htmlFor?: string
  /** 说明放 Tooltip（标签旁的图标），页面上不写句子。 */
  hint?: ReactNode
  /** 字段下方的即时校验错误；控件应以 aria-describedby 指向 `${htmlFor}-error`。 */
  error?: string | null
  /** 标签行右侧的动作（例如 编辑 / 渲染 切换）。 */
  action?: ReactNode
  testid?: string
  className?: string
  children: ReactNode
}

/** 一个字段：标签一行（可带说明图标与动作）+ 控件 + 下方错误。 */
export function FormField({ label, htmlFor, hint, error, action, testid, className, children }: FormFieldProps): JSX.Element {
  const { t } = useT()
  return (
    <div className={`grid min-w-0 content-start gap-1.5 ${className ?? ''}`} data-testid={testid}>
      <div className="flex min-h-6 min-w-0 items-center gap-1.5 whitespace-nowrap text-caption font-semibold text-text-2">
        {htmlFor === undefined ? <span className="truncate">{label}</span> : <label htmlFor={htmlFor} className="truncate">{label}</label>}
        {hint !== undefined && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="grid size-6 flex-none place-items-center rounded-xs text-text-3 outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent)"
                aria-label={t('common.field_hint', { label })}
                data-testid={testid === undefined ? undefined : `${testid}-hint`}
              >
                <Info className="size-4" strokeWidth={1.75} aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" className="max-w-none">{hint}</TooltipContent>
          </Tooltip>
        )}
        {action !== undefined && <div className="ml-auto flex-none">{action}</div>}
      </div>
      {children}
      {error !== undefined && error !== null && error !== '' && (
        <p
          id={htmlFor === undefined ? undefined : `${htmlFor}-error`}
          role="alert"
          className="truncate whitespace-nowrap text-caption text-red-d"
          title={error}
          data-testid={testid === undefined ? undefined : `${testid}-error`}
        >
          {error}
        </p>
      )}
    </div>
  )
}
