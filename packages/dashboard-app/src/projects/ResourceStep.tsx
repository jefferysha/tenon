import { useState } from 'react'
import { Check, LoaderCircle } from 'lucide-react'
import { useT } from '../i18n'
import type { ResourceEntry } from '../api/resourceTypes'
import { SegmentTabs } from '../shared/SegmentTabs'
import { cn } from '@/lib/utils'
import { DESIGN_CATEGORIES, availableResources, needsFrontend, type DesignCategory, type ResourcePicks } from './designResources'
import { InlineError } from './projectBits'

export interface ResourceStepProps {
  entries: readonly ResourceEntry[]
  loading: boolean
  failed: boolean
  onRetry: () => void
  /** 已加入的前端模板的框架；为空时组件库 / 图标不可选。 */
  frameworks: readonly string[]
  picks: ResourcePicks
  /** 再点一次已选的条目 = 取消（传 undefined）。 */
  onPick: (category: DesignCategory, id: string | undefined) => void
}

const ROW = 'flex min-h-9 w-full min-w-0 items-center gap-2 rounded-sm px-2 text-left text-body whitespace-nowrap text-text outline-none transition-colors duration-(--dur-fast) hover:bg-fill focus-visible:ring-2 focus-visible:ring-(--accent) aria-pressed:bg-sel-bg aria-pressed:font-semibold'

/**
 * 资源（可跳过）：组件库 / 图标 / DESIGN.md 三个页签，每类最多选一个，再点一次取消。
 * 组件库与图标写进前端模板的资源行，没选前端模板时页签禁用（说明在 Tooltip）；DESIGN.md 在创建时取到项目根。
 */
export function ResourceStep({ entries, loading, failed, onRetry, frameworks, picks, onPick }: ResourceStepProps): JSX.Element {
  const { t } = useT()
  const disabled = (category: DesignCategory): boolean => needsFrontend(category) && frameworks.length === 0
  const [tab, setTab] = useState<DesignCategory>(() => DESIGN_CATEGORIES.find((category) => !disabled(category)) ?? 'design-md')
  const rows = availableResources(entries, tab, frameworks)
  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-3" data-testid="np-resources">
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
      <div id="np-res-panel" role="tabpanel" aria-labelledby={`np-res-tab-${tab}`} className="min-h-0 overflow-y-auto pr-1" data-testid={`np-res-list-${tab}`}>
        {failed ? (
          <InlineError errorKey="resources_unavailable" onRetry={onRetry} testId="np-res-error" />
        ) : loading ? (
          <LoaderCircle className="mx-auto mt-8 size-5 animate-spin text-text-3 motion-reduce:animate-none" aria-label={t('common.loading')} />
        ) : rows.length === 0 ? (
          <p className="px-2 text-body text-text-3" data-testid="np-res-empty">{t('resources.empty')}</p>
        ) : (
          <ul className="grid gap-0.5">
            {rows.map((entry) => {
              const picked = picks[tab] === entry.id
              return (
                <li key={entry.id}>
                  <button
                    type="button"
                    aria-pressed={picked}
                    className={cn(ROW)}
                    title={entry.name}
                    data-testid={`np-res-${entry.id}`}
                    onClick={() => onPick(tab, picked ? undefined : entry.id)}
                  >
                    <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                    {picked && <Check className="size-4 flex-none text-(--accent)" strokeWidth={2.5} aria-hidden="true" />}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
