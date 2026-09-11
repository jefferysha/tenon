import { memo, useEffect, useMemo, useState, type DragEvent } from 'react'
import { GripVertical, Plus, Search } from 'lucide-react'
import type { WbSkillEntry, WbSkillRef } from '../api/governanceTypes'
import { useT } from '../i18n'
import { Dialog } from '../shared/Dialog'
import { SkillDetail } from './SkillDetail'
import { appendSerial, SkillFlow } from './SkillFlow'
import { SkillSourceIcon } from './SkillSourceIcon'
import { cn } from '@/lib/utils'

export interface SkillComposerProps {
  open: boolean
  stageLabel: string
  skills: readonly WbSkillRef[]
  registry: readonly WbSkillEntry[] | null
  onClose: () => void
  onSave: (skills: WbSkillRef[]) => void
}

const PaletteItem = memo(function PaletteItem({ entry, placed, active, onOpen, onAdd, onDragging }: {
  entry: WbSkillEntry
  placed: boolean
  active: boolean
  onOpen: (name: string) => void
  onAdd: (name: string) => void
  onDragging: (name: string | null) => void
}): JSX.Element {
  const { t } = useT()
  function onDragStart(event: DragEvent<HTMLLIElement>): void {
    event.dataTransfer.setData('text/skill', entry.name)
    event.dataTransfer.effectAllowed = 'move'
    onDragging(entry.name)
  }
  return (
    <li
      className={cn('flex min-w-0 items-center gap-1 rounded-md border px-1 py-1 transition-[opacity,border-color,background-color] duration-150', active ? 'border-accent-b bg-accent-t' : 'border-transparent hover:border-border hover:bg-card', placed ? 'opacity-45' : 'cursor-grab active:cursor-grabbing')}
      draggable={!placed}
      onDragStart={placed ? undefined : onDragStart}
      onDragEnd={() => onDragging(null)}
      data-testid={`palette-${entry.name}`}
      data-placed={placed}
    >
      <span className="grid size-6 flex-none place-items-center text-text-3" aria-hidden="true"><GripVertical className="size-3.5" /></span>
      <button type="button" className="flex min-w-0 flex-1 items-center gap-2 py-0.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-(--accent)" aria-pressed={active} data-testid={`palette-open-${entry.name}`} onClick={() => onOpen(entry.name)}>
        <span className={cn('truncate font-mono text-body', active ? 'font-semibold text-(--accent)' : 'text-text')}>{entry.name}</span>
        <span className="ml-auto flex flex-none items-center" data-testid={`palette-source-${entry.name}`}><SkillSourceIcon source={entry.source} /></span>
      </button>
      <button type="button" className="grid size-6 flex-none place-items-center rounded-xs text-text-3 outline-none hover:bg-fill hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent) disabled:invisible" aria-label={t('workflow.add_skill', { id: entry.name })} disabled={placed} data-testid={`palette-add-${entry.name}`} onClick={() => onAdd(entry.name)}>
        <Plus className="size-3.5" aria-hidden="true" />
      </button>
    </li>
  )
})

/**
 * 技能编辑器，三栏：技能库（拖到画布或点「+」加入；点名称看详情）/ React Flow 画布（拖节点、拉线 = depends_on、
 * × 移除、Backspace 删边）/ 技能详情。保存才写回阶段定义。
 */
export function SkillComposer({ open, stageLabel, skills, registry, onClose, onSave }: SkillComposerProps): JSX.Element | null {
  const { t } = useT()
  const [draft, setDraft] = useState<WbSkillRef[]>(() => [...skills])
  const [search, setSearch] = useState('')
  const [detail, setDetail] = useState<string | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  useEffect(() => { if (open) { setDraft([...skills]); setDetail(skills[0]?.id ?? null) } }, [open, skills])
  const placed = useMemo(() => new Set(draft.map((skill) => skill.id)), [draft])
  const entries = useMemo(() => (registry ?? [])
    .filter((entry) => entry.installed && entry.available !== false && entry.name.toLowerCase().includes(search.trim().toLowerCase()))
    .sort((a, b) => Number(placed.has(a.name)) - Number(placed.has(b.name)) || a.name.localeCompare(b.name)), [registry, placed, search])
  if (!open) return null

  /** 技能库「+」：串行追加为新一步（依赖末波全部技能）；要并行就拖到那一列上。 */
  function add(id: string): void {
    setDraft((current) => appendSerial(current, id))
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
          <button type="button" className="min-h-10 rounded-md bg-(--accent) px-4 text-base font-semibold text-btn-fg hover:bg-accent-d" data-testid="skill-composer-save" onClick={() => { onSave(draft); onClose() }}>{t('workflow.composer_save')}</button>
        </>
      )}
    >
      <div className="grid h-full min-h-0 grid-cols-[17rem_minmax(0,1fr)_minmax(20rem,26rem)] gap-4 max-[1100px]:grid-cols-[16rem_minmax(0,1fr)] max-[900px]:grid-cols-1">
        <section className="flex min-h-0 flex-col gap-2 rounded-lg border border-border bg-bg p-2" data-testid="skill-palette" aria-label={t('workflow.local_skills')}>
          <label className="flex h-9 flex-none items-center gap-2 rounded-md border border-border bg-card px-2 text-text-3 focus-within:border-accent-b">
            <Search className="size-3.5 flex-none" aria-hidden="true" />
            <span className="sr-only">{t('workflow.search_skills')}</span>
            <input type="search" value={search} placeholder={t('workflow.search_skills')} className="min-w-0 flex-1 bg-transparent text-body text-text outline-none placeholder:text-text-3" data-testid="skill-palette-search" onChange={(event) => setSearch(event.target.value)} />
          </label>
          {registry === null ? (
            <p className="px-1 text-caption text-text-3" role="status">{t('common.loading')}</p>
          ) : entries.length === 0 ? (
            <p className="px-1 text-caption text-text-3" role="status">{t('workflow.palette_empty')}</p>
          ) : (
            <ul className="grid min-h-0 flex-1 grid-cols-1 content-start gap-0.5 overflow-y-auto pr-0.5">
              {entries.map((entry) => <PaletteItem key={entry.name} entry={entry} placed={placed.has(entry.name)} active={detail === entry.name} onOpen={setDetail} onAdd={add} onDragging={setDragging} />)}
            </ul>
          )}
        </section>
        <SkillFlow skills={draft} registry={registry} editable onChange={setDraft} onOpen={setDetail} dragLabel={dragging} className="min-h-0" />
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
    </Dialog>
  )
}
