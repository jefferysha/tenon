import { useMemo, useState } from 'react'
import { ArrowRight, FileText, Info, Pencil, Trash2 } from 'lucide-react'
import type { WbIoSlot, WbStepDef } from '../api/governanceTypes'
import { useT } from '../i18n'
import { Drawer } from '../shared/Drawer'
import { DetailColumn } from '../shell/ThreeColumns'
import { wavesOf } from '../workbench/skillWaves'
import type { WorkflowEditor } from '../workbench/useWorkflowEditor'
import { BASE_BRANCH } from '../workbench/workbenchDefinition'
import { InputsSection, OutputsSection, type SlotProvenance } from './IoSections'
import { SkillComposer } from './SkillComposer'
import { SkillWavesView } from './SkillDag'
import { SkillDetailDrawer } from './SkillDetail'
import { availableOutputSlots, upstreamOutputs } from './slotCatalog'
import { cn } from '@/lib/utils'

export interface StageEditorPaneProps {
  editor: WorkflowEditor
  step: WbStepDef
}

const FIELD_CLS = 'min-h-10 rounded-sm border border-border bg-card px-3 text-base text-text outline-none focus:border-accent-b disabled:cursor-not-allowed disabled:bg-fill disabled:text-text-3'
const SMALL_BTN = 'inline-flex min-h-9 items-center gap-1.5 rounded-sm border border-border bg-card px-3 text-body text-text-2 hover:border-text-3 hover:text-text disabled:opacity-50'
const GATES: Array<WbStepDef['gate']> = [null, 'review', 'auto']

