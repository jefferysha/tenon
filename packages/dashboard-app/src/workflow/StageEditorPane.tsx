import { useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, Plus, Trash2, X } from 'lucide-react'
import { useT } from '../i18n'
import { DetailColumn, StatusPill } from '../shell/ThreeColumns'
import type { BoardLane } from '../workbench/boardLane'
import { resolveMandatoryCell, type MandatoryState } from '../workbench/mandatoryState'
import { isParallelWithPrevious, skillExecutionWaves } from '../workbench/skillWaves'
import { trackDisplayName } from '../workbench/trackPresentation'
import type { WbStepDef } from '../workbench/workbenchDefinition'
import type { WorkflowEditor } from '../workbench/useWorkflowEditor'
import { DerivedIoPanel } from './DerivedIoPanel'

export interface StageEditorPaneProps {
  editor: WorkflowEditor
  lane: BoardLane
  step: WbStepDef
  mandatory: MandatoryState
}

const FIELD_CLS = 'min-h-10 rounded-sm border border-border bg-card px-3 text-base text-text outline-none focus:border-accent-b disabled:cursor-not-allowed disabled:bg-fill disabled:text-text-3'
const SMALL_BTN = 'inline-flex min-h-9 items-center gap-1.5 rounded-sm border border-border bg-card px-3 text-body text-text-2 hover:border-text-3 hover:text-text disabled:opacity-50'

function SectionHead({ title, meta }: { title: string; meta?: string }): JSX.Element {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-4">
      <h2 className="text-section font-bold text-text">{title}</h2>
      {meta !== undefined && <span className="text-body text-text-3">{meta}</span>}
    </div>
  )
}

/**
 * 工作流页右列 · 阶段：不用页签，三段纵排——技能（顺序 + 串行/并行）/ 门禁 / 输入·输出（推导只读）。
 * 头部带阶段名与上移 / 下移 / 删除；底部是唯一的保存 / 放弃入口。
 */
