import { useCallback, useEffect, useRef, useState } from 'react'
import {
  fetchHostTargetDetection,
  fetchHostTargetPlan,
  fetchHostTargets,
  HostTargetPlanClientError,
} from '../api/hostTargetPlanClient'
import type {
  HostId,
  HostOperation,
  HostTarget,
  HostTargetCatalog,
  HostTargetDetection,
  HostTargetPlan,
} from '../api/hostTargetPlanTypes'
import { useT } from '../i18n'
import { BUTTON_GHOST } from '../shared/uiRecipes'
import {
  HostOperationPlanPanel,
  type HostPlanRequestState,
} from './HostOperationPlanPanel'

interface HostTargetPlanViewProps {
  root?: string
  loadTargets?: (signal: AbortSignal) => Promise<HostTargetCatalog>
  loadDetection?: (signal: AbortSignal) => Promise<HostTargetDetection>
  loadPlan?: (
    host: HostId,
    operation: HostOperation,
    signal: AbortSignal,
  ) => Promise<HostTargetPlan>
  copyText?: (text: string) => Promise<void>
}

type CatalogState =
  | { status: 'loading' }
  | { status: 'error'; error: unknown }
  | { status: 'ready'; catalog: HostTargetCatalog }

type DetectionState =
  | { status: 'loading' }
  | { status: 'unavailable'; error: unknown }
  | { status: 'ready'; detection: HostTargetDetection }

const HOST_NAMES: Record<string, string> = {
  codex: 'Codex',
  claude: 'Claude',
  cursor: 'Cursor',
  gemini: 'Gemini',
  copilot: 'GitHub Copilot',
  pi: 'Pi',
  devin: 'Devin',
  zed: 'Zed',
  aider: 'Aider',
  continue: 'Continue',
  cline: 'Cline',
  amp: 'Amp',
}

function hostName(target: HostTarget): string {
  return HOST_NAMES[target.id] ?? target.id
}

function localizedError(
  error: unknown,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  if (!(error instanceof HostTargetPlanClientError)) return t('hostPlan.errors.unknown')
  switch (error.code) {
    case 'HOST_TARGET_NETWORK_ERROR':
      return t('hostPlan.errors.network')
    case 'HOST_TARGET_QUERY_INVALID':
      return t('hostPlan.errors.query_invalid')
    case 'HOST_TARGET_PLAN_UNAVAILABLE':
      return t('hostPlan.errors.unavailable')
    case 'HOST_TARGET_PLAN_INVALID':
      return t('hostPlan.errors.upstream_invalid')
    case 'HOST_TARGET_CATALOG_RESPONSE_INVALID':
      return t('hostPlan.errors.catalog_invalid')
    case 'HOST_TARGET_DETECTION_RESPONSE_INVALID':
      return t('hostPlan.errors.detection_invalid')
    case 'HOST_TARGET_PLAN_RESPONSE_INVALID':
      return t('hostPlan.errors.plan_invalid')
    case 'HOST_TARGET_PLAN_REQUEST_MISMATCH':
      return t('hostPlan.errors.mismatch')
    case 'HOST_TARGET_HTTP_ERROR':
      return t('hostPlan.errors.http', { status: error.status ?? 'unknown' })
  }
}

