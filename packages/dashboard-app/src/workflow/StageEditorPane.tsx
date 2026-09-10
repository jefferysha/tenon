import { useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react'
import type { WbStepDef } from '../api/governanceTypes'
import { useT } from '../i18n'
import { DetailColumn } from '../shell/ThreeColumns'
import type { WorkflowEditor } from '../workbench/useWorkflowEditor'
import { InputsSection, OutputsSection } from './IoSections'
import { SkillDag } from './SkillDag'
import { availableOutputSlots, upstreamOutputs } from './slotCatalog'
import { cn } from '@/lib/utils'

export interface StageEditorPaneProps {
  editor: WorkflowEditor
  step: WbStepDef
}

const FIELD_CLS = 'min-h-10 rounded-sm border border-border bg-card px-3 text-base text-text outline-none focus:border-accent-b disabled:cursor-not-allowed disabled:bg-fill disabled:text-text-3'
const SMALL_BTN = 'inline-flex min-h-9 items-center gap-1.5 rounded-sm border border-border bg-card px-3 text-body text-text-2 hover:border-text-3 hover:text-text disabled:opacity-50'
const GATES: Array<WbStepDef['gate']> = [null, 'review', 'confirm']

/** 工作流页右列：阶段名与顺序 → 技能 DAG → 轨道技能 → 输出 → 输入 → 门禁；底栏保存 / 放弃。 */
export function StageEditorPane({ editor, step }: StageEditorPaneProps): JSX.Element {
  const { t } = useT()
  const def = editor.def
  const steps = def?.steps ?? []
  const index = steps.findIndex((candidate) => candidate.id === step.id)
  const editable = editor.canWrite
  const [confirmDelete, setConfirmDelete] = useState(false)
  const stepIo = editor.effectiveIo?.[step.id]
  const candidates = useMemo(() => def ? availableOutputSlots(def, step.id, editor.effectiveIo) : [], [def, step.id, editor.effectiveIo])
  const upstream = useMemo(() => def ? upstreamOutputs(def, step.id, editor.effectiveIo) : [], [def, step.id, editor.effectiveIo])
  const blocked = editor.lint.length > 0

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

  return (
    <DetailColumn
      testId="stage-editor-pane"
      panelId="stage-editor-panel"
      header={(
        <>
          <p className="mb-2.5 text-caption font-semibold text-(--accent)">{editor.wfName}</p>
          <h1 className="mb-1.5 text-page font-bold tracking-[-.01em] text-text" data-testid={`wb-lane-name-${step.id}`}>{editor.labelOf(step.id)}</h1>
          <p className="mb-5 font-mono text-base text-text-2">{step.id} · {index + 1} / {steps.length}</p>
          <div className="mb-6 flex flex-wrap items-center gap-2 border-b border-border pb-6" data-testid="stage-actions">
            <label className="flex min-w-0 flex-1 items-center gap-2 text-body text-text-2">
              <span className="flex-none">{t('workflow.settings_name')}</span>
              <input className={`${FIELD_CLS} min-w-0 flex-1`} value={step.label} disabled={!editable} data-testid={`wb-lane-name-input-${step.id}`} onChange={(event) => editor.renameStep(step.id, event.target.value)} />
            </label>
            <button type="button" className={SMALL_BTN} disabled={!editable || index <= 0} data-testid={`wb-lane-up-${step.id}`} aria-label={t('workflow.settings_move_up')} onClick={() => { const previous = steps[index - 1]; if (previous) editor.reorderStages(step.id, previous.id, false) }}><ArrowUp className="size-4" aria-hidden="true" /></button>
            <button type="button" className={SMALL_BTN} disabled={!editable || index < 0 || index >= steps.length - 1} data-testid={`wb-lane-down-${step.id}`} aria-label={t('workflow.settings_move_down')} onClick={() => { const next = steps[index + 1]; if (next) editor.reorderStages(step.id, next.id, true) }}><ArrowDown className="size-4" aria-hidden="true" /></button>
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
        <h2 className="mb-3 text-section font-bold text-text">{t('workflow.skills_title')}</h2>
        <SkillDag
          skills={step.skills}
          registry={editor.mandatory.registry}
          tracks={editor.mandatory.tracks}
          editable={editable}
          onWaves={(next) => editor.setSkillWaves(step.id, next)}
          onWhen={(skillId, when) => editor.setSkillWhen(step.id, skillId, when)}
        />
      </section>

      <OutputsSection
        slots={stepIo?.outputs ?? []}
        candidates={candidates}
        editable={editable}
        labelOf={editor.labelOf}
        onAdd={(candidate) => editor.addOutput(step.id, candidate)}
        onRemove={(candidate) => editor.removeOutput(step.id, candidate)}
      />

      <InputsSection
        upstream={upstream}
        inputs={stepIo?.inputs ?? []}
        editable={editable}
        labelOf={editor.labelOf}
        onToggle={(candidate, on) => editor.setInput(step.id, candidate, on)}
      />

      <section data-testid="stage-gate">
        <h2 className="mb-3 text-section font-bold text-text">{t('workflow.gate_title')}</h2>
        <div className="inline-flex rounded-md border border-border bg-card p-0.5" role="radiogroup" aria-label={t('workflow.gate_title')} data-testid={`wb-lane-gate-${step.id}`}>
          {GATES.map((gate) => (
            <button
              key={gate ?? 'none'}
              type="button"
              role="radio"
              aria-checked={step.gate === gate}
              disabled={!editable}
              className={cn('min-h-8 rounded-sm px-3 text-body text-text-2 outline-none focus-visible:ring-2 focus-visible:ring-(--accent) disabled:cursor-not-allowed', step.gate === gate && 'bg-accent-t font-semibold text-(--accent)')}
              data-testid={`wb-lane-gate-${step.id}-${gate ?? 'none'}`}
              onClick={() => editor.setGate(step.id, gate)}
            >
              {t(gate === null ? 'workflow.gate_none' : gate === 'review' ? 'workflow.gate_review' : 'workflow.gate_confirm')}
            </button>
          ))}
        </div>
      </section>
    </DetailColumn>
  )
}
