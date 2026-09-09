import { useEffect, useMemo, useRef, useState } from 'react'
import { Activity, Play, RefreshCw } from 'lucide-react'
import {
  fetchAutomationStarters,
  fetchCadenceStatus,
  fetchLoopsSnapshot,
  postLoopRun,
  postLoopStarterInit,
  postLoopSync,
  postTriage,
  type AutomationStarterTemplate,
  type OperationResponse,
  type WbLoopRow,
  type WbCadenceStatus,
} from '../api/client'
import { formatApiError } from '../api/transport'
import { useT } from '../i18n'
import { OperationsCadenceCard } from './OperationsCadenceCard'
import { OperationSyncCard } from './OperationSyncCard'
import { OperationStarterGallery } from './OperationStarterGallery'
import { OperationTriageCard } from './OperationTriageCard'
import { OperationResultView } from './OperationResultView'
import {
  operationButton as button,
  operationCard as card,
  operationGhost as ghost,
  operationInput as input,
} from './operationsPresentation'
import {
  operationFactsKey,
  useOperationMutationIdentity,
  type OperationMutationKind,
} from './useOperationMutationIdentity'

export interface OperationsPanelProps {
  root: string
  onToast?: (message: string) => void
  /** 结构化 operation 结果里的权威 change 标识，跳转到该 Change / Run 审计现场。 */
  onOpenChange?: (name: string) => void
  /** 缺省展示完整操作面；自动运行工具抽屉传入后只呈现一个真实工具。 */
  activeTool?: OperationTool
  compact?: boolean
}

export type OperationTool = 'cadence' | 'starter' | 'run' | 'sync' | 'triage'

