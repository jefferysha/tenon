import { useEffect, useMemo, useRef, useState } from 'react'
import {
  fetchWorkflow,
  fetchWorkflowNames,
  postCreateChange,
  postRouterPreview,
  type WbRouterPreview,
  type WbRouterPreviewCandidate,
} from '../api/client'
import { formatApiError } from '../api/transport'
import { useT } from '../i18n'
import { Dialog } from '../shared/Dialog'
import { BUTTON_GHOST, BUTTON_SOLID, INPUT, SELECT } from '../shared/uiRecipes'
import { useDefinitionCatalogSelection } from './useDefinitionCatalogSelection'
import { PipelineSelector } from './PipelineSelector'
import { PipelineCatalogStatus } from './PipelineCatalogStatus'
import { FirstStepStatus } from './FirstStepStatus'

export interface CreateChangeDialogProps {
  root: string
  onClose: () => void
  onCreated: (name: string) => void | Promise<void>
  onToast?: (message: string) => void
}

const NAME_RE = /^[a-zA-Z0-9_-]+$/
function workflowOptions(candidate: WbRouterPreviewCandidate | undefined, names: readonly string[]): string[] {
  if (!candidate) return []
  const allowed = candidate.track.workflow.allowed
  const raw = allowed === '*' ? ['default', ...names] : [...allowed]
  const out: string[] = []
  for (const name of [candidate.track.workflow.default, ...raw]) {
    if (name !== '' && !out.includes(name)) out.push(name)
  }
  return out
}

/**
 * Route Lock：描述任务后由真 Router 建议 Track，用户确认 Workflow；服务端锁内复验并把
 * 提示词持久化为当前 Change 的会话任务，再由真实 CLI 绑定当前会话。
 */
