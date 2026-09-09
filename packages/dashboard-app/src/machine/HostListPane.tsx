import { ChevronRight } from 'lucide-react'
import type { HostId, HostTarget } from '../api/hostTargetPlanTypes'
import { hostName, hostNameOf, localizedError, type CatalogState, type DetectionState } from '../hostPlan/useHostTargetPlan'
import { useT } from '../i18n'
import { matchesQuery } from '../shell/GlobalSearch'
import { FilterChip, ListColumn, StatusPill, type PillTone } from '../shell/ThreeColumns'
import { cn } from '@/lib/utils'

const HOST_FILTERS = ['all', 'detected', 'recommended', 'undetected'] as const
export type HostFilter = (typeof HOST_FILTERS)[number]

export type HostDetectionStatus = 'recommended' | 'detected' | 'undetected' | 'unknown'

export function hostDetectionStatus(target: HostTarget, detection: DetectionState): HostDetectionStatus {
  if (detection.status !== 'ready') return 'unknown'
  if (detection.detection.recommended_host === target.id) return 'recommended'
  return detection.detection.detected_hosts.some((host) => host === target.id) ? 'detected' : 'undetected'
}

export const HOST_STATUS_TONE: Record<HostDetectionStatus, PillTone> = {
  recommended: 'pending',
  detected: 'done',
  undetected: 'neutral',
  unknown: 'neutral',
}

function hostFilterMatch(status: HostDetectionStatus, filter: HostFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'detected') return status === 'detected' || status === 'recommended'
  if (filter === 'recommended') return status === 'recommended'
  return status === 'undetected'
}

export interface HostListPaneProps {
  catalogState: CatalogState
  detectionState: DetectionState
  orderedTargets: readonly HostTarget[]
  selectedHost: HostId | null
  platform: string | null
  /** 顶部条的全局搜索词；与本列搜索框同时生效。 */
  query: string
  search: string
  onSearch: (next: string) => void
  filter: HostFilter
  onFilter: (next: HostFilter) => void
  onSelect: (host: HostId) => void
  onRetry: () => void
}

/** 机器页中列：eyebrow / H1「适配器」/ 说明框 + 检测状态条 / 搜索 / 四类页签 / 宿主卡。 */
export function HostListPane({
  catalogState,
  detectionState,
  orderedTargets,
  selectedHost,
  platform,
  query,
  search,
  onSearch,
  filter,
  onFilter,
  onSelect,
  onRetry,
}: HostListPaneProps): JSX.Element {
  const { t } = useT()
  const statusOf = (target: HostTarget): HostDetectionStatus => hostDetectionStatus(target, detectionState)
  const counts = Object.fromEntries(
    HOST_FILTERS.map((candidate) => [candidate, orderedTargets.filter((target) => hostFilterMatch(statusOf(target), candidate)).length]),
  ) as Record<HostFilter, number>
  const visible = orderedTargets.filter((target) => hostFilterMatch(statusOf(target), filter)
    && matchesQuery(query, target.id, hostName(target), target.cli_flag, target.kind)
    && matchesQuery(search, target.id, hostName(target), target.cli_flag, target.kind))

  const detectionText = detectionState.status === 'loading'
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
            host: hostNameOf(detectionState.detection.recommended_host),
            operation: t(`hostPlan.operation.${detectionState.detection.recommended_operation ?? 'setup'}`),
          },
        )

  return (
    <ListColumn
      eyebrow={platform === null ? t('machines.local_machine') : t('machines.eyebrow', { platform: platform.toUpperCase() })}
      title={t('machines.title')}
      note={(
        <>
          <p><b className="font-semibold text-text">{t('machines.note_lead')}</b>{t('machines.note')}</p>
          <p
            className="mt-2 border-t border-border pt-2 text-body text-text-2"
            data-testid="host-detection-status"
            data-detection={detectionState.status}
          >
            {detectionText}
          </p>
        </>
      )}
      search={{ value: search, onChange: onSearch, placeholder: t('machines.search'), label: t('machines.search') }}
      chips={(
        <div role="tablist" aria-label={t('machines.filter_label')} className="flex flex-wrap gap-1">
          {HOST_FILTERS.map((candidate) => (
            <FilterChip
              key={candidate}
              label={t(`machines.filter_${candidate}`)}
              count={counts[candidate]}
              selected={filter === candidate}
              testId={`host-filter-${candidate}`}
              onClick={() => onFilter(candidate)}
            />
          ))}
        </div>
      )}
      testId="host-list"
    >
      {catalogState.status === 'loading' ? (
        <p className="text-body text-text-3" role="status" aria-live="polite">{t('hostPlan.catalog_loading')}</p>
      ) : catalogState.status === 'error' ? (
        <div className="rounded-md border border-red-b bg-red-t px-4 py-3 text-red-d" role="alert">
          <p className="break-words text-base">{localizedError(catalogState.error, t)}</p>
          <button
            type="button"
            className="mt-3 min-h-9 rounded-sm border border-red-b bg-card px-3 text-caption font-semibold text-red-d hover:bg-red-t"
            onClick={onRetry}
          >
            {t('hostPlan.catalog_retry')}
          </button>
        </div>
      ) : catalogState.catalog.targets.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-5 py-10 text-center" role="status" data-testid="host-plan-empty">
          <p className="text-base font-semibold text-text">{t('hostPlan.catalog_empty')}</p>
          <button
            type="button"
            className="mt-3 min-h-9 rounded-sm border border-border bg-card px-3 text-caption font-semibold text-text-2 hover:bg-fill"
            onClick={onRetry}
          >
            {t('hostPlan.catalog_retry')}
          </button>
        </div>
      ) : visible.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-5 py-8 text-center text-body text-text-3" role="status" data-testid="host-list-empty-filtered">
          {t('machines.empty_filtered')}
        </p>
      ) : (
        <ul className="grid" data-testid="host-list-items">
          {visible.map((target, index) => {
            const status = statusOf(target)
            const selected = target.id === selectedHost
            const previousSelected = index > 0 && visible[index - 1]?.id === selectedHost
            return (
              <li key={target.id} className={index > 0 && !selected && !previousSelected ? 'border-t border-border' : undefined}>
                <HostCard target={target} status={status} selected={selected} onSelect={() => onSelect(target.id)} />
              </li>
            )
          })}
        </ul>
      )}
    </ListColumn>
  )
}

