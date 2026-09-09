import { useEffect, useRef, useState } from 'react'
import {
  postVerificationEvidenceCompose,
  VerificationEvidenceApiError,
  type VerificationEvidenceDraftEntry,
  type VerificationEvidenceLocale,
} from '../api/client'
import { useT } from '../i18n'
import { Dialog } from '../shared/Dialog'
import {
  VerificationEvidenceEntryEditor,
  type VerificationEvidenceEditorField,
  type VerificationEvidenceEditorEntry,
} from './VerificationEvidenceEntryEditor'

interface VerificationEvidenceComposerProps {
  root: string
  locale: VerificationEvidenceLocale
  onToast?: (message: string) => void
}

function draftEntry(entry: VerificationEvidenceEditorEntry): VerificationEvidenceDraftEntry {
  return {
    kind: entry.kind,
    title: entry.title,
    status: entry.status,
    ...(entry.kind === 'command' && entry.command.trim() !== '' ? { command: entry.command } : {}),
    ...(entry.status === 'skipped'
      ? { skipReason: entry.skipReason }
      : { result: entry.result }),
  }
}

interface ValidationFailure {
  message: string
  path: string
}

interface ActiveRequest {
  id: number
  controller: AbortController
}

const ERROR_ID = 'verification-evidence-error'
const ENTRY_FIELD_PATH = /^entries\[(\d+)\]\.(title|kind|status|command|result|skipReason)$/u

