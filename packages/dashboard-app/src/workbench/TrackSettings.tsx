import { useEffect, useRef, useState } from 'react'
import {
  deleteTrackDefinition,
  patchTrackDefinition,
  postRouterPreview,
  postTrackDefinition,
  type WbRouterPreview,
  type WbTrackDefinition,
} from '../api/client'
import { useT } from '../i18n'
import { formatApiError } from '../api/transport'
import { decodeTrackMutationSuccess } from '../api/trackMutationResponse'
import { Dialog } from '../shared/Dialog'
import { UnsavedDraftDialog, useDiscardGuard } from '../shared/UnsavedDraftDialog'
import type { MandatoryState } from './mandatoryState'
import {
  allowedFromTrackDraft,
  cloneTrackPolicy,
  effectiveTrackDraft,
  trackDraftHasRequiredFields,
  trackDraftFromDefinition,
  type TrackEditorDraft,
} from './trackEditorDraft'
import { TrackSettingsList } from './TrackSettingsList'
import { TrackEditorFields } from './TrackEditorFields'
import { TrackRoutePreview } from './TrackRoutePreview'
import { useTrackMutationIdentity } from './useTrackMutationIdentity'
import { useMutationFocus } from './useMutationFocus'

const ADD_CLS =
  'cursor-pointer rounded-md border-[1.5px] border-dashed border-border-2 bg-transparent px-3 py-1 text-caption font-bold whitespace-nowrap text-text-3 transition-colors enabled:hover:border-purple-b enabled:hover:text-purple-d disabled:cursor-not-allowed disabled:opacity-50'

interface TrackSettingsProps {
  state: MandatoryState
  onDirtyChange?: (dirty: boolean) => void
}

type TrackEditorState = {
  mode: 'create' | 'edit'
  original: WbTrackDefinition | null
  baseline: TrackEditorDraft
  draft: TrackEditorDraft
}

