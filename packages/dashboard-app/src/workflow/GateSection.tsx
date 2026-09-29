import { AlertTriangle } from 'lucide-react'
import type { WbStepDef } from '../api/governanceTypes'
import { useT } from '../i18n'
import type { WorkflowEditor } from '../workbench/useWorkflowEditor'
import { backTargetOf } from '../workbench/workbenchDefinition'
import { GateSegment } from './GateSegment'
import { Hint } from './Hint'
import { issuesFor } from './lint'
import { lintMessage } from './lintMessages'
import { SectionHead } from './SectionHead'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

/** Radix Select 不收空字符串值：「不退回」用这个占位值。 */
const BACK_NONE = '__none__'

/**
 * 「门禁」段：门禁分段控件（不拦 / 评审 / 自动）与退回目标。退回目标只能是本阶段之前的阶段——往后跳在
 * 流程里不存在，从选项里就配不出来。测试策略表单（测试体系）排在退回之后。
 */
export function GateSection({ editor, step, hasOutputs }: { editor: WorkflowEditor; step: WbStepDef; hasOutputs: boolean }): JSX.Element {
  const { t } = useT()
  const def = editor.def
  const steps = def?.steps ?? []
  const index = steps.findIndex((candidate) => candidate.id === step.id)
  const editable = editor.canWrite
  const backTargets = steps.slice(0, Math.max(index, 0)).map((candidate) => ({ id: candidate.id, label: candidate.label }))
  const backTarget = def === null ? null : backTargetOf(def, step.id)
  // 保存已被 editor.lintBlocked 挡住，这里只说清楚是哪一条。
  const backIssues = issuesFor(editor.lint, step.id)
    .filter((issue) => issue.kind.startsWith('transition-'))
    .map((issue) => lintMessage(t, issue, editor.labelOf))
  return (
    <section className="grid gap-3.5 py-6" data-testid="stage-gate">
      <SectionHead title={t('workflow.gate_title')} />
      <div className="flex items-center gap-2">
        <GateSegment stepId={step.id} value={step.gate} disabled={!editable} onChange={(gate) => editor.setGate(step.id, gate)} />
        {/* 自动门禁看的是产物齐全；阶段没有输出时它无从判断，标警示图标，原因放 Tooltip。 */}
        {step.gate === 'auto' && !hasOutputs && (
          <Hint label={t('workflow.gate_auto_no_output')}>
            <button type="button" className="grid size-8 flex-none place-items-center rounded-sm text-amber-d outline-none focus-visible:ring-2 focus-visible:ring-(--accent)" aria-label={t('workflow.gate_auto_no_output')} data-testid="stage-gate-auto-warning">
              <AlertTriangle className="size-4" aria-hidden="true" />
            </button>
          </Hint>
        )}
      </div>
      {/* 第一个阶段没有退回目标、不出下拉；但导入的 YAML 可能让它带着往后跳的边，问题仍要在这里说出来。 */}
      {(backTargets.length > 0 || backIssues.length > 0) && (
        <div className="grid gap-2" data-testid="stage-back">
          {backTargets.length > 0 && (
            <div className="flex items-center gap-3">
              <span className="w-14 flex-none whitespace-nowrap text-body text-text-2">{t('workflow.back_title')}</span>
              <Select value={backTarget ?? BACK_NONE} disabled={!editable} onValueChange={(value) => editor.setStageBack(step.id, value === BACK_NONE ? null : value)}>
                <SelectTrigger className="max-w-[24rem]" aria-label={t('workflow.back_title')} data-testid={`wb-lane-back-${step.id}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper" data-testid={`wb-lane-back-menu-${step.id}`}>
                  <SelectItem value={BACK_NONE} data-testid={`wb-lane-back-option-${step.id}-none`}>{t('workflow.back_none')}</SelectItem>
                  {backTargets.map((target) => (
                    <SelectItem key={target.id} value={target.id} data-testid={`wb-lane-back-option-${step.id}-${target.id}`}>{t('workflow.back_to', { stage: target.label })}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {backIssues.length > 0 && (
            <p className="text-body text-amber-d" role="status" data-testid="stage-back-lint">{backIssues[0]}</p>
          )}
        </div>
      )}
    </section>
  )
}