/** 工作流页右列：阶段名与顺序 → 技能（只读波次 + 编辑浮层）→ 输出 / 输入两个 sheet 入口 → 门禁；底栏保存 / 放弃。 */
export function StageEditorPane({ editor, step }: StageEditorPaneProps): JSX.Element {
  const { t } = useT()
  const def = editor.def
  const steps = def?.steps ?? []
  const index = steps.findIndex((candidate) => candidate.id === step.id)
  const editable = editor.canWrite
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [composerOpen, setComposerOpen] = useState(false)
  const [skillDetail, setSkillDetail] = useState<string | null>(null)
  const [sheet, setSheet] = useState<'outputs' | 'inputs' | null>(null)
  const stepIo = editor.effectiveIo?.[step.id]
  const candidates = useMemo(() => def ? availableOutputSlots(def, step.id, editor.effectiveIo) : [], [def, step.id, editor.effectiveIo])
  const upstream = useMemo(() => def ? upstreamOutputs(def, step.id, editor.effectiveIo) : [], [def, step.id, editor.effectiveIo])
  const waves = useMemo(() => wavesOf(step.skills), [step.skills])
  const blocked = editor.lintBlocked
  const branchLabel = editor.branches.find((candidate) => candidate.id === editor.branch)?.label ?? t('workflow.branch_base')
  const yamlBase = editor.branch === BASE_BRANCH ? `steps[${step.id}]` : `tracks.${editor.branch}.steps[${step.id}]`

  /** 输出槽位的产出者：文档槽位取契约 producers（技能），值槽位 = 本阶段技能。 */
  function outputProvenance(slot: WbIoSlot): SlotProvenance {
    const skills = slot.kind === 'document' && slot.producers.length > 0 ? slot.producers : step.skills.map((skill) => skill.id)
    return {
      text: skills.length === 0 ? t('workflow.no_producer') : t('workflow.produced_by_skills', { skills: skills.join(' / ') }),
      path: slot.kind === 'document' ? `document_contract.slots[${slot.id}]` : `${yamlBase}.outputs[${slot.id}]`,
    }
  }
  /** 输入槽位的来源：产出它的阶段 + 那个阶段的技能。 */
  function inputProvenance(slot: WbIoSlot): SlotProvenance {
    const producerStepId = slot.kind === 'field'
      ? slot.producer
      : steps.find((candidate) => (editor.effectiveIo?.[candidate.id]?.outputs ?? []).some((output) => output.kind === 'document' && output.id === slot.id))?.id ?? null
    const producerStep = producerStepId === null ? undefined : steps.find((candidate) => candidate.id === producerStepId)
    const skills = slot.kind === 'document' && slot.producers.length > 0 ? slot.producers : (producerStep?.skills ?? []).map((skill) => skill.id)
    return {
      text: producerStep === undefined ? t('workflow.no_producer') : t('workflow.from_stage', { stage: editor.labelOf(producerStep.id), skills: skills.join(' / ') || '—' }),
      path: slot.kind === 'document' ? `document_contract.reads[${step.id}]` : `${yamlBase}.inputs[${slot.id}]`,
    }
  }

  const footer = (
    <>
      <p className="flex min-w-0 items-center gap-2 text-body text-text-2">
        {!editable ? (
          <span data-testid="wb-no-token">{t('workflow.no_token')}</span>
        ) : editor.dirty ? (
          <><span className="size-1.5 rounded-full bg-(--amber-d)" aria-hidden="true" /><span data-testid="wb-dirty" role="status" aria-live="polite">{blocked ? t('workflow.lint_blocked') : t('workflow.dirty')}</span></>
        ) : editor.saveStatus.kind === 'ok' ? (
          <span data-testid="wb-save-ok" role="status" aria-live="polite" className="text-green-d">{t('workflow.saved')}</span>
        ) : (
          <span className="font-mono">{editor.wfName}</span>
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
        <button type="button" className="min-h-10 rounded-md bg-(--accent) px-4 text-base font-semibold text-btn-fg hover:bg-accent-d disabled:opacity-50" data-testid="wb-save" disabled={!editable || !editor.dirty || editor.saving || blocked} onClick={() => void editor.save()}>{t('workflow.save')}</button>
      </span>
    </>
  )

  const entryCls = 'grid w-full grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-3 rounded-md border border-border bg-card px-4 py-3 text-left outline-none hover:border-accent-b focus-visible:ring-2 focus-visible:ring-(--accent)'

  return (
    <>
      <DetailColumn
        testId="stage-editor-pane"
        panelId="stage-editor-panel"
        header={(
          <>
            <p className="mb-2.5 text-caption font-semibold text-(--accent)">{editor.wfName} · {branchLabel}</p>
            <h1 className="mb-1.5 text-page font-bold tracking-[-.01em] text-text" data-testid={`wb-lane-name-${step.id}`}>{editor.labelOf(step.id)}</h1>
            <p className="mb-5 font-mono text-base text-text-2">{index + 1} / {steps.length}</p>
            <div className="mb-6 flex flex-wrap items-center gap-2 border-b border-border pb-6" data-testid="stage-actions">
              <label className="flex min-w-0 flex-1 items-center gap-2 text-body text-text-2">
                <span className="flex-none">{t('workflow.settings_name')}</span>
                <input className={`${FIELD_CLS} min-w-0 flex-1`} value={step.label} disabled={!editable} data-testid={`wb-lane-name-input-${step.id}`} onChange={(event) => editor.renameStep(step.id, event.target.value)} />
              </label>
              {confirmDelete ? (
                <>
                  <span className="text-body text-red-d">{t('workflow.settings_delete_confirm', { name: editor.labelOf(step.id) })}</span>
                  <button type="button" className={SMALL_BTN} onClick={() => setConfirmDelete(false)}>{t('workflow.cancel')}</button>
                  <button type="button" className={`${SMALL_BTN} border-red-b text-red-d hover:bg-red-t`} data-testid={`wb-lane-remove-confirm-${step.id}`} onClick={() => { setConfirmDelete(false); editor.removeStage(step.id) }}>{t('workflow.settings_delete')}</button>
                </>
              ) : (
                <button type="button" className={`${SMALL_BTN} text-red-d hover:border-red-b hover:bg-red-t`} disabled={!editable || steps.length <= 1} data-testid={`wb-lane-remove-${step.id}`} aria-label={t('workflow.settings_delete')} onClick={() => setConfirmDelete(true)}><Trash2 className="size-4" aria-hidden="true" /></button>
              )}
            </div>
          </>
        )}
        footer={footer}
      >
        <section className="mb-8" data-testid="stage-skills">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-section font-bold text-text">{t('workflow.skills_title')}</h2>
            {editable && (
              <button type="button" className={SMALL_BTN} data-testid="wb-skills-edit" onClick={() => setComposerOpen(true)}>
                <Pencil className="size-3.5" aria-hidden="true" />
                {t('workflow.edit_skills')}
              </button>
            )}
          </div>
          <SkillWavesView waves={waves} onOpen={setSkillDetail} />
        </section>

        <section className="mb-8 grid gap-2" data-testid="stage-io">
          <button type="button" className={entryCls} data-testid="wb-open-outputs" onClick={() => setSheet('outputs')}>
            <FileText className="size-4 text-text-3" aria-hidden="true" />
            <span className="text-base font-semibold text-text">{t('workflow.open_outputs')}</span>
            <span className={cn('font-mono text-body', (stepIo?.outputs.length ?? 0) === 0 ? 'text-amber-d' : 'text-text-2')} data-testid="wb-outputs-count">{stepIo?.outputs.length ?? 0}</span>
            <ArrowRight className="size-4 text-text-3" aria-hidden="true" />
          </button>
          <button type="button" className={entryCls} data-testid="wb-open-inputs" onClick={() => setSheet('inputs')}>
            <FileText className="size-4 text-text-3" aria-hidden="true" />
            <span className="text-base font-semibold text-text">{t('workflow.open_inputs')}</span>
            <span className="font-mono text-body text-text-2" data-testid="wb-inputs-count">{stepIo?.inputs.length ?? 0}</span>
            <ArrowRight className="size-4 text-text-3" aria-hidden="true" />
          </button>
        </section>

        <section data-testid="stage-gate">
          <h2 className="mb-3 text-section font-bold text-text">{t('workflow.gate_title')}</h2>
          <div className="inline-flex rounded-md border border-border bg-card p-0.5" role="radiogroup" aria-label={t('workflow.gate_title')} data-testid={`wb-lane-gate-${step.id}`}>
            {GATES.map((gate) => {
              const key = gate ?? 'none'
              return (
                <button
                  key={key}
                  type="button"
                  role="radio"
                  aria-checked={step.gate === gate}
                  aria-describedby={`gate-help-${step.id}-${key}`}
                  disabled={!editable}
                  title={t(`workflow.gate_help_${key}`)}
                  className={cn('inline-flex min-h-8 items-center gap-1.5 rounded-sm px-3 text-body text-text-2 outline-none focus-visible:ring-2 focus-visible:ring-(--accent) disabled:cursor-not-allowed', step.gate === gate && 'bg-accent-t font-semibold text-(--accent)')}
                  data-testid={`wb-lane-gate-${step.id}-${key}`}
                  onClick={() => editor.setGate(step.id, gate)}
                >
                  {t(`workflow.gate_${key}`)}
                  <Info className="size-3.5 text-text-3" aria-hidden="true" />
                  <span id={`gate-help-${step.id}-${key}`} className="sr-only">{t(`workflow.gate_help_${key}`)}</span>
                </button>
              )
            })}
          </div>
        </section>
      </DetailColumn>

      <SkillComposer
        open={composerOpen}
        stageLabel={editor.labelOf(step.id)}
        skills={step.skills}
        registry={editor.mandatory.registry}
        onClose={() => setComposerOpen(false)}
        onSave={(next) => editor.setSkillWaves(step.id, next)}
      />

      <SkillDetailDrawer name={skillDetail} onClose={() => setSkillDetail(null)} />
      <Drawer open={sheet === 'outputs'} onClose={() => setSheet(null)} title={t('workflow.outputs_title')} ariaLabel={t('workflow.outputs_title')} testId="outputs-sheet">
        <OutputsSection
          slots={stepIo?.outputs ?? []}
          candidates={candidates}
          editable={editable}
          labelOf={editor.labelOf}
          provenance={outputProvenance}
          onAdd={(candidate) => editor.addOutput(step.id, candidate)}
          onRemove={(candidate) => editor.removeOutput(step.id, candidate)}
        />
      </Drawer>
      <Drawer open={sheet === 'inputs'} onClose={() => setSheet(null)} title={t('workflow.inputs_title')} ariaLabel={t('workflow.inputs_title')} testId="inputs-sheet">
        <InputsSection
          upstream={upstream}
          inputs={stepIo?.inputs ?? []}
          editable={editable}
          labelOf={editor.labelOf}
          provenance={inputProvenance}
          onToggle={(candidate, on) => editor.setInput(step.id, candidate, on)}
        />
      </Drawer>
    </>
  )
}