function HostCard({ target, status, selected, onSelect }: { target: HostTarget; status: HostDetectionStatus; selected: boolean; onSelect: () => void }): JSX.Element {
  const { t } = useT()
  const name = hostName(target)
  return (
    <button
      type="button"
      className={cn(
        'grid w-full min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5 rounded-md border border-transparent px-3.5 py-4 text-left outline-none transition-colors hover:bg-bg focus-visible:ring-2 focus-visible:ring-(--accent) motion-reduce:transition-none',
        selected && 'border-sel-border border-l-[3px] border-l-sel-edge bg-sel-bg pl-3 hover:bg-sel-bg',
      )}
      aria-current={selected ? 'true' : undefined}
      aria-label={selected ? t('hostPlan.selected', { host: name }) : t('hostPlan.select', { host: name })}
      data-kind={target.kind}
      data-detected={status === 'detected' || status === 'recommended'}
      data-recommended={status === 'recommended'}
      data-testid={`host-target-${target.id}`}
      onClick={onSelect}
    >
      <span className="flex min-w-0 items-center justify-between gap-3">
        <span className="min-w-0 truncate text-title font-semibold text-text">{name}</span>
        {status !== 'unknown' && (
          <StatusPill tone={HOST_STATUS_TONE[status]} testId={`host-status-${target.id}`}>{t(`machines.pill_${status}`)}</StatusPill>
        )}
      </span>
      <span className="truncate font-mono text-body text-text-2">{target.id} · {target.cli_flag}</span>
      <span className="flex min-w-0 items-center gap-3.5 text-body text-text-2">
        <span className="flex-none">{t(`hostPlan.kind.${target.kind}`)} · {t(`hostPlan.scope.${target.target_scope}`)}</span>
        <span className="min-w-0 flex-1 truncate">
          {t('machines.card_operations', { ops: target.supported_operations.map((operation) => t(`hostPlan.operation.${operation}`)).join(' / ') })}
        </span>
        <ChevronRight className="size-3.5 flex-none text-text-3" aria-hidden="true" />
      </span>
    </button>
  )
}
