import { useMemo } from 'react'
import type { WbAutomationSettings } from '../api/client'
import { useT } from '../i18n'
import type { SchedulerHealthSummary } from '../model/progressModel'
import { SheetTabs, useSheetState, type SheetDef } from '../shared/DetailSheets'
import { DetailColumn, StatusPill, type PillTone } from '../shell/ThreeColumns'
import { ConcurrencyField } from './ConcurrencyField'
import { OperationsPanel } from './OperationsPanel'

const HEALTH_TONE: Record<SchedulerHealthSummary['status'], PillTone> = { ok: 'done', busy: 'running', attention: 'blocked' }

type SheetId = 'limit' | 'starter' | 'run'

export interface AutomationSettingsPaneProps {
  root: string
  projectName: string
  health: SchedulerHealthSummary
  settings: WbAutomationSettings | null
  settingsBusy: boolean
  onMaxParallel: (next: number) => void
  /** snapshot.capabilities.operations：为 true 时才有定时任务的 starter / run 两个 sheet。 */
  operations: boolean
  onToast?: (message: string) => void
  onOpenChange?: (name: string) => void
}

/** 自动化页右列 · 节奏设置：并发（上限 + 重试 + 默认入队）/ 新建定时任务 / 验证定时任务。 */
export function AutomationSettingsPane({
  root,
  projectName,
  health,
  settings,
  settingsBusy,
  onMaxParallel,
  operations,
  onToast,
  onOpenChange,
}: AutomationSettingsPaneProps): JSX.Element {
  const { t } = useT()
  const sheets: readonly SheetDef<SheetId>[] = useMemo(() => {
    const base: SheetDef<SheetId>[] = [{ id: 'limit', label: t('automation.settings_sheet_limit') }]
    if (operations) {
      base.push({ id: 'starter', label: t('afk.tool_schedule') }, { id: 'run', label: t('afk.tool_validate') })
    }
    return base
  }, [operations, t])
  const [sheet, setSheet] = useSheetState<SheetId>('tenon-dashboard-sheet:automation-settings', sheets, 'limit')
  const sheetLabel = sheets.find((candidate) => candidate.id === sheet)?.label ?? ''

  return (
    <DetailColumn
      testId="afk-settings"
      panelId="afk-settings-panel"
      labelledBy={`afk-settings-tab-${sheet}`}
      header={(
        <>
          <p className="mb-2.5 text-caption font-semibold text-(--accent)">{t('automation.eyebrow_detail')} / {sheetLabel}</p>
          <h1 className="mb-1.5 text-page font-bold tracking-[-.01em] text-text">{t('automation.settings')}</h1>
          <p className="mb-4 font-mono text-base text-text-2">{projectName}</p>
          <p className="mb-6 flex flex-wrap items-center gap-3.5">
            <StatusPill tone={HEALTH_TONE[health.status]} testId="afk-settings-health">{t(`automation.health_${health.status}`)}</StatusPill>
            <span className="text-base text-text-2">{t('automation.health_note', { running: health.running, queued: health.queued, failed: health.failed })}</span>
          </p>
        </>
      )}
      sheets={<SheetTabs sheets={sheets} active={sheet} onChange={setSheet} ariaLabel={t('shell.sheet_label')} idPrefix="afk-settings" />}
      footer={<p className="text-body text-text-2">{t('automation.settings_footer')}</p>}
    >
      {sheet === 'limit' && (
        <div className="grid gap-6">
          <ConcurrencyField settings={settings} busy={settingsBusy} onChange={onMaxParallel} />
          {settings !== null && (
            <ul className="grid grid-cols-3 gap-2 max-[900px]:grid-cols-1" data-testid="afk-settings-stats">
              <li className="grid gap-1 rounded-md border border-border bg-card px-4 py-3.5">
                <span className="text-body text-text-2">{t('automation.stat_limit')}</span>
                <span className="font-mono text-section font-bold text-text">{settings.max_parallel}</span>
              </li>
              <li className="grid gap-1 rounded-md border border-border bg-card px-4 py-3.5">
                <span className="text-body text-text-2">{t('automation.stat_retries')}</span>
                <span className="font-mono text-section font-bold text-text">{settings.max_retries}</span>
              </li>
              <li className="grid gap-1 rounded-md border border-border bg-card px-4 py-3.5">
                <span className="text-body text-text-2">{t('automation.stat_opt_in')}</span>
                <span className="font-mono text-section font-bold text-text">{t(settings.default_opt_in ? 'automation.opt_in_on' : 'automation.opt_in_off')}</span>
              </li>
            </ul>
          )}
          {!operations && (
            <p className="rounded-md border border-dashed border-border px-4 py-3 text-body text-text-2" role="status" data-testid="afk-ops-unavailable">{t('automation.ops_unavailable')}</p>
          )}
        </div>
      )}
      {sheet === 'starter' && operations && <OperationsPanel root={root} onToast={onToast} onOpenChange={onOpenChange} activeTool="starter" compact />}
      {sheet === 'run' && operations && <OperationsPanel root={root} onToast={onToast} onOpenChange={onOpenChange} activeTool="run" compact />}
    </DetailColumn>
  )
}
