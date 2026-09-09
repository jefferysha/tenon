import { useState, type DragEvent } from 'react'
import { GripVertical, X } from 'lucide-react'
import { useT } from '../i18n'
import type { WbSkillEntry } from '../api/client'
import { SkillExecutionTopology } from './SkillExecutionTopology'
import { skillPresentation } from './skillPresentation'
import { sourceLabel, statusTone } from './TimelineHookRows'
import type { TimelineSkillMove } from './executionTimelineTypes'

export interface TimelineSkillRowsProps {
  stageId: string
  /** 本阶段技能全名 id 序（已去重）。 */
  skills: string[]
  /** 键=技能 id、值=同列依赖 id 序；undefined = 数据面不描述依赖。 */
  skillDeps?: Record<string, string[]>
  skillRegistry?: WbSkillEntry[] | null
  /** 注册表按名索引（编排器已算好，避免每行重复建表）。 */
  registryByName: ReadonlyMap<string, WbSkillEntry>
  readonly: boolean
  onSkillMove?: (move: TimelineSkillMove) => void
  onSkillRemove?: (stageId: string, skillId: string) => void
}

/**
 * 阶段技能清单：并行/依赖拓扑图 + 可拖拽（并给键盘等价的上移/下移按钮）的技能行。
 * 拖拽落点是这份清单自己的瞬时状态，排序结果通过 onSkillMove 交回编排器。
 */
export function TimelineSkillRows({
  stageId,
  skills,
  skillDeps,
  skillRegistry,
  registryByName,
  readonly,
  onSkillMove,
  onSkillRemove,
}: TimelineSkillRowsProps): JSX.Element {
  const { lang, t } = useT()
  const [draggingSkill, setDraggingSkill] = useState<string | null>(null)
  const [skillDrop, setSkillDrop] = useState<{ id: string; after: boolean } | null>(null)

  function skillDropAt(event: DragEvent<HTMLElement>, refSkillId: string): void {
    if (!draggingSkill || draggingSkill === refSkillId || !onSkillMove) return
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    const after = event.clientY > rect.top + rect.height / 2
    onSkillMove({
      skillId: draggingSkill,
      fromStage: stageId,
      toStage: stageId,
      refSkillId,
      after,
    })
    setDraggingSkill(null)
    setSkillDrop(null)
  }

  return (
    <div className="space-y-3">
      {skills.length > 0 && (
        <SkillExecutionTopology
          skills={skills}
          depsBySkill={skillDeps ?? {}}
          registry={skillRegistry}
          testId="wb-skill-topology-inline"
          compact
        />
      )}
      <div className="rounded-md bg-card px-3 shadow-sm ring-1 ring-border">
      {skills.length === 0 && <p className="py-5 text-center text-base text-text-3" role="status" aria-live="polite">{t('workbench.timeline_skills_empty')}</p>}
      {skills.map((skillId, index) => {
        const entry = registryByName.get(skillId)
        const presentation = skillPresentation(skillId, skillRegistry, lang)
        const deps = skillDeps?.[skillId] ?? []
        const isDrop = skillDrop?.id === skillId
        return (
          <div
            key={skillId}
            draggable={!readonly && Boolean(onSkillMove)}
            data-testid={`wb-timeline-skill-${skillId}`}
            data-drop={isDrop ? (skillDrop?.after ? 'after' : 'before') : undefined}
            className="relative flex min-h-[62px] items-center gap-3 border-b border-border py-2.5 last:border-b-0 data-[drop=before]:before:absolute data-[drop=before]:before:inset-x-0 data-[drop=before]:before:top-0 data-[drop=before]:before:h-0.5 data-[drop=before]:before:bg-(--accent) data-[drop=after]:after:absolute data-[drop=after]:after:inset-x-0 data-[drop=after]:after:bottom-0 data-[drop=after]:after:h-0.5 data-[drop=after]:after:bg-(--accent)"
            onDragStart={(event) => {
              setDraggingSkill(skillId)
              event.dataTransfer?.setData('text/plain', skillId)
              if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
            }}
            onDragOver={(event) => {
              if (!draggingSkill || draggingSkill === skillId) return
              event.preventDefault()
              const rect = event.currentTarget.getBoundingClientRect()
              setSkillDrop({ id: skillId, after: event.clientY > rect.top + rect.height / 2 })
            }}
            onDrop={(event) => skillDropAt(event, skillId)}
            onDragEnd={() => { setDraggingSkill(null); setSkillDrop(null) }}
          >
            {!readonly && onSkillMove && <GripVertical className="h-5 w-5 flex-none cursor-grab text-text-3 active:cursor-grabbing" aria-hidden="true" />}
            <span className={`h-2.5 w-2.5 flex-none rounded-full ${deps.length > 0 ? 'bg-(--accent)' : 'bg-border-2'}`} aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span data-testid={`wb-lane-sk-${stageId}-${skillId}`} className="text-body font-semibold text-text" title={presentation.technicalTitle}>{presentation.name}</span>
                <span className={`text-micro font-semibold ${statusTone(entry?.installed)}`}>
                  {t(entry ? (entry.installed ? 'workbench.timeline_installed' : 'workbench.timeline_uninstalled') : 'workbench.timeline_unknown')}
                </span>
              </div>
              <p className="mt-0.5 text-micro text-text-3">
                {presentation.description} · {entry ? sourceLabel(entry.source, t) : t('workbench.timeline_source_missing')}
                {' · '}{deps.length > 0 ? t('workbench.timeline_waiting', { ids: deps.join(', ') }) : t(skills.length > 1 ? 'workbench.timeline_parallel_start' : 'workbench.timeline_independent')}
              </p>
            </div>
            {!readonly && onSkillMove && (
              <span className="inline-flex gap-1">
                <button
                  type="button"
                  className="grid h-8 w-8 place-items-center rounded-md text-text-3 hover:bg-fill hover:text-accent-d disabled:opacity-30"
                  aria-label={t('workbench.move_skill_before', { name: presentation.name })}
                  disabled={index === 0}
                  onClick={() => {
                    const previous = skills[index - 1]
                    if (previous) onSkillMove({ skillId, fromStage: stageId, toStage: stageId, refSkillId: previous, after: false })
                  }}
                >↑</button>
                <button
                  type="button"
                  className="grid h-8 w-8 place-items-center rounded-md text-text-3 hover:bg-fill hover:text-accent-d disabled:opacity-30"
                  aria-label={t('workbench.move_skill_after', { name: presentation.name })}
                  disabled={index === skills.length - 1}
                  onClick={() => {
                    const next = skills[index + 1]
                    if (next) onSkillMove({ skillId, fromStage: stageId, toStage: stageId, refSkillId: next, after: true })
                  }}
                >↓</button>
              </span>
            )}
            {!readonly && onSkillRemove && (
              <button type="button" className="grid h-9 w-9 place-items-center rounded-md text-text-3 hover:bg-fill hover:text-red" aria-label={t('workbench.timeline_remove_skill', { id: skillId })} onClick={() => onSkillRemove(stageId, skillId)}>
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
          </div>
        )
      })}
      </div>
    </div>
  )
}
