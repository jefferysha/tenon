import { useEffect, useMemo, useRef, useState } from 'react'
import { ShieldCheck, Zap } from 'lucide-react'
import { useT } from '../i18n'
import { TaskRecords } from './TaskRecords'
import { DetailColumn, StatusPill } from '../shell/ThreeColumns'
import { SheetTabs } from '../shared/DetailSheets'
import { SkillFlow } from '../workflow/SkillFlow'
import { AgentRunDrawer } from './AgentRunDrawer'
import { DocumentDrawer } from './DocumentDrawer'
import { StageAgentsPanel } from './StageAgentsPanel'
import { StageIoPanel } from './StageIoPanel'
import { StageTestsPanel } from './StageTestsPanel'
import { TestRunDrawer } from './TestRunDrawer'
import { stageTestCount, stageTestRows } from './stageTests'
import { StageRail } from './StageRail'
import { fallbackStepIo, gateProgress, isReadyRow, readableFiles, skillsFromRuns, stageInputs, stageOutputs } from './stageIo'
import { summaryShort, type TaskRow } from './taskModel'
import { useWorkflowDefinition } from './useWorkflowDefinition'
import { ReviewDecisionPanel } from './ReviewDecisionPanel'
import { summaryTone } from './TaskCard'
import { TaskMenu, type TaskMenuEntry } from './TaskMenu'
import { readWorkspaceParam, writeWorkspaceParam } from './workspaceLocation'

export interface TaskDetailPaneProps {
  row: TaskRow
  onToast?: (message: string) => void
  onRefresh?: () => void | Promise<void>
  showReviewConsole?: boolean
  /** 聚合语境为 false：不发 per-root 请求，IO 退化为快照里的输出字段名。 */
  fetchDefinition?: boolean
  /** 标题右侧 ⋯ 菜单（与卡片 ⋯ 同一份 taskMenuItems）；缺省 = 无菜单。 */
  menu?: readonly TaskMenuEntry[]
  /** 已归档视图：不显示评审台。 */
  archived?: boolean
}

/** URL 里的 step 只对它所属的任务生效：change 缺省（隐式选中首条）或与本任务同名。 */
function initialStep(row: TaskRow, current: string): string {
  const step = readWorkspaceParam('step')
  const change = new URLSearchParams(window.location.search).get('change')
  if (step === null || (change !== null && change !== row.change.name)) return current
  return row.stages.some((stage) => stage.id === step) ? step : current
}

