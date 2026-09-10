import { memo } from 'react'
import { closestCenter, pointerWithin, useDraggable, useDroppable, type CollisionDetection } from '@dnd-kit/core'
import { ArrowRight, GripVertical, Plus, X } from 'lucide-react'
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

const Node = memo(function Node({ id, onRemove, onOpen }: { id: string; onRemove: (id: string) => void; onOpen: (id: string) => void }): JSX.Element {
  const { t } = useT()
  // 拖动中的移动体只由 DragOverlay 承载：源节点不施加 transform，只留半透明占位（避免双重移动与整列重排）。
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `skill:${id}` })
  return (
    <div
      ref={setNodeRef}
      data-flip-id={`skill:${id}`}
      className={cn('flex items-center gap-1 rounded-md border bg-card py-1.5 pl-1 pr-1 shadow-xs transition-[opacity,box-shadow] duration-150', isDragging ? 'border-dashed border-accent-b opacity-40' : 'border-border hover:shadow-sm')}
      data-testid={`skill-node-${id}`}
    >
      <button type="button" className="grid size-6 flex-none cursor-grab touch-none place-items-center rounded-xs text-text-3 outline-none hover:bg-fill hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent) active:cursor-grabbing" aria-label={t('workflow.drag_skill', { id })} data-testid={`skill-handle-${id}`} {...listeners} {...attributes}>
        <GripVertical className="size-3.5" aria-hidden="true" />
      </button>
      <button type="button" className="min-w-0 truncate font-mono text-body font-semibold text-text outline-none hover:text-(--accent) focus-visible:ring-2 focus-visible:ring-(--accent)" data-testid={`skill-open-${id}`} onClick={() => onOpen(id)}>{id}</button>
      <button type="button" className="grid size-6 flex-none place-items-center rounded-xs text-text-3 hover:bg-fill hover:text-red-d" aria-label={t('workflow.remove_skill', { id })} data-testid={`skill-remove-${id}`} onClick={() => onRemove(id)}>
        <X className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  )
})

const Column = memo(function Column({ index, skills, onRemove, onOpen }: { index: number; skills: readonly string[]; onRemove: (id: string) => void; onOpen: (id: string) => void }): JSX.Element {
  const { t } = useT()
  const { setNodeRef, isOver } = useDroppable({ id: `wave:${index}` })
  const parallel = skills.length > 1
  return (
    <div
      ref={setNodeRef}
      className={cn('relative grid min-w-40 content-start gap-2 rounded-lg border p-2 pt-7 transition-[background-color,box-shadow,border-color] duration-150', parallel ? 'border-accent-b bg-accent-t/40' : 'border-transparent', isOver && 'bg-accent-t shadow-[inset_0_0_0_2px_var(--accent-b)]')}
      aria-label={t('workflow.wave_label', { n: index + 1 })}
      data-testid={`wave-${index}`}
      data-parallel={parallel}
    >
      <span className="absolute left-2 top-1.5 flex items-center gap-1.5 font-mono text-micro text-text-3">
        <span className="grid size-4 place-items-center rounded-full bg-fill text-micro font-semibold text-text-2">{index + 1}</span>
        {parallel && <span className="text-(--accent)">∥ {t('workflow.parallel')} {skills.length}</span>}
      </span>
      {skills.map((id) => <Node key={id} id={id} onRemove={onRemove} onOpen={onOpen} />)}
    </div>
  )
})

/** 列间隙：串行连接线 + 常显的「+」落区（悬停 / 拖入时放大成「新一步」）。末尾是「+ 新一步」。 */
function Gap({ index, last }: { index: number; last: boolean }): JSX.Element {
  const { t } = useT()
  const { setNodeRef, isOver } = useDroppable({ id: `gap:${index}` })
  return (
    <div className="flex flex-none items-center self-stretch" data-testid={`gap-${index}`}>
      {!last && index > 0 && (
        <span className="flex items-center gap-0.5 px-1 text-text-3" aria-hidden="true">
          <span className="h-px w-3 bg-border-2" />
          <ArrowRight className="size-3.5" />
        </span>
      )}
      <div
        ref={setNodeRef}
        className={cn(
          'grid place-items-center self-stretch rounded-md border border-dashed text-text-3 transition-[width,background-color,border-color,color] duration-150',
          isOver ? 'w-28 border-(--accent) bg-accent-t text-(--accent)' : last ? 'w-24 border-border hover:border-text-3' : 'w-6 border-transparent hover:border-border',
        )}
        aria-label={t('workflow.gap_label', { n: index + 1 })}
        data-testid={`gap-drop-${index}`}
      >
        <span className="inline-flex items-center gap-1 text-caption">
          <Plus className="size-3.5" aria-hidden="true" />
          {(last || isOver) && t('workflow.new_step')}
        </span>
      </div>
      {!last && (
        <span className="flex items-center gap-0.5 px-1 text-text-3" aria-hidden="true">
          <ArrowRight className="size-3.5" />
          <span className="h-px w-3 bg-border-2" />
        </span>
      )}
    </div>
  )
}

/**
 * 可编辑的波次画布：必须挂在调用方的 DndContext 里（技能库面板与画布共用一个拖拽语境）。
 * 列 = 一步；同列多项 = 并行；列与列之间 = 串行连接；拖到列间 / 末尾的「+」= 新一步；× 移除。
 */
export function SkillCanvas({ waves, onRemove, onOpen, containerRef }: {
  waves: readonly (readonly string[])[]
  onRemove: (id: string) => void
  onOpen: (id: string) => void
  containerRef?: React.RefObject<HTMLDivElement>
}): JSX.Element {
  const { t } = useT()
  return (
    <div ref={containerRef} className="flex min-h-32 items-stretch overflow-x-auto rounded-lg border border-border bg-bg p-3" data-testid="skill-dag-canvas">
      <Gap index={0} last={false} />
      {waves.map((wave, index) => (
        <div key={index} className="flex items-stretch">
          <Column index={index} skills={wave} onRemove={onRemove} onOpen={onOpen} />
          <Gap index={index + 1} last={index === waves.length - 1} />
        </div>
      ))}
      {waves.length === 0 && <span className="self-center pl-3 text-body text-text-3" role="status">{t('workflow.dag_empty')}</span>}
    </div>
  )
}
