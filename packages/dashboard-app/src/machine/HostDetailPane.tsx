import { Copy } from 'lucide-react'
import { useEffect, useState, type RefObject } from 'react'
import type { HostTarget } from '../api/hostTargetPlanTypes'
import { hostName, type DetectionState, type HostTargetPlanState } from '../hostPlan/useHostTargetPlan'
import { useT } from '../i18n'
import { SheetTabs, type SheetDef } from '../shared/DetailSheets'
import { DetailColumn, StatusPill, type PillTone } from '../shell/ThreeColumns'
import type { Snapshot } from '../types'
import { hostDetectionStatus, HOST_STATUS_TONE } from './HostListPane'
import type { Translate } from './machineModel'
import { CapabilitiesSheet, PlanSheet } from './HostSheets'
import { BlockersSheet, DiagnosticsSheet, ReadinessSheet, RisksSheet } from './MachineSheets'
import type { MachineProbes } from './useMachineProbes'

export const HOST_SHEETS = ['plan', 'capabilities', 'readiness', 'blockers', 'risks', 'diagnostics'] as const
export const MACHINE_SHEETS = ['readiness', 'blockers', 'risks', 'diagnostics'] as const
export type MachineSheetId = (typeof HOST_SHEETS)[number]

export interface HostDetailPaneProps {
  snapshot: Snapshot | null
  currentRoot: string
  onOpenProject: (root: string) => void
  probes: MachineProbes
  host: HostTargetPlanState
  copyText: (text: string) => Promise<void>
  sheets: readonly SheetDef<MachineSheetId>[]
  sheet: MachineSheetId
  onSheet: (next: MachineSheetId) => void
  platform: string | null
  /** 安装计划 sheet 的容器；窄屏选中宿主后滚到这里并聚焦。 */
  planRef: RefObject<HTMLDivElement>
}

function detectionNote(target: HostTarget, detection: DetectionState, t: Translate): string {
  const status = hostDetectionStatus(target, detection)
  const name = hostName(target)
  if (status === 'unknown') return t('machines.detection_note_unknown')
  if (status === 'recommended' && detection.status === 'ready') {
    return t(
      detection.detection.reason === 'tenon-plugin-detected' ? 'hostPlan.detection_recommended_plugin' : 'hostPlan.detection_recommended_host',
      { host: name, operation: t(`hostPlan.operation.${detection.detection.recommended_operation ?? 'setup'}`) },
    )
  }
  return t(status === 'detected' ? 'machines.detection_note_detected' : 'machines.detection_note_undetected', { host: name })
}

/**
 * 机器页右列：固定头部（eyebrow / H1 / slug / 状态行）+ sheet 页签 + 底部命令条。
 * 选中宿主时多出「安装计划 / 能力」两个宿主级 sheet；机器级四个 sheet（就绪 / 阻塞 / 风险 / 诊断）
 * 始终挂载、只切换 hidden——探测结果不随页签切换丢失；诊断面板本体只在展开时挂载。
 */
