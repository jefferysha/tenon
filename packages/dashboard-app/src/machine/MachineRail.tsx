import { ArrowRight, RefreshCw } from 'lucide-react'
import type { HostId, HostTarget } from '../api/hostTargetPlanTypes'
import { hostName, type DetectionState } from '../hostPlan/useHostTargetPlan'
import { useT } from '../i18n'
import { RailCard, RailColumn, RailFootLink } from '../shell/ThreeColumns'

export interface MachineRailProps {
  targets: readonly HostTarget[]
  detection: DetectionState
  selectedHost: HostId | null
  platform: string | null
  collapsed: boolean
  onToggle: () => void
  /** 选中「本机」= 清空宿主选择，右列回到机器级 sheet。 */
  onSelectMachine: () => void
  onSelectHost: (host: HostId) => void
  onRefresh: () => void
  onHostPlan: () => void
}

/** 机器页左列：首张「本机」卡 + 每个宿主目标一行；底部「刷新」「宿主计划」。 */
export function MachineRail({
  targets,
  detection,
  selectedHost,
  platform,
  collapsed,
  onToggle,
  onSelectMachine,
  onSelectHost,
  onRefresh,
  onHostPlan,
}: MachineRailProps): JSX.Element {
  const { t } = useT()
  const detected = new Set<string>(detection.status === 'ready' ? detection.detection.detected_hosts : [])
  const machineMeta = platform === null
    ? t('machines.adapters_meta', { n: targets.length })
    : t('machines.adapters_meta_platform', { n: targets.length, platform })
  return (
    <RailColumn
      title={t('machines.rail_title')}
      collapsed={collapsed}
      onToggle={onToggle}
      testId="machine-rail"
      footer={(
        <>
          <RailFootLink
            icon={<RefreshCw />}
            label={t('machines.refresh')}
            collapsed={collapsed}
            testId="machine-rail-refresh"
            onClick={onRefresh}
          />
          <RailFootLink
            icon={<ArrowRight />}
            label={t('machines.host_plan_link')}
            collapsed={collapsed}
            testId="machine-rail-host-plan"
            onClick={onHostPlan}
          />
        </>
      )}
    >
      <ul className="grid gap-1">
        <li>
          <RailCard
            mark="M"
            name={t('machines.local_machine')}
            meta={machineMeta}
            count={targets.length}
            selected={selectedHost === null}
            collapsed={collapsed}
            tag={<span className="rounded-full bg-green-t px-1.5 text-micro font-medium text-green-d">{t('machines.online')}</span>}
            testId="machine-rail-local"
            onClick={onSelectMachine}
          />
        </li>
        {targets.map((target) => {
          const name = hostName(target)
          return (
            <li key={target.id}>
              <RailCard
                mark={name.slice(0, 1).toUpperCase()}
                name={name}
                meta={[target.cli_flag, t(`hostPlan.kind.${target.kind}`), t(`hostPlan.scope.${target.target_scope}`)].join(' · ')}
                selected={selectedHost === target.id}
                collapsed={collapsed}
                tag={detected.has(target.id)
                  ? <span className="rounded-full bg-green-t px-1.5 text-micro font-medium text-green-d">{t('machines.pill_detected')}</span>
                  : undefined}
                testId={`machine-rail-host-${target.id}`}
                onClick={() => onSelectHost(target.id)}
              />
            </li>
          )
        })}
      </ul>
    </RailColumn>
  )
}