/** 工作台右列：任务名 / 一行状态 / 阶段轨 → 所选阶段的输出与输入 → 点文件开抽屉。 */
export function TaskDetailPane({ row, onToast, onRefresh, showReviewConsole = false, fetchDefinition = true, menu = [], archived = false }: TaskDetailPaneProps): JSX.Element {
  const { t } = useT()
  const { change, root } = row
  const current = row.stages.find((stage) => stage.status === 'current')?.id ?? change.phase
  const [selectedStep, setSelectedStep] = useState<string>(() => initialStep(row, current))
  const identity = `${root} ${change.name}`
  // SSE replaces the whole snapshot object; only this change's own state should reload its decisions.
  const decisionSignature = [change.phase, change.phase_status, change.updated_at, JSON.stringify(change.reviewHandshake ?? null)].join('\n')
  // 任务推进到新阶段时跟过去；首次挂载保留 URL 里的 step。
  const seen = useRef(`${identity}\n${current}`)
  useEffect(() => {
    const key = `${identity}\n${current}`
    if (seen.current === key) return
    seen.current = key
    setSelectedStep(current)
  }, [identity, current])
  useEffect(() => { writeWorkspaceParam('step', selectedStep === current ? null : selectedStep) }, [selectedStep, current])
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
  const testRows = useMemo(() => stageTestRows(change, selectedStep), [change, selectedStep])
  const [openTest, setOpenTest] = useState<string | null>(null)
  const [sheet, setSheet] = useState<'inputs' | 'outputs' | 'tests'>('outputs')
  const stepAgents = change.agentRuns?.find((step) => step.stepId === selectedStep)?.agents ?? []
  const [openAgent, setOpenAgent] = useState<string | null>(null)
  useEffect(() => { setOpenIndex(null); setOpenTest(null); setOpenAgent(null) }, [identity, selectedStep])
  useEffect(() => { if (sheet === 'tests' && testRows.length === 0) setSheet('outputs') }, [sheet, testRows.length])
  const activePath = openIndex === null ? null : files[openIndex]?.path ?? null
  const readyOutputs = outputs.filter(isReadyRow).length
  const reviewSatisfied = row.stages.find((stage) => stage.id === selectedStep)?.status === 'done'
    || (change.phase === selectedStep && change.reviewHandshake?.status === 'approved')
  const progress = gateProgress((row.rules ?? change.workflowRules).gateByStep[selectedStep] ?? null, outputs, reviewSatisfied)
  // 没有运行记录的技能不写「未开始」：只有当前阶段仍在进行时它才是真话，否则与阶段状态矛盾。
  const stageRunning = selectedStep === change.phase && (row.summary.kind === 'running' || row.summary.kind === 'missing')
  const statusOf = (id: string): { state: 'idle' | 'running' | 'done'; label: string } | null => {
    const hit = runs?.skills.find((skill) => skill.id === id)
    if (hit === undefined || (hit.status === 'idle' && !stageRunning)) return null
    return { state: hit.status, label: t(`workspace.skill_${hit.status}`) }
  }

  return (
    <>
      <DetailColumn
        testId="task-detail-pane"
        panelId="task-detail-panel"
        header={(
          <>
            <div className="mb-1.5 flex min-w-0 items-center gap-2">
              <h1 className="min-w-0 flex-1 truncate text-page font-bold tracking-[-.01em] text-text" title={change.name} data-testid="task-detail-title">{change.name}</h1>
              <TaskMenu items={menu} testId="task-detail-menu" />
            </div>
            <p className="mb-4 truncate whitespace-nowrap font-mono text-base text-text-2" data-testid="task-detail-meta">{[change.track === '' ? row.workflow : `${row.workflow}/${change.track}`, row.owner?.name].filter(Boolean).join(' · ')}</p>
            <p className="mb-6" data-testid="task-detail-status">
              <StatusPill tone={summaryTone(row)} testId="task-detail-badge">{summaryShort(row, t)}</StatusPill>
            </p>
            {showReviewConsole && !archived && <ReviewDecisionPanel root={root} change={change.name} snapshotSignature={decisionSignature} onRefresh={onRefresh} onToast={onToast} />}
            {row.stages.length > 0 && (
              <div className="mb-6 border-b border-border pb-6">
                <StageRail stages={row.stages} selected={selectedStep} onSelect={setSelectedStep} />
              </div>
            )}
          </>
        )}
      >
        {skills.length > 0 && (
          <section className="mb-8" data-testid="stage-skills">
            <h2 className="mb-3 text-title font-semibold text-text">{t('workspace.skills')}<span className="ml-2 font-mono text-caption font-normal text-text-3">{skills.length}</span></h2>
            <SkillFlow key={`${identity} ${selectedStep}`} skills={skills} registry={null} editable={false} onOpen={() => undefined} statusOf={statusOf} />
          </section>
        )}
        <StageAgentsPanel identity={identity} stepId={selectedStep} agents={stepAgents} onOpen={setOpenAgent} />
        {progress !== null && (
          <p className="mb-3 flex items-center gap-2 whitespace-nowrap text-body text-text-2" data-testid="task-gate-row">
            {progress.gate === 'review'
              ? <ShieldCheck className="size-4 flex-none text-amber-d" aria-hidden="true" />
              : <Zap className="size-4 flex-none text-(--accent)" aria-hidden="true" />}
            {t(`workspace.gate_${progress.gate}`)}
            <span className="font-mono text-text-3">· {progress.done}/{progress.total}</span>
          </p>
        )}
        {(inputs.length > 0 || outputs.length > 0 || testRows.length > 0) && (
          <div className="grid gap-4" data-testid="stage-io">
            <SheetTabs
              sheets={[
                { id: 'inputs', label: t('workspace.inputs'), count: inputs.length },
                { id: 'outputs', label: t('workspace.outputs'), count: `${readyOutputs}/${outputs.length}` },
                ...(testRows.length === 0
                  ? []
                  : [{ id: 'tests' as const, label: t('workspace.tests'), count: stageTestCount(testRows) }]),
              ]}
              active={sheet}
              onChange={setSheet}
              ariaLabel={t('workspace.io_sheets')}
              idPrefix="task-io"
            />
            {sheet === 'tests' ? (
              <StageTestsPanel rows={testRows} activeId={openTest} onOpen={setOpenTest} />
            ) : (
              <StageIoPanel
                direction={sheet}
                items={sheet === 'inputs' ? inputs : outputs}
                activePath={activePath}
                definitionState={definitionState}
                onOpen={(path) => setOpenIndex(files.findIndex((file) => file.path === path))}
              />
            )}
          </div>
        )}
        {fetchDefinition && <TaskRecords root={root} change={change.name} signature={decisionSignature} />}
      </DetailColumn>
      <DocumentDrawer root={root} files={files} index={openIndex} onIndex={setOpenIndex} onClose={() => setOpenIndex(null)} />
      <AgentRunDrawer
        root={root}
        agent={stepAgents.find((agent) => agent.agent === openAgent) ?? null}
        onClose={() => setOpenAgent(null)}
      />
      <TestRunDrawer
        root={root}
        change={change.name}
        row={testRows.find((item) => item.id === openTest) ?? null}
        onClose={() => setOpenTest(null)}
      />
    </>
  )
}