export function OperationsPanel({ root, onToast, onOpenChange, activeTool, compact = false }: OperationsPanelProps): JSX.Element {
  const { lang, t } = useT()
  const [templates, setTemplates] = useState<AutomationStarterTemplate[]>([])
  const [loops, setLoops] = useState<WbLoopRow[]>([])
  const [cadence, setCadence] = useState<WbCadenceStatus | null>(null)
  const [loadError, setLoadError] = useState<unknown | null>(null)
  const [loading, setLoading] = useState(false)
  const [selectedTemplate, setSelectedTemplate] = useState('')
  const [loopId, setLoopId] = useState('')
  const [runner, setRunner] = useState('codex')
  const [workflow, setWorkflow] = useState('default')
  const [skillBundle, setSkillBundle] = useState('')
  const [selector, setSelector] = useState('')
  const [runLevel, setRunLevel] = useState<'L1' | 'L2' | 'L3'>('L1')
  const [runReal, setRunReal] = useState(false)
  const [runCommit, setRunCommit] = useState(false)
  const [confirmedRunKey, setConfirmedRunKey] = useState<string | null>(null)
  const [confirmedL3Key, setConfirmedL3Key] = useState<string | null>(null)
  const [syncMode, setSyncMode] = useState<'dry-run' | 'apply'>('dry-run')
  const [confirmedSyncKey, setConfirmedSyncKey] = useState<string | null>(null)
  const [triageSource, setTriageSource] = useState<'git-commits' | 'loop-run-terminals'>('git-commits')
  const [triageModel, setTriageModel] = useState('')
  const [confirmedTriageKey, setConfirmedTriageKey] = useState<string | null>(null)
  const [result, setResult] = useState<OperationResponse | null>(null)
  const [operationError, setOperationError] = useState<unknown | null>(null)
  const [loadedRoot, setLoadedRoot] = useState<string | null>(null)
  const loadGeneration = useRef(0)
  const loadingRoot = useRef<string | null>(null)
  const currentRoot = useRef(root)
  currentRoot.current = root
  const localeIdentity = useRef({ t, lang })
  localeIdentity.current = { t, lang }

  const clearRootScopedState = (): void => {
    setTemplates([])
    setLoops([])
    setCadence(null)
    setSelectedTemplate('')
    setLoopId('')
    setRunner('codex')
    setWorkflow('default')
    setSkillBundle('')
    setSelector('')
    setRunLevel('L1')
    setRunReal(false)
    setRunCommit(false)
    setConfirmedRunKey(null)
    setConfirmedL3Key(null)
    setSyncMode('dry-run')
    setConfirmedSyncKey(null)
    setTriageSource('git-commits')
    setTriageModel('')
    setConfirmedTriageKey(null)
    setResult(null)
    setOperationError(null)
    setLoadedRoot(null)
  }

  const reload = (): void => {
    const targetRoot = root
    if (loadingRoot.current === targetRoot) return
    const generation = ++loadGeneration.current
    loadingRoot.current = targetRoot
    setLoading(true)
    setLoadError(null)
    void Promise.all([fetchAutomationStarters(targetRoot), fetchLoopsSnapshot(), fetchCadenceStatus(targetRoot)])
      .then(([nextTemplates, loopSnapshot, cadenceStatus]) => {
        if (generation !== loadGeneration.current || currentRoot.current !== targetRoot) return
        const nextLoops = loopSnapshot.rows.filter((loop) => loop.root === targetRoot)
        setTemplates(nextTemplates)
        setLoops(nextLoops)
        setCadence(cadenceStatus)
        setSelectedTemplate((current) => nextTemplates.some((item) => item.id === current) ? current : nextTemplates[0]?.id || '')
        setSelector((current) => nextLoops.some((item) => item.id === current) ? current : nextLoops[0]?.id || '')
        setLoadedRoot(targetRoot)
      })
      .catch((error: unknown) => {
        if (generation === loadGeneration.current && currentRoot.current === targetRoot) {
          setLoadError(error)
        }
      })
      .finally(() => {
        if (generation === loadGeneration.current && currentRoot.current === targetRoot) {
          loadingRoot.current = null
          setLoading(false)
        }
      })
  }

  useEffect(() => {
    operationMutation.invalidate()
    loadingRoot.current = null
    setLoading(false)
    clearRootScopedState()
    reload()
    return () => {
      ++loadGeneration.current
      operationMutation.abandon()
    }
  }, [root])

  useEffect(() => {
    const loop = loops.find((item) => item.id === selector)
    if (loop && loop.autonomy_level !== runLevel) {
      invalidateOperation()
      setRunLevel(loop.autonomy_level)
      setConfirmedRunKey(null)
      setConfirmedL3Key(null)
    }
  }, [selector, loops])

  const template = useMemo(
    () => templates.find((item) => item.id === selectedTemplate) ?? null,
    [templates, selectedTemplate],
  )
  const runDecisionKey = operationFactsKey('run', {
    root,
    selector,
    level: runLevel,
    real: runReal,
    commit: runCommit,
  })
  const syncDecisionKey = operationFactsKey('sync', { root, selector, mode: syncMode })
  const triageDecisionKey = operationFactsKey('triage', {
    root,
    source: triageSource,
    model: triageModel,
  })
  const confirmRun = confirmedRunKey === runDecisionKey
  const confirmL3 = confirmedL3Key === runDecisionKey
  const confirmSync = confirmedSyncKey === syncDecisionKey
  const confirmTriage = confirmedTriageKey === triageDecisionKey
  const operationMutation = useOperationMutationIdentity({
    init: operationFactsKey('init', {
      root,
      id: loopId,
      template: template?.id ?? '',
      workflow,
      skill_bundle: skillBundle,
      runner,
      goal: template?.goal ?? '',
    }),
    run: operationFactsKey('run', { root, selector, dry_run: !runReal, level: runLevel, commit: runCommit }),
    sync: operationFactsKey('sync', { root, loop_id: selector, mode: syncMode }),
    triage: operationFactsKey('triage', { root, source: triageSource, model: triageModel }),
  })
  const busy = operationMutation.busy

  function invalidateOperation(): void {
    operationMutation.invalidate()
    setResult(null)
    setOperationError(null)
  }

  async function perform(
    kind: OperationMutationKind,
    request: Record<string, unknown>,
    action: (input: Record<string, unknown>) => Promise<OperationResponse>,
    refresh = false,
  ): Promise<void> {
    const identity = operationMutation.begin(kind, request)
    setOperationError(null)
    setResult(null)
    try {
      const response = await action(request)
      if (!operationMutation.isCurrent(identity)) return
      setResult(response)
      if (response.ok) {
        onToast?.(localeIdentity.current.t('operations.completed'))
        if (refresh) reload()
      }
    } catch (error) {
      if (operationMutation.isCurrent(identity)) {
        setOperationError(error)
      }
    } finally {
      operationMutation.finish(identity)
    }
  }

  const rootReady = loadedRoot === root
  const realRunReady = !runReal || (confirmRun && (runLevel !== 'L3' || confirmL3))
  const shows = (tool: OperationTool): boolean => activeTool === undefined || activeTool === tool
  const compactToolEmpty = compact && rootReady && (
    (activeTool === 'starter' && templates.length === 0)
    || ((activeTool === 'run' || activeTool === 'sync') && loops.length === 0)
  )
  const compactToolEmptyMessage = activeTool === 'starter'
    ? t('operations.empty_starters')
    : t('operations.empty_loops')

  return (
    <section className={compact ? 'bg-card' : 'mb-5 rounded-md border border-border bg-card p-4'} data-testid="operations-panel" data-tool={activeTool}>
      {!compact && <header className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-text"><Activity size={17} aria-hidden="true" /><h2 className="text-base font-bold">{t('operations.title')}</h2></div>
          <p className="mt-1 text-caption text-text-3">{t('operations.subtitle')}</p>
        </div>
        <button type="button" className={ghost} onClick={reload} disabled={loading || busy !== null} data-testid="ops-refresh">
          <RefreshCw className="mr-1.5 inline size-3.5" aria-hidden="true" />{t('operations.refresh')}
        </button>
      </header>}

      {loadError !== null && <div role="alert" className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-red-b bg-red-t px-3 py-2 text-caption text-red-d">
        <span>{formatApiError(loadError, t, { exposeServerDetail: lang === 'zh' })}</span>
        {compact && <button type="button" className={ghost} onClick={reload} disabled={loading || busy !== null} data-testid="ops-compact-retry"><RefreshCw className="mr-1.5 inline size-3.5" aria-hidden="true" />{t('operations.refresh')}</button>}
      </div>}
      {loading && <p role="status" aria-live="polite" data-testid="ops-loading" className="mb-3 rounded-md border border-border bg-fill px-3 py-2 text-caption text-text-3">{t('operations.loading')}</p>}
      {!compact && !loading && loadError === null && rootReady && templates.length === 0 && loops.length === 0 && (
        <p role="status" aria-live="polite" data-testid="ops-empty" className="mb-3 rounded-md border border-border bg-fill px-3 py-2 text-caption text-text-3">{t('operations.empty')}</p>
      )}
      {!loading && loadError === null && compactToolEmpty && (
        <p role="status" aria-live="polite" data-testid="ops-tool-empty" className="mb-3 rounded-md border border-border bg-fill px-3 py-2 text-caption text-text-3">{compactToolEmptyMessage}</p>
      )}

      <div className={`grid gap-3 ${compact ? 'grid-cols-1' : 'lg:grid-cols-2'}`}>
        {shows('cadence') && <OperationsCadenceCard cadence={cadence} compact={compact} />}

        {shows('starter') && !(compact && compactToolEmpty) && <article className={card}>
          <OperationStarterGallery templates={templates} selected={selectedTemplate} onSelect={(id) => { invalidateOperation(); setSelectedTemplate(id) }} />
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <label className="text-caption font-semibold text-text-2">{t('operations.loop_id')}<input className={`${input} mt-1`} data-testid="ops-loop-id" name="loop-id" autoComplete="off" value={loopId} onChange={(event) => {
              invalidateOperation()
              setLoopId(event.target.value)
            }} placeholder={t('operations.loop_id_placeholder')} /><span className="mt-1 block text-micro font-normal text-text-3">{t('operations.loop_id_help')}</span></label>
            <label className="text-caption font-semibold text-text-2">{t('operations.skill_bundle')}<input className={`${input} mt-1`} data-testid="ops-skill-bundle" name="skill-bundle" autoComplete="off" value={skillBundle} onChange={(event) => {
              invalidateOperation()
              setSkillBundle(event.target.value)
            }} placeholder={t('operations.skill_bundle_placeholder')} /><span className="mt-1 block text-micro font-normal text-text-3">{t('operations.skill_bundle_help')}</span></label>
            <label className="text-caption font-semibold text-text-2">{t('operations.workflow')}<input className={`${input} mt-1`} name="workflow" autoComplete="off" value={workflow} onChange={(event) => {
              invalidateOperation()
              setWorkflow(event.target.value)
            }} /><span className="mt-1 block text-micro font-normal text-text-3">{t('operations.workflow_help')}</span></label>
            <label className="text-caption font-semibold text-text-2">{t('operations.runner')}<select className={`${input} mt-1`} data-testid="ops-runner" value={runner} onChange={(event) => {
              invalidateOperation()
              setRunner(event.target.value)
            }}><option value="codex">Codex</option><option value="claude-code">Claude Code</option></select><span className="mt-1 block text-micro font-normal text-text-3">{t('operations.runner_help')}</span></label>
          </div>
          <button
            type="button"
            className={`${button} mt-3`}
            data-testid="ops-create-loop"
            disabled={!rootReady || busy !== null || template === null || !/^[a-z][a-z0-9-]{1,63}$/.test(loopId)}
            onClick={() => {
              if (template === null) return
              const request = {
                root, id: loopId, template: template.id, workflow, skill_bundle: skillBundle,
                runner, goal: template.goal,
              }
              void perform('init', request, postLoopStarterInit, true)
            }}
          >{busy === 'init' ? t('operations.running') : t('operations.create_draft')}</button>
        </article>}

        {shows('run') && !(compact && compactToolEmpty) && <article className={card}>
          <div className="flex items-center gap-2"><Play size={15} aria-hidden="true" /><h3 className="font-bold text-text">{t('operations.run_title')}</h3></div>
          <p className="mt-1 text-caption leading-5 text-text-3">{t('operations.run_note')}</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <label className="text-caption font-semibold text-text-2">{t('operations.run_loop')}<select className={`${input} mt-1`} data-testid="ops-loop-selector" value={selector} onChange={(event) => {
              invalidateOperation()
              setSelector(event.target.value)
              setConfirmedRunKey(null)
              setConfirmedL3Key(null)
              setConfirmedSyncKey(null)
            }}>{loops.map((loop) => <option key={loop.id} value={loop.id}>{loop.id} · {loop.status}</option>)}</select><span className="mt-1 block text-micro font-normal text-text-3">{t('operations.run_loop_help')}</span></label>
            <label className="text-caption font-semibold text-text-2">{t('operations.run_permission')}<select className={`${input} mt-1`} data-testid="ops-run-level" value={runLevel} onChange={(event) => {
              invalidateOperation()
              const level = event.target.value
              if (level !== 'L1' && level !== 'L2' && level !== 'L3') return
              setRunLevel(level)
              setConfirmedRunKey(null)
              setConfirmedL3Key(null)
            }}><option value="L1">{t('operations.run_permission_l1')}</option><option value="L2">{t('operations.run_permission_l2')}</option><option value="L3">{t('operations.run_permission_l3')}</option></select><span className="mt-1 block text-micro font-normal text-text-3">{t('operations.run_permission_help')}</span></label>
          </div>
          <div className="mt-3 flex flex-wrap gap-3 text-caption text-text-2">
            <label><input type="checkbox" data-testid="ops-run-real" checked={runReal} onChange={(event) => {
              invalidateOperation()
              setRunReal(event.target.checked)
              setConfirmedRunKey(null)
              setConfirmedL3Key(null)
            }} /> {t('operations.real_run')}</label>
            {runReal && <label><input type="checkbox" data-testid="ops-confirm-run" checked={confirmRun} onChange={(event) => {
              invalidateOperation()
              setConfirmedRunKey(event.target.checked ? runDecisionKey : null)
            }} /> {t('operations.confirm_run')}</label>}
            {runReal && runLevel === 'L3' && <label><input type="checkbox" data-testid="ops-confirm-l3" checked={confirmL3} onChange={(event) => {
              invalidateOperation()
              setConfirmedL3Key(event.target.checked ? runDecisionKey : null)
            }} /> {t('operations.confirm_l3')}</label>}
            {runReal && <label><input type="checkbox" data-testid="ops-run-commit" checked={runCommit} onChange={(event) => {
              invalidateOperation()
              setRunCommit(event.target.checked)
              setConfirmedRunKey(null)
              setConfirmedL3Key(null)
            }} /> {t('operations.commit')}</label>}
          </div>
          <button type="button" className={`${button} mt-3`} data-testid="ops-run-submit" disabled={!rootReady || busy !== null || selector === '' || !loops.some((loop) => loop.id === selector) || !realRunReady} onClick={() => {
            const request = { root, selector, dry_run: !runReal, level: runLevel, commit: runCommit, confirm_run: confirmRun, confirm_l3: confirmL3 }
            setConfirmedRunKey(null)
            setConfirmedL3Key(null)
            void perform('run', request, postLoopRun)
          }}>{busy === 'run' ? t('operations.running') : runReal ? t('operations.run_now') : t('operations.preview')}</button>
        </article>}

        {shows('sync') && !(compact && compactToolEmpty) && <OperationSyncCard
          rootReady={rootReady} busy={busy} selectorReady={selector !== '' && loops.some((loop) => loop.id === selector)}
          mode={syncMode} confirmed={confirmSync}
          onModeChange={(mode) => { invalidateOperation(); setSyncMode(mode); setConfirmedSyncKey(null) }}
          onConfirmChange={(confirmed) => { invalidateOperation(); setConfirmedSyncKey(confirmed ? syncDecisionKey : null) }}
          onSubmit={() => {
            const request = { root, loop_id: selector, mode: syncMode, confirm_apply: confirmSync }
            setConfirmedSyncKey(null)
            void perform('sync', request, postLoopSync)
          }}
        />}

        {shows('triage') && <OperationTriageCard
          rootReady={rootReady} busy={busy} source={triageSource} model={triageModel} confirmed={confirmTriage}
          onSourceChange={(source) => { invalidateOperation(); setTriageSource(source); setConfirmedTriageKey(null) }}
          onModelChange={(model) => { invalidateOperation(); setTriageModel(model); setConfirmedTriageKey(null) }}
          onConfirmChange={(confirmed) => { invalidateOperation(); setConfirmedTriageKey(confirmed ? triageDecisionKey : null) }}
          onSubmit={() => {
            const request = { root, source: triageSource, model: triageModel, confirm_apply: confirmTriage }
            setConfirmedTriageKey(null)
            void perform('triage', request, postTriage)
          }}
        />}
      </div>

      {operationError !== null && <p role="alert" data-testid="ops-operation-error" className="mt-3 rounded-md border border-red-b bg-red-t px-3 py-2 text-caption text-red-d">{formatApiError(operationError, t, { exposeServerDetail: lang === 'zh' })}</p>}
      {result && <OperationResultView response={result} onOpenChange={onOpenChange} />}
    </section>
  )
}
