import { useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { useT } from '../i18n'
import { SheetTabs, useSheetState, type SheetDef } from '../shared/DetailSheets'
import { DetailColumn, StatusPill } from '../shell/ThreeColumns'
import type { BoardLane } from '../workbench/boardLane'
import { LaneMandatorySkills } from '../workbench/LaneMandatorySkills'
import type { MandatoryState } from '../workbench/mandatoryState'
import { skillExecutionWaves } from '../workbench/SkillExecutionTopology'
import { StepPolicyEditor } from '../workbench/StepPolicyEditor'
import { TimelineSkillRows } from '../workbench/TimelineSkillRows'
import { EVENT_ORDER, TimelineHookNodes } from '../workbench/TimelineHookRows'
import { TimelineRuntimeFacts } from '../workbench/TimelineRuntimeFacts'
import type { WbStepDef } from '../workbench/workbenchDefinition'
import type { WorkflowEditor } from '../workbench/useWorkflowEditor'
import { DerivedIoPanel } from './DerivedIoPanel'

const SHEETS = ['skills', 'io', 'gate', 'prompt', 'hooks', 'settings'] as const
type SheetId = (typeof SHEETS)[number]

export interface StageEditorPaneProps {
  editor: WorkflowEditor
  lane: BoardLane
  step: WbStepDef
  mandatory: MandatoryState
  onOpenSkillEditor: () => void
}

const FIELD_CLS = 'min-h-10 w-full rounded-sm border border-border bg-card px-3 text-base text-text outline-none focus:border-accent-b disabled:cursor-not-allowed disabled:bg-fill disabled:text-text-3'
const SWITCH_CLS =
  "relative h-5 w-9 flex-none cursor-pointer rounded-full border border-border-2 bg-fill-2 transition-colors after:absolute after:top-0.5 after:left-0.5 after:size-3.5 after:rounded-full after:bg-card after:shadow-sm after:transition-transform after:content-[''] aria-checked:border-(--accent) aria-checked:bg-(--accent) aria-checked:after:translate-x-4 disabled:cursor-not-allowed disabled:opacity-55 motion-reduce:transition-none"

/**
 * 工作流页右列 · 阶段编辑：固定头部 + sheet：技能顺序 / 输入产出（只读推导）/ 门禁守卫 / 执行指令 / 阶段设置。
 * 所有写操作都落到 editor 的 def 草稿上，保存由底部动作条统一提交。
 */
export function StageEditorPane({ editor, lane, step, mandatory, onOpenSkillEditor }: StageEditorPaneProps): JSX.Element {
  const { t } = useT()
  const readonly = editor.readonlyWf
  const steps = editor.def?.steps ?? []
  const index = steps.findIndex((candidate) => candidate.id === step.id)
  const skills = lane.skills ?? []
  const waves = skillExecutionWaves(skills, lane.skillDeps ?? {})
  const registryByName = useMemo(() => new Map((mandatory.registry ?? []).map((entry) => [entry.name, entry])), [mandatory.registry])
  const labelOf = (id: string): string => editor.boardLanes.find((candidate) => candidate.id === id)?.name ?? id
  const [confirmDelete, setConfirmDelete] = useState(false)

  const sheets: readonly SheetDef<SheetId>[] = useMemo(() => [
    { id: 'skills', label: t('workflow.sheet_skills'), count: lane.skills?.length },
    { id: 'io', label: t('workflow.sheet_io'), count: step.inputs.length + step.outputs.length },
    { id: 'gate', label: t('workflow.sheet_gate') },
    { id: 'prompt', label: t('workflow.sheet_prompt') },
    { id: 'hooks', label: t('workflow.sheet_hooks'), count: lane.hooksCount },
    { id: 'settings', label: t('workflow.sheet_settings') },
  ], [lane.hooksCount, lane.skills?.length, step.inputs.length, step.outputs.length, t])
  const [sheet, setSheet] = useSheetState<SheetId>('tenon-dashboard-sheet:workflow-stage', sheets, 'skills')

  const summary = [
    lane.skills === undefined
      ? t('workflow.card_skills_matrix')
      : t('workflow.summary', { skills: skills.length, waves: waves.length }),
    step.outputs.length > 0 ? t('workflow.summary_outputs', { fields: step.outputs.map((output) => output.field).join('、') }) : null,
  ].filter((part): part is string => part !== null).join('；')

  const footer = readonly ? (
    <>
      <p className="text-body text-text-2" data-testid="wb-ro-pill">{t('workflow.readonly_note')}</p>
      <button type="button" className="inline-flex min-h-10 items-center rounded-md border border-border bg-card px-4 text-base font-semibold text-text hover:border-text-3" data-testid="workflow-copy-editable" onClick={() => editor.openWorkflowCreate('copy')}>
        {t('workflow.copy_editable')}
      </button>
    </>
  ) : (
    <>
      <p className="flex items-center gap-2 text-body text-text-2">
        {editor.dirty ? (
          <><span className="size-1.5 rounded-full bg-(--amber-d)" aria-hidden="true" /><span data-testid="wb-dirty" role="status" aria-live="polite">{t('workflow.dirty', { name: editor.wfName ?? '' })}</span></>
        ) : editor.saveStatus.kind === 'ok' ? (
          <span data-testid="wb-save-ok" role="status" aria-live="polite" className="text-green-d">{t('workbench.save_success')}</span>
        ) : (
          <span>{t('workflow.footer_stages', { n: steps.length })}</span>
        )}
      </p>
      <span className="flex items-center gap-2">
        {editor.saveStatus.kind === 'error' && (
          <span className="max-w-[40ch] truncate text-caption text-red-d" role="alert" data-testid="wb-save-error" title={editor.saveStatus.errors.join('\n')}>
            {editor.saveStatus.errors[0]}
          </span>
        )}
        {editor.saveStatus.kind === 'error' && editor.saveStatus.conflict === true && (
          <button type="button" className="min-h-10 rounded-md border border-border bg-card px-3 text-base text-text-2 hover:bg-fill" data-testid="wb-save-conflict-reload" onClick={editor.reloadDefinition}>{t('workbench.save_conflict_reload')}</button>
        )}
        <button type="button" className="min-h-10 rounded-md px-3 text-base text-text-2 hover:bg-fill disabled:opacity-50" data-testid="wb-discard" disabled={!editor.dirty || editor.saving} onClick={editor.discardDraft}>{t('workflow.discard')}</button>
        <button type="button" className="min-h-10 rounded-md bg-(--accent) px-4 text-base font-semibold text-btn-fg hover:bg-accent-d disabled:opacity-50" data-testid="wb-save" disabled={!editor.dirty || editor.saving} onClick={() => void editor.save()}>{t('workflow.save')}</button>
      </span>
    </>
  )

  return (
    <DetailColumn
      testId="stage-editor-pane"
      panelId="stage-editor-panel"
      labelledBy={`stage-editor-tab-${sheet}`}
      header={(
        <>
          <p className="mb-2.5 text-caption font-semibold text-(--accent)">{t('workflow.rail_title')} / {t('workflow.detail_eyebrow')}</p>
          <h1 className="mb-1.5 text-page font-bold tracking-[-.01em] text-text" data-testid={`wb-lane-name-${lane.id}`}>{lane.name}</h1>
          <p className="mb-4 font-mono text-base text-text-2">{editor.wfName} · {lane.id} · {t('workflow.stage_position', { n: index + 1, total: steps.length })}</p>
          <p className="mb-6 flex flex-wrap items-center gap-3.5">
            <StatusPill tone={lane.gate === null ? 'neutral' : 'pending'}>{lane.gate === null ? t('workflow.gate_none') : t(lane.gate === 'review' ? 'workflow.gate_tag_review' : 'workflow.gate_tag_confirm')}</StatusPill>
            <span className="text-base text-text-2">{summary}</span>
          </p>
        </>
      )}
      sheets={<SheetTabs sheets={sheets} active={sheet} onChange={setSheet} ariaLabel={t('shell.sheet_label')} idPrefix="stage-editor" />}
      footer={footer}
    >
      {sheet === 'skills' && (
        <div className="grid gap-4" data-testid="stage-skills-sheet">
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="text-section font-bold text-text">{t('workflow.sheet_skills')}</h2>
            <span className="text-body text-text-3">{t('workflow.waves_hint')}</span>
          </div>
          {lane.skills === undefined ? (
            <LaneMandatorySkills phase={lane.id} state={mandatory} readonly />
          ) : (
            <>
              <TimelineSkillRows
                stageId={lane.id}
                skills={skills}
                skillDeps={lane.skillDeps}
                skillRegistry={mandatory.registry}
                registryByName={registryByName}
                readonly={readonly}
                onSkillMove={readonly ? undefined : editor.moveSkill}
                onSkillRemove={readonly ? undefined : editor.removeSkill}
              />
              {!readonly && (
                <button type="button" data-testid={`wb-lane-sk-add-${lane.id}`} className="inline-flex min-h-10 items-center gap-2 self-start rounded-md border border-dashed border-border px-3.5 text-base font-semibold text-(--accent) hover:border-accent-b hover:bg-accent-t" onClick={onOpenSkillEditor}>
                  <Plus className="size-4" aria-hidden="true" /> {t('workbench.timeline_add_skill')}
                </button>
              )}
            </>
          )}
        </div>
      )}
      {sheet === 'io' && (
        <div className="grid gap-4">
          <h2 className="text-section font-bold text-text">{t('workflow.sheet_io')}</h2>
          <DerivedIoPanel step={step} steps={steps} labelOf={labelOf} />
        </div>
      )}
      {sheet === 'gate' && (
        <div className="grid gap-5" data-testid="stage-gate-sheet">
          <h2 className="text-section font-bold text-text">{t('workflow.sheet_gate')}</h2>
          <div className="grid grid-cols-2 gap-3 max-[900px]:grid-cols-1">
            <label className="grid gap-1.5">
              <span className="text-body text-text-2">{t('workflow.gate_label')}</span>
              <select
                className={FIELD_CLS}
                value={lane.gate ?? 'none'}
                disabled={readonly}
                data-testid={`wb-lane-gate-${lane.id}`}
                onChange={(event) => editor.editLane(lane.id, { gate: event.target.value === 'none' ? null : event.target.value === 'confirm' ? 'confirm' : 'review' })}
              >
                <option value="none">{t('workflow.gate_none')}</option>
                <option value="review">{t('workflow.gate_review')}</option>
                <option value="confirm">{t('workflow.gate_confirm')}</option>
              </select>
            </label>
            {lane.nonemptyGuard !== undefined && (
              <label className="flex items-center justify-between gap-3 rounded-sm border border-border bg-card px-3 py-2.5">
                <span className="text-body text-text-2">{t('workflow.guard_nonempty')}</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={lane.nonemptyGuard}
                  className={SWITCH_CLS}
                  disabled={readonly}
                  data-testid={`wb-lane-guard-${lane.id}`}
                  onClick={() => editor.setLaneGuard(lane.id, !lane.nonemptyGuard)}
                />
              </label>
            )}
          </div>
          <StepPolicyEditor step={step} allStepIds={steps.map((candidate) => candidate.id)} readonly={readonly} onChange={editor.replaceStep} />
        </div>
      )}
      {sheet === 'prompt' && (
        <div className="grid gap-3" data-testid="stage-prompt-sheet">
          <h2 className="text-section font-bold text-text">{t('workbench.step_prompt_title')}</h2>
          <label htmlFor={`wb-timeline-prompt-${lane.id}`} className="text-body text-text-2">{t('workbench.step_prompt_label')}</label>
          <textarea
            id={`wb-timeline-prompt-${lane.id}`}
            value={step.prompt ?? ''}
            readOnly={readonly}
            rows={9}
            placeholder={t('workbench.timeline_prompt_placeholder')}
            className="min-h-40 w-full resize-y rounded-sm border border-border bg-card px-3 py-2.5 text-base leading-6 text-text outline-none placeholder:text-text-3 focus:border-accent-b read-only:bg-fill"
            onChange={(event) => {
              const prompt = event.target.value
              if (prompt === '') {
                const { prompt: _prompt, ...withoutPrompt } = step
                editor.replaceStep(withoutPrompt)
              } else {
                editor.replaceStep({ ...step, prompt })
              }
            }}
          />
          <p className="text-caption leading-5 text-text-3">{t('workbench.timeline_prompt_note')}</p>
        </div>
      )}
      {sheet === 'hooks' && (
        <div className="grid gap-4" data-testid={`wb-lane-hooks-${lane.id}`}>
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="text-section font-bold text-text">{t('workflow.sheet_hooks')}</h2>
            <span className="text-body text-text-3">{t('workflow.hooks_sheet_hint')}</span>
          </div>
          {/* Hook 节点带时间线式左侧图标（-left-[47px] 绝对定位），沿用原编排器的 pl-12 轨道留白。 */}
          <div className="relative min-w-0 pl-12 before:absolute before:top-5 before:bottom-5 before:left-[19px] before:w-px before:bg-border-2 before:content-['']">
            <TimelineHookNodes events={EVENT_ORDER} stageId={lane.id} config={editor.hooksConfig} />
          </div>
          <TimelineRuntimeFacts selected={lane} hooks={editor.hooksConfig} skillRegistry={mandatory.registry} registryByName={registryByName} prompt={step.prompt ?? ''} />
        </div>
      )}
      {sheet === 'settings' && (
        <div className="grid gap-5" data-testid="stage-settings-sheet">
          <h2 className="text-section font-bold text-text">{t('workflow.sheet_settings')}</h2>
          <div className="grid grid-cols-2 gap-3 max-[900px]:grid-cols-1">
            <label className="grid gap-1.5">
              <span className="text-body text-text-2">{t('workflow.settings_name')}</span>
              <input
                className={FIELD_CLS}
                value={lane.name}
                disabled={readonly}
                data-testid={`wb-lane-name-input-${lane.id}`}
                onChange={(event) => editor.editLane(lane.id, { label: event.target.value })}
              />
            </label>
            <label className="grid gap-1.5">
              <span className="text-body text-text-2">{t('workflow.settings_id')}</span>
              <input className={`${FIELD_CLS} font-mono`} value={lane.id} disabled readOnly />
            </label>
          </div>
          {lane.hooksCount !== undefined && (
            <p className="text-body text-text-2">{t('workflow.settings_hooks', { n: lane.hooksCount })}</p>
          )}
          {!readonly && (
            <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
              <button type="button" className="inline-flex min-h-10 items-center gap-1.5 rounded-md border border-border bg-card px-3 text-base text-text-2 hover:bg-fill disabled:opacity-50" disabled={index <= 0} data-testid={`wb-lane-up-${lane.id}`} onClick={() => { const previous = steps[index - 1]; if (previous) editor.reorderStages(lane.id, previous.id, false) }}>
                <ArrowUp className="size-4" aria-hidden="true" />{t('workflow.settings_move_up')}
              </button>
              <button type="button" className="inline-flex min-h-10 items-center gap-1.5 rounded-md border border-border bg-card px-3 text-base text-text-2 hover:bg-fill disabled:opacity-50" disabled={index < 0 || index >= steps.length - 1} data-testid={`wb-lane-down-${lane.id}`} onClick={() => { const next = steps[index + 1]; if (next) editor.reorderStages(lane.id, next.id, true) }}>
                <ArrowDown className="size-4" aria-hidden="true" />{t('workflow.settings_move_down')}
              </button>
              <span className="flex-1" />
              {confirmDelete ? (
                <>
                  <span className="text-body text-red-d">{t('workflow.settings_delete_confirm', { name: lane.name })}</span>
                  <button type="button" className="min-h-10 rounded-md px-3 text-base text-text-2 hover:bg-fill" onClick={() => setConfirmDelete(false)}>{t('workbench.workflow_cancel')}</button>
                  <button type="button" className="min-h-10 rounded-md border border-red-b bg-card px-3 text-base font-semibold text-red-d hover:bg-red-t" data-testid={`wb-lane-remove-confirm-${lane.id}`} onClick={() => { setConfirmDelete(false); editor.removeStage(lane.id) }}>{t('workbench.timeline_delete_confirm')}</button>
                </>
              ) : (
                <button type="button" className="inline-flex min-h-10 items-center gap-1.5 rounded-md border border-border bg-card px-3 text-base text-red-d hover:border-red-b hover:bg-red-t" data-testid={`wb-lane-remove-${lane.id}`} onClick={() => setConfirmDelete(true)}>
                  <Trash2 className="size-4" aria-hidden="true" />{t('workflow.settings_delete')}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </DetailColumn>
  )
}
