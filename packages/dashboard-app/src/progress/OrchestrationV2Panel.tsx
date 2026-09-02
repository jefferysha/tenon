import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Pause, Play, RefreshCw, Square } from 'lucide-react'
import type { BoardEventV2, BoardSnapshotV2 } from '@tenon/kernel'
import { formatApiError } from '../api/transport'
import { fetchOrchestrationV2Snapshot, postOrchestrationV2Command, postOrchestrationV2Control, sortUniqueEvents, subscribeOrchestrationV2 } from '../api/orchestrationV2Client'
import { useT } from '../i18n'

export interface OrchestrationV2PanelProps {
  readonly root: string
  readonly change: string | null | undefined
  readonly readOnly?: boolean
  readonly onToast?: (message: string) => void
}

const statusTone: Record<string, string> = {
  completed: 'text-green-700 dark:text-green-300', executing: 'text-sky-700 dark:text-sky-300', running: 'text-sky-700 dark:text-sky-300',
  blocked: 'text-red-700 dark:text-red-300', failed: 'text-red-700 dark:text-red-300', paused: 'text-amber-700 dark:text-amber-300',
}

export function OrchestrationV2Panel({ root, change, readOnly = false, onToast }: OrchestrationV2PanelProps): JSX.Element | null {
  const { t } = useT()
  const [snapshot, setSnapshot] = useState<BoardSnapshotV2 | null>(null)
  const [events, setEvents] = useState<readonly BoardEventV2[]>([])
  const [error, setError] = useState<unknown>(null)
  const [connected, setConnected] = useState(false)
  const [busy, setBusy] = useState(false)
  const [artifactDraft, setArtifactDraft] = useState<{ readonly workItemId: string; readonly ref: string; readonly digest: string } | null>(null)
  const [workItemsOpen, setWorkItemsOpen] = useState(false)
  const revision = useRef(0)

  useEffect(() => {
    revision.current = 0
    setSnapshot(null)
    setEvents([])
    setError(null)
    setConnected(false)
    setWorkItemsOpen(false)
    setArtifactDraft(null)
    if (!change) return
    const controller = new AbortController()
    let disposed = false
    void fetchOrchestrationV2Snapshot(root, change, controller.signal).then((next) => {
      if (disposed) return
      if (next.revision < revision.current) return
      revision.current = Math.max(revision.current, next.revision)
      setSnapshot(next)
      setError(null)
    }).catch((reason: unknown) => {
      if (!disposed && !(reason instanceof DOMException && reason.name === 'AbortError')) setError(reason)
    })
    const unsubscribe = subscribeOrchestrationV2(root, change, (frame) => {
      if (disposed) return
      const frameRevision = frame.value.revision
      if (frameRevision < revision.current) return
      revision.current = frameRevision
      setConnected(true)
      setError(null)
      if (frame.kind === 'snapshot') setSnapshot(frame.value)
      else setEvents((previous) => sortUniqueEvents([...previous, frame.value]))
    }, () => {
      if (!disposed) setConnected(false)
    })
    return () => {
      disposed = true
      controller.abort()
      unsubscribe()
    }
  }, [change, root])

  const counts = useMemo(() => {
    const values = snapshot?.work_items ?? []
    return { done: values.filter((item) => item.status === 'completed').length, total: values.length, running: values.filter((item) => item.status === 'running').length }
  }, [snapshot])

  const refresh = async (): Promise<void> => {
    if (!change || busy) return
    setBusy(true)
    try {
      const next = await fetchOrchestrationV2Snapshot(root, change)
      if (next.revision < revision.current) return
      revision.current = Math.max(revision.current, next.revision)
      setSnapshot(next)
      setError(null)
    } catch (reason) {
      setError(reason)
    } finally {
      setBusy(false)
    }
  }

  if (!change) return null
  const action = async (type: 'pause-change' | 'resume-change' | 'cancel-change'): Promise<void> => {
    if (!snapshot || busy || readOnly) return
    setBusy(true)
    try {
      const next = await postOrchestrationV2Control(root, snapshot, type)
      revision.current = Math.max(revision.current, next.revision)
      setSnapshot(next)
      onToast?.(type === 'cancel-change' ? t('progress.orchestration_cancel_ok') : type === 'pause-change' ? t('progress.orchestration_pause_ok') : t('progress.orchestration_resume_ok'))
    } catch (reason) {
      setError(reason)
    } finally {
      setBusy(false)
    }
  }

  const dispatch = async (type: Parameters<typeof postOrchestrationV2Command>[2], payload: Record<string, unknown> = {}): Promise<void> => {
    if (!snapshot || busy || readOnly) return
    setBusy(true)
    try {
      const next = await postOrchestrationV2Command(root, snapshot, type, payload)
      revision.current = Math.max(revision.current, next.revision)
      setSnapshot(next)
      onToast?.(t('progress.orchestration_command_ok', { command: type }))
    } catch (reason) {
      setError(reason)
    } finally {
      setBusy(false)
    }
  }

  const retryItem = (workItemId: string): void => {
    const previous = snapshot?.runs.filter((run) => run.work_item_id === workItemId).at(-1)
    if (!previous) return
    const nonce = typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID() : `${Date.now()}`
    void dispatch('retry-work-item', { work_item_id: workItemId, attempt_id: `attempt:dashboard:${nonce}`, run_id: `run:dashboard:${nonce}` })
  }

  const evaluateGate = (status: 'passed' | 'rejected'): void => {
    if (!snapshot) return
    const nonce = typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID() : `${Date.now()}`
    const gateId = snapshot.gates.find((gate) => gate.status === 'pending')?.gate_id ?? `verification:${snapshot.change_id}`
    const evidence = snapshot.validations.filter((report) => report.status === 'pass').flatMap((report) => report.evidence_refs)
    void dispatch('evaluate-gate', { gate: {
      schema_version: 'gate-evaluation/v2', record_id: `gate:${gateId}`, project_id: snapshot.project_id, change_id: snapshot.change_id,
      revision: snapshot.revision, correlation_id: snapshot.correlation_id, actor: { kind: 'user', id: 'dashboard' }, created_at: new Date().toISOString(),
      gate_id: gateId, kind: 'verification', status, required_evidence_refs: evidence, decision_revision: snapshot.revision, rationale: `dashboard:${status}:${nonce}`,
    } })
  }

  const bindArtifact = (workItemId: string): void => setArtifactDraft({ workItemId, ref: '', digest: '' })
  const submitArtifact = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (!artifactDraft) return
    const ref = artifactDraft.ref.trim()
    const digest = artifactDraft.digest.trim()
    if (!ref || !digest || !/^sha256:[a-f0-9]{64}$/u.test(digest)) { setError(new Error('artifact digest must be sha256')); return }
    setArtifactDraft(null)
    void dispatch('bind-artifact', { work_item_id: artifactDraft.workItemId, artifact_ref: ref, digest })
  }

  const status = snapshot?.status ?? 'loading'
  const progress = counts.total === 0 ? 0 : Math.round((counts.done / counts.total) * 100)
  const currentItem = snapshot?.work_items.find((item) => ['running', 'queued', 'ready'].includes(item.status))
  const currentStage = currentItem && snapshot?.pipeline?.stages.find((stage) => stage.work_item_ids.includes(currentItem.work_item_id))
  const statusLabel = (value: string): string => {
    const key = value === 'waiting-input' ? 'waiting_input' : value
    return ['executing', 'completed', 'verifying', 'blocked', 'failed', 'paused', 'waiting_input', 'cancelled', 'planning', 'ready'].includes(key)
      ? t(`progress.orchestration_status_${key}`)
      : value
  }
  const currentStepLabel = currentStage?.name ?? statusLabel(status)
  const nextAction = snapshot?.next_actions[0]
  return (
    <section className="prg-orchestration mt-4 rounded-xl border border-border-2 bg-card/80 p-4 shadow-sm" data-testid="orchestration-v2-panel" aria-label={t('progress.orchestration_title')}>
      <div className="prg-orchestration-head">
        <div className="prg-orchestration-title">
          <span className="prg-orchestration-pulse" aria-hidden="true" />
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-[15px] font-bold text-text">{t('progress.orchestration_title')}</h2>
              <span className={`text-[12px] font-semibold ${statusTone[status] ?? 'text-text-3'}`} data-testid="orchestration-v2-status">{status}</span>
              <span className="text-[12px] text-text-2">{statusLabel(status)}</span>
              <span className="text-[11px] text-text-3" data-testid="orchestration-v2-revision">rev {snapshot?.revision ?? '—'}</span>
            </div>
            <p className="mt-1 text-[12px] text-text-3">{connected ? t('progress.orchestration_connected') : t('progress.orchestration_syncing')} · {t('progress.orchestration_counts', counts)}</p>
          </div>
        </div>
        <div className="prg-orchestration-actions">
          {!readOnly && status === 'executing' && <button type="button" aria-label={t('progress.orchestration_pause')} disabled={busy || !snapshot} onClick={() => { void action('pause-change') }} className="prg-control"><Pause className="h-3.5 w-3.5" /><span>{t('progress.orchestration_pause')}</span></button>}
          {!readOnly && status === 'paused' && <button type="button" aria-label={t('progress.orchestration_resume')} disabled={busy || !snapshot} onClick={() => { void action('resume-change') }} className="prg-control"><Play className="h-3.5 w-3.5" /><span>{t('progress.orchestration_resume')}</span></button>}
          {!readOnly && !['completed', 'cancelled'].includes(status) && <button type="button" aria-label={t('progress.orchestration_cancel')} disabled={busy || !snapshot} onClick={() => { void action('cancel-change') }} className="prg-control prg-control-danger"><Square className="h-3.5 w-3.5" /><span>{t('progress.orchestration_cancel')}</span></button>}
          {!readOnly && !['completed', 'cancelled'].includes(status) && <button type="button" aria-label={t('progress.orchestration_replan')} disabled={busy || !snapshot} onClick={() => { void dispatch('replan-change', { reason: 'dashboard-request' }) }} className="prg-control"><span aria-hidden="true">↻</span><span>{t('progress.orchestration_replan')}</span></button>}
          {!readOnly && status === 'verifying' && <><button type="button" aria-label={t('progress.orchestration_approve')} disabled={busy || !snapshot} onClick={() => evaluateGate('passed')} className="prg-control prg-control-success"><span aria-hidden="true">✓</span><span>{t('progress.orchestration_approve')}</span></button><button type="button" aria-label={t('progress.orchestration_reject')} disabled={busy || !snapshot} onClick={() => evaluateGate('rejected')} className="prg-control prg-control-warning"><span aria-hidden="true">!</span><span>{t('progress.orchestration_reject')}</span></button></>}
          <button type="button" aria-label={t('progress.orchestration_refresh')} disabled={busy} onClick={() => { void refresh() }} className="prg-control"><RefreshCw className="h-3.5 w-3.5" /><span>{t('progress.orchestration_refresh')}</span></button>
        </div>
      </div>
      {snapshot && <div className="prg-command-summary" role="status" aria-live="polite" data-testid="orchestration-v2-guided-summary">
        <div className="prg-command-current"><span className="prg-command-label">{t('progress.orchestration_current_step')}</span><strong>{currentStepLabel}{currentItem && <><span aria-hidden="true"> · </span><span className="prg-command-task">{currentItem.title}</span></>}</strong></div>
        <div className="prg-command-next"><span className="prg-command-label">{t('progress.orchestration_next_step')}</span><strong>{nextAction ?? t('progress.orchestration_no_next_step')}</strong></div>
        <div className="prg-command-progress"><strong>{progress}%</strong><div className="prg-progress-track" aria-label={`${progress}%`}><span style={{ transform: `scaleX(${progress / 100})` }} /></div><span className="prg-command-label">{t('progress.orchestration_counts', counts)}</span></div>
      </div>}
      {error !== null && <p className="mt-2 text-xs text-red-700 dark:text-red-300" role="alert">{formatApiError(error, t, { exposeServerDetail: false })}</p>}
      {snapshot?.pipeline && <section className="prg-pipeline mt-3" data-testid="orchestration-v2-pipeline" aria-label={t('progress.orchestration_pipeline')}>
        <div className="prg-pipeline-head"><h3 className="font-semibold text-text">{t('progress.orchestration_pipeline')}</h3><div className="prg-pipeline-meta" translate="no"><span>{snapshot.pipeline.workflow_id}@{snapshot.pipeline.workflow_version}</span><span>{snapshot.pipeline.track_id}</span><span>{snapshot.pipeline.pipeline_id}@{snapshot.pipeline.pipeline_version}</span></div></div>
        <ol className="prg-pipeline-stages" aria-label={t('progress.orchestration_stage_order')}>
          {snapshot.pipeline.stage_order.map((stageId, index) => {
            const stage = snapshot.pipeline?.stages.find((entry) => entry.stage_id === stageId)
            if (!stage) return <li key={stageId}>{index + 1}. {stageId}</li>
            return <li key={stageId}><span className="prg-stage-index">{index + 1}</span><span className="font-medium text-text">{stage.name}</span><span>{stage.execution_mode}</span><span className="prg-stage-skills">{[...stage.skills].sort((left, right) => left.order - right.order).map((skill) => `${skill.skill_id}@${skill.skill_version}`).join(' → ') || '—'}</span></li>
          })}
        </ol>
      </section>}
      {snapshot && snapshot.work_items.length > 0 && (
        <details className="prg-work-items mt-3" onToggle={(event) => setWorkItemsOpen(event.currentTarget.open)}>
          <summary>{t('progress.orchestration_items')} · {snapshot.work_items.length}</summary>
          {workItemsOpen && <ul className="mt-2 grid gap-2 sm:grid-cols-2" aria-label={t('progress.orchestration_items')}>
          {snapshot.work_items.map((item) => {
            const binding = snapshot.resolution?.bindings.find((entry) => entry.work_item_id === item.work_item_id)
            const latestRun = snapshot.runs.filter((run) => run.work_item_id === item.work_item_id).at(-1)
            return <li key={item.work_item_id} className="prg-work-item rounded-lg border border-border-2 px-3 py-2 text-xs">
              <div className="flex items-center justify-between gap-2"><span className="min-w-0 truncate font-medium text-text">{item.title}</span><span className={`shrink-0 font-semibold ${statusTone[item.status] ?? 'text-text-3'}`}>{item.status}</span></div>
              <div className="mt-1 space-y-0.5 text-text-3">
                <div>{t('progress.orchestration_dependencies')}: {item.depends_on.length === 0 ? '—' : item.depends_on.join(', ')}</div>
                {binding && <div>{t('progress.orchestration_capabilities')}: {binding.skill_id}@{binding.skill_version}{binding.mcp_ids.length > 0 ? ` · ${binding.mcp_ids.join(', ')}` : ''}</div>}
                {item.required_artifact_refs.length > 0 && <div>{t('progress.orchestration_artifacts')}: {item.required_artifact_refs.join(', ')}</div>}
                {latestRun && <div>{t('progress.orchestration_runs')}: {latestRun.status} · {latestRun.attempt_id}</div>}
              </div>
              {!readOnly && ['failed', 'interrupted', 'blocked'].includes(item.status) && <div className="mt-2 flex flex-wrap gap-2"><button type="button" aria-label={`${t('progress.orchestration_retry')}: ${item.title}`} onClick={() => retryItem(item.work_item_id)} disabled={busy} className="rounded border border-border-2 px-2 py-1 text-[11px] hover:bg-fill disabled:opacity-50">{t('progress.orchestration_retry')}</button><button type="button" aria-label={`${t('progress.orchestration_bind_artifact')}: ${item.title}`} onClick={() => bindArtifact(item.work_item_id)} disabled={busy} className="rounded border border-border-2 px-2 py-1 text-[11px] hover:bg-fill disabled:opacity-50">{t('progress.orchestration_bind_artifact')}</button></div>}
              {artifactDraft?.workItemId === item.work_item_id && <form className="mt-2 grid gap-2 rounded-md bg-fill/60 p-2" onSubmit={submitArtifact}><label className="grid gap-1 text-[11px] text-text-2" htmlFor={`artifact-ref-${item.work_item_id}`}>{t('progress.orchestration_artifact_ref')}<input id={`artifact-ref-${item.work_item_id}`} value={artifactDraft.ref} onChange={(event) => setArtifactDraft({ ...artifactDraft, ref: event.target.value })} className="rounded border border-border-2 bg-card px-2 py-1 text-xs text-text" required /></label><label className="grid gap-1 text-[11px] text-text-2" htmlFor={`artifact-digest-${item.work_item_id}`}>{t('progress.orchestration_artifact_digest')}<input id={`artifact-digest-${item.work_item_id}`} value={artifactDraft.digest} onChange={(event) => setArtifactDraft({ ...artifactDraft, digest: event.target.value })} className="rounded border border-border-2 bg-card px-2 py-1 text-xs text-text" placeholder="sha256:…" required /></label><div className="flex gap-2"><button type="submit" disabled={busy} className="rounded border border-(--accent) px-2 py-1 text-[11px] hover:bg-fill disabled:opacity-50">{t('progress.orchestration_artifact_submit')}</button><button type="button" onClick={() => setArtifactDraft(null)} className="rounded border border-border-2 px-2 py-1 text-[11px] hover:bg-fill">{t('progress.orchestration_artifact_cancel')}</button></div></form>}
            </li>
          })}
          </ul>}
        </details>
      )}
      {snapshot && <details className="prg-technical-details mt-3"><summary>{t('progress.orchestration_details')}</summary><div className="mt-2 grid gap-3 text-xs sm:grid-cols-2" data-testid="orchestration-v2-technical-details">
        <section className="rounded-lg border border-border-2 p-3" aria-label={t('progress.orchestration_runs')}><h3 className="font-semibold text-text">{t('progress.orchestration_runs')}</h3>{snapshot.runs.length === 0 ? <p className="mt-1 text-text-3">—</p> : <ul className="mt-1 space-y-1">{snapshot.runs.map((run) => <li key={run.run_id} className="text-text-3">{run.skill_id}@{run.skill_version} · {run.status} · {run.attempt_id}{run.lease ? ` · ${run.lease.status}#${run.lease.generation}` : ''}</li>)}</ul>}</section>
        <section className="rounded-lg border border-border-2 p-3" aria-label={t('progress.orchestration_results')}><h3 className="font-semibold text-text">{t('progress.orchestration_results')}</h3>{snapshot.results.length === 0 ? <p className="mt-1 text-text-3">—</p> : <ul className="mt-1 space-y-1">{snapshot.results.map((result) => <li key={result.result_id} className="text-text-3">{result.status} · {result.contract_status}{result.output_schema_id ? ` · ${result.output_schema_id}` : ''}{result.artifacts.length ? ` · ${result.artifacts.map((artifact) => artifact.ref).join(', ')}` : ''}</li>)}</ul>}</section>
        <section className="rounded-lg border border-border-2 p-3" aria-label={t('progress.orchestration_validations')}><h3 className="font-semibold text-text">{t('progress.orchestration_validations')}</h3>{snapshot.validations.length === 0 ? <p className="mt-1 text-text-3">—</p> : <ul className="mt-1 space-y-1">{snapshot.validations.map((report) => <li key={report.report_id} className="text-text-3">{report.validator_id}@{report.validator_version} · {report.status} · {report.evidence_refs.join(', ') || '—'}</li>)}</ul>}</section>
        <section className="rounded-lg border border-border-2 p-3" aria-label={t('progress.orchestration_gates')}><h3 className="font-semibold text-text">{t('progress.orchestration_gates')}</h3>{snapshot.gates.length === 0 ? <p className="mt-1 text-text-3">—</p> : <ul className="mt-1 space-y-1">{snapshot.gates.map((gate) => <li key={gate.gate_id} className="text-text-3">{gate.kind} · {gate.status} · rev {gate.decision_revision}</li>)}</ul>}</section>
      </div></details>}
      {snapshot && (snapshot.blockers.length > 0 || snapshot.next_actions.length > 0) && <div className="mt-3 grid gap-3 text-xs sm:grid-cols-2"><section aria-label={t('progress.orchestration_blockers')}><h3 className="font-semibold text-text">{t('progress.orchestration_blockers')}</h3><ul className="mt-1 list-disc pl-4 text-red-700 dark:text-red-300">{(snapshot.blockers.length ? snapshot.blockers : ['—']).map((blocker) => <li key={blocker}>{blocker}</li>)}</ul></section><section aria-label={t('progress.orchestration_next_actions')}><h3 className="font-semibold text-text">{t('progress.orchestration_next_actions')}</h3><ul className="mt-1 list-disc pl-4 text-text-3">{snapshot.next_actions.map((next) => <li key={next}>{next}</li>)}</ul></section></div>}
      {events.length > 0 && <p className="mt-3 text-[11px] text-text-3" data-testid="orchestration-v2-event-tail">{t('progress.orchestration_event_tail', { events: events.slice(0, 3).map((event) => `${event.revision} ${event.event_type}`).join(' · ') })}</p>}
    </section>
  )
}