export function CreateChangeDialog({ root, onClose, onCreated, onToast }: CreateChangeDialogProps): JSX.Element {
  const { t, lang } = useT()
  const [name, setName] = useState('')
  const [intent, setIntent] = useState('')
  const [workflowNames, setWorkflowNames] = useState<string[]>([])
  const [preview, setPreview] = useState<WbRouterPreview | null>(null)
  const [previewState, setPreviewState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [previewError, setPreviewError] = useState<unknown | null>(null)
  const [selectedTrack, setSelectedTrack] = useState('')
  const [selectedWorkflow, setSelectedWorkflow] = useState('')
  const [firstStep, setFirstStep] = useState<string | null>(null)
  const [firstStepError, setFirstStepError] = useState<unknown | null>(null)
  const [firstStepState, setFirstStepState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const { definitionCatalog, catalogState, pipelines, selectedPipeline, setSelectedPipeline } = useDefinitionCatalogSelection(root, selectedTrack, selectedWorkflow)
  const [busy, setBusy] = useState(false)
  const [createError, setCreateError] = useState<unknown | null>(null)
  const previewSequence = useRef(0)
  const createSequence = useRef(0)
  const mounted = useRef(true)
  const rootIdentity = useRef(root)
  rootIdentity.current = root
  const localeIdentity = useRef({ t, lang })
  localeIdentity.current = { t, lang }
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      ++previewSequence.current
      ++createSequence.current
    }
  }, [])
  useEffect(() => {
    ++previewSequence.current
    ++createSequence.current
    setName('')
    setIntent('')
    setWorkflowNames([])
    setPreview(null)
    setPreviewState('idle')
    setPreviewError(null)
    setSelectedTrack('')
    setSelectedWorkflow('')
    setFirstStep(null)
    setFirstStepError(null)
    setFirstStepState('idle')
    setBusy(false)
    setCreateError(null)
  }, [root])
  useEffect(() => {
    let active = true
    void fetchWorkflowNames(root)
      .then((names) => { if (active) setWorkflowNames(names) })
      .catch(() => { if (active) setWorkflowNames([]) })
    return () => { active = false }
  }, [root])

  useEffect(() => {
    const prompt = intent
    const seq = ++previewSequence.current
    setPreviewError(null)
    if (prompt.trim().length < 3) {
      setPreview(null)
      setPreviewState('idle')
      setSelectedTrack('')
      setSelectedWorkflow('')
      return
    }
    setPreviewState('loading')
    const timer = window.setTimeout(() => {
      void postRouterPreview(root, prompt)
        .then((result) => {
          if (previewSequence.current !== seq) return
          setPreview(result)
          setPreviewState('ready')
          const suggested = result.winner?.track.id
            ?? result.candidates.find((candidate) => candidate.track.id === 'free')?.track.id
            ?? result.candidates.find((candidate) => candidate.track.id === 'chat')?.track.id
            ?? result.candidates[0]?.track.id
            ?? ''
          setSelectedTrack(suggested)
        })
        .catch((error) => {
          if (previewSequence.current !== seq) return
          setPreview(null)
          setPreviewState('error')
          setPreviewError(error)
          setSelectedTrack('')
        })
    }, 260)
    return () => window.clearTimeout(timer)
  }, [intent, root])
  const selectedCandidate = useMemo(
    () => preview?.candidates.find((candidate) => candidate.track.id === selectedTrack),
    [preview, selectedTrack],
  )
  const workflows = useMemo(
    () => workflowOptions(
      selectedCandidate,
      [...new Set([
        ...workflowNames,
        ...(definitionCatalog?.workflows.map((workflow) => workflow.id) ?? []),
      ])],
    ),
    [definitionCatalog, selectedCandidate, workflowNames],
  )
  useEffect(() => {
    if (!selectedCandidate) {
      setSelectedWorkflow('')
      return
    }
    setSelectedWorkflow(selectedCandidate.track.workflow.default)
  }, [selectedCandidate])
  useEffect(() => {
    let active = true
    if (selectedWorkflow === '') {
      setFirstStep(null)
      setFirstStepError(null)
      setFirstStepState('idle')
      return () => { active = false }
    }
    if (selectedWorkflow === 'default') {
      setFirstStep('open')
      setFirstStepError(null)
      setFirstStepState('ready')
      return () => { active = false }
    }
    setFirstStepState('loading')
    setFirstStep(null)
    setFirstStepError(null)
    void fetchWorkflow(selectedWorkflow, root)
      .then((body) => {
        const first = body.steps[0]?.id ?? null
        if (active) {
          setFirstStep(first)
          setFirstStepState('ready')
        }
      })
      .catch((error) => {
        if (active) {
          setFirstStep(null)
          setFirstStepError(error)
          setFirstStepState('error')
        }
      })
    return () => { active = false }
  }, [root, selectedWorkflow])

  const validName = NAME_RE.test(name)
  const canCreate = validName
    && selectedCandidate !== undefined
    && selectedWorkflow !== ''
    && firstStepState === 'ready'
    && firstStep !== null
    && catalogState !== 'loading'
    && (catalogState === 'unavailable' || selectedPipeline !== '')
    && !busy

  async function create(): Promise<void> {
    if (!canCreate || !selectedCandidate) return
    const operation = {
      root,
      name,
      track: selectedCandidate.track.id,
      workflow: selectedWorkflow,
      intent: intent.trim(),
      token: ++createSequence.current,
    }
    setBusy(true)
    setCreateError(null)
    try {
      const result = await postCreateChange({
        root: operation.root,
        name: operation.name,
        track: operation.track,
        workflow: operation.workflow,
        ...(selectedPipeline === '' ? {} : { pipeline_id: selectedPipeline }),
        task_prompt: operation.intent,
        activate_session: true,
      })
      if (!mounted.current || operation.token !== createSequence.current || rootIdentity.current !== operation.root) return
      await onCreated(operation.name)
      if (!mounted.current || operation.token !== createSequence.current || rootIdentity.current !== operation.root) return
      const current = localeIdentity.current
      onToast?.(
        result.session?.active === true
          ? current.t('change_create.created_and_activated', { name: operation.name })
          : current.t('change_create.created_session_not_active', { name: operation.name }),
      )
      onClose()
    } catch (error) {
      if (mounted.current && operation.token === createSequence.current && rootIdentity.current === operation.root) {
        setCreateError(error)
      }
    } finally {
      if (mounted.current && operation.token === createSequence.current && rootIdentity.current === operation.root) {
        setBusy(false)
      }
    }
  }
  function requestClose(): void {
    if (!busy) onClose()
  }
  return (
    <Dialog
      title={t('change_create.title')}
      onClose={requestClose}
      testid="create-change-dialog"
      panelClassName="w-[min(780px,94vw)]"
      actions={(
        <>
          <button
            type="button"
            className={`${BUTTON_GHOST} px-3 py-2 text-xs`}
            data-testid="change-create-cancel"
            disabled={busy}
            onClick={requestClose}
          >
            {t('change_create.cancel')}
          </button>
          <button
            type="button"
            className={`${BUTTON_SOLID} px-4 py-2 text-xs`}
            data-testid="change-create"
            disabled={!canCreate}
            onClick={() => void create()}
          >
            {busy ? t('change_create.creating') : t('change_create.create')}
          </button>
        </>
      )}
    >
      <p className="mb-4 text-[12.5px] leading-5 text-text-3">{t('change_create.subtitle')}</p>
      <div className="grid gap-4 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.35fr)]">
        <div className="space-y-3">
          <label className="block text-xs font-bold text-text-2">
            {t('change_create.name')}
            <input
              className={`${INPUT} mt-1.5 font-mono`}
              data-testid="change-name"
              value={name}
              placeholder="release-checkout"
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          {name !== '' && !validName && (
            <p className="text-xs text-red-d" data-testid="change-name-error" role="alert">{t('change_create.name_error')}</p>
          )}
          <label className="block text-xs font-bold text-text-2">
            {t('change_create.intent')}
            <textarea
              className={`${INPUT} mt-1.5 min-h-28 resize-y leading-5`}
              data-testid="change-intent"
              value={intent}
              placeholder={t('change_create.intent_placeholder')}
              onChange={(event) => setIntent(event.target.value)}
            />
          </label>
          <p className="text-[11px] leading-4 text-text-3">{t('change_create.intent_note')}</p>
        </div>
        <section className="rounded-2xl border border-border bg-card p-3.5 shadow-sm" aria-label={t('change_create.route_lock')}>
          <div className="mb-3 flex items-center justify-between gap-3 border-b border-border pb-2.5">
            <div>
              <div className="text-[11px] font-black uppercase tracking-[0.16em] text-accent-d">{t('change_create.route_lock')}</div>
              <div className="mt-1 text-xs text-text-3">{t('change_create.route_truth')}</div>
            </div>
            <span className="rounded-full border border-border bg-card px-2 py-1 font-mono text-[10px] text-text-3">
              {preview?.revision ?? '—'}
            </span>
          </div>

          {previewState === 'idle' && <p className="py-8 text-center text-xs text-text-3" role="status" aria-live="polite">{t('change_create.route_idle')}</p>}
          {previewState === 'loading' && <p className="py-8 text-center text-xs text-text-3" role="status" aria-live="polite">{t('change_create.route_loading')}</p>}
          {previewState === 'error' && <p className="py-4 text-xs text-red-d" role="alert">{formatApiError(previewError, t, { exposeServerDetail: lang === 'zh' })}</p>}
          {preview && previewState === 'ready' && (
            <>
              {preview.suppressed_reason !== null ? (
                <div className="mb-3 rounded-lg border border-amber-b bg-amber-t px-3 py-2 text-xs text-amber-d" data-testid="route-suppressed" role="status" aria-live="polite">
                  {t('change_create.route_suppressed', { reason: preview.suppressed_reason })}
                </div>
              ) : preview.winner ? (
                <div className="mb-3 rounded-lg border border-accent-b bg-accent-t px-3 py-2 text-xs text-accent-d" data-testid="route-winner" role="status" aria-live="polite">
                  {t('change_create.route_winner', {
                    label: preview.winner.track.label,
                    score: preview.winner.score,
                    priority: preview.winner.priority,
                  })}
                </div>
              ) : (
                <div className="mb-3 rounded-lg border border-border bg-card px-3 py-2 text-xs text-text-2" role="status" aria-live="polite">{t('change_create.route_no_match')}</div>
              )}

              <div className="flex flex-wrap gap-2" role="group" aria-label={t('change_create.track')}>
                {preview.candidates.map((candidate) => (
                  <button
                    type="button"
                    key={candidate.track.id}
                    className="rounded-xl border border-border bg-card px-3 py-2 text-left transition-[background-color,border-color,box-shadow] hover:border-border-2 aria-pressed:border-(--accent) aria-pressed:bg-accent-t"
                    data-testid={`route-candidate-${candidate.track.id}`}
                    aria-pressed={selectedTrack === candidate.track.id}
                    onClick={() => setSelectedTrack(candidate.track.id)}
                  >
                    <span className="block text-xs font-bold text-text">{candidate.track.label}</span>
                    <span className="mt-0.5 block font-mono text-[10px] text-text-3">
                      {candidate.routable ? t('change_create.route_score', { score: candidate.score, priority: candidate.priority }) : t('change_create.route_disabled')}
                    </span>
                  </button>
                ))}
              </div>
              {selectedCandidate && (
                <>
                  {selectedCandidate.track.id === 'free' && (
                    <div className="mt-3 rounded-lg border border-accent-b bg-accent-t px-3 py-2 text-xs leading-5 text-accent-d" data-testid="route-free-note">
                      {t('change_create.free_note')}
                    </div>
                  )}
                  <div className="mt-3 grid gap-3 border-t border-border pt-3 sm:grid-cols-2">
                    <div className="rounded-lg bg-card p-2.5" data-testid="route-policy">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-text-3">{t('change_create.policy')}</div>
                      <div className="mt-1 text-xs leading-5 text-text-2">
                        {selectedCandidate.track.policyProfile.coverageProfile} · {selectedCandidate.track.policyProfile.skills.profile}<br />
                        {selectedCandidate.track.policyProfile.automationEligible ? t('change_create.afk_yes') : t('change_create.afk_no')} · {t('change_create.review_seed', { value: selectedCandidate.track.policyProfile.reviewSeed })}
                      </div>
                    </div>
                    <label className="block text-[10px] font-bold uppercase tracking-wider text-text-3">
                      {t('change_create.workflow')}
                      <select
                        className={`${SELECT} mt-1.5 font-mono text-xs`}
                        data-testid="change-workflow"
                        value={selectedWorkflow}
                        onChange={(event) => setSelectedWorkflow(event.target.value)}
                      >
                        {workflows.map((workflow) => <option key={workflow} value={workflow}>{workflow}</option>)}
                      </select>
                      <FirstStepStatus state={firstStepState} firstStep={firstStep} error={firstStepError} workflow={selectedWorkflow} lang={lang} t={t} />
                    </label>
                    <PipelineSelector
                      pipelines={pipelines}
                      selectedPipeline={selectedPipeline}
                      onChange={setSelectedPipeline}
                      label={t('change_create.pipeline')}
                      stageSummary={(count) => t('change_create.pipeline_stages', { count })}
                    />
                    <PipelineCatalogStatus state={catalogState} pipelineCount={pipelines.length} t={t} />
                  </div>
                </>
              )}
            </>
          )}
        </section>
      </div>

      {createError !== null && <p className="mt-3 rounded-lg bg-red-t px-3 py-2 text-xs text-red-d" role="alert">{formatApiError(createError, t, { exposeServerDetail: lang === 'zh' })}</p>}
    </Dialog>
  )
}
