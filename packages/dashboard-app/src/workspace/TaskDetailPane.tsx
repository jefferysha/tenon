import { useEffect, useMemo, useState } from 'react'
import { Link2 } from 'lucide-react'
import { useT } from '../i18n'
import { DetailColumn, StatusPill } from '../shell/ThreeColumns'
import { dashboardSearch } from '../shell/dashboardLocation'
import { FileWorkbench } from './FileWorkbench'
import { PhaseRail } from './PhaseRail'
import { rowBadgeOf, stepLabel, type FlatRow } from './taskRows'
import { useWorkflowDefinition } from './useWorkflowDefinition'
import { railStages, stageExecution } from './workspaceModel'

export interface TaskDetailPaneProps {
  row: FlatRow
  onToast?: (message: string) => void
}

/**
 * 工作台右列（模板 1:1）：任务名 / 状态 / 六段阶段轨 → 所选阶段的输入 / 输出文件 → 点文件即读。
 * 阶段轨可点：默认选中当前阶段。没有别的 sheet，也没有任何写操作。
 */
export function TaskDetailPane({ row, onToast }: TaskDetailPaneProps): JSX.Element {
  const { t } = useT()
  const change = row.row.change
  const root = row.row.root
  const badge = rowBadgeOf(row, t)
  const stages = useMemo(() => stageExecution(change, row.rules, row.row.state, t), [change, row.rules, row.row.state, t])
  const rail = useMemo(() => railStages(stages), [stages])
  const currentStep = stages.find((stage) => stage.status === 'current' || stage.status === 'failed')?.step ?? change.phase
  const [selectedStep, setSelectedStep] = useState<string>(currentStep)
  const identity = `${root} ${change.name}`
  useEffect(() => { setSelectedStep(currentStep) }, [identity, currentStep])
  const definition = useWorkflowDefinition(root, row.workflow)
  const step = definition.status === 'ready' ? definition.def.steps.find((candidate) => candidate.id === selectedStep) : undefined
  const stageLabel = stepLabel(selectedStep, row.rules, t)

  function copyLink(): void {
    const search = dashboardSearch(window.location.search, { view: 'progress', root, change: change.name })
    const link = `${window.location.origin}${window.location.pathname}${search}`
    void navigator.clipboard?.writeText(link).then(() => onToast?.(t('detail.copied', { value: link })))
  }

  return (
    <DetailColumn
      testId="task-detail-pane"
      panelId="task-detail-panel"
      header={(
        <>
          <p className="mb-2.5 text-caption font-semibold text-(--accent)">{stageLabel} / {t('workspace.eyebrow_detail')}</p>
          <h1 className="mb-1.5 text-page font-bold tracking-[-.01em] text-text [overflow-wrap:anywhere]" data-testid="task-detail-title">{change.name}</h1>
          <p className="mb-4 font-mono text-base text-text-2">{[row.workflow, change.track].filter(Boolean).join(' · ')}</p>
          <p className="mb-6 flex flex-wrap items-center gap-3.5" data-testid="task-detail-status">
            <StatusPill tone={badge.tone} testId="task-detail-badge">{badge.text}</StatusPill>
            <span className="text-base text-text-2">{badge.lead}</span>
          </p>
          {rail.length > 0 && (
            <div className="mb-6 border-b border-border pb-6">
              <PhaseRail stages={rail} selected={selectedStep} onSelect={setSelectedStep} />
            </div>
          )}
        </>
      )}
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
      <FileWorkbench root={root} change={change} stageLabel={stageLabel} step={step} definition={definition} />
    </DetailColumn>
  )
}
