import { CornerLeftUp, Plus, ShieldCheck } from 'lucide-react'
import type { WbWorkflowDef } from '../api/governanceTypes'
import { useT } from '../i18n'
import { matchesQuery } from '../shell/GlobalSearch'
import { ListColumn } from '../shell/ThreeColumns'
import type { LintIssue } from './lint'
import { backEdgesFrom, linkedToNext, pipelineEdges } from './pipelineModel'
import { cn } from '@/lib/utils'

export interface PipelineListProps {
  def: WbWorkflowDef | null
  labelOf: (stepId: string) => string
  selectedId: string | null
  lint: readonly LintIssue[]
  query: string
  loading: boolean
  error: string | null
  canWrite: boolean
  onSelect: (id: string) => void
  onAddStage: () => void
}

/** 工作流页中列：竖向流水线——节点 + 连接线 + 门禁标 + 回流边；末尾是「添加阶段」。 */
export function PipelineList({ def, labelOf, selectedId, lint, query, loading, error, canWrite, onSelect, onAddStage }: PipelineListProps): JSX.Element {
  const { t } = useT()
  const steps = def?.steps ?? []
  const edges = pipelineEdges(steps)
  const visible = steps.filter((step) => matchesQuery(query, labelOf(step.id), step.id, ...step.skills.map((skill) => skill.id)))
  return (
    <ListColumn eyebrow={def?.name.toUpperCase() ?? ''} title={t('workflow.stages_title')} testId="stage-list">
      {error !== null ? (
        <p className="rounded-md border border-red-b bg-red-t px-4 py-3 text-body text-red-d" role="alert">{error}</p>
      ) : loading ? (
        <p className="text-body text-text-3" role="status" aria-live="polite">{t('common.loading')}</p>
      ) : (
        <ol className="grid" data-testid="stage-list-items">
          {visible.map((step, index) => {
            const selected = step.id === selectedId
            const order = steps.indexOf(step) + 1
            const next = steps[steps.indexOf(step) + 1]
            const linked = linkedToNext(edges, step.id, next?.id)
            const back = backEdgesFrom(edges, step.id)
            const missing = lint.some((issue) => issue.stepId === step.id && issue.kind === 'step-no-output')
            const skillCount = step.skills.length
            return (
              <li key={step.id} className="grid grid-cols-[28px_minmax(0,1fr)] gap-x-3" data-testid={`wb-pipeline-node-${step.id}`}>
                <div className="flex flex-col items-center">
                  <span className={cn('grid size-7 flex-none place-items-center rounded-full border font-mono text-caption', selected ? 'border-(--accent) bg-(--accent) text-btn-fg' : 'border-border bg-card text-text-2')} aria-hidden="true">{order}</span>
                  {index < visible.length - 1 && (
                    <span className={cn('my-1 w-px flex-1', linked ? 'bg-border-2' : 'border-l border-dashed border-border')} aria-hidden="true" data-testid={`wb-link-${step.id}`} data-linked={linked} />
                  )}
                </div>
                <div className="pb-3">
                  <button
                    type="button"
                    className={cn(
                      'grid w-full min-w-0 grid-cols-[minmax(0,1fr)] gap-1 rounded-md border px-3.5 py-3 text-left outline-none transition-colors hover:bg-bg focus-visible:ring-2 focus-visible:ring-(--accent) motion-reduce:transition-none',
                      selected ? 'border-sel-border bg-sel-bg hover:bg-sel-bg' : 'border-border bg-card',
                    )}
                    aria-current={selected ? 'true' : undefined}
                    data-testid={`wb-step-${step.id}`}
                    onClick={() => onSelect(step.id)}
                  >
                    <span className="flex min-w-0 items-center justify-between gap-3">
                      <span className="truncate text-title font-semibold text-text">{labelOf(step.id)}</span>
                      <span className="flex flex-none items-center gap-1.5">
                        {missing && <span className="rounded-full bg-amber-t px-2 py-0.5 text-caption font-semibold text-amber-d" data-testid={`wb-lint-${step.id}`}>{t('workflow.lint_no_output')}</span>}
                        {step.gate !== null && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-fill px-2 py-0.5 text-caption text-text-2" data-testid={`wb-gate-${step.id}`}>
                            <ShieldCheck className="size-3" aria-hidden="true" />
                            {t(step.gate === 'review' ? 'workflow.gate_review' : 'workflow.gate_confirm')}
                          </span>
                        )}
                      </span>
                    </span>
                    <span className="flex min-w-0 items-center gap-3 font-mono text-body text-text-2">
                      <span className="truncate">{step.id}</span>
                      <span className="flex-none">{t('workflow.card_skills', { n: skillCount })}</span>
                    </span>
                  </button>
                  {back.map((edge) => (
                    <span key={`${edge.from}-${edge.to}`} className="mt-1.5 inline-flex items-center gap-1.5 pl-1 text-caption text-text-3" data-testid={`wb-back-edge-${edge.from}-${edge.to}`}>
                      <CornerLeftUp className="size-3.5" aria-hidden="true" />
                      {t('workflow.back_to', { stage: labelOf(edge.to) })}
                    </span>
                  ))}
                </div>
              </li>
            )
          })}
          {visible.length === 0 && steps.length > 0 && (
            <li className="rounded-md border border-dashed border-border px-5 py-8 text-center text-body text-text-3" role="status">{t('workflow.empty_filtered')}</li>
          )}
          {canWrite && query.trim() === '' && def !== null && (
            <li className="grid grid-cols-[28px_minmax(0,1fr)] gap-x-3">
              <span className="grid size-7 place-items-center rounded-full border border-dashed border-border text-text-3" aria-hidden="true"><Plus className="size-3.5" /></span>
              <button
                type="button"
                className="flex w-full items-center gap-2.5 rounded-md border border-dashed border-border px-3.5 py-3 text-left text-base font-semibold text-text-2 hover:border-accent-b hover:text-(--accent)"
                data-testid="wb-add-stage-open"
                onClick={onAddStage}
              >
                {t('workflow.add_stage')}
              </button>
            </li>
          )}
        </ol>
      )}
    </ListColumn>
  )
}
