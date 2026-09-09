import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import type { HostPlanRequestState } from './HostOperationPlanPanel'

export type CatalogState =
  | { status: 'loading' }
  | { status: 'error'; error: unknown }
  | { status: 'ready'; catalog: HostTargetCatalog }

export type DetectionState =
  | { status: 'loading' }
  | { status: 'unavailable'; error: unknown }
  | { status: 'ready'; detection: HostTargetDetection }

export interface HostTargetPlanLoaders {
  loadTargets: (signal: AbortSignal) => Promise<HostTargetCatalog>
  loadDetection: (signal: AbortSignal) => Promise<HostTargetDetection>
  loadPlan: (host: HostId, operation: HostOperation, signal: AbortSignal) => Promise<HostTargetPlan>
  copyText: (text: string) => Promise<void>
}

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

export function hostName(target: HostTarget): string {
  return HOST_NAMES[target.id] ?? target.id
}

export function hostNameOf(id: string): string {
  return HOST_NAMES[id] ?? id
}

type Translate = (key: string, vars?: Record<string, string | number>) => string

export function localizedError(error: unknown, t: Translate): string {
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

export interface HostTargetPlanState {
  catalogState: CatalogState
  detectionState: DetectionState
  selectedHost: HostId | null
  selectedOperation: HostOperation | null
  planState: HostPlanRequestState
  selectedTarget: HostTarget | null
  /** 目录排序：推荐 > 已检测 > 其他，同档按显示名。 */
  orderedTargets: readonly HostTarget[]
  /** 重拉目录与检测；同时清空选中宿主与计划。 */
  refresh: () => void
  selectHost: (host: HostId) => void
  clearHost: () => void
  requestPlan: (host: HostId, operation: HostOperation) => void
}

const defaultCopyText = async (text: string): Promise<void> => navigator.clipboard.writeText(text)

export function resolveLoaders(over: Partial<HostTargetPlanLoaders> | undefined): HostTargetPlanLoaders {
  return {
    loadTargets: over?.loadTargets ?? fetchHostTargets,
    loadDetection: over?.loadDetection ?? fetchHostTargetDetection,
    loadPlan: over?.loadPlan ?? fetchHostTargetPlan,
    copyText: over?.copyText ?? defaultCopyText,
  }
}

/**
 * 宿主目标目录 / 检测 / 安装计划的加载与竞态处理。
 * 目录与检测并行加载并共用一个 AbortController；计划请求按序号失效——切换宿主或刷新后，
 * 迟到的响应一律丢弃，不会把上一个宿主的计划贴到当前宿主上。
 * 检测给出推荐宿主时自动请求一次推荐计划；用户主动清空选择后不再自动回选。
 */
export function useHostTargetPlan(loaders: Pick<HostTargetPlanLoaders, 'loadTargets' | 'loadDetection' | 'loadPlan'>): HostTargetPlanState {
  const { loadTargets, loadDetection, loadPlan } = loaders
  const [catalogState, setCatalogState] = useState<CatalogState>({ status: 'loading' })
  const [detectionState, setDetectionState] = useState<DetectionState>({ status: 'loading' })
  const [selectedHost, setSelectedHost] = useState<HostId | null>(null)
  const [selectedOperation, setSelectedOperation] = useState<HostOperation | null>(null)
  const [planState, setPlanState] = useState<HostPlanRequestState>({ status: 'idle' })
  const bootstrapSequence = useRef(0)
  const planSequence = useRef(0)
  const bootstrapController = useRef<AbortController | null>(null)
  const planController = useRef<AbortController | null>(null)
  const autoSelected = useRef(false)

  const abortPlan = useCallback((): void => {
    planController.current?.abort()
    planController.current = null
    planSequence.current += 1
  }, [])

  const refresh = useCallback(() => {
    bootstrapController.current?.abort()
    abortPlan()
    const controller = new AbortController()
    bootstrapController.current = controller
    const sequence = bootstrapSequence.current + 1
    bootstrapSequence.current = sequence
    autoSelected.current = false
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
        if (bootstrapSequence.current === sequence) setCatalogState({ status: 'error', error })
      },
    )
    const detectionRequest = loadDetection(controller.signal).then(
      (detection) => {
        if (bootstrapSequence.current === sequence) setDetectionState({ status: 'ready', detection })
      },
      (error: unknown) => {
        if (bootstrapSequence.current === sequence) setDetectionState({ status: 'unavailable', error })
      },
    )
    void Promise.allSettled([catalogRequest, detectionRequest]).finally(() => {
      if (bootstrapController.current === controller) bootstrapController.current = null
    })
  }, [abortPlan, loadDetection, loadTargets])

  useEffect(() => {
    refresh()
    return () => {
      bootstrapController.current?.abort()
      bootstrapController.current = null
      planController.current?.abort()
      planController.current = null
      bootstrapSequence.current += 1
      planSequence.current += 1
    }
  }, [refresh])

  const selectHost = useCallback((host: HostId): void => {
    abortPlan()
    setSelectedHost(host)
    setSelectedOperation(null)
    setPlanState({ status: 'idle' })
  }, [abortPlan])

  const clearHost = useCallback((): void => {
    abortPlan()
    autoSelected.current = true
    setSelectedHost(null)
    setSelectedOperation(null)
    setPlanState({ status: 'idle' })
  }, [abortPlan])

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
        if (planSequence.current === sequence) setPlanState({ status: 'error', error })
      },
    ).finally(() => {
      if (planController.current === controller) planController.current = null
    })
  }, [loadPlan])

  useEffect(() => {
    if (catalogState.status !== 'ready'
      || detectionState.status !== 'ready'
      || selectedHost !== null
      || autoSelected.current) return
    const { recommended_host: host, recommended_operation: operation } = detectionState.detection
    if (host === null || operation === null) return
    const target = catalogState.catalog.targets.find((candidate) => candidate.id === host)
    if (target === undefined || !target.supported_operations.includes(operation)) return
    autoSelected.current = true
    requestPlan(host, operation)
  }, [catalogState, detectionState, requestPlan, selectedHost])

  const selectedTarget = catalogState.status === 'ready'
    ? catalogState.catalog.targets.find((target) => target.id === selectedHost) ?? null
    : null

  const orderedTargets = useMemo(() => {
    if (catalogState.status !== 'ready') return []
    if (detectionState.status !== 'ready') return catalogState.catalog.targets
    const detected = new Set<string>(detectionState.detection.detected_hosts)
    const recommended = detectionState.detection.recommended_host
    return [...catalogState.catalog.targets].sort((left, right) => {
      const rank = (target: HostTarget): number => target.id === recommended ? 0 : detected.has(target.id) ? 1 : 2
      return rank(left) - rank(right) || hostName(left).localeCompare(hostName(right))
    })
  }, [catalogState, detectionState])

  return {
    catalogState,
    detectionState,
    selectedHost,
    selectedOperation,
    planState,
    selectedTarget,
    orderedTargets,
    refresh,
    selectHost,
    clearHost,
    requestPlan,
  }
}
