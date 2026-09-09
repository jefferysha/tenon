import { Plus, SlidersHorizontal } from 'lucide-react'
import type { WbLoopRow } from '../api/client'
import { useT } from '../i18n'
import type { SchedulerHealthSummary } from '../model/progressModel'
import { RailCard, RailColumn, RailFootLink } from '../shell/ThreeColumns'
import type { AutomationScope } from './automationModel'

export interface AutomationRailProps {
  health: SchedulerHealthSummary
  total: number
  /** 当前 root 的循环；null = 加载中或加载失败（loopsError 区分）。 */
  loops: readonly WbLoopRow[] | null
  loopsError: string | null
  countOfLoop: (loop: WbLoopRow) => number
  scope: AutomationScope
  /** 右列当前面板：运行详情 / 节奏设置。 */
  panel: 'runs' | 'settings'
  collapsed: boolean
  onToggle: () => void
  onScope: (scope: AutomationScope) => void
  onNewRun: () => void
  newRunDisabled: boolean
  onSettings: () => void
}

/** 自动化页左列：范围选择（全部运行 + 每个循环），底部「新建运行」「节奏设置」。 */
export function AutomationRail({
  health,
  total,
  loops,
  loopsError,
  countOfLoop,
  scope,
  panel,
  collapsed,
  onToggle,
  onScope,
  onNewRun,
  newRunDisabled,
  onSettings,
}: AutomationRailProps): JSX.Element {
  const { t } = useT()
  const allLabel = t('automation.scope_all')
  return (
    <RailColumn
      title={t('automation.rail_title')}
      collapsed={collapsed}
      onToggle={onToggle}
      testId="afk-rail"
      footer={(
        <>
          <RailFootLink
            icon={<Plus />}
            label={t('automation.new_run')}
            collapsed={collapsed}
            disabled={newRunDisabled}
            title={newRunDisabled ? t('automation.new_run_unavailable') : undefined}
            testId="afk-new-run"
            onClick={onNewRun}
          />
          <RailFootLink
            icon={<SlidersHorizontal />}
            label={t('automation.settings')}
            collapsed={collapsed}
            current={panel === 'settings'}
            testId="afk-rail-settings"
            onClick={onSettings}
          />
        </>
      )}
    >
      <ul className="grid gap-1" data-testid="afk-scope-list">
        <li data-testid="afk-health" data-status={health.status}>
          <RailCard
            mark={allLabel.slice(0, 1).toUpperCase()}
            name={allLabel}
            meta={t('automation.scope_all_meta', { running: health.running, failed: health.failed })}
            count={total}
            selected={scope === 'all' && panel === 'runs'}
            collapsed={collapsed}
            testId="afk-scope-all"
            onClick={() => onScope('all')}
          />
        </li>
        {(loops ?? []).map((loop) => (
          <li key={loop.id}>
            <RailCard
              mark={loop.name.slice(0, 1).toUpperCase()}
              name={loop.name}
              meta={t('automation.loop_meta', { status: loop.status })}
              count={countOfLoop(loop)}
              selected={scope !== 'all' && scope.loopId === loop.id && panel === 'runs'}
              collapsed={collapsed}
              testId={`afk-scope-${loop.id}`}
              onClick={() => onScope({ loopId: loop.id })}
            />
          </li>
        ))}
      </ul>
      {!collapsed && loops === null && loopsError === null && (
        <p className="mt-3 px-1.5 text-caption text-text-3 max-[1279px]:hidden" role="status">{t('automation.loops_loading')}</p>
      )}
      {!collapsed && loopsError !== null && (
        <p className="mt-3 px-1.5 text-caption text-red-d max-[1279px]:hidden" role="status" data-testid="afk-loops-error">{loopsError}</p>
      )}
      {!collapsed && loops !== null && loops.length === 0 && (
        <p className="mt-3 px-1.5 text-caption text-text-3 max-[1279px]:hidden" role="status">{t('automation.loops_none')}</p>
      )}
    </RailColumn>
  )
}
