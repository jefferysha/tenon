import { memo, useEffect, useMemo, useRef, useState } from 'react'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { GripVertical, Search } from 'lucide-react'
import type { WbSkillEntry, WbSkillRef } from '../api/governanceTypes'
import { useT } from '../i18n'
import { Dialog } from '../shared/Dialog'
import { useFlipLayout } from '../shared/useFlip'
import { wavesOf } from '../workbench/skillWaves'
import { applyDrop, dropCollision, SkillCanvas } from './SkillDag'
import { SkillDetail } from './SkillDetail'
import { SkillSourceIcon } from './SkillSourceIcon'
import { cn } from '@/lib/utils'

export interface SkillComposerProps {
  open: boolean
  stageLabel: string
  skills: readonly WbSkillRef[]
  registry: readonly WbSkillEntry[] | null
  onClose: () => void
  onSave: (waves: string[][]) => void
}

const PaletteItem = memo(function PaletteItem({ entry, placed, active, onOpen }: {
  entry: WbSkillEntry
  placed: boolean
  active: boolean
  onOpen: (name: string) => void
}): JSX.Element {
  const { t } = useT()
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `pal:${entry.name}`, disabled: placed })
  return (
    <li
      ref={setNodeRef}
      className={cn('flex items-center gap-1 rounded-md border px-1 py-1 transition-[opacity,border-color,background-color] duration-150', active ? 'border-accent-b bg-accent-t' : 'border-transparent hover:border-border hover:bg-card', isDragging && 'opacity-40', placed && 'opacity-45')}
      data-testid={`palette-${entry.name}`}
      data-placed={placed}
    >
      <button type="button" className={cn('grid size-6 flex-none touch-none place-items-center rounded-xs text-text-3 outline-none focus-visible:ring-2 focus-visible:ring-(--accent)', placed ? 'cursor-default' : 'cursor-grab hover:bg-fill hover:text-text active:cursor-grabbing')} aria-label={t('workflow.drag_skill', { id: entry.name })} disabled={placed} data-testid={`palette-handle-${entry.name}`} {...listeners} {...attributes}>
        <GripVertical className="size-3.5" aria-hidden="true" />
      </button>
      <button type="button" className="flex min-w-0 flex-1 items-center gap-2 py-0.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-(--accent)" aria-pressed={active} data-testid={`palette-open-${entry.name}`} onClick={() => onOpen(entry.name)}>
        <span className={cn('truncate font-mono text-body', active ? 'font-semibold text-(--accent)' : 'text-text')}>{entry.name}</span>
        <span className="ml-auto flex flex-none items-center" data-testid={`palette-source-${entry.name}`}><SkillSourceIcon source={entry.source} /></span>
      </button>
    </li>
  )
})

function Palette({ registry, placed, search, detail, onSearch, onOpen }: {
  registry: readonly WbSkillEntry[] | null
  placed: ReadonlySet<string>
  search: string
  detail: string | null
  onSearch: (value: string) => void
  onOpen: (name: string) => void
}): JSX.Element {
  const { t } = useT()
  const { setNodeRef, isOver } = useDroppable({ id: 'palette' })
  const entries = useMemo(() => (registry ?? [])
    .filter((entry) => entry.installed && entry.available !== false && entry.name.toLowerCase().includes(search.trim().toLowerCase()))
    .sort((a, b) => Number(placed.has(a.name)) - Number(placed.has(b.name)) || a.name.localeCompare(b.name)), [registry, placed, search])
  return (
    <section ref={setNodeRef} className={cn('flex min-h-0 flex-col gap-2 rounded-lg border border-border bg-bg p-2 transition-colors', isOver && 'border-red-b bg-red-t')} data-testid="skill-palette" aria-label={t('workflow.local_skills')}>
      <label className="flex h-9 flex-none items-center gap-2 rounded-md border border-border bg-card px-2 text-text-3 focus-within:border-accent-b">
        <Search className="size-3.5 flex-none" aria-hidden="true" />
        <span className="sr-only">{t('workflow.search_skills')}</span>
        <input type="search" value={search} placeholder={t('workflow.search_skills')} className="min-w-0 flex-1 bg-transparent text-body text-text outline-none placeholder:text-text-3" data-testid="skill-palette-search" onChange={(event) => onSearch(event.target.value)} />
      </label>
      {registry === null ? (
        <p className="px-1 text-caption text-text-3" role="status">{t('common.loading')}</p>
      ) : entries.length === 0 ? (
        <p className="px-1 text-caption text-text-3" role="status">{t('workflow.palette_empty')}</p>
      ) : (
        <ul className="grid min-h-0 flex-1 content-start gap-0.5 overflow-y-auto pr-0.5">
          {entries.map((entry) => <PaletteItem key={entry.name} entry={entry} placed={placed.has(entry.name)} active={detail === entry.name} onOpen={onOpen} />)}
        </ul>
      )}
    </section>
  )
}

