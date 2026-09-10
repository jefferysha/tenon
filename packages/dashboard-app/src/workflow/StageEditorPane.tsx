import { useMemo, useState } from 'react'
import { ChevronRight, Circle, Info, Pencil, ShieldCheck, Trash2, Zap, type LucideIcon } from 'lucide-react'
import type { WbIoSlot, WbStepDef } from '../api/governanceTypes'
import { useT } from '../i18n'
import { DetailColumn } from '../shell/ThreeColumns'
import { wavesOf } from '../workbench/skillWaves'
import type { WorkflowEditor } from '../workbench/useWorkflowEditor'
import { BASE_BRANCH } from '../workbench/workbenchDefinition'
import { slotLabel } from '../workspace/taskModel'
import { SkillComposer } from './SkillComposer'
import { SkillDetailDrawer } from './SkillDetail'
import { SkillWaveCards } from './SkillWaveCards'
import { SlotList, type SlotRow } from './SlotList'
import { cn } from '@/lib/utils'

export interface StageEditorPaneProps {
  editor: WorkflowEditor
  step: WbStepDef
}

type View = 'stage' | 'outputs' | 'inputs'

const SMALL_BTN = 'inline-flex min-h-9 items-center gap-1.5 rounded-sm border border-border bg-card px-3 text-body text-text-2 hover:border-text-3 hover:text-text disabled:opacity-50'
const GATES: Array<{ gate: WbStepDef['gate']; key: 'none' | 'review' | 'auto'; icon: LucideIcon }> = [
  { gate: null, key: 'none', icon: Circle },
  { gate: 'review', key: 'review', icon: ShieldCheck },
  { gate: 'auto', key: 'auto', icon: Zap },
]

/** 契约里的产出者候选带插件前缀别名（superpowers:brainstorming）；与阶段技能按裸名匹配，命中则只显命中的。 */
function bareName(skill: string): string {
  const colon = skill.indexOf(':')
  return colon === -1 ? skill : skill.slice(colon + 1)
}
export function producerSkills(candidates: readonly string[], stageSkills: readonly string[]): string[] {
  const hits = stageSkills.filter((skill) => candidates.some((candidate) => bareName(candidate) === bareName(skill)))
  if (hits.length > 0) return hits
  return [...new Set(candidates.map(bareName))]
}

function Crumb({ children, current, onClick, testId }: { children: string; current?: boolean; onClick?: () => void; testId?: string }): JSX.Element {
  const cls = cn('max-w-[24ch] truncate text-body', current ? 'font-semibold text-text' : 'text-text-2')
  if (onClick === undefined) return <span className={cls} aria-current={current ? 'page' : undefined} data-testid={testId}>{children}</span>
  return <button type="button" className={cn(cls, 'rounded-xs outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent)')} data-testid={testId} onClick={onClick}>{children}</button>
}

/**
 * 工作流页右列。头部是面包屑（工作流 / 轨道 / 阶段 [/ 输出|输入]）与可直接编辑的阶段名；
 * 正文 = 技能（波次卡片）→ 输出 / 输入两张摘要卡（点开在本列切成 sheet，面包屑返回）→ 门禁。
 * 输入 / 输出全部由定义推导，sheet 只读。
 */
