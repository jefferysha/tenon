import { useMemo } from 'react'
import { AlertTriangle, Clock3, Terminal, Workflow } from 'lucide-react'
import type { WbAutomationSettings } from '../api/client'
import { useT } from '../i18n'
import { SheetTabs, useSheetState, type SheetDef } from '../shared/DetailSheets'
import { RunAuditPanel } from '../shared/RunAuditPanel'
import { DetailColumn, StatusPill } from '../shell/ThreeColumns'
import { PhaseRail } from '../workspace/PhaseRail'
import { fieldStr } from '../workspace/taskRows'
import { railStages, stageExecution } from '../workspace/workspaceModel'
import { ConcurrencyField } from './ConcurrencyField'
import { runPhaseLabel, runStateLabel, runTone, type AutomationRow } from './automationModel'
import { TaskRunPanel } from './TaskRunPanel'

const SHEET_IDS = ['overview', 'run', 'handle', 'records'] as const
type SheetId = (typeof SHEET_IDS)[number]

export interface RunDetailPaneProps {
  row: AutomationRow
  root: string
  /** 失败原因（已经过 formatServerProse 处理的一句话）；非失败态为 ''。 */
  failureText: string
  /** 失败且有 worktree 时的终端接管命令；否则 null。 */
  takeoverCmd: string | null
  onCopy: (cmd: string) => void
  onRetryPreview: () => void
  onOpenPipeline: () => void
  displayTime: (value: string) => string
  settings: WbAutomationSettings | null
  settingsBusy: boolean
  onMaxParallel: (next: number) => void
}

/**
 * 自动化页右列 · 运行详情：固定头部（eyebrow / 标题 / slug / 状态 + 一句说明 / 阶段轨）+ sheet：
 * 概览 · 运行 · 处置 · 记录。阶段轨与工作台同源（stageExecution），同一任务两页口径一致。
 */
