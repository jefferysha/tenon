import { useMemo, useState } from 'react'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import { ArrowRight, GripVertical, Search, Users, X } from 'lucide-react'
import type { WbSkillEntry, WbSkillRef, WbTrackDefinition, WbTrackPredicate } from '../api/governanceTypes'
import { useT } from '../i18n'
import { insertWaveBefore, placeSkillInWave, wavesOf } from '../workbench/skillWaves'
import { trackDisplayName } from '../workbench/trackPresentation'
import { cn } from '@/lib/utils'

export interface SkillDagProps {
  skills: readonly WbSkillRef[]
  registry: readonly WbSkillEntry[] | null
  /** 可选轨道（用于标签与勾选）；空数组时不显示轨道相关控件。 */
  tracks: readonly WbTrackDefinition[]
  editable: boolean
  onWaves: (waves: string[][]) => void
  onWhen: (skillId: string, when: WbTrackPredicate | undefined) => void
}

/** 指针所在的落点优先（列间隙很窄，按中心距离会被旁边的整列抢走）；指针不在任何落点上时退回中心距离。 */
const dropCollision: CollisionDetection = (args) => {
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

/** 技能对某轨道是否生效（与 kernel skillAppliesToTrack 的 id 分支同口径；profile 继承由服务端负责）。 */
export function skillAppliesTo(skill: Pick<WbSkillRef, 'when'>, trackId: string): boolean {
  if (skill.when === undefined) return true
  const listed = skill.when.values.includes(trackId)
  return skill.when.kind === 'track-in' ? listed : !listed
}

/** 勾选结果 → when：全选或全不选 = 无条件；否则 track_in。 */
export function whenFromSelection(selected: readonly string[], all: readonly string[]): WbTrackPredicate | undefined {
  if (selected.length === 0 || selected.length >= all.length) return undefined
  return { kind: 'track-in', values: all.filter((id) => selected.includes(id)) }
}

function Node({ skill, tracks, editable, onRemove, onWhen }: {
  skill: WbSkillRef
  tracks: readonly WbTrackDefinition[]
  editable: boolean
  onRemove: () => void
  onWhen: (when: WbTrackPredicate | undefined) => void
}): JSX.Element {
  const { t, lang } = useT()
  const [open, setOpen] = useState(false)
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: `skill:${skill.id}`, disabled: !editable })
  const applied = tracks.filter((track) => skillAppliesTo(skill, track.id))
  const allTracks = applied.length === tracks.length
  const badge = tracks.length === 0 ? null : allTracks ? t('workflow.all_tracks') : applied.map((track) => trackDisplayName(track, lang)).join(' / ')
  function toggle(trackId: string): void {
    const selected = applied.map((track) => track.id)
    const next = selected.includes(trackId) ? selected.filter((id) => id !== trackId) : [...selected, trackId]
    onWhen(whenFromSelection(next, tracks.map((track) => track.id)))
  }
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform) }}
      className={cn('grid gap-1 rounded-md border border-border bg-card py-1.5 pl-1.5 pr-1 shadow-xs', isDragging && 'opacity-60 shadow-md')}
      data-testid={`skill-node-${skill.id}`}
    >
      <div className="flex items-center gap-1.5">
        <button type="button" className={cn('grid size-6 flex-none place-items-center rounded-xs text-text-3 outline-none focus-visible:ring-2 focus-visible:ring-(--accent)', editable ? 'cursor-grab hover:bg-fill hover:text-text' : 'cursor-default')} aria-label={t('workflow.drag_skill', { id: skill.id })} disabled={!editable} data-testid={`skill-handle-${skill.id}`} {...listeners} {...attributes}>
          <GripVertical className="size-3.5" aria-hidden="true" />
        </button>
        <span className="font-mono text-body font-semibold text-text">{skill.id}</span>
        {editable && (
          <button type="button" className="grid size-6 flex-none place-items-center rounded-xs text-text-3 hover:bg-fill hover:text-red-d" aria-label={t('workflow.remove_skill', { id: skill.id })} data-testid={`skill-remove-${skill.id}`} onClick={onRemove}>
            <X className="size-3.5" aria-hidden="true" />
          </button>
        )}
      </div>
      {badge !== null && (
        <button
          type="button"
          className={cn('ml-7 inline-flex w-fit items-center gap-1 rounded-full px-2 py-0.5 text-micro font-medium outline-none focus-visible:ring-2 focus-visible:ring-(--accent)', allTracks ? 'bg-fill text-text-2' : 'bg-info-t text-info-d', editable && 'hover:ring-1 hover:ring-border-2')}
          aria-expanded={open}
          aria-label={t('workflow.tracks_label')}
          disabled={!editable}
          data-testid={`skill-tracks-${skill.id}`}
          onClick={() => setOpen((value) => !value)}
        >
          <Users className="size-3" aria-hidden="true" />
          {badge}
        </button>
      )}
      {open && editable && (
        <ul className="ml-7 flex flex-wrap gap-1" data-testid={`skill-track-picker-${skill.id}`}>
          {tracks.map((track) => {
            const on = applied.some((candidate) => candidate.id === track.id)
            return (
              <li key={track.id}>
                <button type="button" role="checkbox" aria-checked={on} className={cn('rounded-full border px-2 py-0.5 text-micro', on ? 'border-accent-b bg-accent-t text-(--accent)' : 'border-border text-text-2')} data-testid={`skill-track-${skill.id}-${track.id}`} onClick={() => toggle(track.id)}>
                  {trackDisplayName(track, lang)}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function Column({ index, skills, tracks, editable, onRemove, onWhen }: {
  index: number
  skills: readonly WbSkillRef[]
  tracks: readonly WbTrackDefinition[]
  editable: boolean
  onRemove: (id: string) => void
  onWhen: (id: string, when: WbTrackPredicate | undefined) => void
}): JSX.Element {
  const { t } = useT()
  const { setNodeRef, isOver } = useDroppable({ id: `wave:${index}`, disabled: !editable })
  return (
    <div
      ref={setNodeRef}
      className={cn('relative grid content-start gap-2 rounded-md p-1.5 transition-colors', skills.length > 1 && 'border-l-2 border-(--accent)', isOver && 'bg-accent-t')}
      aria-label={t('workflow.wave_label', { n: index + 1 })}
      data-testid={`wave-${index}`}
      data-parallel={skills.length > 1}
    >
      {skills.map((skill) => <Node key={skill.id} skill={skill} tracks={tracks} editable={editable} onRemove={() => onRemove(skill.id)} onWhen={(when) => onWhen(skill.id, when)} />)}
    </div>
  )
}

function Gap({ index, editable, last }: { index: number; editable: boolean; last: boolean }): JSX.Element {
  const { t } = useT()
  const { setNodeRef, isOver } = useDroppable({ id: `gap:${index}`, disabled: !editable })
  return (
    <div
      ref={setNodeRef}
      className={cn('grid min-h-10 w-9 flex-none place-items-center self-stretch rounded-sm transition-colors', isOver && 'bg-accent-t', last && !editable && 'hidden')}
      aria-label={t('workflow.gap_label', { n: index + 1 })}
      data-testid={`gap-${index}`}
    >
      {last ? <span className={cn('size-2 rounded-full border border-dashed border-text-3', !editable && 'hidden')} aria-hidden="true" /> : <ArrowRight className="size-4 text-text-3" aria-hidden="true" />}
    </div>
  )
}

function PaletteItem({ entry, editable }: { entry: WbSkillEntry; editable: boolean }): JSX.Element {
  const { t } = useT()
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: `pal:${entry.name}`, disabled: !editable })
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform) }} className={cn('flex items-center gap-1.5 rounded-sm border border-border bg-card px-1.5 py-1', isDragging && 'opacity-60')} data-testid={`palette-${entry.name}`}>
      <button type="button" className={cn('grid size-5 flex-none place-items-center rounded-xs text-text-3 outline-none focus-visible:ring-2 focus-visible:ring-(--accent)', editable ? 'cursor-grab hover:bg-fill hover:text-text' : 'cursor-default')} aria-label={t('workflow.drag_skill', { id: entry.name })} disabled={!editable} {...listeners} {...attributes}>
        <GripVertical className="size-3" aria-hidden="true" />
      </button>
      <span className="truncate font-mono text-caption text-text">{entry.name}</span>
    </li>
  )
}

