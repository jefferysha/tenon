import { useEffect, useMemo, useState } from 'react'
import { Link2 } from 'lucide-react'
import { useT } from '../i18n'
import { SkillInvocationEvidenceCard } from '../shared/SkillInvocationEvidenceCard'
import { TaskDetail } from '../shared/TaskDetail'
import { TaskPlanPanel } from '../taskPlan/TaskPlanPanel'
import { VerificationEvidenceComposer } from '../verification/VerificationEvidenceComposer'
import { ContextBundlePreview } from '../progress/ContextBundlePreview'
import { ReviewHandshakeStatus } from '../progress/ReviewHandshakeStatus'
import { RunLogPane } from '../progress/RunLogPane'
import { SheetTabs, useSheetState, type SheetDef } from '../shared/DetailSheets'
import { DetailColumn, StatusPill } from '../shell/ThreeColumns'
import { dashboardSearch } from '../shell/dashboardLocation'
import { PhaseRail } from './PhaseRail'
import { StageExecutionList } from './StageExecutionList'
import { fieldStr, rowBadgeOf, stepLabel, type FlatRow } from './taskRows'
import { railStages, stageExecution } from './workspaceModel'

const SHEET_IDS = ['stages', 'outputs', 'skills', 'plan', 'terminal', 'history'] as const
type SheetId = (typeof SHEET_IDS)[number]

export interface TaskDetailPaneProps {
  row: FlatRow
  onToast?: (message: string) => void
}

/**
 * 工作台右列：固定头部（eyebrow / 标题 / slug / 状态 + 导语 / 阶段轨）+ sheet 页签：
 * 阶段执行 · 产出 · 技能 · 计划 · 终端 · 记录。产出 / 终端 / 记录三个 sheet 复用 TaskDetail 的既有
 * surface（数据接线与测试沿用），头部由本组件统一渲染，TaskDetail 自带的小头部隐藏。
 */
