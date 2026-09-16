import { useEffect, useMemo, useState } from 'react'
import { Link2, ShieldCheck, UserCheck, Zap } from 'lucide-react'
import { useT } from '../i18n'
import { ApiError, formatApiError, getToken } from '../api/transport'
import { takeOwner } from '../api/userClient'
import type { UserRefView } from '../types'
import { TaskRecords } from './TaskRecords'
import { DetailColumn, StatusPill, type PillTone } from '../shell/ThreeColumns'
import { dashboardSearch } from '../shell/dashboardLocation'
import { SheetTabs } from '../shared/DetailSheets'
import { SkillFlow } from '../workflow/SkillFlow'
import { DocumentDrawer } from './DocumentDrawer'
import { StageIoPanel } from './StageIoPanel'
import { StageRail } from './StageRail'
import { fallbackStepIo, gateProgress, isReadyRow, readableFiles, skillsFromRuns, stageInputs, stageOutputs } from './stageIo'
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
  /** Current declared user; 接手 shows only for another user's task. */
  me?: UserRefView | null
  /** Opens the identity dialog when the server reports a missing identity. */
  onUserMissing?: () => void
}

/** 工作台右列：任务名 / 一行状态 / 阶段轨 → 所选阶段的输出与输入 → 点文件开抽屉。 */
export function TaskDetailPane({ row, onToast, onRefresh, showReviewConsole = false, fetchDefinition = true, me = null, onUserMissing }: TaskDetailPaneProps): JSX.Element {
  const { t } = useT()
  const [taking, setTaking] = useState(false)
  // 接手 and 记录 need a selected project, like the definition fetch: the aggregate view issues only /api/snapshot.
  const canTake = fetchDefinition && me !== null && row.owner?.slug !== me.slug && getToken() !== ''
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
  const runs = change.skillRuns?.find((step) => step.stepId === selectedStep)
  const skills = useMemo(() => skillsFromRuns(runs), [runs])
  const stageSkills = useMemo(() => skills.map((skill) => skill.id), [skills])
  const outputs = useMemo(() => stageOutputs(change, stepIo, stageSkills), [change, stepIo, stageSkills])
  const inputs = useMemo(() => stageInputs(change, stepIo), [change, stepIo])
  const files = useMemo(() => readableFiles([...outputs, ...inputs]), [outputs, inputs])
  const [openIndex, setOpenIndex] = useState<number | null>(null)
  const [sheet, setSheet] = useState<'inputs' | 'outputs'>('outputs')
  useEffect(() => { setOpenIndex(null) }, [identity, selectedStep])
  const activePath = openIndex === null ? null : files[openIndex]?.path ?? null
  const readyOutputs = outputs.filter(isReadyRow).length
  const reviewSatisfied = row.stages.find((stage) => stage.id === selectedStep)?.status === 'done'
    || (change.phase === selectedStep && change.reviewHandshake?.status === 'approved')
  const progress = gateProgress((row.rules ?? change.workflowRules).gateByStep[selectedStep] ?? null, outputs, reviewSatisfied)
  const statusOf = (id: string): { state: 'idle' | 'running' | 'done'; label: string } | null => {
    const hit = runs?.skills.find((skill) => skill.id === id)
    return hit === undefined ? null : { state: hit.status, label: t(`workspace.skill_${hit.status}`) }
  }

  async function take(): Promise<void> {
    setTaking(true)
    try {
      await takeOwner(root, change.name)
      onToast?.(t('workspace.take_done'))
      await onRefresh?.()
    } catch (error) {
      if (error instanceof ApiError && error.status === 412) {
        if (onUserMissing) onUserMissing()
        else onToast?.(t('common.user_missing'))
      } else if (error instanceof ApiError && error.status === 403) {
        onToast?.(t('workspace.owner_required', { name: row.owner?.name ?? '—' }))
      } else {
        onToast?.(formatApiError(error, t))
      }
    } finally {
      setTaking(false)
    }
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
            <p className="mb-4 truncate whitespace-nowrap font-mono text-base text-text-2" data-testid="task-detail-meta">{[row.workflow, change.track, row.owner?.name].filter(Boolean).join(' · ')}</p>
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
          <>
            {canTake && (
              <button
                type="button"
                className="inline-flex min-h-10 items-center gap-2 whitespace-nowrap rounded-md border border-border bg-card px-4 text-base font-semibold text-text hover:border-text-3 disabled:opacity-60"
                data-testid="task-detail-take"
                disabled={taking}
                onClick={() => { void take() }}
              >
                <UserCheck className="size-4" aria-hidden="true" />
                {t('workspace.take_owner')}
              </button>
            )}
            <button
              type="button"
              className="ml-auto inline-flex min-h-10 items-center gap-2 rounded-md border border-border bg-card px-4 text-base font-semibold text-text hover:border-text-3"
              data-testid="task-detail-copy-link"
              onClick={copyLink}
            >
              <Link2 className="size-4" aria-hidden="true" />
              {t('workspace.copy_link')}
            </button>
          </>
        )}
      >
        {skills.length > 0 && (
          <section className="mb-8" data-testid="stage-skills">
            <h2 className="mb-3 text-title font-semibold text-text">{t('workspace.skills')}<span className="ml-2 font-mono text-caption font-normal text-text-3">{skills.length}</span></h2>
            <SkillFlow key={`${identity} ${selectedStep}`} skills={skills} registry={null} editable={false} onOpen={() => undefined} statusOf={statusOf} className="h-56" />
          </section>
        )}
        {progress !== null && (
          <p className="mb-3 flex items-center gap-2 whitespace-nowrap text-body text-text-2" data-testid="task-gate-row">
            {progress.gate === 'review'
              ? <ShieldCheck className="size-4 flex-none text-amber-d" aria-hidden="true" />
              : <Zap className="size-4 flex-none text-(--accent)" aria-hidden="true" />}
            {t(`workspace.gate_${progress.gate}`)}
            <span className="font-mono text-text-3">· {progress.done}/{progress.total}</span>
          </p>
        )}
        {(inputs.length > 0 || outputs.length > 0) && (
          <div className="grid gap-4" data-testid="stage-io">
            <SheetTabs
              sheets={[
                { id: 'inputs', label: t('workspace.inputs'), count: inputs.length },
                { id: 'outputs', label: t('workspace.outputs'), count: `${readyOutputs}/${outputs.length}` },
              ]}
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
        )}
        {fetchDefinition && <TaskRecords root={root} change={change.name} signature={decisionSignature} />}
      </DetailColumn>
      <DocumentDrawer root={root} files={files} index={openIndex} onIndex={setOpenIndex} onClose={() => setOpenIndex(null)} />
    </>
  )
}
