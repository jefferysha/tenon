import { ChevronRight, Plus } from 'lucide-react'
import { useT } from '../i18n'
import { matchesQuery } from '../shell/GlobalSearch'
import { FilterChip, ListColumn } from '../shell/ThreeColumns'
import type { BoardLane } from '../workbench/boardLane'
import { skillExecutionWaves } from '../workbench/SkillExecutionTopology'
import type { WbStepDef } from '../workbench/workbenchDefinition'
import { cn } from '@/lib/utils'

export type StageFilter = 'all' | 'gated' | 'missing'

export interface StageListPaneProps {
  workflowName: string
  readonly: boolean
  lanes: readonly BoardLane[]
  steps: readonly WbStepDef[]
  selectedId: string | null
  query: string
  filter: StageFilter
  onFilter: (next: StageFilter) => void
  onSelect: (id: string) => void
  onAddStage?: () => void
  /** 未安装的技能 id 集（来自技能注册表）；用于「未装技能」筛选与卡片提示。 */
  uninstalled: ReadonlySet<string>
  loading: boolean
  error: string | null
}

/** 工作流页中列：有序阶段卡（序号 / 名称 / 门禁 / id / N 技能 · M 波 / 输入 → 产出）+ 末尾添加阶段。 */
export function StageListPane({
  workflowName,
  readonly,
  lanes,
  steps,
  selectedId,
  query,
  filter,
  onFilter,
  onSelect,
  onAddStage,
  uninstalled,
  loading,
  error,
}: StageListPaneProps): JSX.Element {
  const { t } = useT()
  const stepById = new Map(steps.map((step) => [step.id, step]))
  const missingOf = (lane: BoardLane): number => (lane.skills ?? []).filter((skill) => uninstalled.has(skill)).length
  const matches = (lane: BoardLane): boolean => {
    if (filter === 'gated' && lane.gate === null) return false
    if (filter === 'missing' && missingOf(lane) === 0) return false
    return matchesQuery(query, lane.name, lane.id, ...(lane.skills ?? []))
  }
  const visible = lanes.filter(matches)
  const counts = {
    all: lanes.length,
    gated: lanes.filter((lane) => lane.gate !== null).length,
    missing: lanes.filter((lane) => missingOf(lane) > 0).length,
  }
  return (
    <ListColumn
      eyebrow={t('workflow.eyebrow', { name: workflowName.toUpperCase(), source: t(readonly ? 'workflow.builtin_meta' : 'workflow.project_meta') })}
      title={t('workflow.stages_title')}
      note={<><b className="font-semibold text-text">{t('workflow.note_lead')}</b>{t('workflow.note')}</>}
      chips={(
        <div role="tablist" aria-label={t('workflow.filter_label')} className="flex flex-wrap gap-1">
          {(['all', 'gated', 'missing'] as const).map((candidate) => (
            <FilterChip key={candidate} label={t(`workflow.filter_${candidate}`)} count={counts[candidate]} selected={filter === candidate} testId={`stage-filter-${candidate}`} onClick={() => onFilter(candidate)} />
          ))}
        </div>
      )}
      testId="stage-list"
    >
      {error !== null ? (
        <p className="rounded-md border border-red-b bg-red-t px-4 py-3 text-body text-red-d" role="alert">{error}</p>
      ) : loading ? (
        <p className="text-body text-text-3" role="status" aria-live="polite">{t('common.loading')}</p>
      ) : (
        <ul className="grid" data-testid="stage-list-items">
          {visible.length === 0 && (
            <li className="rounded-md border border-dashed border-border px-5 py-8 text-center text-body text-text-3" role="status">{t('workflow.empty_filtered')}</li>
          )}
          {visible.map((lane, index) => {
            const step = stepById.get(lane.id)
            const skills = lane.skills ?? []
            const waves = skillExecutionWaves(skills, lane.skillDeps ?? {}).length
            const missing = missingOf(lane)
            const selected = lane.id === selectedId
            const order = lanes.findIndex((candidate) => candidate.id === lane.id) + 1
            const io = step
              ? [
                  step.inputs.length > 0 ? t('workflow.card_io_in', { fields: step.inputs.map((input) => input.field).join('、') }) : null,
                  step.outputs.length > 0 ? t('workflow.card_io_out', { fields: step.outputs.map((output) => output.field).join('、') }) : t('workflow.card_io_none'),
                ].filter((part): part is string => part !== null).join(' → ')
              : ''
            const previousSelected = index > 0 && visible[index - 1]?.id === selectedId
            return (
              <li key={lane.id} className={index > 0 && !selected && !previousSelected ? 'border-t border-border' : undefined}>
                <button
                  type="button"
                  className={cn(
                    'grid w-full min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5 rounded-md border border-transparent px-3.5 py-4 text-left outline-none transition-colors hover:bg-bg focus-visible:ring-2 focus-visible:ring-(--accent) motion-reduce:transition-none',
                    selected && 'border-sel-border border-l-[3px] border-l-sel-edge bg-sel-bg pl-3 hover:bg-sel-bg',
                  )}
                  aria-current={selected ? 'true' : undefined}
                  data-testid={`wb-step-${lane.id}`}
                  onClick={() => onSelect(lane.id)}
                >
                  <span className="flex min-w-0 items-center justify-between gap-3">
                    <span className="flex min-w-0 items-center gap-2.5">
                      <span className="grid size-6 flex-none place-items-center rounded-xs bg-fill font-mono text-caption text-text-2" aria-hidden="true">{order}</span>
                      <span className="truncate text-title font-semibold text-text">{lane.name}</span>
                    </span>
                    <span className="flex flex-none items-center gap-1.5">
                      {lane.running && (
                        <span className="size-2 rounded-full bg-info motion-safe:animate-pulse" data-testid={`wb-flow-gloss-${lane.id}`} title={t('workflow.card_running')} aria-label={t('workflow.card_running')} />
                      )}
                      {missing > 0 && <span className="rounded-full bg-red-t px-2 py-0.5 text-caption font-semibold text-red-d">{t('workflow.card_missing', { n: missing })}</span>}
                      {lane.gate !== null && <span className="rounded-full bg-fill px-2 py-0.5 text-caption text-text-2">{t(lane.gate === 'review' ? 'workflow.gate_tag_review' : 'workflow.gate_tag_confirm')}</span>}
                    </span>
                  </span>
                  <span className="truncate font-mono text-body text-text-2">{lane.id}</span>
                  <span className="flex min-w-0 items-center gap-3.5 text-body text-text-2">
                    <span className="flex-none">{lane.skills === undefined ? t('workflow.card_skills_matrix') : t('workflow.card_skills', { n: skills.length, waves })}</span>
                    <span className="min-w-0 flex-1 truncate">{io}</span>
                    <ChevronRight className="size-3.5 flex-none text-text-3" aria-hidden="true" />
                  </span>
                </button>
              </li>
            )
          })}
          {!readonly && onAddStage && filter === 'all' && query.trim() === '' && (
            <li className="mt-2">
              <button
                type="button"
                className="flex w-full items-center gap-2.5 rounded-md border border-dashed border-border px-3.5 py-4 text-left text-base font-semibold text-text-2 hover:border-accent-b hover:text-(--accent)"
                data-testid="wb-add-stage-open"
                aria-label={t('workbench.add_stage')}
                onClick={onAddStage}
              >
                <Plus className="size-4" aria-hidden="true" />
                {t('workflow.add_stage')}
                <span className="ml-auto text-body font-normal text-text-3">{t('workflow.add_stage_hint')}</span>
              </button>
            </li>
          )}
        </ul>
      )}
    </ListColumn>
  )
}
