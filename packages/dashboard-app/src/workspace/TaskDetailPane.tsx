import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ShieldCheck, Zap } from 'lucide-react'
import type { FlowEntry } from '../api/workflowOrchestrationClient'
import { formatApiError } from '../api/transport'
import { useT } from '../i18n'
import { TaskRecords } from './TaskRecords'
import { DetailColumn, StatusPill } from '../shell/ThreeColumns'
import { SheetTabs } from '../shared/DetailSheets'
import { OrchestrationFlow } from '../workflow/OrchestrationFlow'
import { AgentRunDrawer } from './AgentRunDrawer'
import { DocumentDrawer } from './DocumentDrawer'
import { StageIoPanel } from './StageIoPanel'
import { StageTestsPanel } from './StageTestsPanel'
import { SuiteRunDrawer } from './SuiteRunDrawer'
import { TaskTestsTab } from './TaskTestsTab'
import { TestRunDrawer } from './TestRunDrawer'
import { tabCount } from './testsTabModel'
import { stageTestCount, stageTestRows } from './stageTests'
import { StageRail } from './StageRail'
import { fallbackStepIo, gateProgress, isReadyRow, readableFiles, stageInputs, stageOutputs } from './stageIo'
import { stageLabel, summaryShort, type TaskRow } from './taskModel'
import { useChangeOrchestration } from './useChangeOrchestration'
import { ReviewDecisionPanel } from './ReviewDecisionPanel'
import { OwnerAvatar, summaryTone } from './TaskCard'
import { NextStepPanel } from './NextStepPanel'
import { BUTTON_GHOST } from '../shared/uiRecipes'
import { TaskMenu, type TaskMenuEntry } from './TaskMenu'
import { readWorkspaceParam, writeWorkspaceParam } from './workspaceLocation'
import { matchesTaskRef } from './taskRef'

export interface TaskDetailPaneProps {
  row: TaskRow
  onToast?: (message: string) => void
  onRefresh?: () => void | Promise<void>
  /** 评审待确认时显示评审台（已归档视图不显示）。 */
  showReviewConsole?: boolean
  /** false = 只读快照：不取任务编排与记录，IO 退化为快照里的输出字段名。工作台恒为 true（选中时才取）。 */
  fetchDefinition?: boolean
  /** 标题右侧 ⋯ 菜单（与卡片 ⋯ 同一份 taskMenuItems）；缺省 = 无菜单。 */
  menu?: readonly TaskMenuEntry[]
  /** 已归档视图：不显示评审台。 */
  archived?: boolean
  /**
   * The task's evidence (documents, runs, tests) comes from `GET /api/change/:name/snapshot`, not from the list row.
   * `loading` / `error` say it is not in `row` yet; absent = `row` already holds it.
   */
  evidence?: { status: 'loading' } | { status: 'error'; error: unknown; onRetry: () => void }
}

/** URL 里的 step 只对它所属的任务生效：change 缺省（隐式选中首条）或与本任务同名。 */
function initialStep(row: TaskRow, current: string): string {
  const step = readWorkspaceParam('step')
  const change = new URLSearchParams(window.location.search).get('change')
  if (step === null || (change !== null && !matchesTaskRef(change, row))) return current
  return row.stages.some((stage) => stage.id === step) ? step : current
}

type DetailView = 'stage' | 'overview'

/**
 * 工作台右列：任务名 / 一行状态 /「阶段 · 总览」页签。阶段页 = 阶段轨 → 所选阶段的编排画布（执行者 → 技能 →
 * 测试 → 评审者，带运行状态）→ 输出与输入；总览页 = 整条工作流的同一张画布，当前阶段高亮。
 * 编排与输入输出都读任务冻结的计划（不读当前定义）。
 */
