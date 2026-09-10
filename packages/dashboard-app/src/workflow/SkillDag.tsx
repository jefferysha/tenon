import { closestCenter, pointerWithin, useDraggable, useDroppable, type CollisionDetection } from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import { ArrowRight, GripVertical, X } from 'lucide-react'
import { useT } from '../i18n'
import { insertWaveBefore, placeSkillInWave } from '../workbench/skillWaves'
import { cn } from '@/lib/utils'

/** 指针所在的落点优先（列间隙很窄，按中心距离会被旁边的整列抢走）；指针不在任何落点上时退回中心距离。 */
export const dropCollision: CollisionDetection = (args) => {
  const within = pointerWithin(args)
  return within.length > 0 ? within : closestCenter(args)
}

/** 拖放结果的纯计算：画布节点或本机技能落到某列 / 列间隙 / 本机面板。null = 无变化。 */
export function applyDrop(waves: readonly (readonly string[])[], activeId: string, overId: string | null): string[][] | null {
  if (overId === null) return null
  const skill = activeId.replace(/^(skill|pal):/, '')
  const fromPalette = activeId.startsWith('pal:')
  if (overId === 'palette') return fromPalette ? null : waves.map((wave) => wave.filter((id) => id !== skill)).filter((wave) => wave.length > 0)
  if (overId.startsWith('wave:')) return placeSkillInWave(waves, skill, Number(overId.slice(5)))
  if (overId.startsWith('gap:')) return insertWaveBefore(waves, skill, Number(overId.slice(4)))
  return null
}

/** 只读的波次视图：一列一个波次（同列并行、邻列串行），每个技能一枚芯片。 */
export function SkillWavesView({ waves }: { waves: readonly (readonly string[])[] }): JSX.Element {
  const { t } = useT()
  if (waves.length === 0) return <p className="rounded-md border border-dashed border-border px-4 py-3 text-body text-text-3" role="status" data-testid="skill-waves-empty">{t('workflow.dag_empty')}</p>
  return (
    <ol className="flex items-start gap-2 overflow-x-auto pb-1" data-testid="skill-waves">
      {waves.map((wave, index) => (
        <li key={index} className="flex items-start gap-2">
          <ol className={cn('grid gap-1.5 rounded-md p-1', wave.length > 1 && 'border-l-2 border-(--accent)')} aria-label={t('workflow.wave_label', { n: index + 1 })} data-testid={`skill-wave-${index}`} data-parallel={wave.length > 1}>
            {wave.map((id) => <li key={id} className="rounded-md border border-border bg-card px-2.5 py-1.5 font-mono text-body text-text" data-testid={`skill-chip-${id}`}>{id}</li>)}
          </ol>
          {index < waves.length - 1 && <ArrowRight className="mt-2.5 size-4 flex-none text-text-3" aria-hidden="true" />}
        </li>
      ))}
    </ol>
  )
}

function Node({ id, onRemove }: { id: string; onRemove: () => void }): JSX.Element {
  const { t } = useT()
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: `skill:${id}` })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform) }}
      className={cn('flex items-center gap-1.5 rounded-md border border-border bg-card py-1.5 pl-1.5 pr-1 shadow-xs transition-shadow', isDragging && 'opacity-50 shadow-md')}
      data-testid={`skill-node-${id}`}
    >
      <button type="button" className="grid size-6 flex-none cursor-grab place-items-center rounded-xs text-text-3 outline-none hover:bg-fill hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent)" aria-label={t('workflow.drag_skill', { id })} data-testid={`skill-handle-${id}`} {...listeners} {...attributes}>
        <GripVertical className="size-3.5" aria-hidden="true" />
      </button>
      <span className="font-mono text-body font-semibold text-text">{id}</span>
      <button type="button" className="grid size-6 flex-none place-items-center rounded-xs text-text-3 hover:bg-fill hover:text-red-d" aria-label={t('workflow.remove_skill', { id })} data-testid={`skill-remove-${id}`} onClick={onRemove}>
        <X className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  )
}

function Column({ index, skills, onRemove }: { index: number; skills: readonly string[]; onRemove: (id: string) => void }): JSX.Element {
  const { t } = useT()
  const { setNodeRef, isOver } = useDroppable({ id: `wave:${index}` })
  return (
    <div
      ref={setNodeRef}
      className={cn('relative grid min-w-32 content-start gap-2 rounded-md p-1.5 transition-colors duration-150', skills.length > 1 && 'border-l-2 border-(--accent)', isOver && 'bg-accent-t ring-2 ring-accent-b')}
      aria-label={t('workflow.wave_label', { n: index + 1 })}
      data-testid={`wave-${index}`}
      data-parallel={skills.length > 1}
    >
      {skills.map((id) => <Node key={id} id={id} onRemove={() => onRemove(id)} />)}
    </div>
  )
}

function Gap({ index, last }: { index: number; last: boolean }): JSX.Element {
  const { t } = useT()
  const { setNodeRef, isOver } = useDroppable({ id: `gap:${index}` })
  return (
    <div
      ref={setNodeRef}
      className={cn('grid min-h-10 w-9 flex-none place-items-center self-stretch rounded-sm transition-all duration-150', isOver && 'w-14 bg-accent-t ring-2 ring-accent-b')}
      aria-label={t('workflow.gap_label', { n: index + 1 })}
      data-testid={`gap-${index}`}
    >
      {last ? <span className="size-2 rounded-full border border-dashed border-text-3" aria-hidden="true" /> : <ArrowRight className="size-4 text-text-3" aria-hidden="true" />}
    </div>
  )
}

/**
 * 可编辑的波次画布：必须挂在调用方的 DndContext 里（技能库面板与画布共用一个拖拽语境）。
 * 拖到某列 = 与该列并行；拖到列间隙 = 新的串行波次；× 移除。
 */
export function SkillCanvas({ waves, onRemove }: { waves: readonly (readonly string[])[]; onRemove: (id: string) => void }): JSX.Element {
  const { t } = useT()
  return (
    <div className="flex min-h-24 items-center overflow-x-auto rounded-md border border-border bg-bg p-2" data-testid="skill-dag-canvas">
      <Gap index={0} last={false} />
      {waves.map((wave, index) => (
        <div key={index} className="flex items-center">
          <Column index={index} skills={wave} onRemove={onRemove} />
          <Gap index={index + 1} last={index === waves.length - 1} />
        </div>
      ))}
      {waves.length === 0 && <span className="text-body text-text-3" role="status">{t('workflow.dag_empty')}</span>}
    </div>
  )
}
