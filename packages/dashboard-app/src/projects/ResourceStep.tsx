import { useState } from 'react'
import { Check, LoaderCircle } from 'lucide-react'
import { useT } from '../i18n'
import type { ResourceEntry } from '../api/resourceTypes'
import { SegmentTabs } from '../shared/SegmentTabs'
import { LIST_SELECTED_ARIA } from '../shared/uiRecipes'
import { cn } from '@/lib/utils'
import { DESIGN_CATEGORIES, fitsResource, listResources, needsFrontend, type DesignCategory, type ResourcePicks } from './designResources'
import { Hinted, InlineError } from './projectBits'
import { ResourcePreview } from './ResourcePreview'

export interface ResourceStepProps {
  entries: readonly ResourceEntry[]
  loading: boolean
  failed: boolean
  onRetry: () => void
  /** 已加入的前端模板的框架；为空时组件库 / 图标不可选。 */
  frameworks: readonly string[]
  picks: ResourcePicks
  /** 每类最多一个；传 undefined = 移除。 */
  onPick: (category: DesignCategory, id: string | undefined) => void
}

const ROW = 'flex min-h-9 items-center gap-2 rounded-sm px-2 text-left text-caption whitespace-nowrap outline-none transition-colors duration-(--dur-fast) hover:bg-fill focus-visible:ring-2 focus-visible:ring-(--accent)'

/**
 * 资源（可跳过）：与「模板」同构——组件库 / 图标 / DESIGN.md 三个页签，左列条目，点行在右侧预览，预览头部「加入 / 移除」，
 * 每类最多加入一个。组件库 / 图标默认只列与所选前端模板框架相容的条目，「全部」列出该类所有条目（不相容的不能加入）；
 * 没加入前端模板时这两个页签禁用（说明在 Tooltip）。进入页签默认预览第一行，右侧不留空框。
 */
export function ResourceStep({ entries, loading, failed, onRetry, frameworks, picks, onPick }: ResourceStepProps): JSX.Element {
  const { t } = useT()
  const disabled = (category: DesignCategory): boolean => needsFrontend(category) && frameworks.length === 0
  const [tab, setTab] = useState<DesignCategory>(() => DESIGN_CATEGORIES.find((category) => !disabled(category)) ?? 'design-md')
  const [showAll, setShowAll] = useState(false)
  const [focusId, setFocusId] = useState<string | null>(null)
  const rows = listResources(entries, tab, frameworks, showAll)
  // 预览的条目不在当前列表里（换了页签 / 关掉「全部」）时回到第一行。
  const focus = rows.find((entry) => entry.id === focusId) ?? rows[0]
  const added = focus !== undefined && picks[tab] === focus.id
  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-3" data-testid="np-resources">
      <div className="flex min-w-0 items-center gap-3">
        <SegmentTabs
          sheets={DESIGN_CATEGORIES.map((category) => ({
            id: category,
            label: t(`resources.category.${category}`),
            disabled: disabled(category),
            ...(disabled(category) ? { hint: t('projects.template_needs_frontend') } : {}),
          }))}
          active={tab}
          onChange={setTab}
          ariaLabel={t('projects.step_resources')}
          idPrefix="np-res"
        />
        {needsFrontend(tab) && (
          <Hinted hint={t('projects.res_all_hint')} asChild>
            <label className="ml-auto flex min-h-9 cursor-pointer items-center gap-2 text-caption whitespace-nowrap text-text">
              <input type="checkbox" className="size-4 accent-(--accent)" checked={showAll} data-testid="np-res-all" onChange={(event) => setShowAll(event.target.checked)} />
              {t('resources.all')}
            </label>
          </Hinted>
        )}
      </div>
      <div id="np-res-panel" role="tabpanel" aria-labelledby={`np-res-tab-${tab}`} className="min-h-0" data-testid={`np-res-list-${tab}`}>
        {failed ? (
          <InlineError errorKey="resources_unavailable" onRetry={onRetry} testId="np-res-error" />
        ) : loading ? (
          <LoaderCircle className="mx-auto mt-8 size-5 animate-spin text-text-3 motion-reduce:animate-none" aria-label={t('common.loading')} />
        ) : focus === undefined ? (
          <p className="px-2 text-body text-text-3" data-testid="np-res-empty">{t('resources.empty')}</p>
        ) : (
          <div className="grid h-full min-h-0 grid-cols-[208px_minmax(0,1fr)] gap-3">
            <ul className="grid min-h-0 content-start gap-0.5 overflow-y-auto pr-1" data-testid="np-res-rows">
              {rows.map((entry) => {
                const picked = picks[tab] === entry.id
                return (
                  <li key={entry.id}>
                    <button
                      type="button"
                      aria-current={entry.id === focus.id}
                      aria-label={picked ? `${entry.name} · ${t('projects.added')}` : entry.name}
                      className={cn(ROW, 'w-full', fitsResource(entry, frameworks) ? 'text-text' : 'text-text-3', LIST_SELECTED_ARIA)}
                      title={entry.name}
                      data-testid={`np-res-${entry.id}`}
                      onClick={() => setFocusId(entry.id)}
                    >
                      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                      {picked && <Check className="size-4 flex-none text-(--accent)" strokeWidth={2.5} aria-hidden="true" />}
                    </button>
                  </li>
                )
              })}
            </ul>
            <ResourcePreview
              key={focus.id}
              entry={focus}
              added={added}
              allowed={fitsResource(focus, frameworks)}
              onToggle={() => onPick(tab, added ? undefined : focus.id)}
            />
          </div>
        )}
      </div>
    </div>
  )
}