export function HostTargetPlanView({
  loadTargets = fetchHostTargets,
  loadDetection = fetchHostTargetDetection,
  loadPlan = fetchHostTargetPlan,
  copyText = async (text) => navigator.clipboard.writeText(text),
}: HostTargetPlanViewProps): JSX.Element {
  const { t } = useT()
  const [catalogState, setCatalogState] = useState<CatalogState>({ status: 'loading' })
  const [detectionState, setDetectionState] = useState<DetectionState>({ status: 'loading' })
  const [selectedHost, setSelectedHost] = useState<HostId | null>(null)
  const [selectedOperation, setSelectedOperation] = useState<HostOperation | null>(null)
  const [planState, setPlanState] = useState<HostPlanRequestState>({ status: 'idle' })
  const bootstrapSequence = useRef(0)
  const planSequence = useRef(0)
  const bootstrapController = useRef<AbortController | null>(null)
  const planController = useRef<AbortController | null>(null)
  const detailRef = useRef<HTMLDivElement>(null)

  const refreshCatalog = useCallback(() => {
    bootstrapController.current?.abort()
    planController.current?.abort()
    const controller = new AbortController()
    bootstrapController.current = controller
    const sequence = bootstrapSequence.current + 1
    bootstrapSequence.current = sequence
    planSequence.current += 1
    setSelectedHost(null)
    setSelectedOperation(null)
    setPlanState({ status: 'idle' })
    setCatalogState({ status: 'loading' })
    setDetectionState({ status: 'loading' })
    const catalogRequest = loadTargets(controller.signal).then(
      (catalog) => {
        if (bootstrapSequence.current === sequence) setCatalogState({ status: 'ready', catalog })
      },
      (error: unknown) => {
        if (bootstrapSequence.current === sequence) {
          setCatalogState({
            status: 'error',
            error,
          })
        }
      },
    )
    const detectionRequest = loadDetection(controller.signal).then(
      (detection) => {
        if (bootstrapSequence.current === sequence) setDetectionState({ status: 'ready', detection })
      },
      (error: unknown) => {
        if (bootstrapSequence.current === sequence) {
          setDetectionState({ status: 'unavailable', error })
        }
      },
    )
    void Promise.allSettled([catalogRequest, detectionRequest]).finally(() => {
      if (bootstrapController.current === controller) bootstrapController.current = null
    })
  }, [loadDetection, loadTargets])

  useEffect(() => {
    refreshCatalog()
    return () => {
      bootstrapController.current?.abort()
      bootstrapController.current = null
      planController.current?.abort()
      planController.current = null
      bootstrapSequence.current += 1
      planSequence.current += 1
    }
  }, [refreshCatalog])

  const selectHost = (host: HostId): void => {
    planController.current?.abort()
    planController.current = null
    planSequence.current += 1
    setSelectedHost(host)
    setSelectedOperation(null)
    setPlanState({ status: 'idle' })
    if (window.matchMedia?.('(max-width: 899px)').matches) {
      requestAnimationFrame(() => {
        detailRef.current?.scrollIntoView({ block: 'start' })
        detailRef.current?.focus({ preventScroll: true })
      })
    }
  }

  const requestPlan = useCallback((host: HostId, operation: HostOperation): void => {
    planController.current?.abort()
    const controller = new AbortController()
    planController.current = controller
    const sequence = planSequence.current + 1
    planSequence.current = sequence
    setSelectedHost(host)
    setSelectedOperation(operation)
    setPlanState({ status: 'loading' })
    void loadPlan(host, operation, controller.signal).then(
      (plan) => {
        if (planSequence.current === sequence) setPlanState({ status: 'ready', plan })
      },
      (error: unknown) => {
        if (planSequence.current === sequence) {
          setPlanState({
            status: 'error',
            error,
          })
        }
      },
    ).finally(() => {
      if (planController.current === controller) planController.current = null
    })
  }, [loadPlan])

  useEffect(() => {
    if (catalogState.status !== 'ready'
      || detectionState.status !== 'ready'
      || selectedHost !== null) return
    const { recommended_host: host, recommended_operation: operation } = detectionState.detection
    if (host === null || operation === null) return
    const target = catalogState.catalog.targets.find((candidate) => candidate.id === host)
    if (target === undefined || !target.supported_operations.includes(operation)) return
    requestPlan(host, operation)
  }, [catalogState, detectionState, requestPlan, selectedHost])
  const selectedTarget = catalogState.status === 'ready'
    ? catalogState.catalog.targets.find((target) => target.id === selectedHost) ?? null
    : null

  return (
    <section className="mx-auto w-full max-w-[1120px] py-5" data-testid="host-plan-view">
      <header>
        <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-(--accent)">
          {t('hostPlan.eyebrow')}
        </p>
        <h1 className="mt-1 text-2xl font-bold text-text">{t('hostPlan.title')}</h1>
        <p className="mt-2 max-w-3xl text-[13px] leading-6 text-text-2">{t('hostPlan.subtitle')}</p>
      </header>

      {catalogState.status === 'loading' ? (
        <p className="mt-8 text-sm text-text-3" role="status">{t('hostPlan.catalog_loading')}</p>
      ) : catalogState.status === 'error' ? (
          <div className="mt-8 rounded-2xl border border-red-b bg-red-t p-5 text-red-d" role="alert">
            <p className="break-words text-sm">{localizedError(catalogState.error, t)}</p>
            <button
              type="button"
              className={`${BUTTON_GHOST} mt-4 border-red-b bg-card text-red-d hover:border-red-b hover:bg-red-t`}
              onClick={refreshCatalog}
            >
              {t('hostPlan.catalog_retry')}
          </button>
        </div>
      ) : catalogState.catalog.targets.length === 0 ? (
        <div
          className="mt-8 rounded-2xl border border-dashed border-border-2 bg-card p-6 text-sm text-text-2"
          data-testid="host-plan-empty"
          role="status"
        >
          <p>{t('hostPlan.catalog_empty')}</p>
          <button
            type="button"
            className={`${BUTTON_GHOST} mt-4`}
            onClick={refreshCatalog}
          >
            {t('hostPlan.catalog_retry')}
          </button>
        </div>
      ) : (
        <>
          <div
            className="mt-6 rounded-xl border border-border bg-card px-4 py-3 text-sm text-text-2"
            data-testid="host-detection-status"
          >
            {detectionState.status === 'loading'
              ? t('hostPlan.detection_loading')
              : detectionState.status === 'unavailable'
                ? t('hostPlan.detection_unavailable')
                : detectionState.detection.recommended_host === null
                  ? t('hostPlan.detection_none')
                  : t(
                    detectionState.detection.reason === 'tenon-plugin-detected'
                      ? 'hostPlan.detection_recommended_plugin'
                      : 'hostPlan.detection_recommended_host',
                    {
                      host: HOST_NAMES[detectionState.detection.recommended_host]
                        ?? detectionState.detection.recommended_host,
                      operation: t(`hostPlan.operation.${detectionState.detection.recommended_operation ?? 'setup'}`),
                    },
                  )}
          </div>
          <div
            className="mt-5 grid items-start gap-5 min-[900px]:grid-cols-[minmax(300px,0.8fr)_minmax(0,1.2fr)]"
            data-testid="host-plan-workspace"
          >
          <div className="min-w-0">
            <div
              className="grid min-w-0 gap-3 min-[520px]:grid-cols-2 min-[900px]:max-h-[calc(100vh-11rem)] min-[900px]:grid-cols-1 min-[900px]:overflow-y-auto min-[900px]:pr-2 min-[900px]:[scrollbar-gutter:stable]"
              data-testid="host-target-grid"
            >
            {catalogState.catalog.targets.map((target) => {
              const name = hostName(target)
              const selected = selectedHost === target.id
              const detected = detectionState.status === 'ready'
                && detectionState.detection.detected_hosts.some((host) => host === target.id)
              const recommended = detectionState.status === 'ready'
                && detectionState.detection.recommended_host === target.id
              return (
                <article
                  key={target.id}
                  className={`min-w-0 rounded-xl border bg-card p-2 ${
                    selected ? 'border-(--accent) ring-1 ring-(--accent)' : 'border-border'
                  }`}
                  data-kind={target.kind}
                  data-detected={detected}
                  data-recommended={recommended}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
                      <h2 className="truncate text-sm font-bold text-text">{name}</h2>
                      <p className="shrink-0 font-mono text-[11px] text-text-3">{target.cli_flag}</p>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      {detected ? (
                        <span className="rounded-full border border-green-b bg-green-t px-1.5 py-1 text-[11px] font-semibold text-green-d">
                          {t('hostPlan.detected')}
                        </span>
                      ) : null}
                      <span className="rounded-full border border-border bg-fill px-1.5 py-1 text-[11px] font-semibold text-text-2">
                        {t(`hostPlan.kind.${target.kind}`)}
                      </span>
                      <span className="rounded-full border border-border bg-bg px-1.5 py-1 text-[11px] font-semibold text-text-3">
                        {t(`hostPlan.scope.${target.target_scope}`)}
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    aria-pressed={selected}
                    className="mt-1.5 w-full rounded-lg border border-border-2 bg-bg px-3 py-1.5 text-xs font-bold text-text outline-none hover:bg-fill focus-visible:ring-2 focus-visible:ring-(--accent)"
                    onClick={() => selectHost(target.id)}
                  >
                    {selected
                      ? t('hostPlan.selected', { host: name })
                      : t('hostPlan.select', { host: name })}
                  </button>
                </article>
              )
            })}
            </div>
            {catalogState.catalog.targets.length > 4 ? (
              <p className="mt-2 hidden text-[11px] text-text-3 min-[900px]:block" data-testid="host-target-scroll-hint">
                {t('hostPlan.scroll_hint')}
              </p>
            ) : null}
          </div>
          <div
            ref={detailRef}
            className="min-w-0 scroll-mt-16 outline-none focus-visible:ring-2 focus-visible:ring-(--accent) min-[900px]:sticky min-[900px]:top-5"
            data-testid="host-plan-detail"
            tabIndex={-1}
          >
            {selectedTarget === null ? (
              <div
                className="rounded-2xl border border-dashed border-border-2 bg-card p-6 text-sm text-text-2"
                role="status"
              >
                {t('hostPlan.awaiting_host')}
              </div>
            ) : (
              <HostOperationPlanPanel
                target={selectedTarget}
                targetLabel={hostName(selectedTarget)}
                selectedOperation={selectedOperation}
                planState={planState}
                copyText={copyText}
                onRequestPlan={requestPlan}
                errorMessage={(error) => localizedError(error, t)}
              />
            )}
          </div>
          </div>
        </>
      )}
    </section>
  )
}
