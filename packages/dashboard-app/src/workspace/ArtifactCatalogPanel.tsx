import { useEffect, useState } from 'react'
import { fetchArtifactCatalog, fetchArtifactContent, fetchArtifactSubjectRegistry, type ArtifactCatalog, type ArtifactSubjectRegistry, type ArtifactVersion } from '../api/artifactClient'
import { ApiError, formatApiError } from '../api/transport'
import { useT } from '../i18n'

export interface ArtifactCatalogPanelProps {
  root: string
  change?: string
  stageAttemptId?: string
  stageId?: string
  includeCandidates?: boolean
  historyReference?: { readonly workflowRunId?: string; readonly stageAttemptId: string; readonly startedAt?: string; readonly lineageSource?: 'legacy' }
}

function label(v: ArtifactVersion): string { return v.source?.path ?? v.artifactId }
function tone(v: ArtifactVersion): string { return v.disposition === 'deliverable' ? 'text-emerald-700' : v.disposition === 'candidate' ? 'text-amber-700' : 'text-text-2' }
function metadata(v: ArtifactVersion): string {
  const parts = [v.quality, `${v.size} B`, v.projectionKind, v.declarationStatus, v.consumed ? 'consumed' : undefined, v.pendingUpdate ? 'pending update' : undefined, v.affected ? 'affected' : undefined, v.availableFromStage ? `from ${v.availableFromStage}` : undefined]
  return parts.filter((part): part is string => part !== undefined).join(' · ')
}

/** Runtime artifact view. It reads real catalog entries and never creates execution receipts. */
export function ArtifactCatalogPanel({ root, change, stageAttemptId, stageId, includeCandidates = false, historyReference }: ArtifactCatalogPanelProps): JSX.Element {
  const { t } = useT()
  const [catalog, setCatalog] = useState<ArtifactCatalog | null>(null)
  const [subjects, setSubjects] = useState<ArtifactSubjectRegistry | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<ArtifactVersion | null>(null)
  const [content, setContent] = useState<string | null>(null)
  useEffect(() => { let active = true; setError(null); setCatalog(null); if (!stageAttemptId && !stageId) return () => { active = false }; const load = (): void => { void Promise.all([fetchArtifactCatalog(root, stageAttemptId, { includeCandidates, includeHistory: true, ...(stageId ? { stageId } : {}), ...(change ? { change } : {}) }), fetchArtifactSubjectRegistry(root, change).catch(() => null)]).then(([catalogValue, subjectValue]) => { if (!active) return; setCatalog(catalogValue); setSubjects(subjectValue) }).catch((e: unknown) => { if (!active) return; if (e instanceof ApiError && (e.status === 400 || e.status === 404) && !stageAttemptId) { setCatalog({ revision: 0, digest: '', stageAttemptId: '', entries: [] }); setError(null); return } setError(formatApiError(e, t)) }) }; load(); const timer = window.setInterval(load, 5000); return () => { active = false; window.clearInterval(timer) } }, [root, change, stageAttemptId, stageId, includeCandidates, t])
  async function open(v: ArtifactVersion): Promise<void> { setSelected(v); setContent(null); try { const result = await fetchArtifactContent(root, catalog?.stageAttemptId ?? stageAttemptId ?? '', v.artifactId, v.version, undefined, change); if (result.bytes && result.encoding === 'base64') { const binary = atob(result.bytes); const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0)); setContent(new TextDecoder().decode(bytes)) } } catch (e) { setError(formatApiError(e, t)) } }
  if (error) return <section className="rounded-md border border-border p-4 text-sm text-red-d" role="alert">{error}</section>
  if (!catalog) return <section className="rounded-md border border-border p-4 text-sm text-text-3" role="status">{t('workspace.runtime_artifacts_loading')}</section>
  const grouped = catalog.entries.reduce<Record<string, ArtifactVersion[]>>((groups, entry) => { const key = entry.subjectId ?? entry.artifactId; (groups[key] ??= []).push(entry); return groups }, {})
  return <section className="grid gap-3" data-testid="runtime-artifacts">
    <header className="flex items-baseline justify-between"><h2 className="text-title font-semibold text-text">{t('workspace.runtime_artifacts_title')}</h2><span className="font-mono text-caption text-text-3">{catalog.entries.length} · r{catalog.revision}</span></header>
    {historyReference && <div className="rounded-md border border-border bg-card px-3 py-2 text-xs text-text-2" data-testid="runtime-artifacts-history-reference"><strong>{historyReference.lineageSource === 'legacy' ? t('workflow.runtime_artifacts_legacy_lineage') : t('workflow.runtime_artifacts_history_reference')}</strong><span className="ml-2">{historyReference.workflowRunId && historyReference.startedAt ? t('workflow.runtime_artifacts_history_detail', { attempt: historyReference.stageAttemptId, run: historyReference.workflowRunId, date: historyReference.startedAt }) : t('workflow.runtime_artifacts_provenance_unavailable')}</span></div>}
    {subjects && subjects.records.length > 0 && <div className="rounded-md border border-border bg-card px-3 py-2 text-xs text-text-3">subject projections · {subjects.records.length} · {subjects.records.map((record) => `${record.projection}:${record.status}`).join(' · ')}</div>}
    {catalog.entries.length === 0 ? <p className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-text-3">{t('workspace.runtime_artifacts_empty')}</p> : <ul className="grid gap-3">{Object.entries(grouped).map(([subjectId, entries]) => <li key={subjectId} className="grid gap-2"><div className="font-mono text-[11px] text-text-3">subject · {subjectId}</div><ul className="grid gap-2">{entries.map((v) => <li key={`${v.artifactId}:${v.version}`}><button type="button" className="grid w-full grid-cols-[minmax(0,1fr)_auto] gap-2 rounded-md border border-border bg-card px-3 py-2 text-left hover:border-accent-b" onClick={() => void open(v)}><span className="min-w-0"><span className="block truncate font-mono text-sm text-text">{label(v)}<span className="ml-2 text-xs text-text-3">{v.version}</span></span><span className="block truncate text-[11px] text-text-3">{metadata(v)}</span></span><span className={`text-xs ${tone(v)}`}>{v.disposition}{v.pendingUpdate ? ' · pending update' : ''}{v.affected ? ` · ${t('workspace.runtime_artifacts_affected')}` : ''}</span></button></li>)}</ul></li>)}</ul>}
    {selected && <div className="rounded-md border border-border bg-card p-3" data-testid="artifact-preview"><div className="mb-2 flex justify-between text-xs text-text-2"><span>{label(selected)} · {selected.version}</span><button type="button" className="underline" onClick={() => setSelected(null)}>{t('detail.close')}</button></div>{content === null ? <p className="text-sm text-text-3">{t('workspace.runtime_artifacts_reading')}</p> : <pre className="max-h-72 overflow-auto whitespace-pre-wrap text-xs text-text">{content}</pre>}</div>}
  </section>
}
