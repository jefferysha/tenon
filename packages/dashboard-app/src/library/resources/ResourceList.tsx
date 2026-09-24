import { useT } from '../../i18n'
import { getToken } from '../../api/transport'
import {
  RESOURCE_CATEGORIES, RESOURCE_FRAMEWORKS, RESOURCE_STYLING,
  type ResourceCategory, type ResourceDto, type ResourceFileError, type ResourceFramework, type ResourceStyling,
} from '../../api/resourceTypes'
import type { ResourceQuery } from '@tenon/kernel/resources/query'
import { ListColumn, StatusPill } from '../../shell/ThreeColumns'
import { FacetBar, type FacetGroup } from '../../shared/FacetBar'
import { BUTTON_GHOST } from '../../shared/uiRecipes'
import { CustomMark, LIST_ROW, LIST_ROW_NAME, ListSkeleton } from '../libraryChrome'

const LICENSE_MODES = ['redistributable', 'link-only', 'attribution'] as const
type Facet = 'category' | 'framework' | 'styling' | 'license'

const ALL = 'all'

/** 下拉给回的是字符串：只接受该维度自己的取值，其余（含「全部」）= 不限。 */
function pick<T extends string>(values: readonly T[], value: string | undefined): T | undefined {
  return values.find((candidate) => candidate === value)
}

/** 一个维度 = 一个单行下拉触发器；「全部」= 不限。 */
function facetGroup(facet: Facet, label: string, allLabel: string, values: readonly string[], selected: string | undefined, labelOf: (value: string) => string, onPick: (value: string | undefined) => void): FacetGroup {
  return {
    id: facet,
    kind: 'menu',
    label,
    testId: `res-facet-${facet}`,
    value: selected ?? ALL,
    onChange: (id) => onPick(id === ALL ? undefined : id),
    options: [
      { id: ALL, label: allLabel, testId: `res-${facet}-all` },
      ...values.map((value) => ({ id: value, label: labelOf(value), testId: `res-${facet}-${value}` })),
    ],
  }
}

/** 中列：搜索 + 单行筛选栏（类别 / 框架 / 样式 / 许可下拉）+ 条目行（只显示名称，标识在悬停提示里，自定义条目带标记）；解析失败的文件也列出来，标「无效」。 */
export function ResourceList({
  rows, errors, loading, search, query, selected, busy, onSearch, onQuery, onSelect, onNew, measureWidth,
}: {
  rows: readonly ResourceDto[]
  /** 首次读取尚未返回：显示骨架，不显示「没有资源」。 */
  loading: boolean
  errors: readonly ResourceFileError[]
  search: string
  query: ResourceQuery
  selected: string | null
  busy: boolean
  onSearch: (next: string) => void
  onQuery: (next: ResourceQuery) => void
  onSelect: (id: string) => void
  onNew: () => void
  /** 测试注入筛选栏宽度测量。 */
  measureWidth?: (element: HTMLElement) => number
}): JSX.Element {
  const { t } = useT()
  const all = t('resources.all')
  const canWrite = getToken() !== ''
  const patch = (next: Partial<ResourceQuery>): void => onQuery({ ...query, ...next })

  return (
    <ListColumn
      title={t('resources.title')}
      action={(
        <button type="button" className={BUTTON_GHOST} data-testid="res-new" disabled={!canWrite || busy} onClick={onNew}>
          {t('resources.new')}
        </button>
      )}
      search={{ value: search, onChange: onSearch, placeholder: t('resources.search'), label: t('resources.search'), name: 'res-search' }}
      chips={(
        <FacetBar
          label={t('resources.title')}
          testId="res-facets"
          {...(measureWidth === undefined ? {} : { measureWidth })}
          groups={[
            facetGroup('category', t('resources.facet.category'), all, RESOURCE_CATEGORIES, query.category, (value) => t(`resources.category.${value}`), (value) => patch({ category: pick<ResourceCategory>(RESOURCE_CATEGORIES, value) })),
            facetGroup('framework', t('resources.facet.framework'), all, RESOURCE_FRAMEWORKS, query.framework, (value) => value, (value) => patch({ framework: pick<ResourceFramework>(RESOURCE_FRAMEWORKS, value) })),
            facetGroup('styling', t('resources.facet.styling'), all, RESOURCE_STYLING, query.styling, (value) => value, (value) => patch({ styling: pick<ResourceStyling>(RESOURCE_STYLING, value) })),
            facetGroup('license', t('resources.facet.license'), all, LICENSE_MODES, query.license, (value) => t(`resources.license_mode.${value.replace(/-/gu, '_')}`), (value) => patch({ license: pick(LICENSE_MODES, value) })),
          ]}
        />
      )}
      testId="res-list"
    >
      {loading ? (
        <ListSkeleton testId="res-loading" />
      ) : rows.length === 0 && errors.length === 0 ? (
        <p className="text-base text-text-2" data-testid="res-empty">{t('resources.empty')}</p>
      ) : (
        <ul className="grid gap-1">
          {rows.map((row) => (
            <li key={row.entry.id}>
              <button
                type="button"
                className={LIST_ROW}
                aria-current={selected === row.entry.id ? 'true' : undefined}
                title={row.entry.id}
                data-testid={`res-row-${row.entry.id}`}
                onClick={() => onSelect(row.entry.id)}
              >
                <span className={LIST_ROW_NAME}>{row.entry.name}</span>
                {row.source === 'custom' ? <CustomMark quiet testId={`res-mark-${row.entry.id}`} /> : <span />}
              </button>
            </li>
          ))}
          {errors.map((error) => (
            <li key={`${error.source}/${error.file}`}>
              <div
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md border border-red-b px-3 py-2.5"
                data-testid={`res-row-invalid-${error.file}`}
              >
                <span className="min-w-0">
                  <span className="block truncate font-mono text-caption text-text">{error.file}</span>
                  <span className="block truncate text-caption text-red-d" title={error.errors.join('；')}>{error.errors[0]}</span>
                </span>
                <StatusPill tone="blocked">{t('resources.invalid')}</StatusPill>
              </div>
            </li>
          ))}
        </ul>
      )}
    </ListColumn>
  )
}