export function StageEditorPane({ editor, lane, step, mandatory }: StageEditorPaneProps): JSX.Element {
  const { t, lang } = useT()
  const readonly = editor.readonlyWf
  const steps = editor.def?.steps ?? []
  const index = steps.findIndex((candidate) => candidate.id === step.id)
  const waves = skillExecutionWaves(step.skills.map((skill) => skill.id), Object.fromEntries(step.skills.map((skill) => [skill.id, skill.depends_on ?? []])))
  const labelOf = (id: string): string => editor.boardLanes.find((candidate) => candidate.id === id)?.name ?? id
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [pendingSkill, setPendingSkill] = useState('')
  const available = useMemo(
    () => (mandatory.registry ?? []).filter((entry) => entry.installed && entry.available !== false && !step.skills.some((skill) => skill.id === entry.name)),
    [mandatory.registry, step.skills],
  )

  function addSkill(): void {
    if (pendingSkill === '') return
    const last = step.skills.at(-1)
    editor.addSkill(lane.id, pendingSkill)
    // 新技能默认串行：跟在上一技能之后。
    if (last) editor.setSkillDependency(lane.id, pendingSkill, last.id, null)
    setPendingSkill('')
  }
  function toggleParallel(skillIndex: number): void {
    const current = step.skills[skillIndex]
    const previous = step.skills[skillIndex - 1]
    if (!current || !previous) return
    if (isParallelWithPrevious(step.skills, skillIndex)) editor.setSkillDependency(lane.id, current.id, previous.id, null)
    else editor.setSkillDependency(lane.id, current.id, null, previous.id)
  }

  const summary = lane.skills === undefined
    ? t('workflow.card_skills_matrix')
    : t('workflow.summary', { skills: step.skills.length, waves: waves.length })

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
          <span className="max-w-[40ch] truncate text-caption text-red-d" role="alert" data-testid="wb-save-error" title={editor.saveStatus.errors.join('\n')}>{editor.saveStatus.errors[0]}</span>
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
      header={(
        <>
          <p className="mb-2.5 text-caption font-semibold text-(--accent)">{t('workflow.rail_title')} / {t('workflow.detail_eyebrow')}</p>
          <h1 className="mb-1.5 text-page font-bold tracking-[-.01em] text-text" data-testid={`wb-lane-name-${lane.id}`}>{lane.name}</h1>
          <p className="mb-4 font-mono text-base text-text-2">{editor.wfName} · {lane.id} · {t('workflow.stage_position', { n: index + 1, total: steps.length })}</p>
          <p className="mb-5 flex flex-wrap items-center gap-3.5">
            <StatusPill tone={lane.gate === null ? 'neutral' : 'pending'}>{lane.gate === null ? t('workflow.gate_none') : t(lane.gate === 'review' ? 'workflow.gate_tag_review' : 'workflow.gate_tag_confirm')}</StatusPill>
            <span className="text-base text-text-2">{summary}</span>
          </p>
          {!readonly && (
            <div className="mb-6 flex flex-wrap items-center gap-2 border-b border-border pb-6" data-testid="stage-actions">
              <label className="flex min-w-0 flex-1 items-center gap-2 text-body text-text-2">
                <span className="flex-none">{t('workflow.settings_name')}</span>
                <input className={`${FIELD_CLS} min-w-0 flex-1`} value={lane.name} data-testid={`wb-lane-name-input-${lane.id}`} onChange={(event) => editor.editLane(lane.id, { label: event.target.value })} />
              </label>
              <button type="button" className={SMALL_BTN} disabled={index <= 0} data-testid={`wb-lane-up-${lane.id}`} aria-label={t('workflow.settings_move_up')} onClick={() => { const previous = steps[index - 1]; if (previous) editor.reorderStages(lane.id, previous.id, false) }}><ArrowUp className="size-4" aria-hidden="true" /></button>
              <button type="button" className={SMALL_BTN} disabled={index < 0 || index >= steps.length - 1} data-testid={`wb-lane-down-${lane.id}`} aria-label={t('workflow.settings_move_down')} onClick={() => { const next = steps[index + 1]; if (next) editor.reorderStages(lane.id, next.id, true) }}><ArrowDown className="size-4" aria-hidden="true" /></button>
              {confirmDelete ? (
                <>
                  <span className="text-body text-red-d">{t('workflow.settings_delete_confirm', { name: lane.name })}</span>
                  <button type="button" className={SMALL_BTN} onClick={() => setConfirmDelete(false)}>{t('workbench.workflow_cancel')}</button>
                  <button type="button" className={`${SMALL_BTN} border-red-b text-red-d hover:bg-red-t`} data-testid={`wb-lane-remove-confirm-${lane.id}`} onClick={() => { setConfirmDelete(false); editor.removeStage(lane.id) }}>{t('workbench.timeline_delete_confirm')}</button>
                </>
              ) : (
                <button type="button" className={`${SMALL_BTN} text-red-d hover:border-red-b hover:bg-red-t`} data-testid={`wb-lane-remove-${lane.id}`} aria-label={t('workflow.settings_delete')} onClick={() => setConfirmDelete(true)}><Trash2 className="size-4" aria-hidden="true" /></button>
              )}
            </div>
          )}
        </>
      )}
      footer={footer}
    >
      <section className="mb-8" data-testid="stage-skills">
        <SectionHead title={t('workflow.skills_title')} meta={t('workflow.waves_hint')} />
        {lane.skills === undefined ? (
          mandatory.table === null ? (
            <p className="text-body text-text-3" role="status">{t('workbench.track_loading')}</p>
          ) : (
            <ul className="grid gap-2" data-testid="stage-skills-matrix">
              {mandatory.matrixTracks.map((track) => {
                const cell = resolveMandatoryCell(mandatory.table ?? {}, track, lane.id, mandatory.writableProfiles)
                return (
                  <li key={track.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md border border-border bg-card px-4 py-3">
                    <span className="min-w-0">
                      <span className="block text-base font-semibold text-text">{trackDisplayName(track, lang)}</span>
                      <span className="block truncate font-mono text-caption text-text-2">{cell.skills.length > 0 ? cell.skills.join(' → ') : t('workflow.card_skills_none')}</span>
                    </span>
                    <span className="text-caption text-text-3">{t('workflow.serial')}</span>
                  </li>
                )
              })}
            </ul>
          )
        ) : (
          <>
            {step.skills.length === 0 ? (
              <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-body text-text-3" role="status">{t('workflow.card_skills_none')}</p>
            ) : (
              <ol className="grid gap-2" data-testid="stage-skills-list">
                {step.skills.map((skill, skillIndex) => {
                  const parallel = isParallelWithPrevious(step.skills, skillIndex)
                  return (
                    <li key={skill.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-3 rounded-md border border-border bg-card px-3.5 py-3" data-testid={`stage-skill-${skill.id}`} data-parallel={parallel}>
                      <span className="grid size-6 place-items-center rounded-xs bg-fill font-mono text-caption text-text-2" aria-hidden="true">{skillIndex + 1}</span>
                      <span className="min-w-0 truncate font-mono text-body font-semibold text-text">{skill.id}</span>
                      {skillIndex === 0 ? (
                        <span className="text-caption text-text-3">{t('workflow.serial_first')}</span>
                      ) : (
                        <button
                          type="button"
                          className={`${SMALL_BTN} min-h-8 px-2.5 text-caption`}
                          disabled={readonly}
                          aria-pressed={parallel}
                          title={t(parallel ? 'workflow.toggle_serial' : 'workflow.toggle_parallel')}
                          data-testid={`stage-skill-mode-${skill.id}`}
                          onClick={() => toggleParallel(skillIndex)}
                        >
                          {t(parallel ? 'workflow.parallel_with_prev' : 'workflow.serial_after_prev')}
                        </button>
                      )}
                      <button type="button" className="grid size-8 place-items-center rounded-sm text-text-3 hover:bg-fill hover:text-red-d disabled:opacity-40" disabled={readonly} aria-label={t('workflow.remove_skill', { id: skill.id })} data-testid={`stage-skill-remove-${skill.id}`} onClick={() => editor.removeSkill(lane.id, skill.id)}><X className="size-4" aria-hidden="true" /></button>
                    </li>
                  )
                })}
              </ol>
            )}
            {!readonly && (
              <div className="mt-3 flex items-center gap-2">
                <select className={`${FIELD_CLS} min-w-0 flex-1 font-mono`} value={pendingSkill} data-testid="stage-skill-picker" disabled={mandatory.registry === null} onChange={(event) => setPendingSkill(event.target.value)}>
                  <option value="">{mandatory.registry === null ? t('common.loading') : t('workflow.add_skill_placeholder')}</option>
                  {available.map((entry) => <option key={entry.name} value={entry.name}>{entry.name}</option>)}
                </select>
                <button type="button" className={`${SMALL_BTN} min-h-10`} disabled={pendingSkill === ''} data-testid="stage-skill-add" onClick={addSkill}><Plus className="size-4" aria-hidden="true" />{t('workflow.add_skill')}</button>
              </div>
            )}
          </>
        )}
      </section>

      <section className="mb-8" data-testid="stage-gate">
        <SectionHead title={t('workflow.gate_title')} />
        <label className="grid max-w-[360px] gap-1.5">
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
      </section>

      <section data-testid="stage-io">
        <SectionHead title={t('workflow.io_title')} meta={t('workflow.io_hint')} />
        <DerivedIoPanel step={step} steps={steps} labelOf={labelOf} />
      </section>
    </DetailColumn>
  )
}