/**
 * 技能 DAG：列式画布（同列并行、邻列串行）+ 本机技能面板。拖节点到某列 = 与该列并行；拖到列间隙 = 新的一步；
 * 拖回本机面板 = 移除。节点带轨道标签，点开可勾选生效轨道；顶部轨道芯片按某轨道查看有效链（只看，不改）。
 */
export function SkillDag({ skills, registry, tracks, editable, onWaves, onWhen }: SkillDagProps): JSX.Element {
  const { t, lang } = useT()
  const [search, setSearch] = useState('')
  const [trackFilter, setTrackFilter] = useState<string>('all')
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor))
  const byId = useMemo(() => new Map(skills.map((skill) => [skill.id, skill])), [skills])
  const waves = useMemo(() => wavesOf(skills), [skills])
  const visibleWaves = useMemo(() => trackFilter === 'all'
    ? waves
    : waves.map((wave) => wave.filter((id) => skillAppliesTo(byId.get(id) ?? { id }, trackFilter))).filter((wave) => wave.length > 0), [waves, trackFilter, byId])
  const canEdit = editable && trackFilter === 'all'
  const placed = useMemo(() => new Set(skills.map((skill) => skill.id)), [skills])
  const palette = useMemo(
    () => (registry ?? []).filter((entry) => entry.installed && entry.available !== false && !placed.has(entry.name) && entry.name.toLowerCase().includes(search.trim().toLowerCase())),
    [registry, placed, search],
  )
  const { setNodeRef: setPaletteRef, isOver: overPalette } = useDroppable({ id: 'palette', disabled: !canEdit })

  function onDragEnd(event: DragEndEvent): void {
    const next = applyDrop(waves, String(event.active.id), event.over === null ? null : String(event.over.id))
    if (next !== null) onWaves(next)
  }
  function remove(id: string): void {
    onWaves(waves.map((wave) => wave.filter((candidate) => candidate !== id)).filter((wave) => wave.length > 0))
  }
  const refs = (wave: readonly string[]): WbSkillRef[] => wave.map((id) => byId.get(id) ?? { id })

  return (
    <DndContext sensors={sensors} collisionDetection={dropCollision} onDragEnd={onDragEnd}>
      <div className="grid gap-3" data-testid="skill-dag">
        {tracks.length > 0 && (
          <div className="flex flex-wrap gap-1" role="tablist" aria-label={t('workflow.track_filter')}>
            <button type="button" role="tab" aria-selected={trackFilter === 'all'} className="rounded-sm px-2.5 py-1 text-body text-text-2 aria-selected:bg-accent-t aria-selected:font-semibold aria-selected:text-(--accent) hover:bg-fill" data-testid="dag-track-all" onClick={() => setTrackFilter('all')}>{t('workflow.all_tracks')}</button>
            {tracks.map((track) => (
              <button key={track.id} type="button" role="tab" aria-selected={trackFilter === track.id} className="rounded-sm px-2.5 py-1 text-body text-text-2 aria-selected:bg-accent-t aria-selected:font-semibold aria-selected:text-(--accent) hover:bg-fill" data-testid={`dag-track-${track.id}`} onClick={() => setTrackFilter(track.id)}>{trackDisplayName(track, lang)}</button>
            ))}
          </div>
        )}
        <div className="flex min-h-14 items-center overflow-x-auto rounded-md border border-border bg-bg p-2" data-testid="skill-dag-canvas" data-track-filter={trackFilter}>
          <Gap index={0} editable={canEdit} last={false} />
          {visibleWaves.map((wave, index) => (
            <div key={index} className="flex items-center">
              <Column index={index} skills={refs(wave)} tracks={tracks} editable={canEdit} onRemove={remove} onWhen={onWhen} />
              <Gap index={index + 1} editable={canEdit} last={index === visibleWaves.length - 1} />
            </div>
          ))}
          {visibleWaves.length === 0 && <span className="text-body text-text-3" role="status">{t('workflow.dag_empty')}</span>}
        </div>
        {canEdit && (
          <div ref={setPaletteRef} className={cn('grid gap-2 rounded-md border border-dashed border-border p-2.5 transition-colors', overPalette && 'bg-red-t')} data-testid="skill-palette">
            <label className="flex h-8 items-center gap-2 rounded-sm border border-border bg-card px-2 text-text-3 focus-within:border-accent-b">
              <Search className="size-3.5 flex-none" aria-hidden="true" />
              <span className="sr-only">{t('workflow.search_skills')}</span>
              <input type="search" value={search} placeholder={t('workflow.local_skills')} className="min-w-0 flex-1 bg-transparent text-body text-text outline-none placeholder:text-text-3" data-testid="skill-palette-search" onChange={(event) => setSearch(event.target.value)} />
            </label>
            {registry === null ? (
              <p className="text-caption text-text-3" role="status">{t('common.loading')}</p>
            ) : palette.length === 0 ? (
              <p className="text-caption text-text-3" role="status">{t('workflow.palette_empty')}</p>
            ) : (
              <ul className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
                {palette.map((entry) => <PaletteItem key={entry.name} entry={entry} editable={canEdit} />)}
              </ul>
            )}
          </div>
        )}
      </div>
    </DndContext>
  )
}
