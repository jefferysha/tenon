import { useEffect, useMemo, useState } from 'react'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import { ChevronDown, ChevronRight, Eye, GripVertical, Search } from 'lucide-react'
import { fetchSkillReadme } from '../api/client'
import type { WbSkillEntry, WbSkillReadme, WbSkillRef } from '../api/governanceTypes'
import { formatApiError } from '../api/transport'
import { useT } from '../i18n'
import { Dialog } from '../shared/Dialog'
import { Drawer } from '../shared/Drawer'
import { Markdown } from '../shared/Markdown'
import { wavesOf } from '../workbench/skillWaves'
import { applyDrop, dropCollision, SkillCanvas } from './SkillDag'
import { cn } from '@/lib/utils'

export interface SkillComposerProps {
  open: boolean
  stageLabel: string
  skills: readonly WbSkillRef[]
  registry: readonly WbSkillEntry[] | null
  onClose: () => void
  onSave: (waves: string[][]) => void
}

function PaletteItem({ entry, placed, expanded, onToggle, onPreview }: {
  entry: WbSkillEntry
  placed: boolean
  expanded: boolean
  onToggle: () => void
  onPreview: () => void
}): JSX.Element {
  const { t } = useT()
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: `pal:${entry.name}`, disabled: placed })
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform) }}
      className={cn('grid gap-1 rounded-md border border-border bg-card px-1.5 py-1.5 transition-shadow', isDragging && 'opacity-50 shadow-md', placed && 'opacity-50')}
      data-testid={`palette-${entry.name}`}
      data-placed={placed}
    >
      <div className="flex items-center gap-1.5">
        <button type="button" className={cn('grid size-6 flex-none place-items-center rounded-xs text-text-3 outline-none focus-visible:ring-2 focus-visible:ring-(--accent)', placed ? 'cursor-default' : 'cursor-grab hover:bg-fill hover:text-text')} aria-label={t('workflow.drag_skill', { id: entry.name })} disabled={placed} data-testid={`palette-handle-${entry.name}`} {...listeners} {...attributes}>
          <GripVertical className="size-3.5" aria-hidden="true" />
        </button>
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-(--accent)" aria-expanded={expanded} data-testid={`palette-toggle-${entry.name}`} onClick={onToggle}>
          <span className="truncate font-mono text-body font-semibold text-text">{entry.name}</span>
          <span className="flex-none rounded-full bg-fill px-1.5 py-0.5 text-micro text-text-2" data-testid={`palette-source-${entry.name}`}>{t(`workflow.skill_source_${entry.source}`)}</span>
          {expanded ? <ChevronDown className="ml-auto size-3.5 flex-none text-text-3" aria-hidden="true" /> : <ChevronRight className="ml-auto size-3.5 flex-none text-text-3" aria-hidden="true" />}
        </button>
        <button type="button" className="grid size-6 flex-none place-items-center rounded-xs text-text-3 hover:bg-fill hover:text-text" aria-label={t('workflow.preview_skill', { id: entry.name })} data-testid={`palette-preview-${entry.name}`} onClick={onPreview}>
          <Eye className="size-3.5" aria-hidden="true" />
        </button>
      </div>
      {expanded && (
        <dl className="ml-7 grid gap-0.5 text-caption text-text-2" data-testid={`palette-detail-${entry.name}`}>
          <div className="flex gap-2"><dt className="flex-none text-text-3">{t('workflow.skill_origin')}</dt><dd className="min-w-0 truncate font-mono">{entry.version === undefined ? t(`workflow.skill_source_${entry.source}`) : `${t(`workflow.skill_source_${entry.source}`)} · ${entry.version}`}</dd></div>
          {entry.description !== undefined && <div><dd>{entry.description}</dd></div>}
        </dl>
      )}
    </li>
  )
}

function Palette({ registry, placed, search, onSearch, onPreview }: {
  registry: readonly WbSkillEntry[] | null
  placed: ReadonlySet<string>
  search: string
  onSearch: (value: string) => void
  onPreview: (name: string) => void
}): JSX.Element {
  const { t } = useT()
  const [expanded, setExpanded] = useState<string | null>(null)
  const { setNodeRef, isOver } = useDroppable({ id: 'palette' })
  const entries = useMemo(() => (registry ?? [])
    .filter((entry) => entry.installed && entry.available !== false && entry.name.toLowerCase().includes(search.trim().toLowerCase()))
    .sort((a, b) => Number(placed.has(a.name)) - Number(placed.has(b.name)) || a.name.localeCompare(b.name)), [registry, placed, search])
  return (
    <section ref={setNodeRef} className={cn('flex min-h-0 flex-col gap-2 rounded-md border border-border p-2.5 transition-colors', isOver && 'bg-red-t')} data-testid="skill-palette" aria-label={t('workflow.local_skills')}>
      <label className="flex h-9 flex-none items-center gap-2 rounded-sm border border-border bg-card px-2 text-text-3 focus-within:border-accent-b">
        <Search className="size-3.5 flex-none" aria-hidden="true" />
        <span className="sr-only">{t('workflow.search_skills')}</span>
        <input type="search" value={search} placeholder={t('workflow.search_skills')} className="min-w-0 flex-1 bg-transparent text-body text-text outline-none placeholder:text-text-3" data-testid="skill-palette-search" onChange={(event) => onSearch(event.target.value)} />
      </label>
      {registry === null ? (
        <p className="text-caption text-text-3" role="status">{t('common.loading')}</p>
      ) : entries.length === 0 ? (
        <p className="text-caption text-text-3" role="status">{t('workflow.palette_empty')}</p>
      ) : (
        <ul className="grid min-h-0 flex-1 content-start gap-1.5 overflow-y-auto pr-1">
          {entries.map((entry) => (
            <PaletteItem key={entry.name} entry={entry} placed={placed.has(entry.name)} expanded={expanded === entry.name} onToggle={() => setExpanded((current) => current === entry.name ? null : entry.name)} onPreview={() => onPreview(entry.name)} />
          ))}
        </ul>
      )}
    </section>
  )
}

