import { useState } from 'react'
import { Check, ChevronRight, Circle, Info, Pencil, Plus, ShieldCheck, Trash2, Zap, type LucideIcon } from 'lucide-react'
import { DOCUMENT_KIND_CATALOG } from '@tenon/kernel/workflow/document-contract-model'
import type { WbIoSlot, WbStepDef } from '../api/governanceTypes'
import { useT } from '../i18n'
import { documentInputCandidates, documentKindsForOutput } from '../workbench/documentContractEdits'
import type { WorkflowEditor } from '../workbench/useWorkflowEditor'
import { backTargetOf, BASE_BRANCH } from '../workbench/workbenchDefinition'
import { AgentComposer } from './AgentComposer'
import { AgentSection } from './AgentSection'
import { issuesFor } from './lint'
import { lintMessage } from './lintMessages'
import { IoTable, type IoRow } from './IoTable'
import { producerSkills } from './producers'
import { SkillComposer } from './SkillComposer'
import { SkillDetailDrawer } from './SkillDetail'
import { TestEditorDrawer } from './TestEditorDrawer'
import { TestsSection } from './TestsSection'
import { SkillFlow } from './SkillFlow'
import { cn } from '@/lib/utils'

export interface StageEditorPaneProps {
  editor: WorkflowEditor
  step: WbStepDef
}

const GATES: Array<{ gate: WbStepDef['gate']; key: 'none' | 'review' | 'auto'; icon: LucideIcon }> = [
  { gate: null, key: 'none', icon: Circle },
  { gate: 'review', key: 'review', icon: ShieldCheck },
  { gate: 'auto', key: 'auto', icon: Zap },
]

const HEAD_ACTION = 'inline-flex items-center gap-1.5 whitespace-nowrap text-body text-text-2 outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent)'
const POPOVER = 'absolute right-0 top-[calc(100%+6px)] z-40 min-w-[260px] rounded-md border border-border bg-card p-1 shadow-lg'
const POPOVER_ROW = 'flex w-full items-center gap-2 whitespace-nowrap rounded-sm px-2.5 py-2 text-left text-body outline-none hover:bg-fill focus-visible:bg-fill'

function SectionHead({ title, count, action }: { title: string; count?: number; action?: JSX.Element }): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <h2 className="text-title font-semibold text-text">
        {title}
        {count !== undefined && <span className="ml-2 font-mono text-caption font-normal text-text-3">{count}</span>}
      </h2>
      {action}
    </div>
  )
}

/**
 * 工作流页右栏：面包屑 + 可编辑标题；段落顺序 输入 → 技能 → 执行者 → 输出 → 评审者 → 门禁 → 退回。
 * 段头一行（标题 · 计数 · 动作），内容满宽。字段输入输出由定义推导；开启 OpenSpec 时文档输出用「+ 输出」声明，文档输入用「+ 输入」勾选。
 */
