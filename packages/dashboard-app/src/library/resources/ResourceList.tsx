import { useT } from '../../i18n'
import { getToken } from '../../api/transport'
import {
  RESOURCE_CATEGORIES, RESOURCE_FRAMEWORKS, RESOURCE_STYLING,
  type ResourceCategory, type ResourceDto, type ResourceFileError, type ResourceFramework, type ResourceStyling,
} from '../../api/resourceTypes'
import type { ResourceQuery } from '@tenon/kernel/resources/query'
import { FilterChip, ListColumn } from '../../shell/ThreeColumns'
import { BUTTON_GHOST } from '../../shared/uiRecipes'

const LICENSE_MODES = ['redistributable', 'link-only', 'attribution'] as const
type Facet = 'category' | 'framework' | 'styling' | 'license'

function FacetRow({
  facet, values, selected, labelOf, onPick,
}: {
  facet: Facet
  values: readonly string[]
  selected: string | undefined
  labelOf: (value: string) => string
  onPick: (value: string | undefined) => void
}): JSX.Element {
  const { t } = useT()
  return (
    <div
      className="flex w-full gap-1 overflow-x-auto whitespace-nowrap"
      role="tablist"
      aria-label={t(`resources.facet.${facet}`)}
      data-testid={`res-facet-${facet}`}
    >
      <FilterChip label={t('resources.all')} selected={selected === undefined} testId={`res-${facet}-all`} onClick={() => onPick(undefined)} />
      {values.map((value) => (
        <FilterChip
          key={value}
          label={labelOf(value)}
          selected={selected === value}
          testId={`res-${facet}-${value}`}
          onClick={() => onPick(selected === value ? undefined : value)}
        />
      ))}
    </div>
  )
}

/** 中列：搜索 + 四行单选芯片 + 条目行；解析失败的文件也列出来，标「无效」。 */
export function ResourceList({
  rows, errors, search, query, selected, busy, onSearch, onQuery, onSelect, onNew,
}: {
  rows: readonly ResourceDto[]
  errors: readonly ResourceFileError[]
  search: string
  query: ResourceQuery
  selected: string | null
  busy: boolean
  onSearch: (next: string) => void
  onQuery: (next: ResourceQuery) => void
  onSelect: (id: string) => void
  onNew: () => void
}): JSX.Element {
  const { t } = useT()
  const canWrite = getToken() !== ''
  const patch = (next: Partial<ResourceQuery>): void => onQuery({ ...query, ...next })

  return (
    <ListColumn
      testId="res-list"
      eyebrow={t('library.title')}
      title={t('resources.title')}
      search={{ value: search, onChange: onSearch, placeholder: t('resources.search'), label: t('resources.search'), name: 'res-search' }}
      chips={(
        <>
          <FacetRow
            facet="category"
            values={RESOURCE_CATEGORIES}
            selected={query.category}
            labelOf={(value) => t(`resources.category.${value}`)}
            onPick={(value) => patch({ category: value as ResourceCategory | undefined })}
          />
          <FacetRow
            facet="framework"
            values={RESOURCE_FRAMEWORKS}
            selected={query.framework}
            labelOf={(value) => value}
            onPick={(value) => patch({ framework: value as ResourceFramework | undefined })}
          />
          <FacetRow
            facet="styling"
            values={RESOURCE_STYLING}
            selected={query.styling}
            labelOf={(value) => value}
            onPick={(value) => patch({ styling: value as ResourceStyling | undefined })}
          />
          <FacetRow
            facet="license"
            values={LICENSE_MODES}
            selected={query.license}
            labelOf={(value) => t(`resources.license_mode.${value.replace(/-/gu, '_')}`)}
            onPick={(value) => patch({ license: value as ResourceQuery['license'] })}
          />
          <button type="button" className={`${BUTTON_GHOST} ml-auto min-h-9 px-3`} data-testid="res-new" disabled={!canWrite || busy} onClick={onNew}>
            {t('resources.new')}
          </button>
        </>
      )}
    >
      {rows.length === 0 && errors.length === 0 ? (
        <p className="text-base text-text-2" data-testid="res-empty">{t('resources.empty')}</p>
      ) : (
        <ul className="grid gap-1">
          {rows.map((row) => (
            <li key={row.entry.id}>
              <button
                type="button"
                className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md border border-transparent px-3 py-2.5 text-left outline-none hover:bg-fill focus-visible:ring-2 focus-visible:ring-(--accent) aria-[current=true]:border-accent-b aria-[current=true]:bg-accent-t"
                aria-current={selected === row.entry.id ? 'true' : undefined}
                data-testid={`res-row-${row.entry.id}`}
                onClick={() => onSelect(row.entry.id)}
              >
                <span className="min-w-0">
                  <span className="block truncate text-base font-semibold text-text" title={row.entry.name}>{row.entry.name}</span>
                  <span className="block truncate font-mono text-caption text-text-3">{row.entry.id}</span>
                </span>
                <span className="flex items-center gap-2 whitespace-nowrap">
                  <span className="rounded-full bg-fill px-2 py-0.5 text-micro font-bold text-text-2">
                    {t(`resources.category.${row.entry.category}`)}
                  </span>
                  <span className="rounded-full bg-fill px-2 py-0.5 text-micro font-bold text-text-2">
                    {t(row.entry.license.redistributable ? 'resources.license_mode.redistributable' : 'resources.license_mode.link_only')}
                  </span>
                  <span className="rounded-full bg-fill px-2 py-0.5 text-micro font-bold text-text-2">
                    {t(`resources.source.${row.source}`)}
                  </span>
                </span>
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
                <span className="rounded-full bg-red-t px-2 py-0.5 text-micro font-bold whitespace-nowrap text-red-d">
                  {t('resources.invalid')}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </ListColumn>
  )
}
