import { useEffect, useState } from 'react'
import { fetchArtifactCatalog, fetchArtifactContent, type ArtifactCatalog, type ArtifactVersion } from '../api/artifactClient'
import { ApiError } from '../api/transport'

export interface ArtifactCatalogPanelProps { root: string; change?: string; stageAttemptId?: string; stageId?: string; includeCandidates?: boolean }

function label(v: ArtifactVersion): string { return v.source?.path ?? v.artifactId }
function tone(v: ArtifactVersion): string { return v.disposition === 'deliverable' ? 'text-emerald-700' : v.disposition === 'candidate' ? 'text-amber-700' : 'text-text-2' }

/** Runtime artifact view. It reads real catalog entries and never creates execution receipts. */
export function ArtifactCatalogPanel({ root, change, stageAttemptId, stageId, includeCandidates = true }: ArtifactCatalogPanelProps): JSX.Element {
  const [catalog, setCatalog] = useState<ArtifactCatalog | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<ArtifactVersion | null>(null)
  const [content, setContent] = useState<string | null>(null)
  useEffect(() => { let active = true; setError(null); const load = (): void => { void fetchArtifactCatalog(root, stageAttemptId, { includeCandidates, includeHistory: true, ...(stageId ? { stageId } : {}), ...(change ? { change } : {}) }).then((v) => { if (active) setCatalog(v) }).catch((e: unknown) => { if (!active) return; if (e instanceof ApiError && (e.status === 400 || e.status === 404) && !stageAttemptId) { setCatalog({ revision: 0, digest: '', stageAttemptId: '', entries: [] }); setError(null); return } setError(e instanceof Error ? e.message : String(e)) }) }; load(); const timer = window.setInterval(load, 5000); return () => { active = false; window.clearInterval(timer) } }, [root, change, stageAttemptId, stageId, includeCandidates])
  async function open(v: ArtifactVersion): Promise<void> { setSelected(v); setContent(null); try { const result = await fetchArtifactContent(root, catalog?.stageAttemptId ?? stageAttemptId ?? '', v.artifactId, v.version, undefined, change); if (result.bytes && result.encoding === 'base64') { const binary = atob(result.bytes); const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0)); setContent(new TextDecoder().decode(bytes)) } } catch (e) { setError(e instanceof Error ? e.message : String(e)) } }
  if (error) return <section className="rounded-md border border-border p-4 text-sm text-red-d" role="alert">{error}</section>
  if (!catalog) return <section className="rounded-md border border-border p-4 text-sm text-text-3" role="status">加载运行时产物…</section>
  return <section className="grid gap-3" data-testid="runtime-artifacts">
    <header className="flex items-baseline justify-between"><h2 className="text-title font-semibold text-text">运行时产物</h2><span className="font-mono text-caption text-text-3">{catalog.entries.length} · r{catalog.revision}</span></header>
    {catalog.entries.length === 0 ? <p className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-text-3">执行后登记产物</p> : <ul className="grid gap-2">{catalog.entries.map((v) => <li key={`${v.artifactId}:${v.version}`}><button type="button" className="grid w-full grid-cols-[minmax(0,1fr)_auto] gap-2 rounded-md border border-border bg-card px-3 py-2 text-left hover:border-accent-b" onClick={() => void open(v)}><span className="min-w-0 truncate font-mono text-sm text-text">{label(v)}<span className="ml-2 text-xs text-text-3">{v.version}</span></span><span className={`text-xs ${tone(v)}`}>{v.disposition}{v.affected ? ' · 需复核' : ''}</span></button></li>)}</ul>}
    {selected && <div className="rounded-md border border-border bg-card p-3" data-testid="artifact-preview"><div className="mb-2 flex justify-between text-xs text-text-2"><span>{label(selected)} · {selected.version}</span><button type="button" className="underline" onClick={() => setSelected(null)}>关闭</button></div>{content === null ? <p className="text-sm text-text-3">读取内容…</p> : <pre className="max-h-72 overflow-auto whitespace-pre-wrap text-xs text-text">{content}</pre>}</div>}
  </section>
}
