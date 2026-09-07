import { useEffect, useMemo, useRef, useState } from 'react'
import {
  fetchDefinitionCatalog,
  postAdapterInstall,
  subscribeDefinitionCatalog,
  subscribeAdapterInstall,
  type AdapterInstallState,
  type DefinitionCatalog,
} from '../api/client'
import { formatApiError, formatServerProse } from '../api/transport'
import { useT } from '../i18n'

interface AdapterInstallWizardProps { root: string }
const TERMINAL = new Set(['planned', 'installed', 'failed'])

export function AdapterInstallWizard({ root }: AdapterInstallWizardProps): JSX.Element {
  const { t, lang } = useT()
  const [catalog, setCatalog] = useState<DefinitionCatalog | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [states, setStates] = useState<AdapterInstallState[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const installStop = useRef<(() => void) | null>(null)
  const installGeneration = useRef(0)
  const adapters = useMemo(() => catalog?.adapters ?? [], [catalog])

  useEffect(() => {
    let active = true
    if (root === '') { setCatalog(null); return () => { active = false } }
    setError(null)
    void fetchDefinitionCatalog(root).then((value) => {
      if (active) setCatalog(value)
    }).catch(() => {
      if (active) setError(t('hostPlan.installer.catalog_error'))
    })
    const stop = subscribeDefinitionCatalog(root, (value) => {
      if (active) setCatalog(value)
    }, () => {
      if (active) setError(t('hostPlan.installer.catalog_error'))
    })
    return () => { active = false; stop() }
  }, [root, t])

  // A project switch must detach the old finite install stream before the new
  // project is rendered. Otherwise late events from project A can appear under
  // project B (and keep its install button disabled).
  useEffect(() => {
    const generation = ++installGeneration.current
    installStop.current?.()
    installStop.current = null
    setBusy(false)
    setStates([])
    setSelected([])
    return () => {
      if (installGeneration.current === generation) {
        ++installGeneration.current
        installStop.current?.()
        installStop.current = null
      }
    }
  }, [root])

  useEffect(() => {
    const adaptersById = new Set(adapters.map((adapter) => adapter.id))
    setSelected((current) => current.filter((id) => adaptersById.has(id)))
  }, [adapters])

  const toggle = (id: string): void => {
    setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])
  }

  async function install(dryRun: boolean): Promise<void> {
    if (root === '' || selected.length === 0 || busy) return
    const generation = installGeneration.current
    setBusy(true); setError(null); setStates([])
    try {
      const job = await postAdapterInstall({ root, hosts: selected, dry_run: dryRun, confirm: !dryRun })
      if (generation !== installGeneration.current) return
      let stop: (() => void) | undefined
      const finish = (): void => {
        if (generation !== installGeneration.current) return
        setBusy(false)
        if (installStop.current === stop) installStop.current = null
      }
      stop = subscribeAdapterInstall(
        job.stream,
        (state) => {
          if (generation === installGeneration.current) setStates((current) => [...current, state])
        },
        finish,
        () => {
          if (generation === installGeneration.current) {
            setBusy(false)
            setError(t('hostPlan.installer.stream_error'))
            if (installStop.current === stop) installStop.current = null
          }
        },
      )
      installStop.current = stop
      window.setTimeout(stop, 15 * 60 * 1000)
    } catch (cause) {
      if (generation === installGeneration.current) {
        setBusy(false)
        setError(formatApiError(cause, t) || t('hostPlan.installer.create_error'))
      }
    }
  }

  if (root === '') {
    return <div className="mt-6 rounded-xl border border-dashed border-border-2 bg-card p-5 text-sm text-text-2" data-testid="adapter-install-empty">{t('hostPlan.installer.select_project')}</div>
  }
  return (
    <section className="mt-6 rounded-2xl border border-border bg-card p-5" data-testid="adapter-install-wizard" aria-label={t('hostPlan.installer.title')}>
      <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-[11px] font-bold uppercase tracking-[0.16em] text-(--accent)">{t('hostPlan.installer.eyebrow')}</p><h2 className="mt-1 text-lg font-bold text-text">{t('hostPlan.installer.title')}</h2><p className="mt-1 text-xs leading-5 text-text-3">{t('hostPlan.installer.subtitle')}</p></div><span className="rounded-full border border-border bg-bg px-2 py-1 font-mono text-[10px] text-text-3">{catalog?.revision ?? 'loading'}</span></div>
      {catalog === null ? <p className="mt-4 text-xs text-text-3" role="status">{t('hostPlan.installer.loading')}</p> : <>
        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{adapters.map((adapter) => <label key={adapter.id} className={`cursor-pointer rounded-lg border p-3 transition-[border-color,transform,background-color] duration-200 ${selected.includes(adapter.id) ? 'border-(--accent) bg-accent-t shadow-sm' : 'border-border bg-bg hover:border-border-2'}`}><input className="sr-only" type="checkbox" checked={selected.includes(adapter.id)} onChange={() => toggle(adapter.id)} /><span className="flex items-center justify-between gap-2 text-xs font-bold text-text"><span>{adapter.label}</span><span className="font-mono text-[10px] text-text-3">Tier {adapter.tier}</span></span><span className="mt-1 block text-[10px] text-text-3">{t(`hostPlan.kind.${adapter.kind}`)} · {t(`hostPlan.scope.${adapter.target_scope}`)} · {t(`hostPlan.installer.state.${adapter.state}`)}</span></label>)}</div>
        <div className="mt-4 flex flex-wrap items-center gap-2"><button type="button" className="rounded-lg border border-border-2 bg-bg px-3 py-2 text-xs font-bold text-text hover:bg-fill disabled:opacity-45" disabled={busy || selected.length === 0} onClick={() => void install(true)}>{t('hostPlan.installer.preflight')}</button><button type="button" className="rounded-lg bg-btn-bg px-3 py-2 text-xs font-bold text-btn-fg hover:bg-btn-hover disabled:opacity-45" disabled={busy || selected.length === 0} onClick={() => void install(false)}>{busy ? t('hostPlan.installer.installing') : t('hostPlan.installer.install')}</button>{selected.length > 0 && <span className="text-[11px] text-text-3">{t('hostPlan.installer.selected_count', { count: selected.length })}</span>}</div>
        {error !== null && <p className="mt-3 rounded-lg bg-red-t px-3 py-2 text-xs text-red-d" role="alert">{error}</p>}
        {states.length > 0 && <ol className="mt-4 grid gap-2" aria-live="polite">{states.map((state, index) => { const { message: stateMessage } = state; return <li key={`${state.host}-${state.phase}-${index}`} className={`flex items-center gap-2 rounded-lg border border-border bg-bg px-3 py-2 text-xs ${TERMINAL.has(state.phase) ? '' : 'motion-safe:animate-pulse'}`}><span className="min-w-20 font-mono text-[10px] text-text-3">{state.host}</span><span className="font-semibold text-text">{state.phase}</span><span className="text-text-3">{formatServerProse(stateMessage, t, { exposeServerDetail: lang === 'zh', fallback: state.phase })}</span></li> })}</ol>}
      </>}
    </section>
  )
}