/**
 * 技能编排浮层，三栏：技能库（拖柄 + 名称 + 来源图标，点名称看详情）/ 波次画布（主体：列 = 一步，同列并行，
 * 列间串行连接，「+」= 新一步）/ 技能详情（SKILL.md 与目录内全部文件）。拖动只由 DragOverlay 承载；
 * 落位、换列、移除用 GSAP Flip 补间。保存才写回阶段定义。
 */
export function SkillComposer({ open, stageLabel, skills, registry, onClose, onSave }: SkillComposerProps): JSX.Element | null {
  const { t } = useT()
  const [waves, setWaves] = useState<string[][]>(() => wavesOf(skills))
  const [search, setSearch] = useState('')
  const [active, setActive] = useState<string | null>(null)
  const [detail, setDetail] = useState<string | null>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const captureFlip = useFlipLayout(canvasRef, [waves])
  useEffect(() => { if (open) { setWaves(wavesOf(skills)); setDetail(skills[0]?.id ?? null) } }, [open, skills])
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor))
  const placed = useMemo(() => new Set(waves.flat()), [waves])
  if (!open) return null

  function commit(next: string[][] | null): void {
    if (next === null) return
    captureFlip()
    setWaves(next)
  }
  function onDragEnd(event: DragEndEvent): void {
    setActive(null)
    commit(applyDrop(waves, String(event.active.id), event.over === null ? null : String(event.over.id)))
  }
  function onDragStart(event: DragStartEvent): void {
    setActive(String(event.active.id).replace(/^(skill|pal):/, ''))
  }
  function remove(id: string): void {
    commit(waves.map((wave) => wave.filter((candidate) => candidate !== id)).filter((wave) => wave.length > 0))
  }

  return (
    <Dialog
      title={`${stageLabel} · ${t('workflow.composer_title')}`}
      onClose={onClose}
      variant="workspace"
      testid="skill-composer"
      closeLabel={t('workflow.cancel')}
      closeTestid="skill-composer-close"
      panelClassName="h-[min(90vh,60rem)] w-[min(97vw,96rem)]"
      actions={(
        <>
          <button type="button" className="min-h-10 rounded-md px-3 text-base text-text-2 hover:bg-fill" data-testid="skill-composer-cancel" onClick={onClose}>{t('workflow.cancel')}</button>
          <button type="button" className="min-h-10 rounded-md bg-(--accent) px-4 text-base font-semibold text-btn-fg hover:bg-accent-d" data-testid="skill-composer-save" onClick={() => { onSave(waves); onClose() }}>{t('workflow.composer_save')}</button>
        </>
      )}
    >
      <DndContext sensors={sensors} collisionDetection={dropCollision} measuring={{ droppable: { strategy: MeasuringStrategy.WhileDragging } }} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setActive(null)}>
        <div className="grid h-full min-h-0 grid-cols-[17rem_minmax(0,1fr)_minmax(20rem,26rem)] gap-4 max-[1100px]:grid-cols-[16rem_minmax(0,1fr)] max-[900px]:grid-cols-1">
          <Palette registry={registry} placed={placed} search={search} detail={detail} onSearch={setSearch} onOpen={setDetail} />
          <section className="flex min-h-0 flex-col gap-3" aria-label={t('workflow.skills_title')}>
            <SkillCanvas waves={waves} onRemove={remove} onOpen={setDetail} containerRef={canvasRef} />
          </section>
          <aside className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card p-4 max-[1100px]:hidden" aria-label={t('workflow.preview_skill', { id: detail ?? '' })} data-testid="skill-composer-detail">
            {detail === null ? (
              <p className="text-body text-text-3" role="status">{t('workflow.pick_skill')}</p>
            ) : (
              <>
                <p className="mb-3 font-mono text-title font-semibold text-text">{detail}</p>
                <SkillDetail key={detail} name={detail} layout="stacked" />
              </>
            )}
          </aside>
        </div>
        <DragOverlay dropAnimation={{ duration: 180, easing: 'cubic-bezier(0.2, 0, 0, 1)' }}>
          {active !== null && <div className="rounded-md border border-accent-b bg-card px-3 py-1.5 font-mono text-body font-semibold text-text shadow-lg" data-testid="skill-drag-overlay">{active}</div>}
        </DragOverlay>
      </DndContext>
    </Dialog>
  )
}
