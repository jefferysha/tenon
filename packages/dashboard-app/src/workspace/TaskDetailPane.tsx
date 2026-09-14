import { useEffect, useMemo, useState } from 'react'
import { Link2 } from 'lucide-react'
import { useT } from '../i18n'
import { DetailColumn, StatusPill, type PillTone } from '../shell/ThreeColumns'
import { dashboardSearch } from '../shell/dashboardLocation'
import { SheetTabs } from '../shared/DetailSheets'
import { SkillFlow } from '../workflow/SkillFlow'
import { DocumentDrawer } from './DocumentDrawer'
import { ArtifactCatalogPanel } from './ArtifactCatalogPanel'
import { StageIoPanel } from './StageIoPanel'
import { StageRail } from './StageRail'
import { fallbackStepIo, readableFiles, skillsFromRuns, stageInputs, stageOutputs } from './stageIo'
import { stageLabel, summaryText, type TaskRow } from './taskModel'
import { useWorkflowDefinition } from './useWorkflowDefinition'
import { ReviewDecisionPanel } from './ReviewDecisionPanel'

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
  onRefresh?: () => void | Promise<void>
  showReviewConsole?: boolean
  /** 聚合语境为 false：不发 per-root 请求，IO 退化为快照里的输出字段名。 */
  fetchDefinition?: boolean
}

/** 工作台右列：任务名 / 一行状态 / 阶段轨 → 所选阶段的输出与输入 → 点文件开抽屉。 */
export function TaskDetailPane({ row, onToast, onRefresh, showReviewConsole = false, fetchDefinition = true }: TaskDetailPaneProps): JSX.Element {
  const { t } = useT()
  const { change, root } = row
  const current = row.stages.find((stage) => stage.status === 'current')?.id ?? change.phase
  const [selectedStep, setSelectedStep] = useState<string>(current)
  const identity = `${root} ${change.name}`
  // SSE replaces the whole snapshot object; only this change's own state should reload its decisions.
  const decisionSignature = [change.phase, change.phase_status, change.updated_at, JSON.stringify(change.reviewHandshake ?? null)].join('\n')
  useEffect(() => { setSelectedStep(current) }, [identity, current])
  const definition = useWorkflowDefinition(root, row.workflow, fetchDefinition)
  // change 走自己 track 的分支 IO；没有对应分支 → 通用分支。
  const stepIo = definition.status === 'ready'
    ? (definition.def.branches?.[change.track]?.effectiveIo ?? definition.def.branches?._base?.effectiveIo ?? definition.def.effectiveIo)?.[selectedStep]
    : definition.status === 'disabled' ? fallbackStepIo(change, selectedStep) : undefined
  const definitionState = definition.status === 'disabled' ? 'ready' : definition.status
  const outputs = useMemo(() => stageOutputs(change, stepIo), [change, stepIo])
  const inputs = useMemo(() => stageInputs(change, stepIo), [change, stepIo])
  const files = useMemo(() => readableFiles([...outputs, ...inputs]), [outputs, inputs])
  const [openIndex, setOpenIndex] = useState<number | null>(null)
  const [sheet, setSheet] = useState<'inputs' | 'outputs'>('outputs')
  useEffect(() => { setOpenIndex(null) }, [identity, selectedStep])
  const activePath = openIndex === null ? null : files[openIndex]?.path ?? null
  const runs = change.skillRuns?.find((step) => step.stepId === selectedStep)
  const artifactAttemptId = change.artifactAttempts?.find((attempt) => attempt.stageId === selectedStep)?.stageAttemptId
  const skills = useMemo(() => skillsFromRuns(runs), [runs])
  const statusOf = (id: string): { state: 'idle' | 'running' | 'done'; label: string } | null => {
    const hit = runs?.skills.find((skill) => skill.id === id)
    return hit === undefined ? null : { state: hit.status, label: t(`workspace.skill_${hit.status}`) }
  }

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
            <h1 className="mb-1.5 truncate text-page font-bold tracking-[-.01em] text-text" title={change.name} data-testid="task-detail-title">{change.name}</h1>
            <p className="mb-4 font-mono text-base text-text-2">{[row.workflow, change.track].filter(Boolean).join(' · ')}</p>
            <p className="mb-6" data-testid="task-detail-status">
              <StatusPill tone={TONE[row.summary.kind]} testId="task-detail-badge">{summaryText(row, t)}</StatusPill>
            </p>
            {showReviewConsole && <ReviewDecisionPanel root={root} change={change.name} snapshotSignature={decisionSignature} onRefresh={onRefresh} onToast={onToast} />}
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
        {skills.length > 0 && (
          <section className="mb-8" data-testid="stage-skills">
            <h2 className="mb-3 text-title font-semibold text-text">{t('workspace.skills')}<span className="ml-2 font-mono text-caption font-normal text-text-3">{skills.length}</span></h2>
            <SkillFlow key={`${identity} ${selectedStep}`} skills={skills} registry={null} editable={false} onOpen={() => undefined} statusOf={statusOf} className="h-56" />
          </section>
        )}
        {fetchDefinition && <div className="mb-8"><ArtifactCatalogPanel root={root} change={change.name} stageAttemptId={artifactAttemptId} stageId={selectedStep} /></div>}
        <div className="grid gap-4" data-testid="stage-io">
          <SheetTabs
            sheets={[{ id: 'inputs', label: t('workspace.inputs'), count: inputs.length }, { id: 'outputs', label: t('workspace.outputs'), count: outputs.length }]}
            active={sheet}
            onChange={setSheet}
            ariaLabel={t('workspace.io_sheets')}
            idPrefix="task-io"
          />
          <StageIoPanel
            direction={sheet}
            items={sheet === 'inputs' ? inputs : outputs}
            activePath={activePath}
            definitionState={definitionState}
            onOpen={(path) => setOpenIndex(files.findIndex((file) => file.path === path))}
          />
        </div>
      </DetailColumn>
      <DocumentDrawer root={root} files={files} index={openIndex} onIndex={setOpenIndex} onClose={() => setOpenIndex(null)} />
    </>
  )
}
