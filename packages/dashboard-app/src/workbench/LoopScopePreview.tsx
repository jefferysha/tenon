import { useEffect, useRef, useState } from 'react'
import { CircleAlert, ScanSearch, ShieldCheck, ShieldX } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  LoopScopePreviewError,
  parseLoopScopePreviewPaths,
  postLoopScopePreview,
  type LoopScopePreviewErrorKind,
  type LoopScopePreviewResponse,
} from '../api/loopScopePreview'
import { useT } from '../i18n'
import { Dialog } from '../shared/Dialog'
import { ERR_BLOCK_TW, WB_TW } from './loopCardModel'

export function LoopScopePreview({
  root,
  loopId,
  policyDirty = false,
}: {
  root: string
  loopId: string
  policyDirty?: boolean
}): JSX.Element {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  const [raw, setRaw] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<LoopScopePreviewResponse | null>(null)
  const [error, setError] = useState<LoopScopePreviewErrorKind | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const requestRef = useRef(0)
  const controllerRef = useRef<AbortController | null>(null)
  const paths = parseLoopScopePreviewPaths(raw)

  useEffect(() => () => controllerRef.current?.abort(), [])

  const close = (): void => {
    requestRef.current += 1
    controllerRef.current?.abort()
    controllerRef.current = null
    setOpen(false)
    setRaw('')
    setBusy(false)
    setResult(null)
    setError(null)
  }

  const submit = async (): Promise<void> => {
    if (paths === null || busy) return
    const request = requestRef.current + 1
    requestRef.current = request
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setBusy(true)
    setResult(null)
    setError(null)
    try {
      const nextResult = await postLoopScopePreview({ root, loopId, paths, signal: controller.signal })
      if (requestRef.current !== request) return
      setResult(nextResult)
    } catch (nextError) {
      if (requestRef.current !== request) return
      if (nextError instanceof DOMException && nextError.name === 'AbortError') return
      setResult(null)
      setError(nextError instanceof LoopScopePreviewError ? nextError.kind : 'response')
    } finally {
      if (requestRef.current === request) {
        controllerRef.current = null
        setBusy(false)
      }
    }
  }

  return <>
    <div className="mt-3 flex flex-wrap items-center gap-2 rounded-sm border border-border bg-fill/60 p-2.5">
      <div className="min-w-0 flex-1">
        <p className="text-caption font-bold text-text">{t('workbench.lp_scope_title')}</p>
        <p className={WB_TW.note}>{t('workbench.lp_scope_desc')}</p>
        {policyDirty && (
          <p
            id={`lp-scope-policy-dirty-${loopId}`}
            className="mt-1 text-caption font-semibold text-amber-d"
            data-testid="lp-scope-dirty-policy"
            role="status"
          >
            {t('workbench.lp_scope_dirty_policy')}
          </p>
        )}
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="shrink-0 gap-1.5"
        data-testid="lp-scope-open"
        aria-label={t('workbench.lp_scope_open')}
        aria-describedby={policyDirty ? `lp-scope-policy-dirty-${loopId}` : undefined}
        disabled={policyDirty}
        onClick={() => setOpen(true)}
      >
        <ScanSearch className="size-3.5" aria-hidden="true" />
        {t('workbench.lp_scope_open')}
      </Button>
    </div>
    {open && (
      <Dialog
        title={t('workbench.lp_scope_dialog_title', { id: loopId })}
        onClose={close}
        testid="lp-scope-dialog"
        panelClassName="w-[min(680px,94vw)]"
        initialFocusRef={inputRef}
        actions={<>
          <Button variant="ghost" size="sm" onClick={close}>{t('workbench.lp_scope_close')}</Button>
          <Button
            size="sm"
            data-testid="lp-scope-submit"
            disabled={paths === null || busy}
            onClick={() => void submit()}
          >
            {busy ? t('workbench.lp_scope_loading') : t('workbench.lp_scope_submit')}
          </Button>
        </>}
      >
        <p className="mb-3 text-caption leading-[1.55] text-text-2">{t('workbench.lp_scope_help')}</p>
        <label className="mb-1.5 block text-caption font-bold text-text-2" htmlFor={`lp-scope-input-${loopId}`}>
          {t('workbench.lp_scope_input_label')}
        </label>
        <textarea
          ref={inputRef}
          id={`lp-scope-input-${loopId}`}
          className={cn(WB_TW.input, 'min-h-28 resize-y font-mono leading-5 placeholder:text-text-2')}
          data-testid="lp-scope-input"
          value={raw}
          disabled={busy}
          placeholder={t('workbench.lp_scope_placeholder')}
          onChange={(event) => {
            setRaw(event.target.value)
            setResult(null)
            setError(null)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault()
              void submit()
            }
          }}
        />
        <p className={cn(WB_TW.note, 'mt-1.5')}>
          {raw !== '' && paths === null ? t('workbench.lp_scope_invalid') : t('workbench.lp_scope_limits')}
        </p>
        {busy && (
          <p className="mt-3 text-caption font-semibold text-accent-d" data-testid="lp-scope-loading" role="status">
            {t('workbench.lp_scope_loading')}
          </p>
        )}
        {error && (
          <div className={cn(ERR_BLOCK_TW, 'mt-3')} data-testid="lp-scope-error" data-tone="error" role="alert">
            <CircleAlert className="mr-1 inline size-3.5" aria-hidden="true" />
            {t(`workbench.lp_scope_error_${error}`)}
            <button type="button" className="ml-2 font-bold underline underline-offset-2" data-testid="lp-scope-retry" onClick={() => void submit()}>
              {t('workbench.lp_scope_retry')}
            </button>
          </div>
        )}
        {result && (
          <div className="mt-3" aria-live="polite">
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-bg p-2.5" data-testid="lp-scope-summary">
              <span className="font-mono text-caption font-bold text-text">{result.summary.total}</span>
              <span className="text-caption text-text-2">{t('workbench.lp_scope_total')}</span>
              <span className="rounded-full border border-green-b bg-green-t px-2 py-0.5 text-caption font-bold text-green-d">
                {t('workbench.lp_scope_allowed', { n: result.summary.allowed })}
              </span>
              <span className="rounded-full border border-red-b bg-red-t px-2 py-0.5 text-caption font-bold text-red-d">
                {t('workbench.lp_scope_blocked', { n: result.summary.blocked })}
              </span>
            </div>
            <ul className="mt-2 flex max-h-56 list-none flex-col gap-1.5 overflow-y-auto p-0">
              {result.items.map((item) => (
                <li key={item.path} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 rounded-md border border-border bg-card p-2.5">
                  {item.verdict === 'allowed'
                    ? <ShieldCheck className="mt-0.5 size-4 text-green-d" aria-hidden="true" />
                    : <ShieldX className="mt-0.5 size-4 text-red-d" aria-hidden="true" />}
                  <div className="min-w-0">
                    <p className="break-all font-mono text-caption font-bold text-text">{item.path}</p>
                    <p className="mt-0.5 text-micro text-text-3">
                      {t(`workbench.lp_scope_reason_${item.reason.replace(/-/g, '_')}`)}
                      {item.matched_pattern !== null && <> · <span className="font-mono">{item.matched_pattern}</span></>}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
            <p className={cn(WB_TW.note, 'mt-2')}>{result.enforced_for_unattended_merge
              ? t('workbench.lp_scope_fresh_l3')
              : t('workbench.lp_scope_fresh_simulation')}</p>
          </div>
        )}
      </Dialog>
    )}
  </>
}