export function StageEditorPane({ editor, step }: StageEditorPaneProps): JSX.Element {
  const { t } = useT()
  const def = editor.def
  const steps = def?.steps ?? []
  const index = steps.findIndex((candidate) => candidate.id === step.id)
  const editable = editor.canWrite
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [composerOpen, setComposerOpen] = useState(false)
  const [agentRole, setAgentRole] = useState<'executors' | 'reviewers' | null>(null)
  const [skillDetail, setSkillDetail] = useState<string | null>(null)
  const [outputPicker, setOutputPicker] = useState(false)
  const [testDetail, setTestDetail] = useState<string | null>(null)
  const [inputPicker, setInputPicker] = useState(false)
  const stepIo = editor.effectiveIo?.[step.id]
  const registry = editor.mandatory.registry
  const blocked = editor.lintBlocked
  const branchLabel = editor.branch === BASE_BRANCH ? null : (editor.branches.find((candidate) => candidate.id === editor.branch)?.label ?? editor.branch)
  const yamlBase = editor.branch === BASE_BRANCH ? `steps[${step.id}]` : `tracks.${editor.branch}.steps[${step.id}]`
  const contractBase = editor.branch === BASE_BRANCH ? 'document_contract' : `tracks.${editor.branch}.document_contract`
  const stageSkills = step.skills.map((skill) => skill.id)
  const stageLabel = editor.labelOf(step.id)
  const documentsEditable = editable && def?.openspec === true
  const outputChoices = documentsEditable && def !== null ? documentKindsForOutput(def, step.id) : []
  const inputChoices = documentsEditable && def !== null ? documentInputCandidates(def, step.id) : []
  const checkedInputs = new Set([
    ...(def?.documentContract?.reads.find((read) => read.step === step.id)?.kinds ?? []),
    ...(def?.documentContract?.slots ?? []).filter((slot) => slot.ownerStep === step.id && slot.role === 'require').map((slot) => slot.kind),
  ])
  const documentLint = issuesFor(editor.lint, step.id).find((issue) => issue.kind.startsWith('document-'))
  // 退回目标只能是本阶段之前的阶段：往后跳在流程里不存在，从选项里就配不出来。
  const backTargets = steps.slice(0, Math.max(index, 0)).map((candidate) => ({ id: candidate.id, label: candidate.label }))
  const backTarget = def === null ? null : backTargetOf(def, step.id)
  // 保存已被 editor.lintBlocked 挡住，这里只说清楚是哪一条。
  const backIssues = issuesFor(editor.lint, step.id)
    .filter((issue) => issue.kind.startsWith('transition-'))
    .map((issue) => lintMessage(t, issue, editor.labelOf))

  const outputRows: IoRow[] = (stepIo?.outputs ?? []).map((slot) => ({
    slot,
    stage: stageLabel,
    skills: slot.kind === 'document' ? producerSkills(slot.producers, stageSkills) : stageSkills,
    path: slot.kind === 'document' ? `${contractBase}.slots[${slot.id}]` : `${yamlBase}.outputs[${slot.id}]`,
  }))
  function producerStepOf(slot: WbIoSlot): WbStepDef | undefined {
    const producerId = slot.kind === 'field'
      ? slot.producer
      : steps.find((candidate) => (editor.effectiveIo?.[candidate.id]?.outputs ?? []).some((output) => output.kind === 'document' && output.id === slot.id))?.id ?? null
    return producerId === null ? undefined : steps.find((candidate) => candidate.id === producerId)
  }
  // 输入侧文档槽位的 producers 是产出阶段 id；技能候选回到那个阶段的输出槽位上取。
  const inputRows: IoRow[] = (stepIo?.inputs ?? []).map((slot) => {
    const producer = producerStepOf(slot)
    const producerSkillIds = (producer?.skills ?? []).map((skill) => skill.id)
    const candidates = producer === undefined || slot.kind !== 'document'
      ? []
      : (editor.effectiveIo?.[producer.id]?.outputs ?? []).flatMap((output) => output.kind === 'document' && output.id === slot.id ? output.producers : [])
    return {
      slot,
      stage: producer === undefined ? undefined : editor.labelOf(producer.id),
      skills: slot.kind === 'document' ? producerSkills(candidates, producerSkillIds) : producerSkillIds,
      path: slot.kind === 'document' ? `${contractBase}.reads[${step.id}]` : `${yamlBase}.inputs[${slot.id}]`,
    }
  })

  const smallBtn = 'inline-flex min-h-8 items-center gap-1.5 rounded-sm border border-border bg-card px-2.5 text-body text-text-2 hover:border-text-3 hover:text-text disabled:opacity-50'

  const inputAction = documentsEditable ? (
    <span className="relative">
      <button type="button" className={HEAD_ACTION} aria-haspopup="menu" aria-expanded={inputPicker} data-testid="wb-inputs-edit" onClick={() => setInputPicker((open) => !open)}>
        <Plus className="size-3.5" aria-hidden="true" />
        {t('workflow.add_input')}
      </button>
      {inputPicker && (
        <div className={POPOVER} role="menu" aria-label={t('workflow.add_input')} data-testid="wb-inputs-picker">
          {inputChoices.length === 0 ? <p className="whitespace-nowrap px-2.5 py-2 text-body text-text-3" role="status">{t('workflow.no_inputs')}</p> : inputChoices.map(({ kind, fromStep }) => {
            const checked = checkedInputs.has(kind)
            return (
              <button
                key={kind}
                type="button"
                role="menuitemcheckbox"
                aria-checked={checked}
                className={POPOVER_ROW}
                data-testid={`wb-input-option-${kind}`}
                onClick={() => editor.setDocumentInputs(step.id, checked ? [...checkedInputs].filter((candidate) => candidate !== kind) : [...checkedInputs, kind])}
              >
                <Check className={cn('size-3.5 flex-none', checked ? 'text-(--accent)' : 'invisible')} aria-hidden="true" />
                <span className="font-mono text-text">{kind}</span>
                <span className="truncate text-caption text-text-3">{fromStep === null ? '—' : editor.labelOf(fromStep)}</span>
              </button>
            )
          })}
        </div>
      )}
    </span>
  ) : undefined

  const outputAction = documentsEditable ? (
    <span className="relative">
      <button type="button" className={HEAD_ACTION} aria-haspopup="listbox" aria-expanded={outputPicker} data-testid="wb-outputs-add" onClick={() => setOutputPicker((open) => !open)}>
        <Plus className="size-3.5" aria-hidden="true" />
        {t('workflow.add_output')}
      </button>
      {outputPicker && (
        <div className={POPOVER} role="listbox" aria-label={t('workflow.add_output')} data-testid="wb-outputs-picker">
          {outputChoices.length === 0 ? <p className="whitespace-nowrap px-2.5 py-2 text-body text-text-3" role="status">{t('workflow.outputs_none_available')}</p> : outputChoices.map((kind) => (
            <button
              key={kind}
              type="button"
              role="option"
              aria-selected={false}
              className={POPOVER_ROW}
              data-testid={`wb-output-option-${kind}`}
              onClick={() => { setOutputPicker(false); editor.addDocumentOutput(step.id, kind) }}
            >
              <span className="font-mono text-text">{kind}</span>
              <span className="truncate font-mono text-caption text-text-3">{DOCUMENT_KIND_CATALOG[kind].producers.join(', ')}</span>
            </button>
          ))}
        </div>
      )}
    </span>
  ) : undefined

  return (
    <section className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-surface-detail" data-testid="stage-editor-pane">
      {/* relative：sr-only 等绝对定位后代要以本滚动容器为包含块，否则它们会越过裁切把整页撑出滚动条。 */}
      <div className="relative min-h-0 flex-1 overflow-y-auto px-10 pt-7 pb-8 max-[900px]:px-4 max-[900px]:pt-5">
        <nav className="flex min-w-0 items-center gap-1.5 text-body text-text-2" aria-label={t('workflow.crumbs')} data-testid="wb-crumbs">
          <span className="truncate">{editor.wfName ?? ''}</span>
          {branchLabel !== null && <><ChevronRight className="size-3.5 flex-none text-text-3" aria-hidden="true" /><span className="truncate">{branchLabel}</span></>}
        </nav>
        <div className="mt-1 flex items-start gap-3" data-testid="stage-actions">
          <span className="sr-only" data-testid={`wb-lane-name-${step.id}`}>{stageLabel}</span>
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
                <button type="button" className={smallBtn} onClick={() => setConfirmDelete(false)}>{t('workflow.cancel')}</button>
                <button type="button" className={`${smallBtn} border-red-b text-red-d hover:bg-red-t`} data-testid={`wb-lane-remove-confirm-${step.id}`} onClick={() => { setConfirmDelete(false); editor.removeStage(step.id) }}>{t('workflow.settings_delete')}</button>
              </>
            ) : (
              <button type="button" className="grid size-8 place-items-center rounded-sm text-text-3 outline-none hover:bg-red-t hover:text-red-d focus-visible:ring-2 focus-visible:ring-(--accent) disabled:cursor-not-allowed disabled:opacity-40" disabled={!editable || steps.length <= 1} data-testid={`wb-lane-remove-${step.id}`} aria-label={t('workflow.delete_stage')} title={t('workflow.delete_stage')} onClick={() => setConfirmDelete(true)}><Trash2 className="size-4" aria-hidden="true" /></button>
            )}
          </span>
        </div>

        <div className="mt-4 grid divide-y divide-border">
          <section className="grid gap-3.5 py-6" data-testid="stage-inputs">
            <SectionHead title={t('workflow.inputs_title')} count={inputRows.length} action={inputAction} />
            <IoTable
              direction="inputs"
              rows={inputRows}
              empty={t('workflow.no_inputs')}
              onRemove={documentsEditable ? (slot) => editor.removeDocumentSlot(step.id, slot.id, 'inputs') : undefined}
            />
          </section>

          <section className="grid gap-3.5 py-6" data-testid="stage-skills">
            <SectionHead
              title={t('workflow.skills_title')}
              count={step.skills.length}
              action={editable ? (
                <button type="button" className={HEAD_ACTION} data-testid="wb-skills-edit" onClick={() => setComposerOpen(true)}>
                  <Pencil className="size-3.5" aria-hidden="true" />
                  {t('workflow.edit_skills')}
                </button>
              ) : undefined}
            />
            <SkillFlow key={step.id} skills={step.skills} registry={registry} editable={false} onOpen={setSkillDetail} className="h-56" />
          </section>

          <AgentSection
            stepId={step.id}
            role="executors"
            refs={step.agents?.executors ?? []}
            agents={editor.agents}
            editable={editable}
            onEdit={() => setAgentRole('executors')}
          />

          <section className="grid gap-3.5 py-6" data-testid="stage-outputs">
            <SectionHead title={t('workflow.outputs_title')} count={outputRows.length} action={outputAction} />
            <IoTable
              direction="outputs"
              rows={outputRows}
              empty={<span className="text-text-3" data-testid="stage-outputs-empty">{t('workflow.no_outputs')}</span>}
              onRemove={documentsEditable ? (slot) => editor.removeDocumentSlot(step.id, slot.id, 'outputs') : undefined}
            />
            {documentLint !== undefined && (
              <p className="whitespace-nowrap text-body text-amber-d" role="status" data-testid="stage-document-lint">{lintMessage(t, documentLint, editor.labelOf)}</p>
            )}
          </section>

          <TestsSection
            tests={step.tests ?? []}
            editable={editable}
            onAdd={(test) => { editor.setTests(step.id, [...(step.tests ?? []), test]); setTestDetail(test.id) }}
            onOpen={setTestDetail}
          />

          <AgentSection
            stepId={step.id}
            role="reviewers"
            refs={step.agents?.reviewers ?? []}
            agents={editor.agents}
            editable={editable}
            onEdit={() => setAgentRole('reviewers')}
          />

          <section className="grid gap-3.5 py-6" data-testid="stage-gate">
            <SectionHead title={t('workflow.gate_title')} />
            <div className="grid max-w-[24rem] grid-cols-3 gap-2" role="radiogroup" aria-label={t('workflow.gate_title')} data-testid={`wb-lane-gate-${step.id}`}>
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
                    className={cn('flex min-h-10 items-center justify-center gap-2 rounded-sm border px-3 text-body outline-none transition-colors focus-visible:ring-2 focus-visible:ring-(--accent) disabled:cursor-not-allowed', checked ? 'border-accent-b bg-accent-t font-semibold text-(--accent)' : 'border-border bg-card text-text hover:border-border-2')}
                    data-testid={`wb-lane-gate-${step.id}-${key}`}
                    onClick={() => editor.setGate(step.id, gate)}
                  >
                    <Icon className={cn('size-3.5', checked ? 'text-(--accent)' : 'text-text-3')} aria-hidden="true" />
                    {t(`workflow.gate_${key}`)}
                    <Info className="size-3 text-text-3" aria-hidden="true" />
                    <span id={`gate-help-${step.id}-${key}`} className="sr-only">{t(`workflow.gate_help_${key}`)}</span>
                  </button>
                )
              })}
            </div>
          </section>

          {/* 第一个阶段没有退回目标、不出下拉；但导入的 YAML 可能让它带着往后跳的边，问题仍要在这里说出来。 */}
          {(backTargets.length > 0 || backIssues.length > 0) && (
            <section className="grid gap-3.5 py-6" data-testid="stage-back">
              <SectionHead title={t('workflow.back_title')} />
              {backTargets.length > 0 && <select
                className="max-w-[24rem] min-h-10 rounded-sm border border-border bg-card px-3 text-body text-text outline-none transition-colors hover:border-border-2 focus-visible:ring-2 focus-visible:ring-(--accent) disabled:cursor-not-allowed disabled:opacity-50"
                value={backTarget ?? ''}
                disabled={!editable}
                aria-label={t('workflow.back_title')}
                data-testid={`wb-lane-back-${step.id}`}
                onChange={(event) => editor.setStageBack(step.id, event.target.value === '' ? null : event.target.value)}
              >
                <option value="">{t('workflow.back_none')}</option>
                {backTargets.map((target) => (
                  <option key={target.id} value={target.id}>{t('workflow.back_to', { stage: target.label })}</option>
                ))}
              </select>}
              {backIssues.length > 0 && (
                <p className="text-body text-amber-d" role="status" data-testid="stage-back-lint">{backIssues[0]}</p>
              )}
            </section>
          )}
        </div>
      </div>

      <footer className="flex flex-none flex-wrap items-center justify-between gap-4 border-t border-border bg-surface-detail px-10 py-4 max-[900px]:px-4">
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
      </footer>

      <SkillComposer
        open={composerOpen}
        stageLabel={stageLabel}
        skills={step.skills}
        registry={registry}
        onClose={() => setComposerOpen(false)}
        onSave={(next) => editor.setSkills(step.id, next)}
      />
      <AgentComposer
        open={agentRole !== null}
        role={agentRole ?? 'executors'}
        stageLabel={stageLabel}
        executors={step.agents?.executors ?? []}
        reviewers={step.agents?.reviewers ?? []}
        tests={step.tests ?? []}
        agents={editor.agents}
        onClose={() => setAgentRole(null)}
        onSave={(patch) => editor.setAgents(step.id, patch)}
      />
      <SkillDetailDrawer name={skillDetail} onClose={() => setSkillDetail(null)} />
      <TestEditorDrawer
        test={(step.tests ?? []).find((test) => test.id === testDetail) ?? null}
        editable={editable}
        onApply={(next) => editor.setTests(step.id, (step.tests ?? []).map((test) => test.id === next.id ? next : test))}
        onDelete={(id) => editor.setTests(step.id, (step.tests ?? []).filter((test) => test.id !== id))}
        onClose={() => setTestDetail(null)}
      />
    </section>
  )
}