export function RunDetailPane({
  row,
  root,
  failureText,
  takeoverCmd,
  onCopy,
  onRetryPreview,
  onOpenPipeline,
  displayTime,
  settings,
  settingsBusy,
  onMaxParallel,
}: RunDetailPaneProps): JSX.Element {
  const { t } = useT()
  const change = row.row.change
  const state = row.row.state
  const stages = useMemo(() => stageExecution(change, row.rules, state, t), [change, row.rules, state, t])
  const rail = useMemo(() => railStages(stages), [stages])
  const currentStep = stages.find((stage) => stage.status === 'current' || stage.status === 'failed')?.step ?? change.phase

  const sheets: readonly SheetDef<SheetId>[] = useMemo(() => [
    { id: 'overview', label: t('automation.sheet_overview') },
    { id: 'run', label: t('automation.sheet_run') },
    { id: 'handle', label: t('automation.sheet_handle') },
    { id: 'records', label: t('automation.sheet_records') },
  ], [t])
  const [sheet, setSheet] = useSheetState<SheetId>('tenon-dashboard-sheet:automation', sheets, 'overview')
  const sheetLabel = sheets.find((candidate) => candidate.id === sheet)?.label ?? ''

  const statusNote = state === 'failed'
    ? failureText
    : t('automation.status_note', { phase: runPhaseLabel(row, t), state: runStateLabel(state, t) })
  const facts: string[] = [
    t('afk.fact_workflow', { value: row.workflow }),
    fieldStr(change, 'autonomy_level') !== '' ? t('afk.fact_autonomy', { value: fieldStr(change, 'autonomy_level') }) : '',
    fieldStr(change, 'skill_bundle_id') !== '' ? t('afk.fact_skills', { value: fieldStr(change, 'skill_bundle_id') }) : '',
    fieldStr(change, 'automation_container') !== '' ? t('afk.fact_container', { value: fieldStr(change, 'automation_container') }) : '',
    change.updated_at ? t('afk.updated_at', { time: displayTime(change.updated_at) }) : t('afk.updated_unknown'),
  ].filter((fact) => fact !== '')
  const refreshKey = `${change.phase} ${fieldStr(change, 'automation')} ${change.updated_at}`

  return (
    <DetailColumn
      testId="afk-detail"
      panelId="afk-detail-panel"
      labelledBy={`afk-detail-tab-${sheet}`}
      header={(
        <>
          <p className="mb-2.5 text-caption font-semibold text-(--accent)">{t('automation.eyebrow_detail')} / {sheetLabel}</p>
          <h1 className="mb-1.5 text-page font-bold tracking-[-.01em] text-text [overflow-wrap:anywhere]" data-testid="afk-detail-title">{change.name}</h1>
          <p className="mb-4 font-mono text-base text-text-2">{[row.workflow, change.track].filter(Boolean).join(' · ')}</p>
          <p className="mb-6 flex flex-wrap items-center gap-3.5" data-testid="afk-detail-status">
            <StatusPill tone={runTone(state)} testId="afk-detail-badge">{runStateLabel(state, t)}</StatusPill>
            <span className="text-base text-text-2">{statusNote}</span>
          </p>
          {rail.length > 0 && (
            <div className="mb-6">
              <PhaseRail stages={rail} selected={currentStep} onSelect={() => setSheet('run')} />
            </div>
          )}
        </>
      )}
      sheets={<SheetTabs sheets={sheets} active={sheet} onChange={setSheet} ariaLabel={t('shell.sheet_label')} idPrefix="afk-detail" />}
      footer={(
        <>
          <p className="text-body text-text-2">{t('automation.footer_note')}</p>
          <button
            type="button"
            className="inline-flex min-h-10 items-center gap-2 rounded-md border border-border bg-card px-4 text-base font-semibold text-text hover:border-text-3"
            data-testid={`afk-flow-${change.name}`}
            onClick={onOpenPipeline}
          >
            <Workflow className="size-4" aria-hidden="true" />
            {t('afk.view_flow')} <span aria-hidden="true">→</span>
          </button>
        </>
      )}
    >
      {sheet === 'overview' && (
        <div className="grid gap-6" data-testid="afk-run-facts">
          <section>
            <h2 className="mb-3.5 text-section font-bold text-text">{t('automation.facts_title')}</h2>
            <ul className="flex flex-wrap gap-2">
              {facts.map((fact) => (
                <li key={fact} className="max-w-full truncate rounded-sm bg-fill px-2.5 py-1.5 text-caption font-semibold text-text-2">{fact}</li>
              ))}
            </ul>
          </section>
          <section>
            <h2 className="mb-3.5 text-section font-bold text-text">{t('afk.activity_title')}</h2>
            <ul className="grid gap-2">
              <li className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 rounded-md border border-border bg-card px-4 py-3">
                <Clock3 className="size-4 text-text-3" aria-hidden="true" />
                <span className="min-w-0">
                  <span className="block text-base font-semibold text-text">{state === 'failed' ? t('afk.activity_verify_failed') : runStateLabel(state, t)}</span>
                  <span className="block text-caption text-text-2">{change.updated_at ? displayTime(change.updated_at) : t('afk.time_unknown')}</span>
                </span>
              </li>
            </ul>
          </section>
          <button
            type="button"
            className="inline-flex min-h-10 w-fit items-center gap-2 rounded-md border border-border bg-card px-4 text-base font-semibold text-text-2 hover:bg-fill"
            data-testid={`afk-flow-inline-${change.name}`}
            onClick={onOpenPipeline}
          >
            <Workflow className="size-4" aria-hidden="true" />
            {t('afk.view_flow')}
          </button>
        </div>
      )}
      {sheet === 'run' && <TaskRunPanel root={root} change={change.name} />}
      {sheet === 'handle' && (
        <div className="grid gap-6" data-testid="afk-handle-sheet">
          {state === 'failed' ? (
            <section className="rounded-md border border-red-b bg-red-t/45 px-4 py-3" data-testid="afk-failure">
              <div className="flex gap-3">
                <AlertTriangle className="mt-0.5 size-4 flex-none text-red" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <h2 className="text-base font-semibold text-text">{t('afk.verify_failed_title', { reason: failureText })}</h2>
                  <p className="mt-1 text-caption text-text-2">{t('afk.verify_failed_hint')}</p>
                </div>
                <button
                  type="button"
                  className="min-h-9 flex-none rounded-md bg-btn-bg px-3 text-caption font-semibold text-btn-fg"
                  data-testid={`afk-retry-preview-${change.name}`}
                  onClick={onRetryPreview}
                >
                  {t('afk.retry_preview')}
                </button>
              </div>
            </section>
          ) : (
            <p className="rounded-md border border-dashed border-border px-5 py-8 text-center" role="status" data-testid="afk-handle-none">
              <span className="block text-base font-semibold text-text">{t('automation.handle_none_title')}</span>
              <span className="mt-1 block text-body text-text-2">{t('automation.handle_none_desc')}</span>
            </p>
          )}
          {takeoverCmd !== null && (
            <section>
              <h2 className="mb-3.5 text-section font-bold text-text">{t('automation.takeover_title')}</h2>
              <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-md border border-border bg-card px-4 py-3">
                <Terminal className="size-4 text-text-3" aria-hidden="true" />
                <span className="min-w-0">
                  <span className="block text-body font-semibold text-text">{t('afk.take_over')}</span>
                  <code className="block truncate font-mono text-caption text-text-2">{takeoverCmd}</code>
                </span>
                <button
                  type="button"
                  className="min-h-8 rounded-sm border border-border bg-card px-3 text-body text-text-2 hover:border-text-3 hover:text-text"
                  data-testid={`afk-cmd-${change.name}`}
                  title={takeoverCmd}
                  aria-label={`${t('progress.cmd_takeover')}: ${takeoverCmd}`}
                  onClick={() => onCopy(takeoverCmd)}
                >
                  {t('automation.copy')}
                </button>
              </div>
            </section>
          )}
          <ConcurrencyField settings={settings} busy={settingsBusy} onChange={onMaxParallel} />
        </div>
      )}
      {sheet === 'records' && <RunAuditPanel root={root} change={change.name} refreshKey={refreshKey} />}
    </DetailColumn>
  )
}