export function TaskDetailPane({ row, onToast }: TaskDetailPaneProps): JSX.Element {
  const { t, lang } = useT()
  const change = row.row.change
  const root = row.row.root
  const badge = rowBadgeOf(row, t)
  const stages = useMemo(() => stageExecution(change, row.rules, row.row.state, t), [change, row.rules, row.row.state, t])
  const rail = useMemo(() => railStages(stages), [stages])
  const currentStep = stages.find((stage) => stage.status === 'current' || stage.status === 'failed')?.step ?? change.phase
  const [expandedStage, setExpandedStage] = useState<string | null>(currentStep)
  const identity = `${root} ${change.name}`
  useEffect(() => { setExpandedStage(currentStep) }, [identity, currentStep])

  const sheets: readonly SheetDef<SheetId>[] = useMemo(() => [
    { id: 'stages', label: t('workspace.sheet_stages'), count: stages.length },
    { id: 'outputs', label: t('workspace.sheet_outputs') },
    { id: 'skills', label: t('workspace.sheet_skills') },
    { id: 'plan', label: t('workspace.sheet_plan') },
    { id: 'terminal', label: t('workspace.sheet_terminal') },
    { id: 'history', label: t('workspace.sheet_history') },
  ], [stages.length, t])
  const [sheet, setSheet] = useSheetState<SheetId>('tenon-dashboard-sheet:workspace', sheets, 'stages')

  function copy(value: string): void {
    void navigator.clipboard?.writeText(value).then(() => onToast?.(t('detail.copied', { value })))
  }
  function copyLink(): void {
    const search = dashboardSearch(window.location.search, { view: 'progress', root, change: change.name })
    copy(`${window.location.origin}${window.location.pathname}${search}`)
  }

  const automation = fieldStr(change, 'automation')
  const surfaceShell = '[&_[data-testid=dt-head]]:hidden'

  return (
    <DetailColumn
      testId="task-detail-pane"
      panelId="task-detail-panel"
      labelledBy={`task-detail-tab-${sheet}`}
      header={(
        <>
          <p className="mb-2.5 text-caption font-semibold text-(--accent)">{stepLabel(change.phase, row.rules, t)} / {t('workspace.eyebrow_detail')}</p>
          <h1 className="mb-1.5 text-page font-bold tracking-[-.01em] text-text [overflow-wrap:anywhere]" data-testid="task-detail-title">{change.name}</h1>
          <p className="mb-4 font-mono text-base text-text-2">{[row.workflow, change.track].filter(Boolean).join(' · ')}</p>
          <p className="mb-6 flex flex-wrap items-center gap-3.5" data-testid="task-detail-status">
            <StatusPill tone={badge.tone} testId="task-detail-badge">{badge.text}</StatusPill>
            <span className="text-base text-text-2">{badge.lead}</span>
          </p>
          {rail.length > 0 && (
            <div className="mb-6">
              <PhaseRail stages={rail} selected={expandedStage} onSelect={(step) => { setSheet('stages'); setExpandedStage(step) }} />
            </div>
          )}
        </>
      )}
      sheets={<SheetTabs sheets={sheets} active={sheet} onChange={setSheet} ariaLabel={t('shell.sheet_label')} idPrefix="task-detail" />}
      footer={(
        <>
          <p className="text-body text-text-2">{t('workspace.footer_note')}</p>
          <button
            type="button"
            className="inline-flex min-h-10 items-center gap-2 rounded-md border border-border bg-card px-4 text-base font-semibold text-text hover:border-text-3"
            data-testid="task-detail-copy-link"
            onClick={copyLink}
          >
            <Link2 className="size-4" aria-hidden="true" />
            {t('workspace.copy_link')}
          </button>
        </>
      )}
    >
      {sheet === 'stages' && (
        <>
          <div className="mb-3.5 flex items-baseline justify-between gap-4">
            <h2 className="text-section font-bold text-text">{t('workspace.sheet_stages')}</h2>
            <span className="text-body text-text-3">{t('workspace.stages_meta', { n: stages.length, done: stages.filter((stage) => stage.status === 'done').length })}</span>
          </div>
          {stages.length === 0 ? (
            <p className="text-body text-text-3" role="status">{t('detail.stages_unknown')}</p>
          ) : (
            <StageExecutionList
              change={change}
              stages={stages}
              expanded={expandedStage}
              onToggle={(step) => setExpandedStage((current) => current === step ? null : step)}
              onCopy={copy}
            />
          )}
        </>
      )}
      {sheet === 'outputs' && (
        <div className={surfaceShell}>
          <TaskDetail
            root={root}
            change={change}
            rules={row.rules}
            surface="outputs"
            curStageExtra={(
              <>
                <ReviewHandshakeStatus change={change} />
                <ContextBundlePreview key={`${identity} ${change.phase}`} root={root} change={change.name} currentPhase={change.phase} />
              </>
            )}
            documentsExtra={change.phase === 'verify'
              ? <VerificationEvidenceComposer locale={lang === 'zh' ? 'zh-CN' : 'en'} onToast={onToast} root={root} />
              : undefined}
            onToast={onToast}
          />
        </div>
      )}
      {sheet === 'skills' && <SkillInvocationEvidenceCard root={root} change={change.name} />}
      {sheet === 'plan' && <TaskPlanPanel root={root} change={change.name} />}
      {sheet === 'terminal' && (
        <div className={surfaceShell}>
          <p className="mb-3 rounded-sm border border-border bg-card px-3 py-2 text-caption text-text-2" data-testid="progress-terminal-boundary">{t('navigation.terminal_boundary')}</p>
          <TaskDetail root={root} change={change} rules={row.rules} surface="terminal" onToast={onToast} />
          {row.row.state === 'running' && automation === 'running' && <RunLogPane root={root} change={change} />}
        </div>
      )}
      {sheet === 'history' && (
        <div className={surfaceShell}>
          <TaskDetail root={root} change={change} rules={row.rules} surface="history" onToast={onToast} />
        </div>
      )}
    </DetailColumn>
  )
}