export function StageEditorPane({ editor, step }: StageEditorPaneProps): JSX.Element {
  const { t } = useT()
  const def = editor.def
  const steps = def?.steps ?? []
  const index = steps.findIndex((candidate) => candidate.id === step.id)
  const editable = editor.canWrite
  const [view, setView] = useState<View>('stage')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [composerOpen, setComposerOpen] = useState(false)
  const [skillDetail, setSkillDetail] = useState<string | null>(null)
  const stepIo = editor.effectiveIo?.[step.id]
  const waves = useMemo(() => wavesOf(step.skills), [step.skills])
  const registry = editor.mandatory.registry
  const blocked = editor.lintBlocked
  const branchLabel = editor.branch === BASE_BRANCH ? null : (editor.branches.find((candidate) => candidate.id === editor.branch)?.label ?? editor.branch)
  const yamlBase = editor.branch === BASE_BRANCH ? `steps[${step.id}]` : `tracks.${editor.branch}.steps[${step.id}]`
  const stageSkills = step.skills.map((skill) => skill.id)

  const outputRows: SlotRow[] = (stepIo?.outputs ?? []).map((slot) => ({
    slot,
    skills: slot.kind === 'document' ? producerSkills(slot.producers, stageSkills) : stageSkills,
    stages: slot.consumers.map(editor.labelOf),
    path: slot.kind === 'document' ? `document_contract.slots[${slot.id}]` : `${yamlBase}.outputs[${slot.id}]`,
  }))
  function producerStepOf(slot: WbIoSlot): WbStepDef | undefined {
    const producerId = slot.kind === 'field'
      ? slot.producer
      : steps.find((candidate) => (editor.effectiveIo?.[candidate.id]?.outputs ?? []).some((output) => output.kind === 'document' && output.id === slot.id))?.id ?? null
    return producerId === null ? undefined : steps.find((candidate) => candidate.id === producerId)
  }
  // 输入侧文档槽位的 producers 是产出阶段的 id；技能候选要回到那个阶段的输出槽位上取。
  const inputRows: SlotRow[] = (stepIo?.inputs ?? []).map((slot) => {
    const producer = producerStepOf(slot)
    const producerSkillIds = (producer?.skills ?? []).map((skill) => skill.id)
    const candidates = producer === undefined || slot.kind !== 'document'
      ? []
      : (editor.effectiveIo?.[producer.id]?.outputs ?? []).flatMap((output) => output.kind === 'document' && output.id === slot.id ? output.producers : [])
    return {
      slot,
      skills: slot.kind === 'document' && candidates.length > 0 ? producerSkills(candidates, producerSkillIds) : producerSkillIds,
      stages: producer === undefined ? [] : [editor.labelOf(producer.id)],
      path: slot.kind === 'document' ? `document_contract.reads[${step.id}]` : `${yamlBase}.inputs[${slot.id}]`,
    }
  })

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

  const sheetTitle = view === 'outputs' ? t('workflow.outputs_title') : t('workflow.inputs_title')
  const sheetCount = view === 'outputs' ? outputRows.length : inputRows.length
  const stageLabel = editor.labelOf(step.id)
  const sep = <ChevronRight className="size-3.5 flex-none text-text-3" aria-hidden="true" />

  function summaryCard(kind: 'outputs' | 'inputs', rows: readonly SlotRow[]): JSX.Element {
    const shown = rows.slice(0, 4)
    const rest = rows.length - shown.length
    const missing = kind === 'outputs' && rows.length === 0
    return (
      <button
        type="button"
        className={cn('grid content-start gap-3 rounded-md border bg-card px-4 py-3.5 text-left shadow-xs outline-none transition-[border-color,box-shadow] hover:border-accent-b hover:shadow-sm focus-visible:ring-2 focus-visible:ring-(--accent)', missing ? 'border-amber-b' : 'border-border')}
        data-testid={`wb-open-${kind}`}
        onClick={() => setView(kind)}
      >
        <span className="flex items-center justify-between gap-3">
          <span className="text-base font-semibold text-text">{t(`workflow.${kind}_title`)}</span>
          <span className={cn('font-mono text-title', missing ? 'text-amber-d' : 'text-text-2')} data-testid={`wb-${kind}-count`}>{rows.length}</span>
        </span>
        <span className="flex min-h-6 flex-wrap items-center gap-1">
          {missing
            ? <span className="rounded-full bg-amber-t px-2 py-0.5 text-caption font-semibold text-amber-d">{t('workflow.lint_no_output')}</span>
            : shown.map(({ slot }) => <span key={`${slot.kind}:${slot.id}`} className="rounded-sm bg-fill px-1.5 py-0.5 font-mono text-caption text-text-2">{slotLabel(slot, t)}</span>)}
          {rest > 0 && <span className="font-mono text-caption text-text-3">+{rest}</span>}
        </span>
      </button>
    )
  }

  return (
    <>
      <DetailColumn
        testId="stage-editor-pane"
        panelId="stage-editor-panel"
        header={(
          <>
            <nav className="mb-4 flex min-w-0 items-center gap-1.5" aria-label={t('workflow.crumbs')} data-testid="wb-crumbs">
              <Crumb>{editor.wfName ?? ''}</Crumb>
              {branchLabel !== null && <>{sep}<Crumb>{branchLabel}</Crumb></>}
              {sep}
              {view === 'stage'
                ? <Crumb current testId={`wb-lane-name-${step.id}`}>{stageLabel}</Crumb>
                : <><Crumb testId={`wb-lane-name-${step.id}`} onClick={() => setView('stage')}>{stageLabel}</Crumb>{sep}<Crumb current testId="wb-crumb-sheet">{sheetTitle}</Crumb></>}
            </nav>
            {view === 'stage' ? (
              <div className="flex items-start gap-3" data-testid="stage-actions">
                <input
                  className="min-w-0 flex-1 rounded-xs border-b border-transparent bg-transparent pb-0.5 text-page font-bold tracking-[-.01em] text-text outline-none transition-colors hover:border-border focus:border-accent-b disabled:cursor-default disabled:hover:border-transparent"
                  value={step.label}
                  disabled={!editable}
                  aria-label={t('workflow.stage_name')}
                  data-testid={`wb-lane-name-input-${step.id}`}
                  onChange={(event) => editor.renameStep(step.id, event.target.value)}
                />
                <span className="mt-2.5 flex flex-none items-center gap-2">
                  <span className="font-mono text-body text-text-3">{index + 1} / {steps.length}</span>
                  {confirmDelete ? (
                    <>
                      <span className="text-body text-red-d">{t('workflow.settings_delete_confirm', { name: stageLabel })}</span>
                      <button type="button" className={SMALL_BTN} onClick={() => setConfirmDelete(false)}>{t('workflow.cancel')}</button>
                      <button type="button" className={`${SMALL_BTN} border-red-b text-red-d hover:bg-red-t`} data-testid={`wb-lane-remove-confirm-${step.id}`} onClick={() => { setConfirmDelete(false); editor.removeStage(step.id) }}>{t('workflow.settings_delete')}</button>
                    </>
                  ) : (
                    <button type="button" className="grid size-8 place-items-center rounded-sm text-text-3 outline-none hover:bg-red-t hover:text-red-d focus-visible:ring-2 focus-visible:ring-(--accent) disabled:cursor-not-allowed disabled:opacity-40" disabled={!editable || steps.length <= 1} data-testid={`wb-lane-remove-${step.id}`} aria-label={t('workflow.delete_stage')} title={t('workflow.delete_stage')} onClick={() => setConfirmDelete(true)}><Trash2 className="size-4" aria-hidden="true" /></button>
                  )}
                </span>
              </div>
            ) : (
              <div className="flex items-baseline gap-3">
                <h1 className="text-page font-bold tracking-[-.01em] text-text" data-testid="wb-sheet-title">{sheetTitle}</h1>
                <span className="font-mono text-body text-text-3">{sheetCount}</span>
              </div>
            )}
          </>
        )}
        footer={footer}
      >
        {view === 'stage' ? (
          <div className="grid gap-10 pt-3">
            <section data-testid="stage-skills">
              <div className="mb-4 flex items-center justify-between gap-3">
                <h2 className="flex items-baseline gap-2 text-section font-bold text-text">{t('workflow.skills_title')}<span className="font-mono text-body font-normal text-text-3">{step.skills.length}</span></h2>
                {editable && (
                  <button type="button" className={SMALL_BTN} data-testid="wb-skills-edit" onClick={() => setComposerOpen(true)}>
                    <Pencil className="size-3.5" aria-hidden="true" />
                    {t('workflow.edit_skills')}
                  </button>
                )}
              </div>
              <SkillWaveCards waves={waves} registry={registry} onOpen={setSkillDetail} />
            </section>

            <section className="grid grid-cols-2 gap-3 max-[1100px]:grid-cols-1" data-testid="stage-io">
              {summaryCard('outputs', outputRows)}
              {summaryCard('inputs', inputRows)}
            </section>

            <section data-testid="stage-gate">
              <h2 className="mb-4 text-section font-bold text-text">{t('workflow.gate_title')}</h2>
              <div className="grid grid-cols-3 gap-2 max-[1100px]:grid-cols-1" role="radiogroup" aria-label={t('workflow.gate_title')} data-testid={`wb-lane-gate-${step.id}`}>
                {GATES.map(({ gate, key, icon: Icon }) => {
                  const checked = step.gate === gate
                  return (
                    <button
                      key={key}
                      type="button"
                      role="radio"
                      aria-checked={checked}
                      aria-describedby={`gate-help-${step.id}-${key}`}
                      disabled={!editable}
                      title={t(`workflow.gate_help_${key}`)}
                      className={cn('grid gap-2 rounded-md border px-4 py-3 text-left outline-none transition-[border-color,background-color] focus-visible:ring-2 focus-visible:ring-(--accent) disabled:cursor-not-allowed', checked ? 'border-accent-b bg-accent-t' : 'border-border bg-card hover:border-border-2')}
                      data-testid={`wb-lane-gate-${step.id}-${key}`}
                      onClick={() => editor.setGate(step.id, gate)}
                    >
                      <span className="flex items-center justify-between">
                        <Icon className={cn('size-4', checked ? 'text-(--accent)' : 'text-text-3')} aria-hidden="true" />
                        <Info className="size-3.5 text-text-3" aria-hidden="true" />
                      </span>
                      <span className={cn('text-base font-semibold', checked ? 'text-(--accent)' : 'text-text')}>{t(`workflow.gate_${key}`)}</span>
                      <span id={`gate-help-${step.id}-${key}`} className="sr-only">{t(`workflow.gate_help_${key}`)}</span>
                    </button>
                  )
                })}
              </div>
            </section>
          </div>
        ) : (
          <div className="pt-1" data-testid={`${view}-sheet`}>
            {view === 'outputs' ? (
              <SlotList rows={outputRows} direction="outputs" registry={registry} empty={<p className="rounded-md border border-dashed border-amber-b bg-amber-t px-4 py-5 text-center text-body text-amber-d" role="status" data-testid="stage-outputs-empty">{t('workflow.lint_no_output')}</p>} />
            ) : (
              <SlotList rows={inputRows} direction="inputs" registry={registry} empty={<p className="rounded-md border border-dashed border-border px-4 py-5 text-center text-body text-text-3" role="status" data-testid="stage-inputs-empty">{t('workflow.no_inputs')}</p>} />
            )}
          </div>
        )}
      </DetailColumn>

      <SkillComposer
        open={composerOpen}
        stageLabel={stageLabel}
        skills={step.skills}
        registry={registry}
        onClose={() => setComposerOpen(false)}
        onSave={(next) => editor.setSkillWaves(step.id, next)}
      />
      <SkillDetailDrawer name={skillDetail} onClose={() => setSkillDetail(null)} />
    </>
  )
}
