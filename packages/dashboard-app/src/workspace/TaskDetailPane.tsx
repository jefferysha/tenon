import { useEffect, useMemo, useState } from 'react'
import { Link2 } from 'lucide-react'
import { useT } from '../i18n'
import { DetailColumn, StatusPill, type PillTone } from '../shell/ThreeColumns'
import { dashboardSearch } from '../shell/dashboardLocation'
import { DocumentDrawer } from './DocumentDrawer'
import { StageIoPanel } from './StageIoPanel'
import { StageRail } from './StageRail'
import { fallbackStepIo, readableFiles, stageInputs, stageOutputs } from './stageIo'
import { stageLabel, summaryText, type TaskRow } from './taskModel'
import { useWorkflowDefinition } from './useWorkflowDefinition'

const TONE: Record<TaskRow['summary']['kind'], PillTone> = {
  missing: 'pending',
  review: 'blocked',
  ready: 'done',
  running: 'running',
  archived: 'neutral',
}

export interface TaskDetailPaneProps {
  row: TaskRow
  onToast?: (message: string) => void
  /** 聚合语境为 false：不发 per-root 请求，IO 退化为快照里的输出字段名。 */
  fetchDefinition?: boolean
}

/** 工作台右列：任务名 / 一行状态 / 阶段轨 → 所选阶段的输出与输入 → 点文件开抽屉。 */
export function TaskDetailPane({ row, onToast, fetchDefinition = true }: TaskDetailPaneProps): JSX.Element {
  const { t } = useT()
  const { change, root } = row
  const current = row.stages.find((stage) => stage.status === 'current')?.id ?? change.phase
  const [selectedStep, setSelectedStep] = useState<string>(current)
  const identity = `${root} ${change.name}`
  useEffect(() => { setSelectedStep(current) }, [identity, current])
  const definition = useWorkflowDefinition(root, row.workflow, fetchDefinition)
  const stepIo = definition.status === 'ready'
    ? definition.def.effectiveIo?.[selectedStep]
    : definition.status === 'disabled' ? fallbackStepIo(change, selectedStep) : undefined
  const definitionState = definition.status === 'disabled' ? 'ready' : definition.status
  const outputs = useMemo(() => stageOutputs(change, stepIo), [change, stepIo])
  const inputs = useMemo(() => stageInputs(change, stepIo), [change, stepIo])
  const files = useMemo(() => readableFiles([...outputs, ...inputs]), [outputs, inputs])
  const [openIndex, setOpenIndex] = useState<number | null>(null)
  useEffect(() => { setOpenIndex(null) }, [identity, selectedStep])
  const activePath = openIndex === null ? null : files[openIndex]?.path ?? null

  function copyLink(): void {
    const search = dashboardSearch(window.location.search, { view: 'progress', root, change: change.name })
    const link = `${window.location.origin}${window.location.pathname}${search}`
    void navigator.clipboard?.writeText(link).then(() => onToast?.(t('detail.copied', { value: link })))
  }

  return (
    <>
      <DetailColumn
        testId="task-detail-pane"
        panelId="task-detail-panel"
        header={(
          <>
            <p className="mb-2.5 text-caption font-semibold text-(--accent)">{stageLabel(selectedStep, row.rules, t)}</p>
            <h1 className="mb-1.5 text-page font-bold tracking-[-.01em] text-text [overflow-wrap:anywhere]" data-testid="task-detail-title">{change.name}</h1>
            <p className="mb-4 font-mono text-base text-text-2">{[row.workflow, change.track].filter(Boolean).join(' · ')}</p>
            <p className="mb-6" data-testid="task-detail-status">
              <StatusPill tone={TONE[row.summary.kind]} testId="task-detail-badge">{summaryText(row, t)}</StatusPill>
            </p>
            {row.stages.length > 0 && (
              <div className="mb-6 border-b border-border pb-6">
                <StageRail stages={row.stages} selected={selectedStep} onSelect={setSelectedStep} />
              </div>
            )}
          </>
        )}
        footer={(
          <button
            type="button"
            className="ml-auto inline-flex min-h-10 items-center gap-2 rounded-md border border-border bg-card px-4 text-base font-semibold text-text hover:border-text-3"
            data-testid="task-detail-copy-link"
            onClick={copyLink}
          >
            <Link2 className="size-4" aria-hidden="true" />
            {t('workspace.copy_link')}
          </button>
        )}
      >
        <StageIoPanel
          outputs={outputs}
          inputs={inputs}
          activePath={activePath}
          definitionState={definitionState}
          onOpen={(path) => setOpenIndex(files.findIndex((file) => file.path === path))}
        />
      </DetailColumn>
      <DocumentDrawer root={root} files={files} index={openIndex} onIndex={setOpenIndex} onClose={() => setOpenIndex(null)} />
    </>
  )
}