export function VerificationEvidenceComposer({
  root,
  locale,
  onToast,
}: VerificationEvidenceComposerProps): JSX.Element {
  const { t } = useT()
  const tRef = useRef(t)
  tRef.current = t
  const [open, setOpen] = useState(false)
  const [entries, setEntries] = useState<VerificationEvidenceEditorEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [invalidPath, setInvalidPath] = useState('')
  const [markdown, setMarkdown] = useState('')
  const [copyError, setCopyError] = useState('')
  const nextId = useRef(1)
  const openerRef = useRef<HTMLButtonElement>(null)
  const restoreFocusRef = useRef(false)
  const activeRequestRef = useRef<ActiveRequest | null>(null)
  const nextRequestIdRef = useRef(1)

  useEffect(() => {
    if (!open && restoreFocusRef.current) {
      restoreFocusRef.current = false
      openerRef.current?.focus()
    }
  }, [open])

  useEffect(() => () => {
    activeRequestRef.current?.controller.abort()
    activeRequestRef.current = null
  }, [])

  useEffect(() => {
    activeRequestRef.current?.controller.abort()
    activeRequestRef.current = null
    setBusy(false)
    setError('')
    setInvalidPath('')
    setMarkdown('')
    setCopyError('')
  }, [locale])

  useEffect(() => {
    if (error === '' || invalidPath === '') return
    const target = [...document.querySelectorAll<HTMLElement>('[data-evidence-path]')]
      .find((element) => element.dataset.evidencePath === invalidPath)
    target?.focus()
  }, [error, invalidPath])

  function closeComposer(): void {
    const active = activeRequestRef.current
    activeRequestRef.current = null
    active?.controller.abort()
    setBusy(false)
    restoreFocusRef.current = true
    setOpen(false)
  }

  function resetOutcome(): void {
    setError('')
    setInvalidPath('')
    setMarkdown('')
    setCopyError('')
  }

  function addEntry(): void {
    const id = nextId.current
    nextId.current += 1
    setEntries((current) => [...current, {
      id,
      kind: 'command',
      title: '',
      status: 'passed',
      command: '',
      result: '',
      skipReason: '',
    }])
    resetOutcome()
  }

  function updateEntry(id: number, patch: Partial<VerificationEvidenceEditorEntry>): void {
    setEntries((current) => current.map((entry) => entry.id === id ? { ...entry, ...patch } : entry))
    resetOutcome()
  }

  function validate(): ValidationFailure | null {
    const invalidTitleIndex = entries.findIndex((entry) => entry.title.trim() === '')
    if (invalidTitleIndex !== -1) {
      return {
        message: t('detail.evidence_error_title'),
        path: `entries[${invalidTitleIndex}].title`,
      }
    }
    const missingBodyIndex = entries.findIndex((entry) => entry.status === 'skipped'
      ? entry.skipReason.trim() === ''
      : entry.result.trim() === '')
    if (missingBodyIndex === -1) return null
    const missingBody = entries[missingBodyIndex]
    if (!missingBody) return null
    return {
      message: missingBody.status === 'skipped'
        ? t('detail.evidence_error_skip_reason')
        : t('detail.evidence_error_result'),
      path: `entries[${missingBodyIndex}].${missingBody.status === 'skipped' ? 'skipReason' : 'result'}`,
    }
  }

  function editorInvalidField(index: number): VerificationEvidenceEditorField | undefined {
    const match = ENTRY_FIELD_PATH.exec(invalidPath)
    if (!match || Number(match[1]) !== index) return undefined
    return match[2] as VerificationEvidenceEditorField
  }

  async function compose(): Promise<void> {
    const validation = validate()
    if (validation !== null) {
      setInvalidPath(validation.path)
      setError(validation.message)
      return
    }
    const controller = new AbortController()
    const request: ActiveRequest = {
      id: nextRequestIdRef.current,
      controller,
    }
    nextRequestIdRef.current += 1
    activeRequestRef.current?.controller.abort()
    activeRequestRef.current = request
    setBusy(true)
    resetOutcome()
    try {
      const result = await postVerificationEvidenceCompose({
        root,
        locale,
        entries: entries.map(draftEntry),
      }, controller.signal)
      if (activeRequestRef.current?.id !== request.id) return
      setMarkdown(result.markdown)
    } catch (caught) {
      if (activeRequestRef.current?.id !== request.id || controller.signal.aborted) return
      if (caught instanceof VerificationEvidenceApiError) {
        const path = caught.details[0]?.path || t('detail.evidence_error_request_path')
        setInvalidPath(caught.details[0]?.path ?? '')
        setError(t('detail.evidence_error_invalid', { path }))
      } else {
        setInvalidPath('')
        setError(t('detail.evidence_error_request'))
      }
    } finally {
      if (activeRequestRef.current?.id === request.id) {
        activeRequestRef.current = null
        setBusy(false)
      }
    }
  }

  async function copy(): Promise<void> {
    setCopyError('')
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable')
      await navigator.clipboard.writeText(markdown)
      onToast?.(tRef.current('detail.evidence_copied'))
    } catch {
      setCopyError(tRef.current('detail.evidence_copy_failed'))
    }
  }

  return (
    <>
      <button
        className="rounded-md border border-border bg-card px-3 py-2 text-caption font-bold text-text transition hover:border-(--accent) hover:bg-fill"
        data-testid="evidence-compose-open"
        ref={openerRef}
        onClick={() => setOpen(true)}
        type="button"
      >
        {t('detail.evidence_open')}
      </button>
      {open && (
        <Dialog
          actions={(
            <>
              <button className="rounded-md border border-border px-3 py-2 text-caption font-semibold text-text-2 hover:bg-fill" onClick={closeComposer} type="button">
                {t('detail.evidence_cancel')}
              </button>
              <button
                className="rounded-md bg-btn-bg px-4 py-2 text-caption font-bold text-btn-fg hover:bg-btn-hover disabled:cursor-not-allowed disabled:opacity-45"
                data-testid="evidence-compose"
                disabled={busy || entries.length === 0}
                onClick={() => void compose()}
                type="button"
              >
                {busy ? t('detail.evidence_composing') : t('detail.evidence_compose')}
              </button>
            </>
          )}
          closeLabel={t('detail.evidence_cancel')}
          onClose={closeComposer}
          panelClassName="w-[min(780px,94vw)]"
          testid="evidence-compose-dialog"
          title={t('detail.evidence_dialog_title')}
          variant="workspace"
        >
          <p className="mb-2 text-body leading-5 text-text-2">{t('detail.evidence_subtitle')}</p>
          <p className="mb-4 rounded-md border border-amber-b bg-amber-t px-3 py-2 text-caption leading-5 text-amber-d">
            {t('detail.evidence_draft_notice')}
          </p>
          {entries.length === 0 ? (
            <div className="rounded-md border border-dashed border-border px-4 py-8 text-center" data-testid="evidence-empty">
              <p className="m-0 text-base font-semibold text-text-2">{t('detail.evidence_empty')}</p>
              <p className="mt-1 text-caption text-text-3">{t('detail.evidence_empty_hint')}</p>
            </div>
          ) : (
            <div className="grid gap-3">
              {entries.map((entry, index) => (
                <VerificationEvidenceEntryEditor
                  disabled={busy}
                  entry={entry}
                  errorId={ERROR_ID}
                  index={index}
                  invalidField={editorInvalidField(index)}
                  key={entry.id}
                  onChange={(patch) => updateEntry(entry.id, patch)}
                  onRemove={() => {
                    setEntries((current) => current.filter((item) => item.id !== entry.id))
                    resetOutcome()
                  }}
                />
              ))}
            </div>
          )}
          <button
            className="mt-3 rounded-md border border-border px-3 py-2 text-caption font-semibold text-text hover:bg-fill disabled:opacity-45"
            data-testid="evidence-add-entry"
            disabled={busy || entries.length >= 12}
            onClick={addEntry}
            type="button"
          >
            + {t('detail.evidence_add')}
          </button>
          {error !== '' && (
            <p aria-live="polite" className="mt-3 rounded-md border border-red-b bg-red-t px-3 py-2 text-caption text-red-d" data-testid="evidence-error" id={ERROR_ID}>
              {error}
            </p>
          )}
          {markdown !== '' && (
            <section className="mt-4 rounded-md border border-green-b bg-green-t/40 p-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <label className="text-caption font-bold text-green-d" htmlFor="verification-evidence-output">
                  {t('detail.evidence_output')}
                </label>
                <button className="rounded-md border border-green-b px-3 py-1.5 text-caption font-semibold text-green-d hover:bg-green-t" data-testid="evidence-copy" onClick={() => void copy()} type="button">
                  {t('detail.evidence_copy')}
                </button>
              </div>
              <textarea
                className="min-h-48 w-full resize-y rounded-md border border-border bg-bg p-3 font-mono text-caption leading-5 text-text outline-none focus-visible:border-(--accent) focus-visible:ring-2 focus-visible:ring-accent-t"
                data-testid="evidence-output"
                id="verification-evidence-output"
                readOnly
                value={markdown}
              />
              {copyError !== '' && <p aria-live="polite" className="mb-0 mt-2 text-caption text-red-d" data-testid="evidence-copy-error">{copyError}</p>}
            </section>
          )}
        </Dialog>
      )}
    </>
  )
}