export function HostDetailPane({
  snapshot,
  currentRoot,
  onOpenProject,
  probes,
  host,
  copyText,
  sheets,
  sheet,
  onSheet,
  platform,
  planRef,
}: HostDetailPaneProps): JSX.Element {
  const { t } = useT()
  const target = host.selectedTarget
  const sheetLabel = sheets.find((candidate) => candidate.id === sheet)?.label ?? ''
  const command = host.planState.status === 'ready' ? host.planState.plan.command.display : null
  const [copyState, setCopyState] = useState<'idle' | 'success' | 'error'>('idle')
  useEffect(() => { setCopyState('idle') }, [command])

  const machineTone: PillTone = probes.readinessCounts.blocked > 0 ? 'blocked' : probes.readinessCounts.unknown > 0 ? 'neutral' : 'done'
  const machineLabel = probes.readinessCounts.blocked > 0
    ? t('machines.machine_blocked')
    : probes.readinessCounts.unknown > 0 ? t('machines.machine_unknown') : t('machines.machine_ready')

  function copyCommand(): void {
    if (command === null) return
    setCopyState('idle')
    void Promise.resolve().then(() => copyText(command)).then(
      () => setCopyState('success'),
      () => setCopyState('error'),
    )
  }

  return (
    <DetailColumn
      testId="host-detail-pane"
      panelId="machine-detail-panel"
      labelledBy={`machine-detail-tab-${sheet}`}
      header={target === null ? (
        <>
          <p className="mb-2.5 text-caption font-semibold text-(--accent)">{t('machines.detail_eyebrow_machine', { sheet: sheetLabel })}</p>
          <h1 className="mb-1.5 text-page font-bold tracking-[-.01em] text-text" data-testid="machine-detail-title">{t('machines.local_machine')}</h1>
          <p className="mb-4 font-mono text-base text-text-2">{platform ?? 'localhost'} · {t('machines.adapters_meta', { n: host.orderedTargets.length })}</p>
          <p className="mb-6 flex flex-wrap items-center gap-3.5" data-testid="machine-detail-status">
            <StatusPill tone={machineTone} testId="machine-detail-badge">{machineLabel}</StatusPill>
            <span className="text-base text-text-2">{t('machine.readiness_summary', probes.readinessCounts)}</span>
          </p>
        </>
      ) : (
        <>
          <p className="mb-2.5 text-caption font-semibold text-(--accent)">{t('machines.detail_eyebrow_host', { sheet: sheetLabel })}</p>
          <h1 className="mb-1.5 text-page font-bold tracking-[-.01em] text-text [overflow-wrap:anywhere]" data-testid="machine-detail-title">{hostName(target)}</h1>
          <p className="mb-4 font-mono text-base text-text-2">{target.id} · {target.cli_flag}</p>
          <p className="mb-6 flex flex-wrap items-center gap-3.5" data-testid="machine-detail-status">
            {hostDetectionStatus(target, host.detectionState) !== 'unknown' && (
              <StatusPill tone={HOST_STATUS_TONE[hostDetectionStatus(target, host.detectionState)]} testId="machine-detail-badge">
                {t(`machines.pill_${hostDetectionStatus(target, host.detectionState)}`)}
              </StatusPill>
            )}
            <span className="text-base text-text-2">{detectionNote(target, host.detectionState, t)}</span>
          </p>
        </>
      )}
      sheets={<SheetTabs sheets={sheets} active={sheet} onChange={onSheet} ariaLabel={t('shell.sheet_label')} idPrefix="machine-detail" />}
      footer={(
        <>
          <p className="min-w-0 flex-1 truncate font-mono text-body text-text-2" data-testid="machine-footer-command" title={command ?? undefined}>
            {command ?? <span className="font-sans">{target === null ? t('hostPlan.awaiting_host') : t('hostPlan.awaiting_operation')}</span>}
          </p>
          <span className="flex items-center gap-3">
            {copyState !== 'idle' && (
              <span className={`text-caption font-semibold ${copyState === 'success' ? 'text-green-d' : 'text-red-d'}`} role="status">
                {copyState === 'success' ? t('hostPlan.copy_success') : t('hostPlan.copy_error')}
              </span>
            )}
            <button
              type="button"
              className="inline-flex min-h-10 items-center gap-2 rounded-md border border-border bg-card px-4 text-base font-semibold text-text hover:border-text-3 disabled:cursor-not-allowed disabled:opacity-50"
              data-testid="machine-footer-copy"
              disabled={command === null}
              onClick={copyCommand}
            >
              <Copy className="size-4" aria-hidden="true" />
              {t('machines.footer_copy')}
            </button>
          </span>
        </>
      )}
    >
      {target !== null && sheet === 'plan' && (
        <div
          ref={planRef}
          className="scroll-mt-16 outline-none focus-visible:ring-2 focus-visible:ring-(--accent)"
          data-testid="host-plan-detail"
          tabIndex={-1}
        >
          <PlanSheet
            target={target}
            selectedOperation={host.selectedOperation}
            planState={host.planState}
            copyText={copyText}
            onRequestPlan={host.requestPlan}
          />
        </div>
      )}
      {target !== null && sheet === 'capabilities' && (
        <CapabilitiesSheet target={target} adapters={probes.adapters} currentRoot={currentRoot} />
      )}
      <div hidden={sheet !== 'readiness'}><ReadinessSheet probes={probes} probeRoot={currentRoot} /></div>
      <div hidden={sheet !== 'blockers'}><BlockersSheet probes={probes} /></div>
      <div hidden={sheet !== 'risks'}><RisksSheet probes={probes} snapshot={snapshot} currentRoot={currentRoot} onOpenProject={onOpenProject} /></div>
      <div hidden={sheet !== 'diagnostics'}><DiagnosticsSheet snapshot={snapshot} /></div>
    </DetailColumn>
  )
}
