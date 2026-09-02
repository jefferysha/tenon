import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronRight, Circle, CircleDot, Clock3, X, type LucideIcon } from 'lucide-react'
import gsap from 'gsap'
import { useGSAP } from '@gsap/react'
import { useT } from '../i18n'
import type { ChangeSnapshot } from '../types'
import { isPhase } from '../types'
import { plannedTransition, type PlannedTransition } from '../model/events'
import { changeProgressState, type ProgressRules, type ProgressState } from '../model/progressModel'
import { artifactChips, gateEvidence, stageArtifacts, VERIFY_STATUS_FIELDS, type EvidenceChip } from '../model/evidence'
import { decisionKind } from '../model/changeModel'
import { getHistory, type ChangeHistoryEntry } from '../api/client'
import { diagnoseFailureWithCause } from './failureDiagnosis'
import { copyBtnCls } from './SessionResumeRow'
import { revealStages } from './motion'
import { Icon } from './Icon'
import { RunAuditPanel } from './RunAuditPanel'
import { BoxField, StageChip, StageTaskList } from './taskDetailParts'
import { TaskHistorySection } from './TaskHistorySection'
import { TaskConnectionCard } from './TaskConnectionCard'
import { TaskDetailIntro } from './TaskDetailIntro'
import { TaskDocumentsSection } from './TaskDocumentsSection'
import { RelatedSessionsSection } from './RelatedSessionsSection'
import { OrchestrationGraphCard } from './OrchestrationGraphCard'
gsap.registerPlugin(useGSAP)
export interface TaskDetailProps {
  root: string
  change: ChangeSnapshot
  rules: ProgressRules | undefined
  requirement?: string
  badge?: ReactNode
  actions?: ReactNode
  curStageExtra?: ReactNode
  evidenceExtra?: ReactNode
  documentsExtra?: ReactNode
  collapseTechnical?: boolean
  /** `all` preserves the legacy full detail for callers outside the Progress sheet. */
  surface?: TaskDetailSurface
  onClose?: () => void
  onToast?: (msg: string) => void
}
export type TaskDetailSurface = 'all' | 'summary' | 'outputs' | 'terminal' | 'history'
type StageStatus = 'done' | 'cur' | 'fail' | 'todo'
const secCls = 'border-b border-border py-[13px] last:border-b-0'
const secHeadCls = 'mb-2.5 flex items-baseline gap-[7px] text-[12.5px] font-bold text-text'
const hintCls = 'text-xs font-normal text-text-3'
const noneCls = 'm-0 text-xs text-text-3'
const noteCls = 'mt-2 mb-0 text-xs leading-[1.55] text-text-3'
const codeRowCls = 'flex items-center gap-2 rounded-md border border-code-border bg-code-bg px-[11px] py-2 font-mono text-xs'
const codePromptCls = 'text-text-3'
const codeCls = 'min-w-0 flex-1 text-text [overflow-wrap:anywhere]'
const chipRowCls = 'flex min-h-[22px] flex-wrap items-center gap-1.5'
const artsCls = 'grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-1.5'
const nodeBaseCls = 'absolute left-0 top-0.5 grid size-4 place-items-center rounded-full font-bold leading-none'
const nodeToneCls: Record<StageStatus, string> = {
  done: 'bg-green text-[11px] text-btn-fg',
  cur: 'bg-btn-bg text-[11px] shadow-[0_0_0_3px_var(--ring)]',
  fail: 'bg-red text-[10px] text-btn-fg',
  todo: 'border-2 border-border-2 bg-card text-[11px]',
}
const stageNameCls: Record<StageStatus, string> = {
  done: 'font-medium text-text',
  cur: 'font-semibold text-text',
  fail: 'font-semibold text-red-d',
  todo: 'font-normal text-text-3',
}
function fieldStr(c: ChangeSnapshot, key: string): string {
  const v = c.fields[key]
  return typeof v === 'string' ? v : ''
}
export function TaskDetail({
  root,
  change,
  rules,
  requirement,
  badge,
  actions,
  curStageExtra,
  evidenceExtra,
  documentsExtra,
  collapseTechnical = false,
  surface = 'all',
  onClose,
  onToast,
}: TaskDetailProps): JSX.Element {
  const { t } = useT()
  const tRef = useRef(t)
  tRef.current = t
  const scopeRef = useRef<HTMLElement>(null)
  const [entries, setEntries] = useState<ChangeHistoryEntry[] | null>(null)
  useEffect(() => {
    let cancelled = false
    setEntries(null)
    if (surface !== 'all' && surface !== 'history') {
      setEntries([])
      return () => { cancelled = true }
    }
    getHistory(change.name, root)
      .then((es) => {
        if (!cancelled) setEntries(es)
      })
      .catch(() => {
        if (!cancelled) setEntries([])
      })
    return () => {
      cancelled = true
    }
  }, [change.name, change.phase, root, surface])
  useGSAP(
    () => {
      const stages = scopeRef.current?.querySelectorAll('[data-anim="stage"]')
      if (stages && stages.length > 0) revealStages(stages)
    },
    { scope: scopeRef, dependencies: [change.name] },
  )
  function copy(value: string): void {
    void navigator.clipboard?.writeText(value).then(() => {
      onToast?.(tRef.current('detail.copied', { value }))
    })
  }
  const state: ProgressState = changeProgressState(change, rules)
  const stages = stageArtifacts(rules, change)
  const todoByStage = new Map((change.todo?.stages ?? []).map((stage) => [stage.id, stage]))
  const curIdx = rules ? rules.steps.indexOf(change.phase) : -1
  const misaligned = rules !== undefined && curIdx === -1
  const showStages = stages.length > 0 && !misaligned
  function statusOf(i: number): StageStatus {
    const projected = todoByStage.get(stages[i]?.step ?? '')?.status
    if (projected === 'done') return 'done'
    if (projected === 'pending') return 'todo'
    if (projected === 'current') return state === 'failed' ? 'fail' : 'cur'
    if (i < curIdx) return 'done'
    if (i > curIdx) return 'todo'
    return state === 'failed' ? 'fail' : 'cur'
  }
  const firstForward: PlannedTransition | null = rules
    ? ((rules.transitions[change.phase] ?? [])
        .map((e) => plannedTransition(rules, change.phase, e.to))
        .find((p): p is PlannedTransition => p !== null && !p.backward) ?? null)
    : null
  const automation = fieldStr(change, 'automation')
  const attempts = fieldStr(change, 'automation_attempts')
  const lastError = fieldStr(change, 'automation_last_error')
  const failCause = fieldStr(change, 'automation_cause')
  const footLabel =
    state === 'failed' ? `automation · ${automation}` : firstForward ? `${change.phase} → ${firstForward.to}` : change.phase
  function verdict(): { text: string; bad: boolean; icon: LucideIcon } {
    if (state === 'failed') return { text: lastError || t('detail.fail_generic'), bad: true, icon: X }
    if (state === 'running') return { text: t('detail.verdict_running'), bad: false, icon: CircleDot }
    if (state === 'queued') return { text: t('detail.verdict_queued'), bad: false, icon: Clock3 }
    if (state === 'agent') return { text: t('detail.verdict_agent'), bad: false, icon: Circle }
    const kind = decisionKind(change)
    if (kind === 'verify' && rules) {
      const failed = gateEvidence(change, rules).filter(
        (c) => (VERIFY_STATUS_FIELDS as readonly string[]).includes(c.key) && c.tone !== 'pass',
      )
      return failed.length === 0
        ? { text: t('detail.why_gate_allpass'), bad: false, icon: Check }
        : { text: t('detail.why_gate', { names: failed.map((c) => c.key.replace(/_result$/, '')).join('、') }), bad: false, icon: Circle }
    }
    return { text: t(`inbox.awaiting.${kind}`), bad: false, icon: Circle }
  }
  function stageLabel(id: string): string {
    return isPhase(id) ? t(`phases.${id}`) : id
  }
  function boxInner(chips: EvidenceChip[]): JSX.Element {
    if (state === 'failed') {
      const missing = chips.filter((c) => c.unset).map((c) => c.key)
      const diag = diagnoseFailureWithCause(failCause, lastError)
      const amb = diag.cause === 'cancelled'
      const fix = diag.fixCommand
      return (
        <>
          <div
            className={`rounded-[11px] border px-[15px] py-[13px] ${amb ? 'border-amb-b bg-amb-t' : 'border-red-b bg-red-t'}`}
            data-tone={amb ? 'amb' : 'red'}
            data-testid="dt-diag"
          >
            <div className={`text-sm font-bold leading-[1.45] ${amb ? 'text-amb-d' : 'text-red-d'}`} data-testid="dt-diag-cause">
              {t(`failure.cause_${diag.cause}`)}
            </div>
            <p className="mt-1.5 mb-0 max-w-[64ch] text-[13px] leading-[1.6] text-text-2" data-testid="dt8-diag-hint">
              {t(`failure.hint_${diag.cause}`)}
            </p>
            {fix !== null && (
              <div className="mt-2.5 flex flex-col gap-1">
                <span className="text-[11px] text-text-3">{t('failure.fix_label')}</span>
                <div className={codeRowCls}>
                  <span className={codePromptCls} aria-hidden="true">
                    $
                  </span>
                  <code className={codeCls} data-testid="detail-fix-cmd">
                    {fix}
                  </code>
                  <button
                    type="button"
                    className={copyBtnCls}
                    data-copy={fix}
                    data-testid="detail-fix-copy"
                    aria-label={t('failure.fix_copy')}
                    onClick={() => copy(fix)}
                  >
                    <Icon name="copy" size={12} />
                  </button>
                </div>
              </div>
            )}
            {lastError !== '' && (
              <details className="group mt-[11px]" data-testid="dt8-rawfold">
                <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-md px-1 py-0.5 text-[12.5px] font-semibold text-text-2 outline-none focus-visible:shadow-[0_0_0_3px_var(--ring-blue)] [&::-webkit-details-marker]:hidden">
                  <ChevronRight className="size-3 flex-none text-text-3 transition-transform group-open:rotate-90 motion-reduce:transition-none" strokeWidth={1.75} aria-hidden="true" />
                  {t('detail.raw_error_summary')}
                </summary>
                <pre
                  className="mt-2 mb-0 rounded-[9px] border border-code-border bg-code-bg px-3 py-2.5 font-mono text-xs leading-[1.65] whitespace-pre-wrap text-text-2 [overflow-wrap:anywhere]"
                  data-testid="dt8-raw-pre"
                >
                  {lastError}
                </pre>
              </details>
            )}
            <div
              className="mt-2.5 flex gap-3.5 font-mono text-xs tabular-nums text-text-3 [&_b]:font-bold [&_b]:text-text-2"
              data-testid="dt8-diag-meta"
            >
              {attempts !== '' && (
                <span>
                  {t('detail.attempts')} <b>{attempts}</b>
                </span>
              )}
              <span>
                {t('detail.cause')} <b>{diag.cause}</b>
              </span>
            </div>
          </div>
          <div className={artsCls}>
            {chips
              .filter((c) => !c.unset)
              .map((c) => (
                <BoxField key={c.key} chip={c} onCopy={copy} />
              ))}
            {missing.length > 0 && (
              <div
                className="min-w-0 rounded-[7px] border border-dashed border-border bg-transparent px-2 py-[5px]"
                data-state="miss"
                data-testid="dt-field-missing"
              >
                <div className="font-mono text-[10.5px] text-text-3 [overflow-wrap:anywhere]">{missing.join(' · ')}</div>
                <div className="text-xs text-text-3 [overflow-wrap:anywhere]">{t('evidence.unset')}</div>
              </div>
            )}
          </div>
          <p className={noteCls}>{t('detail.fail_note')}</p>
        </>
      )
    }
    const v = verdict()
    const VerdictIcon = v.icon
    return (
      <>
        <div
          className={`mb-2 flex items-baseline gap-1.5 text-[12.5px] leading-normal font-semibold ${v.bad ? 'text-red-d' : 'text-text'}`}
          data-tone={v.bad ? 'bad' : 'ok'}
          data-testid="dt-verdict"
        >
          <VerdictIcon className={`size-3.5 flex-none ${v.icon === Check ? 'text-green-d' : ''}`} strokeWidth={1.75} aria-hidden="true" />
          {v.text}
        </div>
        {chips.length > 0 ? (
          <div className={artsCls}>
            {chips.map((c) => (
              <BoxField key={c.key} chip={c} onCopy={copy} />
            ))}
          </div>
        ) : (
          <div className={noneCls}>{t('detail.stage_no_outputs')}</div>
        )}
      </>
    )
  }
  function renderBox(chips: EvidenceChip[]): JSX.Element {
    const bad = state === 'failed'
    return (
      <div
        className={`mt-2 rounded-md border px-[11px] py-2.5 ${bad ? 'border-red-b bg-red-t' : 'border-accent-b bg-accent-t'}`}
        data-tone={bad ? 'bad' : 'ok'}
        data-testid="dtl-box"
      >
        {boxInner(chips)}
      </div>
    )
  }
  function renderStagesTimeline(): JSX.Element {
    return (
      <>
        {showStages && (
          <div role="list" aria-label={t('detail.stages_label', { name: change.name, n: stages.length })}>
            {stages.map((st, i) => {
              const status = statusOf(i)
              const todo = todoByStage.get(st.step)
              return (
                <div
                  className={`relative pb-3 pl-6 before:absolute before:top-[18px] before:-bottom-0.5 before:left-[7px] before:w-0.5 before:rounded-full before:content-[''] last:pb-0 last:before:hidden ${status === 'done' ? 'before:bg-green-b' : 'before:bg-border'}`}
                  role="listitem"
                  data-anim="stage"
                  data-state={status}
                  data-testid={`dtl-${st.step}`}
                  key={st.step}
                >
                  <span className={`${nodeBaseCls} ${nodeToneCls[status]}`} aria-hidden="true">
                    {status === 'done' ? <Check className="size-2.5" strokeWidth={1.75} /> : status === 'fail' ? <X className="size-2.5" strokeWidth={1.75} /> : null}
                  </span>
                  <div className={chipRowCls}>
                    <span className={`text-[13px] ${stageNameCls[status]}`}>{stageLabel(st.step)}</span>
                    {status === 'todo' && <span className="text-xs text-text-3">{t('detail.not_started')}</span>}
                    {status === 'done' &&
                      (st.chips.length > 0 ? (
                        st.chips.map((c) => <StageChip key={c.key} chip={c} onCopy={copy} />)
                      ) : (
                        <span className="text-xs text-text-3">{t('detail.no_outputs')}</span>
                      ))}
                    {status === 'fail' && attempts !== '' && (
                      <span className="text-xs text-text-3">{t('detail.fail_stopped_here', { n: attempts })}</span>
                    )}
                  </div>
                  {(status === 'cur' || status === 'fail') && (
                    <>
                      {renderBox(st.chips)}
                      {curStageExtra}
                    </>
                  )}
                  {todo !== undefined && todo.tasks.length > 0 && (
                    <StageTaskList
                      stage={st.step}
                      tasks={todo.tasks}
                      collapseCompleted={status === 'done' && todo.tasks.every((task) => task.completed)}
                    />
                  )}
                </div>
              )
            })}
          </div>
        )}
        {!showStages && (
          <div>
            <p className={noneCls}>{t('detail.stages_unknown')}</p>
            {state === 'failed' && renderBox([])}
            {curStageExtra}
            <div className={chipRowCls}>
              {artifactChips(change).map((c) => (
                <StageChip key={c.key} chip={c} onCopy={copy} />
              ))}
            </div>
          </div>
        )}
      </>
    )
  }
  function renderCompactStage(): JSX.Element {
    const current = stages[curIdx]
    const currentLabel = current ? stageLabel(current.step) : stageLabel(change.phase)
    const result = verdict()
    const ResultIcon = result.icon
    const compactStatusText = state === 'agent'
      ? t('detail.verdict_agent_compact')
      : state === 'running'
        ? t('detail.verdict_running_compact')
        : state === 'queued'
          ? t('detail.verdict_queued_compact')
          : result.text
    return (
      <div className="rounded-xl border border-border bg-fill/40 p-3.5" data-testid="dt-compact-stage">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-bold text-text">{currentLabel}</span>
          <span className={`inline-flex items-center gap-1.5 text-xs font-semibold ${result.bad ? 'text-red-d' : 'text-text-2'}`} data-testid="dt-compact-status">
            <ResultIcon className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
            {compactStatusText}
          </span>
        </div>
        <p className="mt-2 mb-0 text-xs leading-5 text-text-3">
          {firstForward ? t('navigation.next_step', { step: stageLabel(firstForward.to) }) : t('navigation.no_next_step')}
        </p>
      </div>
    )
  }
  const historySection = <TaskHistorySection entries={entries} />
  return (
    <section data-testid="task-detail" ref={scopeRef}>
      <TaskDetailIntro
        name={change.name}
        badge={badge}
        actions={actions}
        footLabel={surface === 'all' ? footLabel : ''}
        requirement={requirement}
        onClose={onClose}
      />
      <div className={secCls} data-testid="dt-stages-sec">
        <div className={secHeadCls}>
          {t('detail.stages_heading')} <span className={hintCls}>{t('detail.stages_hint')}</span>
        </div>
        {surface === 'all' ? renderStagesTimeline() : renderCompactStage()}
      </div>
      {surface === 'all' && (
        <>
          <OrchestrationGraphCard root={root} change={change.name} />
          {evidenceExtra}
          {change.documents?.governed ? (
            <TaskDocumentsSection documents={change.documents} extra={documentsExtra} />
          ) : documentsExtra !== undefined ? (
            <div className="border-b border-border py-[13px] last:border-b-0" data-testid="dt-verification-tools">{documentsExtra}</div>
          ) : null}
          <RelatedSessionsSection key={`${root}\u0000${change.name}`} root={root} name={change.name} />
          {collapseTechnical ? (
            <details className="my-3 rounded-xl border border-border bg-fill/40 px-3" data-testid="detail-technical">
              <summary className="cursor-pointer py-3 text-[12.5px] font-semibold text-text">{t('runAudit.title')}</summary>
              <RunAuditPanel root={root} change={change.name} refreshKey={`${change.phase}:${automation}`} />
              {historySection}
            </details>
          ) : (
            <RunAuditPanel root={root} change={change.name} refreshKey={`${change.phase}:${automation}`} />
          )}
          {(state === 'failed' || automation === 'running') && <TaskConnectionCard root={root} change={change} automation={automation} onCopy={copy} />}
          {!collapseTechnical && historySection}
        </>
      )}
      {surface === 'outputs' && (
        <>
          <div className={secCls} data-testid="dt-output-current">
            <div className={secHeadCls}>{t('detail.current_stage_heading')}</div>
            {(() => {
              const currentOutputs = stages[curIdx]?.chips ?? artifactChips(change)
              return currentOutputs.length > 0 ? renderBox(currentOutputs) : <p className={noneCls}>{t('detail.stage_no_outputs')}</p>
            })()}
          </div>
          {curStageExtra !== undefined && (
            <details className="group border-b border-border py-[11px] last:border-b-0" data-testid="dt-output-advanced">
              <summary className="cursor-pointer list-none text-[12.5px] font-semibold text-text outline-none focus-visible:ring-2 focus-visible:ring-(--ring-blue) [&::-webkit-details-marker]:hidden">
                <span className="inline-flex items-center gap-1.5">
                  <ChevronRight className="size-3.5 text-text-3 transition-transform group-open:rotate-90 motion-reduce:transition-none" strokeWidth={1.75} aria-hidden="true" />
                  {t('progress.output_advanced_preview')}
                </span>
              </summary>
              <div className="pt-3">{curStageExtra}</div>
            </details>
          )}
          <details className="group border-b border-border py-[11px] last:border-b-0" data-testid="dt-output-graph">
            <summary className="cursor-pointer list-none text-[12.5px] font-semibold text-text outline-none focus-visible:ring-2 focus-visible:ring-(--ring-blue) [&::-webkit-details-marker]:hidden">
              <span className="inline-flex items-center gap-1.5">
                <ChevronRight className="size-3.5 text-text-3 transition-transform group-open:rotate-90 motion-reduce:transition-none" strokeWidth={1.75} aria-hidden="true" />
                {t('progress.output_execution_graph')}
              </span>
            </summary>
            <div className="pt-3"><OrchestrationGraphCard root={root} change={change.name} /></div>
          </details>
          {evidenceExtra !== undefined && (
            <details className="group border-b border-border py-[11px] last:border-b-0" data-testid="dt-output-evidence">
              <summary className="cursor-pointer list-none text-[12.5px] font-semibold text-text outline-none focus-visible:ring-2 focus-visible:ring-(--ring-blue) [&::-webkit-details-marker]:hidden">
                <span className="inline-flex items-center gap-1.5">
                  <ChevronRight className="size-3.5 text-text-3 transition-transform group-open:rotate-90 motion-reduce:transition-none" strokeWidth={1.75} aria-hidden="true" />
                  {t('progress.output_evidence')}
                </span>
              </summary>
              <div className="pt-3">{evidenceExtra}</div>
            </details>
          )}
          {change.documents?.governed ? (
            <TaskDocumentsSection documents={change.documents} extra={documentsExtra} />
          ) : documentsExtra !== undefined ? (
            <div className="border-b border-border py-[13px] last:border-b-0" data-testid="dt-verification-tools">{documentsExtra}</div>
          ) : null}
        </>
      )}
      {surface === 'terminal' && (
        <>
          <RelatedSessionsSection key={`${root}\u0000${change.name}`} root={root} name={change.name} />
          {(state === 'failed' || automation === 'running') && <TaskConnectionCard root={root} change={change} automation={automation} onCopy={copy} />}
        </>
      )}
      {surface === 'history' && (
        <>
          <RunAuditPanel root={root} change={change.name} refreshKey={`${change.phase}:${automation}`} />
          {historySection}
        </>
      )}
    </section>
  )
}