/** SKILL.md 的 YAML 头（name / description / metadata）不是正文：正文渲染前剥掉，只保留 Markdown。 */
export function stripFrontmatter(markdown: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(markdown)
  return match === null ? markdown : markdown.slice(match[0].length).replace(/^\s+/, '')
}

function Preview({ name, onClose }: { name: string | null; onClose: () => void }): JSX.Element {
  const { t } = useT()
  const [state, setState] = useState<{ kind: 'loading' } | { kind: 'ready'; readme: WbSkillReadme } | { kind: 'error'; detail: string }>({ kind: 'loading' })
  useEffect(() => {
    if (name === null) return
    let cancelled = false
    setState({ kind: 'loading' })
    fetchSkillReadme(name)
      .then((readme) => { if (!cancelled) setState({ kind: 'ready', readme }) })
      .catch((error: unknown) => { if (!cancelled) setState({ kind: 'error', detail: formatApiError(error, t) }) })
    return () => { cancelled = true }
  }, [name, t])
  return (
    <Drawer open={name !== null} onClose={onClose} title={<span className="font-mono">{name ?? ''}</span>} ariaLabel={t('workflow.preview_skill', { id: name ?? '' })} testId="skill-preview">
      {state.kind === 'loading' ? (
        <p className="text-body text-text-3" role="status">{t('workflow.preview_loading')}</p>
      ) : state.kind === 'error' ? (
        <p className="text-body text-red-d" role="alert">{t('workflow.preview_failed')} · {state.detail}</p>
      ) : (
        <>
          <p className="mb-4 flex flex-wrap items-center gap-2 font-mono text-caption text-text-2" data-testid="skill-preview-origin">
            <span className="rounded-full bg-fill px-1.5 py-0.5">{t(`workflow.skill_source_${state.readme.source}`)}</span>
            <span>{state.readme.origin}</span>
            <span className="text-text-3">{state.readme.path}</span>
          </p>
          <Markdown text={stripFrontmatter(state.readme.markdown)} testId="skill-preview-markdown" />
        </>
      )}
    </Drawer>
  )
}

/**
 * 技能编排浮层：左侧本机技能库（搜索 / 来源 / 展开来源与说明 / 眼睛预览 SKILL.md），右侧波次画布。
 * 从左拖到右：落到某列 = 并行，落到列间隙 = 新的串行波次；拖回左侧 = 移除。保存才写回阶段定义。
 */
export function SkillComposer({ open, stageLabel, skills, registry, onClose, onSave }: SkillComposerProps): JSX.Element | null {
  const { t } = useT()
  const [waves, setWaves] = useState<string[][]>(() => wavesOf(skills))
  const [search, setSearch] = useState('')
  const [active, setActive] = useState<string | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  useEffect(() => { if (open) setWaves(wavesOf(skills)) }, [open, skills])
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor))
  const placed = useMemo(() => new Set(waves.flat()), [waves])
  if (!open) return null

  function onDragEnd(event: DragEndEvent): void {
    setActive(null)
    const next = applyDrop(waves, String(event.active.id), event.over === null ? null : String(event.over.id))
    if (next !== null) setWaves(next)
  }
  function onDragStart(event: DragStartEvent): void {
    setActive(String(event.active.id).replace(/^(skill|pal):/, ''))
  }
  function remove(id: string): void {
    setWaves(waves.map((wave) => wave.filter((candidate) => candidate !== id)).filter((wave) => wave.length > 0))
  }

  return (
    <Dialog
      title={`${stageLabel} · ${t('workflow.composer_title')}`}
      onClose={onClose}
      variant="workspace"
      testid="skill-composer"
      closeLabel={t('workflow.cancel')}
      closeTestid="skill-composer-close"
      panelClassName="h-[min(88vh,56rem)] w-[min(96vw,80rem)]"
      actions={(
        <>
          <button type="button" className="min-h-10 rounded-md px-3 text-base text-text-2 hover:bg-fill" data-testid="skill-composer-cancel" onClick={onClose}>{t('workflow.cancel')}</button>
          <button type="button" className="min-h-10 rounded-md bg-(--accent) px-4 text-base font-semibold text-btn-fg hover:bg-accent-d" data-testid="skill-composer-save" onClick={() => { onSave(waves); onClose() }}>{t('workflow.composer_save')}</button>
        </>
      )}
    >
      <DndContext sensors={sensors} collisionDetection={dropCollision} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setActive(null)}>
        <div className="grid h-full min-h-0 grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)] gap-4 max-[900px]:grid-cols-1">
          <Palette registry={registry} placed={placed} search={search} onSearch={setSearch} onPreview={setPreview} />
          <section className="flex min-h-0 flex-col gap-3" aria-label={t('workflow.skills_title')}>
            <SkillCanvas waves={waves} onRemove={remove} />
          </section>
        </div>
        <DragOverlay dropAnimation={{ duration: 180, easing: 'cubic-bezier(0.2, 0, 0, 1)' }}>
          {active !== null && <div className="rounded-md border border-accent-b bg-card px-3 py-1.5 font-mono text-body font-semibold text-text shadow-md" data-testid="skill-drag-overlay">{active}</div>}
        </DragOverlay>
      </DndContext>
      <Preview name={preview} onClose={() => setPreview(null)} />
    </Dialog>
  )
}