export function TaskDetailPane({ row, onToast, onRefresh, showReviewConsole = true, fetchDefinition = true, menu = [], archived = false, evidence }: TaskDetailPaneProps): JSX.Element {
  const { t } = useT()
  const { change, root } = row
  const current = row.stages.find((stage) => stage.status === 'current')?.id ?? change.phase
  const [selectedStep, setSelectedStep] = useState<string>(() => initialStep(row, current))
  const [view, setView] = useState<DetailView>('stage')
  const identity = `${root} ${change.name}`
  // SSE replaces the whole snapshot object; only this change's own state should reload its decisions.
  const decisionSignature = [change.phase, change.phase_status, change.updated_at, JSON.stringify(change.reviewHandshake ?? null)].join('\n')
  // 编排的运行状态跟着技能 / agent / 测试 / 文档证据走，这些变了也要重取。
  // A list row names its evidence by `rev`; a row that carries the evidence itself is compared by content.
  const runSignature = [decisionSignature, change.rev ?? JSON.stringify([change.skillRuns ?? null, change.agentRuns ?? null, change.tests ?? null, change.documents ?? null])].join('\n')
  // 任务推进到新阶段时跟过去；首次挂载保留 URL 里的 step。
  const seen = useRef(`${identity}\n${current}`)
  useEffect(() => {
    const key = `${identity}\n${current}`
    if (seen.current === key) return
    seen.current = key
    setSelectedStep(current)
  }, [identity, current])
  useEffect(() => { writeWorkspaceParam('step', selectedStep === current ? null : selectedStep) }, [selectedStep, current])
  // 编排只在选中任务时取；状态、阶段名与计数都只读快照，编排加载前后不变。
  const orchestration = useChangeOrchestration(root, change.name, runSignature, fetchDefinition)
  const ready = orchestration.status === 'ready' ? orchestration.orchestration : null
  const labelOf = (id: string): string => stageLabel(id, row.rules)
  const stepIo = ready !== null
    ? ready.io[selectedStep]
    : orchestration.status === 'disabled' ? fallbackStepIo(change, selectedStep) : undefined
  const definitionState = orchestration.status === 'disabled' ? 'ready' : orchestration.status
  const stage = ready?.stages.find((candidate) => candidate.id === selectedStep)
  const stageSkills = useMemo(() => (stage?.entries ?? []).filter((entry) => entry.kind === 'skill').map((entry) => entry.id), [stage])
  const stageFlow = useMemo(() => stage === undefined || stage.entries.length === 0 ? [] : [stage], [stage])
  const outputs = useMemo(() => stageOutputs(change, stepIo, stageSkills), [change, stepIo, stageSkills])
  const inputs = useMemo(() => stageInputs(change, stepIo), [change, stepIo])
  const files = useMemo(() => readableFiles([...outputs, ...inputs]), [outputs, inputs])
  const [openIndex, setOpenIndex] = useState<number | null>(null)
  const testRows = useMemo(() => stageTestRows(change, selectedStep), [change, selectedStep])
  const policyReport = change.testPolicy?.find((report) => report.stepId === selectedStep)
  const hasTestsTab = policyReport !== undefined || testRows.length > 0
  const [openTest, setOpenTest] = useState<string | null>(null)
  const [openSuite, setOpenSuite] = useState<string | null>(null)
  const [sheet, setSheet] = useState<'inputs' | 'outputs' | 'tests'>('outputs')
  const stepAgents = change.agentRuns?.find((step) => step.stepId === selectedStep)?.agents ?? []
  const [openAgent, setOpenAgent] = useState<string | null>(null)
  useEffect(() => { setOpenIndex(null); setOpenTest(null); setOpenSuite(null); setOpenAgent(null) }, [identity, selectedStep])
  useEffect(() => { if (sheet === 'tests' && !hasTestsTab) setSheet('outputs') }, [sheet, hasTestsTab])
  const activePath = openIndex === null ? null : files[openIndex]?.path ?? null
  const openedSuite = openSuite === null ? undefined : policyReport?.suites.find((suite) => suite.suite === openSuite)
  const readyOutputs = outputs.filter(isReadyRow).length
  const reviewSatisfied = row.stages.find((candidate) => candidate.id === selectedStep)?.status === 'done'
    || (change.phase === selectedStep && change.reviewHandshake?.status === 'approved')
  const progress = gateProgress((row.rules ?? change.workflowRules).gateByStep[selectedStep] ?? null, outputs, reviewSatisfied)
  const openEntry = useCallback((_stage: string, entry: FlowEntry): void => {
    if (entry.kind === 'test') setOpenTest(entry.id)
    else if (entry.kind !== 'skill') setOpenAgent(entry.id)
  }, [])
  // 技能没有抽屉；策略要求运行的种类节点是一个种类（可能多个套件），也没有单一的运行可打开。
  const openable = useCallback((entry: FlowEntry): boolean => entry.kind !== 'skill' && entry.testKind === undefined, [])
  const openStage = useCallback((id: string): void => { setSelectedStep(id); setView('stage') }, [])
  const currentStage = row.stages.find((candidate) => candidate.status === 'current')?.id ?? null
  // 评审待确认：信号停在这一阶段的评审门前（总览与这一阶段的画布），不再流动。
  const heldStage = row.summary.kind === 'review' ? change.phase : null

  return (
    <>
      <DetailColumn
        testId="task-detail-pane"
        panelId="task-detail-panel"
        {...(fetchDefinition ? { labelledBy: `task-view-tab-${view}` } : {})}
        header={(
          <>
            {/* 头像与 ⋯ 同在标题行；状态词只在这一处（下一步区块不再重复「阻塞」与计数）。 */}
            <div className="mb-1.5 flex min-w-0 items-center gap-2">
              <h1 className="min-w-0 flex-1 truncate text-page font-bold tracking-[-.01em] text-text" title={change.name} data-testid="task-detail-title">{change.name}</h1>
              {row.owner !== null && <OwnerAvatar name={row.owner.name} testId="task-detail-owner" />}
              <TaskMenu items={menu} testId="task-detail-menu" />
            </div>
            <div className="mb-4 flex min-w-0 items-center gap-3">
              <p className="min-w-0 flex-1 truncate whitespace-nowrap font-mono text-base text-text-2" data-testid="task-detail-meta">{change.track === '' ? row.workflow : `${row.workflow}/${change.track}`}</p>
              <p className="flex-none" data-testid="task-detail-status">
                <StatusPill tone={summaryTone(row)} testId="task-detail-badge">{summaryShort(row, t)}</StatusPill>
              </p>
            </div>
            {!archived && <NextStepPanel row={row} onToast={onToast} />}
            {showReviewConsole && !archived && change.reviewHandshake?.status === 'pending' && (
              <ReviewDecisionPanel root={root} change={change.name} snapshotSignature={decisionSignature} rules={row.rules ?? change.workflowRules} phase={change.phase} onRefresh={onRefresh} onToast={onToast} />
            )}
            {fetchDefinition && (
              <div className="mb-5">
                <SheetTabs
                  sheets={[{ id: 'stage', label: t('workspace.tab_stage') }, { id: 'overview', label: t('workspace.tab_overview') }]}
                  active={view}
                  onChange={setView}
                  ariaLabel={t('workspace.detail_tabs')}
                  idPrefix="task-view"
                  controls="task-detail-panel"
                />
              </div>
            )}
            {view === 'stage' && row.stages.length > 0 && (
              <div className="mb-6 border-b border-border pb-6">
                <StageRail stages={row.stages} selected={selectedStep} onSelect={setSelectedStep} running={row.summary.kind === 'running'} />
              </div>
            )}
          </>
        )}
      >
        {orchestration.status === 'error' && (
          <p className="mb-6 truncate whitespace-nowrap text-body text-red-d" role="alert" data-testid="task-orchestration-error">{t('workspace.orchestration_error', { msg: formatApiError(orchestration.error, t) })}</p>
        )}
        {evidence?.status === 'error' && (
          <div className="mb-6 flex min-w-0 items-center gap-3 text-body text-red-d" role="alert" data-testid="task-detail-error">
            <p className="min-w-0 flex-1 truncate whitespace-nowrap">{t('workspace.detail_error', { msg: formatApiError(evidence.error, t) })}</p>
            <button type="button" className={BUTTON_GHOST} onClick={evidence.onRetry} data-testid="task-detail-retry">{t('common.snapshot_retry')}</button>
          </div>
        )}
        {evidence?.status === 'loading' && (
          <p className="mb-6 text-body text-text-3" role="status" data-testid="task-detail-loading">{t('common.loading')}</p>
        )}
        {view === 'overview' ? (
          ready === null
            ? orchestration.status === 'loading' && <p className="text-body text-text-3" role="status" data-testid="task-orchestration-loading">{t('common.loading')}</p>
            : (
              <OrchestrationFlow
                mode="overview"
                stages={ready.stages}
                returns={ready.returns}
                flows={ready.flows}
                current={currentStage}
                withStatus
                holding={heldStage}
                onOpenStage={openStage}
                ariaLabel={t('workspace.tab_overview')}
                className="h-[min(70vh,640px)]"
              />
            )
        ) : (
          <>
            {stageFlow.length > 0 && (
              <section className="mb-8" data-testid="stage-skills">
                <OrchestrationFlow key={`${identity} ${selectedStep}`} mode="stage" stages={stageFlow} withStatus holding={selectedStep === heldStage ? heldStage : null} onOpenEntry={openEntry} openable={openable} ariaLabel={t('workflow.skills_title')} />
              </section>
            )}
            {progress !== null && (
              <p className="mb-3 flex items-center gap-2 whitespace-nowrap text-body text-text-2" data-testid="task-gate-row">
                {progress.gate === 'review'
                  ? <ShieldCheck className="size-4 flex-none text-amber-d" aria-hidden="true" />
                  : <Zap className="size-4 flex-none text-(--accent)" aria-hidden="true" />}
                {t(`workspace.gate_${progress.gate}`)}
                <span className="tabular-nums text-text-3">· {progress.done}/{progress.total}</span>
              </p>
            )}
            {(inputs.length > 0 || outputs.length > 0 || hasTestsTab) && (
              <div className="grid gap-4" data-testid="stage-io">
                <SheetTabs
                  sheets={[
                    { id: 'inputs', label: t('workspace.inputs'), count: inputs.length },
                    { id: 'outputs', label: t('workspace.outputs'), count: `${readyOutputs}/${outputs.length}` },
                    ...(!hasTestsTab
                      ? []
                      : [{ id: 'tests' as const, label: t('workspace.tests'), count: policyReport === undefined ? stageTestCount(testRows) : tabCount(policyReport, change.testPlan) }]),
                  ]}
                  active={sheet}
                  onChange={setSheet}
                  ariaLabel={t('workspace.io_sheets')}
                  idPrefix="task-io"
                />
                <div role="tabpanel" id="task-io-panel" aria-labelledby={`task-io-tab-${sheet}`}>
                {sheet === 'tests' ? (
                  policyReport === undefined
                    ? <StageTestsPanel rows={testRows} activeId={openTest} onOpen={setOpenTest} />
                    : (
                      <TaskTestsTab
                        report={policyReport}
                        plan={change.testPlan}
                        legacyRows={testRows}
                        stageLabelOf={labelOf}
                        {...(row.owner === null ? {} : { recordedBy: row.owner.name })}
                        activeSuite={openSuite ?? (openTest === null ? null : `step:${openTest}`)}
                        onOpenSuite={(suite) => {
                          if (suite.startsWith('step:')) { setOpenSuite(null); setOpenTest(suite.slice('step:'.length)) } else { setOpenTest(null); setOpenSuite(suite) }
                        }}
                      />
                    )
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
              </div>
            )}
            {fetchDefinition && <TaskRecords root={root} change={change.name} signature={decisionSignature} stageLabelOf={labelOf} />}
          </>
        )}
      </DetailColumn>
      <DocumentDrawer root={root} files={files} index={openIndex} onIndex={setOpenIndex} onClose={() => setOpenIndex(null)} />
      <AgentRunDrawer
        root={root}
        change={change.name}
        runnable={selectedStep === change.phase && !row.archived}
        agent={stepAgents.find((agent) => agent.agent === openAgent) ?? null}
        onClose={() => setOpenAgent(null)}
      />
      <SuiteRunDrawer
        root={root}
        change={change.name}
        target={openedSuite === undefined || openedSuite.runId === undefined || change.testUser === undefined
          ? null
          : { user: change.testUser, runId: openedSuite.runId, suite: openedSuite.suite }}
        verdict={openedSuite}
        policy={policyReport?.policy}
        stageLabelOf={labelOf}
        onClose={() => setOpenSuite(null)}
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
