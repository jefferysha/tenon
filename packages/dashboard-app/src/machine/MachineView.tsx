import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { HostId } from '../api/hostTargetPlanTypes'
import { resolveLoaders, useHostTargetPlan, type HostTargetPlanLoaders } from '../hostPlan/useHostTargetPlan'
import { useT } from '../i18n'
import { useSheetState, type SheetDef } from '../shared/DetailSheets'
import { useGlobalSearch } from '../shell/GlobalSearch'
import { ThreeColumns } from '../shell/ThreeColumns'
import type { Snapshot } from '../types'
import { HostDetailPane, HOST_SHEETS, MACHINE_SHEETS, type MachineSheetId } from './HostDetailPane'
import { HostListPane, type HostFilter } from './HostListPane'
import { MachineRail } from './MachineRail'
import { detectPlatform } from './machineModel'
import { useMachineProbes } from './useMachineProbes'

export interface MachineViewProps {
  snapshot: Snapshot | null
  currentRoot: string
  onOpenProject: (root: string) => void
  /** 测试注入：宿主目录 / 检测 / 计划加载器与剪贴板；生产不传，走默认客户端。 */
  hostPlan?: Partial<HostTargetPlanLoaders>
}

const RAIL_KEY = 'tenon-dashboard-rail:machine'
const SHEET_KEY = 'tenon-dashboard-sheet:machine'

/**
 * 机器页 = 模板三列：左列本机 + 宿主目标 / 中列适配器列表 / 右列 sheet（安装计划 · 能力 · 就绪 · 阻塞 · 风险 · 诊断）。
 * 机器级探测（useMachineProbes）与宿主计划（useHostTargetPlan）两路数据在此汇合；页面只读，动作以终端命令给出。
 */
export function MachineView({ snapshot, currentRoot, onOpenProject, hostPlan }: MachineViewProps): JSX.Element {
  const { t } = useT()
  const { query } = useGlobalSearch()
  const loaders = useMemo(() => resolveLoaders(hostPlan), [hostPlan])
  const probes = useMachineProbes(snapshot, currentRoot)
  const host = useHostTargetPlan(loaders)
  const platform = useMemo(detectPlatform, [])
  const [filter, setFilter] = useState<HostFilter>('all')
  const [search, setSearch] = useState('')
  const [railCollapsed, setRailCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(RAIL_KEY) === '1' } catch { return false }
  })
  useEffect(() => {
    try { localStorage.setItem(RAIL_KEY, railCollapsed ? '1' : '0') } catch { /* ignore */ }
  }, [railCollapsed])

  const sheets: readonly SheetDef<MachineSheetId>[] = useMemo(() => {
    const ids: readonly MachineSheetId[] = host.selectedTarget === null ? MACHINE_SHEETS : HOST_SHEETS
    return ids.map((id) => ({ id, label: t(`machines.sheet_${id}`) }))
  }, [host.selectedTarget, t])
  const [sheet, setSheet] = useSheetState<MachineSheetId>(SHEET_KEY, sheets, host.selectedTarget === null ? 'readiness' : 'plan')

  // 选中宿主（无论用户点选还是检测推荐）时切到安装计划；窄屏下把计划容器滚进视口并聚焦。
  const planRef = useRef<HTMLDivElement>(null)
  const focusPlanOnSelect = useRef(false)
  const previousHost = useRef<HostId | null>(null)
  useEffect(() => {
    const current = host.selectedHost
    const previous = previousHost.current
    previousHost.current = current
    if (current === null || current === previous) return
    if (previous === null) setSheet('plan')
    if (focusPlanOnSelect.current) {
      focusPlanOnSelect.current = false
      if (window.matchMedia?.('(max-width: 899px)').matches) {
        requestAnimationFrame(() => {
          planRef.current?.scrollIntoView({ block: 'start' })
          planRef.current?.focus({ preventScroll: true })
        })
      }
    }
  }, [host.selectedHost, setSheet])

  const selectHost = useCallback((id: HostId): void => {
    focusPlanOnSelect.current = true
    host.selectHost(id)
    setSheet('plan')
  }, [host, setSheet])

  const refreshAll = useCallback((): void => {
    probes.reload()
    host.refresh()
  }, [host, probes])

  const openHostPlan = useCallback((): void => {
    if (host.selectedTarget !== null) {
      setSheet('plan')
      return
    }
    const first = host.orderedTargets[0]
    if (first !== undefined) selectHost(first.id)
  }, [host.orderedTargets, host.selectedTarget, selectHost, setSheet])

  return (
    <ThreeColumns
      testId="machine-view"
      railCollapsed={railCollapsed}
      rail={(
        <MachineRail
          targets={host.orderedTargets}
          detection={host.detectionState}
          selectedHost={host.selectedHost}
          platform={platform}
          collapsed={railCollapsed}
          onToggle={() => setRailCollapsed((value) => !value)}
          onSelectMachine={host.clearHost}
          onSelectHost={selectHost}
          onRefresh={refreshAll}
          onHostPlan={openHostPlan}
        />
      )}
      list={(
        <HostListPane
          catalogState={host.catalogState}
          detectionState={host.detectionState}
          orderedTargets={host.orderedTargets}
          selectedHost={host.selectedHost}
          platform={platform}
          query={query}
          search={search}
          onSearch={setSearch}
          filter={filter}
          onFilter={setFilter}
          onSelect={selectHost}
          onRetry={host.refresh}
        />
      )}
      detail={(
        <HostDetailPane
          snapshot={snapshot}
          currentRoot={currentRoot}
          onOpenProject={onOpenProject}
          probes={probes}
          host={host}
          copyText={loaders.copyText}
          sheets={sheets}
          sheet={sheet}
          onSheet={setSheet}
          platform={platform}
          planRef={planRef}
        />
      )}
    />
  )
}