export function TrackSettings({ state, onDirtyChange }: TrackSettingsProps): JSX.Element {
  const { t, lang } = useT()
  const [open, setOpen] = useState(false)
  const [editor, setEditor] = useState<TrackEditorState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [routePrompt, setRoutePrompt] = useState('')
  const [routePreview, setRoutePreview] = useState<WbRouterPreview | null>(null)
  const [routePreviewBusy, setRoutePreviewBusy] = useState(false)
  const [routePreviewError, setRoutePreviewError] = useState('')
  const discardGuard = useDiscardGuard()
  const routePreviewGeneration = useRef(0)
  const rootIdentity = useRef(state.root)
  rootIdentity.current = state.root
  const trackMutation = useTrackMutationIdentity(
    state.root,
    editor === null ? null : editor.original?.id ?? editor.draft.id,
  )
  const busy = trackMutation.busy
  const mutationFocus = useMutationFocus(busy, editor !== null)
  const localeIdentity = useRef({ t, lang })
  localeIdentity.current = { t, lang }
  useEffect(() => {
    setError(null)
    setRoutePreviewError('')
  }, [lang])
  useEffect(() => {
    ++routePreviewGeneration.current
    setOpen(false)
    setEditor(null)
    setRoutePreview(null)
    setRoutePreviewBusy(false)
    setRoutePreviewError('')
  }, [state.root])
  const editorDirty = editor !== null && JSON.stringify(editor.draft) !== JSON.stringify(editor.baseline)
  useEffect(() => {
    onDirtyChange?.(editorDirty)
  }, [editorDirty, onDirtyChange])
  useEffect(() => () => {
    onDirtyChange?.(false)
  }, [onDirtyChange])
  const fieldClass = 'rounded-sm border border-border bg-bg px-2 py-1.5 text-caption text-text focus-visible:border-(--accent) focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-(--ring-blue) disabled:opacity-60'

  function clearEditor(): void {
    setEditor(null)
    setRoutePrompt('')
    invalidateRoutePreview()
  }

  function closePanel(): void {
    setOpen(false)
    clearEditor()
  }

  function requestDraftClose(action: () => void): void {
    if (!busy) discardGuard.request(editorDirty, action)
  }

  function requestEditorSwitch(action: () => void, trigger: HTMLElement): void {
    if (!busy) {
      // Capture the list/create trigger before a dirty-draft confirmation can move focus into its
      // own dialog, but commit it only if the deferred switch is actually accepted. Choosing Stay
      // must preserve the opener belonging to the editor that remains on screen.
      discardGuard.request(editorDirty, () => {
        mutationFocus.captureEditorReturn(trigger)
        action()
      })
    }
  }

  function openCreate(): void {
    const template = state.tracks.find((track) => track.id === 'frontend') ?? state.tracks[0]
    if (!template) return
    const draft: TrackEditorDraft = {
      id: '', label: '', workflowDefault: 'default', workflowAny: true, workflowAllowed: '',
      policyProfile: cloneTrackPolicy(template.policyProfile),
    }
    setEditor({
      mode: 'create', original: null,
      baseline: { ...draft, policyProfile: cloneTrackPolicy(draft.policyProfile) },
      draft,
    })
    setError(null)
    setDeleteConfirm(false)
    setRoutePrompt('')
    invalidateRoutePreview()
  }

  function openEdit(track: WbTrackDefinition): void {
    const draft = trackDraftFromDefinition(track)
    setEditor({
      mode: 'edit',
      original: track,
      baseline: { ...draft, policyProfile: cloneTrackPolicy(draft.policyProfile) },
      draft,
    })
    setError(null)
    setDeleteConfirm(false)
    setRoutePrompt('')
    invalidateRoutePreview()
  }

  function updateDraft(patch: Partial<TrackEditorDraft>): void {
    setEditor((current) => current ? { ...current, draft: { ...current.draft, ...patch } } : current)
    invalidateRoutePreview()
  }

  function invalidateRoutePreview(): void {
    ++routePreviewGeneration.current
    setRoutePreview(null)
    setRoutePreviewBusy(false)
    setRoutePreviewError('')
  }

  const routeIdentity = editor === null
    ? ''
    : JSON.stringify({
        root: state.root,
        prompt: routePrompt.trim(),
        draft: effectiveTrackDraft(editor.draft),
      })
  const routeIdentityRef = useRef(routeIdentity)
  routeIdentityRef.current = routeIdentity

  async function previewRoute(): Promise<void> {
    if (!editor || editor.original?.builtin || routePreviewBusy || routePrompt.trim() === '') return
    const targetRoot = state.root
    const prompt = routePrompt.trim()
    const draft = effectiveTrackDraft(editor.draft)
    const identity = JSON.stringify({ root: targetRoot, prompt, draft })
    const generation = ++routePreviewGeneration.current
    setRoutePreviewBusy(true)
    setRoutePreviewError('')
    try {
      const result = await postRouterPreview(targetRoot, prompt, draft)
      if (generation !== routePreviewGeneration.current || rootIdentity.current !== targetRoot || routeIdentityRef.current !== identity) return
      setRoutePreview(result)
    } catch (cause) {
      if (generation !== routePreviewGeneration.current || rootIdentity.current !== targetRoot || routeIdentityRef.current !== identity) return
      setRoutePreview(null)
      const current = localeIdentity.current
      setRoutePreviewError(formatApiError(cause, current.t, { exposeServerDetail: current.lang === 'zh' }))
    } finally {
      if (generation === routePreviewGeneration.current && rootIdentity.current === targetRoot && routeIdentityRef.current === identity) {
        setRoutePreviewBusy(false)
      }
    }
  }

  async function readMutationError(response: Response): Promise<string> {
    let body: unknown = null
    try { body = await response.json() } catch { /* no JSON */ }
    const value = (key: string): unknown =>
      typeof body === 'object' && body !== null && !Array.isArray(body) ? Reflect.get(body, key) : undefined
    const stringList = (input: unknown): string[] =>
      Array.isArray(input) ? input.filter((item): item is string => typeof item === 'string') : []
    const error = value('error')
    const current = localeIdentity.current
    const details = current.lang === 'zh'
      ? [...stringList(value('references')), ...stringList(value('blockers'))]
      : []
    const summary = current.lang === 'zh' && typeof error === 'string'
      ? error
      : current.t('common.request_http_error', { status: response.status })
    return [summary, ...details].join(' · ')
  }

  async function saveTrack(trigger: HTMLElement | null): Promise<void> {
    if (!editor || busy) return
    const draft = editor.draft
    const allowed = allowedFromTrackDraft(draft)
    if (!trackDraftHasRequiredFields(draft)) {
      setError(t('workbench.track_fields_invalid'))
      return
    }
    if (editor.mode === 'create' && state.tracks.some((track) => track.id === draft.id)) {
      setError(t('workbench.track_id_duplicate'))
      return
    }
    if (Array.isArray(allowed) && (allowed.length === 0 || !allowed.includes(draft.workflowDefault.trim()))) {
      setError(t('workbench.track_allowed_invalid'))
      return
    }
    const targetRoot = state.root
    const targetRevision = state.revision
    const targetTrack = draft.id
    mutationFocus.capture(trigger)
    const operation = trackMutation.begin('save', targetRevision, targetTrack)
    setError(null)
    try {
      const response = editor.mode === 'create'
        ? await postTrackDefinition({
            root: targetRoot,
            revision: targetRevision,
            track: {
              id: targetTrack,
              label: draft.label.trim(),
              builtin: false,
              workflow: { default: draft.workflowDefault.trim(), allowed },
              policyProfile: cloneTrackPolicy(draft.policyProfile),
            },
          })
        : await patchTrackDefinition(targetRoot, targetRevision, targetTrack, {
            label: draft.label.trim(),
            workflowDefault: draft.workflowDefault.trim(),
            workflowAllowed: allowed,
            ...(editor.original?.builtin ? {} : { policyProfile: cloneTrackPolicy(draft.policyProfile) }),
          })
      if (!response.ok) {
        const message = await readMutationError(response)
        if (trackMutation.isCurrentEntity(operation)) setError(message)
        return
      }
      let body: unknown
      try { body = await response.json() } catch { body = null }
      const success = decodeTrackMutationSuccess(body)
      if (success === null) {
        if (trackMutation.isCurrentEntity(operation)) setError(localeIdentity.current.t('common.invalid_response'))
        return
      }
      if (!trackMutation.isActive(operation)) return
      await state.reloadConfig()
      if (trackMutation.isCurrentEntity(operation)) setEditor(null)
    } catch (mutationError) {
      if (trackMutation.isCurrentEntity(operation)) {
        const current = localeIdentity.current
        setError(formatApiError(mutationError, current.t, { exposeServerDetail: current.lang === 'zh' }))
      }
    } finally {
      trackMutation.finish(operation)
    }
  }

  async function removeTrack(trigger: HTMLElement): Promise<void> {
    if (!editor?.original || editor.original.builtin || busy) return
    const targetRoot = state.root
    const targetRevision = state.revision
    const targetTrack = editor.original.id
    mutationFocus.capture(trigger)
    const operation = trackMutation.begin('delete', targetRevision, targetTrack)
    setError(null)
    try {
      const response = await deleteTrackDefinition(targetRoot, targetRevision, targetTrack)
      if (!response.ok) {
        const message = await readMutationError(response)
        if (trackMutation.isCurrentEntity(operation)) setError(message)
        return
      }
      let body: unknown
      try { body = await response.json() } catch { body = null }
      const success = decodeTrackMutationSuccess(body)
      if (success === null) {
        if (trackMutation.isCurrentEntity(operation)) setError(localeIdentity.current.t('common.invalid_response'))
        return
      }
      if (!trackMutation.isActive(operation)) return
      await state.reloadConfig()
      if (trackMutation.isCurrentEntity(operation)) setEditor(null)
    } catch (mutationError) {
      if (trackMutation.isCurrentEntity(operation)) {
        const current = localeIdentity.current
        setError(formatApiError(mutationError, current.t, { exposeServerDetail: current.lang === 'zh' }))
      }
    } finally {
      trackMutation.finish(operation)
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        className="rounded-sm border border-border bg-card px-3 py-2 text-caption font-bold text-text-2 transition-colors hover:bg-fill"
        data-testid="wb-track-settings-toggle"
        aria-expanded={open}
        disabled={busy}
        onClick={() => {
          if (open) requestDraftClose(closePanel)
          else setOpen(true)
        }}
      >
        {t('workbench.track_settings_toggle')}
      </button>
      {open && (
        <Dialog
          title={t('workbench.track_settings_dialog')}
          onClose={() => requestDraftClose(closePanel)}
          testid="wb-track-settings-panel"
          closeLabel={t('workbench.track_settings_close')}
          closeDisabled={busy}
          panelClassName="w-[min(920px,calc(100vw-32px))]"
          variant="workspace"
        >
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <p className="text-base text-text-3">{t('workbench.track_settings_description')}</p>
            <button type="button" className={ADD_CLS} data-testid="wb-track-create" disabled={busy} onClick={(event) => requestEditorSwitch(openCreate, event.currentTarget)}>{t('workbench.track_settings_create')}</button>
          </div>
          {editor && (
            <form
              className="mb-3 rounded-md border border-accent-b bg-accent-t/35 p-3"
              data-testid="wb-track-editor"
              onSubmit={(event) => {
                event.preventDefault()
                const submitter = (event.nativeEvent as SubmitEvent).submitter; void saveTrack(submitter instanceof HTMLElement ? submitter : mutationFocus.saveButtonRef.current)
              }}
            >
              <fieldset className="contents" disabled={busy}>
                <div className="mb-3 flex items-center justify-between gap-2">
                  <b className="text-body text-text">{editor.mode === 'create' ? t('workbench.track_create_title') : t('workbench.track_edit_title')}</b>
                  <button type="button" className="text-caption text-text-3 disabled:cursor-not-allowed disabled:opacity-50" onClick={() => requestDraftClose(clearEditor)}>{t('workbench.track_cancel')}</button>
                </div>
                <TrackEditorFields
                  draft={editor.draft}
                  editMode={editor.mode === 'edit'}
                  builtin={editor.original?.builtin === true}
                  tracks={state.tracks}
                  fieldClass={fieldClass}
                  onUpdate={updateDraft}
                />
                {!editor.original?.builtin && (
                  <TrackRoutePreview
                    prompt={routePrompt}
                    preview={routePreview}
                    busy={routePreviewBusy}
                    error={routePreviewError}
                    fieldClass={fieldClass}
                    onPrompt={(value) => { setRoutePrompt(value); invalidateRoutePreview() }}
                    onPreview={() => void previewRoute()}
                    t={t}
                  />
                )}
                {error && <p className="mt-3 rounded-sm border border-red-b bg-red-t p-2 text-caption text-red-d" role="alert" data-testid="wb-track-editor-error">{error}</p>}
                <div className="mt-3 flex flex-wrap justify-end gap-2">
                  {editor.mode === 'edit' && !editor.original?.builtin && (
                    deleteConfirm
                      ? <button type="button" className="rounded-sm border border-red-b px-3 py-1.5 text-caption font-bold text-red-d" data-testid="wb-track-delete-confirm" onClick={(event) => void removeTrack(event.currentTarget)}>{t('workbench.track_delete_confirm')}</button>
                      : <button type="button" className="mr-auto rounded-sm border border-red-b px-3 py-1.5 text-caption font-bold text-red-d" data-testid="wb-track-editor-delete" onClick={() => setDeleteConfirm(true)}>{t('workbench.track_delete')}</button>
                  )}
                  <button ref={mutationFocus.saveButtonRef} type="submit" className="rounded-sm bg-btn-bg px-4 py-1.5 text-caption font-bold text-btn-fg disabled:opacity-50" data-testid="wb-track-editor-save" disabled={!trackDraftHasRequiredFields(editor.draft)}>{busy ? t('workbench.track_saving') : t('workbench.track_save')}</button>
                </div>
              </fieldset>
            </form>
          )}
          <TrackSettingsList state={state} disabled={busy} onEdit={(track, trigger) => requestEditorSwitch(() => openEdit(track), trigger)} />
        </Dialog>
      )}
      <UnsavedDraftDialog
        open={discardGuard.confirmOpen}
        testid="wb-track-unsaved-draft"
        onStay={discardGuard.stay}
        onDiscard={discardGuard.discard}
      />
    </div>
  )
}
