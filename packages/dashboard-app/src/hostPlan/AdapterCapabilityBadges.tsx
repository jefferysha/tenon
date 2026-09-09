import type {
  AdapterCapabilityId,
  AdapterCapabilityStatus,
  DefinitionCatalogAdapter,
} from '../api/client'

type Translate = (key: string, vars?: Record<string, string | number>) => string

export const CAPABILITY_IDS: readonly AdapterCapabilityId[] = ['inject', 'veto', 'track']

/**
 * 三态在视觉上必须**不只靠颜色**区分：色盲用户、灰度截图和高对比模式下颜色会塌缩成
 * 同一片灰。因此每档同时改四个维度——颜色 + 形状（圆角 vs 胶囊）+ 边框样式（实线 /
 * 虚线 / 点线）+ 字形标记（●/◐/○）。语义色沿用仓库约定：绿=受控、琥珀=要你注意、
 * 红=受阻。
 */
const STATUS_STYLE: Record<AdapterCapabilityStatus, { className: string; glyph: string }> = {
  native: {
    className: 'rounded-full border-solid border-green-b bg-green-t text-green-d',
    glyph: '●',
  },
  degraded: {
    className: 'rounded-sm border-dashed border-amber-b bg-amber-t text-amber-d',
    glyph: '◐',
  },
  none: {
    className: 'rounded-sm border-dotted border-red-b bg-red-t text-red-d line-through',
    glyph: '○',
  },
}

const BADGE_BASE = 'inline-flex items-center gap-1 border px-1.5 py-0.5 text-micro font-bold leading-4'

/** 只有 degraded / none 需要解释「意味着什么」；native 是默认承诺，不必占用视觉预算。 */
function needsExplanation(status: AdapterCapabilityStatus): boolean {
  return status !== 'native'
}

interface CapabilityBadgeProps {
  capability: AdapterCapabilityId
  status: AdapterCapabilityStatus
  t: Translate
}

function CapabilityBadge({ capability, status, t }: CapabilityBadgeProps): JSX.Element {
  const style = STATUS_STYLE[status]
  const name = t(`hostPlan.installer.capability_name.${capability}`)
  const statusLabel = t(`hostPlan.installer.capability_status.${status}`)
  const detail = t(`hostPlan.installer.capability_detail.${capability}.${status}`)
  return (
    <span
      className={`${BADGE_BASE} ${style.className}`}
      data-testid={`adapter-capability-${capability}`}
      data-capability-status={status}
      title={detail}
    >
      <span aria-hidden="true">{style.glyph}</span>
      <span>{name}</span>
      <span>{statusLabel}</span>
    </span>
  )
}

export interface AdapterCapabilityBadgesProps {
  adapter: DefinitionCatalogAdapter
  t: Translate
}

/**
 * 一个宿主的能力三连 + veto 失败语义。降级说明与徽章同屏（不是 tooltip-only），
 * 否则触屏和键盘用户永远看不到「降级意味着什么」。
 */
export function AdapterCapabilityBadges({ adapter, t }: AdapterCapabilityBadgesProps): JSX.Element {
  const failClosed = adapter.veto_fail_closed
  const explanations = CAPABILITY_IDS
    .filter((capability) => needsExplanation(adapter.capabilities[capability]))
    .map((capability) => ({
      capability,
      text: t(`hostPlan.installer.capability_detail.${capability}.${adapter.capabilities[capability]}`),
    }))
  return (
    <span className="mt-2 block" data-testid={`adapter-capabilities-${adapter.id}`}>
      <span className="flex flex-wrap items-center gap-1">
        {CAPABILITY_IDS.map((capability) => (
          <CapabilityBadge key={capability} capability={capability} status={adapter.capabilities[capability]} t={t} />
        ))}
        {adapter.capabilities.veto !== 'none' && (
          <span
            className={`${BADGE_BASE} ${failClosed
              ? 'rounded-full border-solid border-green-b bg-green-t text-green-d'
              : 'rounded-sm border-dashed border-amber-b bg-amber-t text-amber-d'}`}
            data-testid={`adapter-veto-fail-mode-${adapter.id}`}
            data-veto-fail-closed={failClosed ? 'true' : 'false'}
            title={t(failClosed ? 'hostPlan.installer.veto_fail_closed_detail' : 'hostPlan.installer.veto_fail_open_detail')}
          >
            <span aria-hidden="true">{failClosed ? '■' : '□'}</span>
            <span>{t(failClosed ? 'hostPlan.installer.veto_fail_closed' : 'hostPlan.installer.veto_fail_open')}</span>
          </span>
        )}
      </span>
      {explanations.length > 0 && (
        <span className="mt-1.5 block border-l-2 border-amber-b pl-2 text-micro leading-4 text-text-2">
          {explanations.map((entry) => (
            <span key={entry.capability} className="block" data-testid={`adapter-capability-note-${adapter.id}-${entry.capability}`}>
              {entry.text}
            </span>
          ))}
        </span>
      )}
    </span>
  )
}

/** 图例：三个字形/形状各出现一次，用户不必逐个 hover 才知道徽章在说什么。 */
export function AdapterCapabilityLegend({ t }: { t: Translate }): JSX.Element {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-border bg-fill/45 px-3 py-2" data-testid="adapter-capability-legend">
      <span className="text-micro font-bold uppercase tracking-[0.12em] text-text-3">{t('hostPlan.installer.legend_title')}</span>
      {(['native', 'degraded', 'none'] as const).map((status) => (
        <span key={status} className="inline-flex items-center gap-1.5 text-micro text-text-2">
          <span className={`${BADGE_BASE} ${STATUS_STYLE[status].className}`} data-testid={`adapter-capability-legend-${status}`}>
            <span aria-hidden="true">{STATUS_STYLE[status].glyph}</span>
            <span>{t(`hostPlan.installer.capability_status.${status}`)}</span>
          </span>
          <span>{t(`hostPlan.installer.legend_detail.${status}`)}</span>
        </span>
      ))}
    </div>
  )
}
