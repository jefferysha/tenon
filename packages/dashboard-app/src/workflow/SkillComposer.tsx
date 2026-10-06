import { memo, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { GripVertical, Plus, Search } from 'lucide-react'
import type { WbSkillEntry, WbSkillRef } from '../api/governanceTypes'
import { useT } from '../i18n'
import { Dialog } from '../shared/Dialog'
import { SkillDetail } from './SkillDetail'
import { appendSkill, explicitSkillRefs, minimalSkillRefs, skillOrderSignature } from '../workbench/skillWaves'
import { SkillFlow } from './SkillFlow'
import { SkillSourceIcon } from './SkillSourceIcon'
import { COMPOSER_CANVAS, COMPOSER_DETAIL, COMPOSER_PALETTE, COMPOSER_SEARCH, COMPOSER_SURFACE, paletteNameClass, paletteRowClass, ROW_ADD, ROW_REVEAL } from './composerChrome'
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
  // 点行 = 在右栏预览 SKILL.md（不加入）；行尾「+」= 串行追加；拖拽 = 按落点加入。先看再决定。
  // 已在画布上的行是停用态：整行压暗，点行与「+」都用原生 disabled、不可拖拽（读屏器读出「不可用」，axe 也按停用控件处理，
  // 不再要求压暗后的名称满足对比度）。已放进画布的技能从画布节点上查看详情。
  return (
    <li
      className={paletteRowClass(active, placed)}
      draggable={!placed}
      onDragStart={placed ? undefined : onDragStart}
      onDragEnd={() => onDragging(null)}
      data-testid={`palette-${entry.name}`}
      data-placed={placed}
    >
      <button
        type="button"
        className="flex min-h-10 min-w-0 flex-1 items-center gap-2 px-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-(--accent)"
        aria-pressed={active}
        disabled={placed}
        data-testid={`palette-open-${entry.name}`}
        onClick={() => onOpen(entry.name)}
      >
        <GripVertical className={cn('size-3.5 flex-none text-text-3', ROW_REVEAL)} aria-hidden="true" data-testid={`palette-grip-${entry.name}`} />
        <span className={paletteNameClass(active)} title={entry.name}>{entry.name}</span>
        <span className="flex flex-none items-center" data-testid={`palette-source-${entry.name}`}><SkillSourceIcon source={entry.source} /></span>
      </button>
      <button
        type="button"
        className={ROW_ADD}
        aria-label={t('workflow.add_skill', { id: entry.name })}
        title={t('workflow.add_skill', { id: entry.name })}
        disabled={placed}
        data-testid={`palette-add-${entry.name}`}
        onClick={() => onAdd(entry.name)}
      >
        <Plus className="size-4" aria-hidden="true" />
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
  const searchRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (open) { setDraft([...skills]); setDetail(skills[0]?.id ?? null) } }, [open, skills])
  // 两级保存：这里只把草稿交回阶段（「完成」），真正写盘在页面保存条。没改动时「完成」不可点。
  // 画布只认显式依赖：没写 depends_on 的技能按声明顺序串行（kernel skill-order），进画布前展开，回写时压回最小声明。
  const changed = skillOrderSignature(draft) !== skillOrderSignature(skills)
  const canvasSkills = useMemo(() => explicitSkillRefs(draft), [draft])
  const placed = useMemo(() => new Set(draft.map((skill) => skill.id)), [draft])
  const entries = useMemo(() => (registry ?? [])
    .filter((entry) => entry.installed && entry.available !== false && entry.name.toLowerCase().includes(search.trim().toLowerCase()))
    .sort((a, b) => Number(placed.has(a.name)) - Number(placed.has(b.name)) || a.name.localeCompare(b.name)), [registry, placed, search])
  if (!open) return null

  /** 技能库「+」：串行追加为新一步（接在前面全部之后）；要并行就拖到那一列上。 */
  function add(id: string): void {
    setDraft((current) => appendSkill(current, id))
  }

  return (
    <Dialog
      title={`${stageLabel} · ${t('workflow.composer_title')}`}
      onClose={onClose}
      variant="workspace"
      testid="skill-composer"
      closeLabel={t('workflow.close')}
      closeTestid="skill-composer-close"
      initialFocusRef={searchRef}
      panelClassName="h-[min(90vh,60rem)] w-[min(97vw,96rem)]"
      actions={(
        <>
          <button type="button" className="min-h-10 rounded-md px-3 text-base text-text-2 hover:bg-fill" data-testid="skill-composer-cancel" onClick={onClose}>{t('workflow.cancel')}</button>
          <button type="button" className="min-h-10 rounded-md bg-(--accent) px-4 text-base font-semibold text-btn-fg hover:bg-accent-d disabled:cursor-not-allowed disabled:bg-fill-2 disabled:text-text-3" data-testid="skill-composer-save" disabled={!changed} onClick={() => { onSave(draft); onClose() }}>{t('workflow.composer_done')}</button>
        </>
      )}
    >
      <div className={cn(COMPOSER_SURFACE, 'grid-cols-[20rem_minmax(0,1fr)_minmax(20rem,26rem)] max-[1100px]:grid-cols-[18rem_minmax(0,1fr)] max-[900px]:grid-cols-1')} data-testid="skill-composer-surface">
        <section className={COMPOSER_PALETTE} data-testid="skill-palette" aria-label={t('workflow.local_skills')}>
          <label className={COMPOSER_SEARCH}>
            <Search className="size-3.5 flex-none" aria-hidden="true" />
            <span className="sr-only">{t('workflow.search_skills')}</span>
            <input ref={searchRef} type="search" value={search} placeholder={t('workflow.search_skills')} className="min-w-0 flex-1 bg-transparent text-body text-text outline-none placeholder:text-text-3" data-testid="skill-palette-search" onChange={(event) => setSearch(event.target.value)} />
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
        <SkillFlow skills={canvasSkills} registry={registry} editable onChange={(next) => setDraft(minimalSkillRefs(next))} onOpen={setDetail} dragLabel={dragging} className={COMPOSER_CANVAS} />
        <aside className={COMPOSER_DETAIL} aria-label={t('workflow.preview_skill', { id: detail ?? '' })} data-testid="skill-composer-detail">
          {detail === null ? (
            <p className="text-body text-text-3" role="status">{t('workflow.pick_skill')}</p>
          ) : (
            <>
              <div className="mb-3 flex items-center justify-between gap-3">
                <p className="min-w-0 truncate whitespace-nowrap font-mono text-title font-semibold text-text" title={detail}>{detail}</p>
                {!placed.has(detail) && (registry ?? []).some((entry) => entry.name === detail && entry.installed && entry.available !== false) && (
                  <button type="button" className="inline-flex min-h-10 flex-none items-center gap-1.5 whitespace-nowrap rounded-md border border-accent-b bg-accent-t px-3 text-base font-semibold text-(--accent) outline-none hover:bg-accent-t/70 focus-visible:ring-2 focus-visible:ring-(--accent)" data-testid="skill-composer-detail-add" onClick={() => add(detail)}>
                    <Plus className="size-4" aria-hidden="true" />
                    {t('workflow.composer_add')}
                  </button>
                )}
              </div>
              <SkillDetail key={detail} name={detail} layout="stacked" />
            </>
          )}
        </aside>
      </div>
    </Dialog>
  )
}
