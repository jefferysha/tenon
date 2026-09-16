import { useEffect, useMemo, useState } from 'react'
import { useT } from '../i18n'
import { getToken } from '../api/transport'
import { TEMPLATE_CATEGORIES, type TemplateCategory, type TemplateRef, type TemplateSource } from '../api/instructionsDecoders'
import { DetailEmpty, FilterChip, ListColumn, ThreeColumns } from '../shell/ThreeColumns'
import { matchesQuery } from '../shell/GlobalSearch'
import { BUTTON_GHOST } from '../shared/uiRecipes'
import { LibraryRail, type LibrarySection } from './LibraryRail'
import { NewTemplateDialog } from './NewTemplateDialog'
import { ResourceCatalog } from './resources/ResourceCatalog'
import { TestDirectionsPane } from './TestDirectionsPane'
import { useTestDirections } from './useTestDirections'
import { TemplateDetail } from './TemplateDetail'
import { useTemplateLibrary } from './useTemplateLibrary'

const RAIL_KEY = 'tenon-dashboard-rail:library'
type SourceFilter = TemplateSource | 'all'
type CategoryFilter = TemplateCategory | 'all'

/** 新建自定义模板的起始骨架：合法 frontmatter + 分类级别标题，保存后即可编辑。 */
function skeleton(category: TemplateCategory, id: string, title: string): string {
  const heading = category === 'state' || category === 'styling' ? '###' : '##'
  const frameworks = category === 'state' || category === 'styling' ? 'frameworks: [react]\n' : ''
  return `---\nid: ${id}\ncategory: ${category}\ntitle: ${id}\n${frameworks}---\n${heading} ${title}\n\n- \n`
}

/** 库：左列种类（模板）/ 中列模板列表 / 右列模板详情。 */
export function LibraryView({ onToast }: { onToast?: (message: string) => void }): JSX.Element {
  const { t } = useT()
  const library = useTemplateLibrary()
  const [railCollapsed, setRailCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(RAIL_KEY) === '1' } catch { return false }
  })
  useEffect(() => {
    try { localStorage.setItem(RAIL_KEY, railCollapsed ? '1' : '0') } catch { /* ignore */ }
  }, [railCollapsed])
  const [category, setCategory] = useState<CategoryFilter>('all')
  const [source, setSource] = useState<SourceFilter>('all')
  const [search, setSearch] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [section, setSection] = useState<LibrarySection>('templates')
  const directions = useTestDirections()

  const rows = useMemo(
    () => library.templates.filter((row) =>
      (category === 'all' || row.category === category)
      && (source === 'all' || row.source === source)
      && matchesQuery(search, row.id, row.title, row.category)),
    [library.templates, category, source, search],
  )
  const canWrite = getToken() !== ''

  const onCreate = (nextCategory: TemplateCategory, id: string): void => {
    void (async () => {
      const ok = await library.create(nextCategory, id, skeleton(nextCategory, id, t(`library.categories.${nextCategory}`)))
      if (ok) {
        setDialogOpen(false)
        onToast?.(t('library.new'))
      }
    })()
  }

  const onCopy = (): void => {
    const current = library.selected
    if (current === null) return
    void (async () => {
      if (await library.copy(`${current.id}-copy`)) onToast?.(t('library.copy'))
    })()
  }

  const rail = (
    <LibraryRail
      section={section}
      templates={library.templates.length}
      directions={directions.directions.length}
      collapsed={railCollapsed}
      onSection={setSection}
      onToggle={() => setRailCollapsed((value) => !value)}
    />
  )
  if (section === 'resources') {
    return (
      <ResourceCatalog
        rail={rail}
        railCollapsed={railCollapsed}
        today={new Date().toISOString().slice(0, 10)}
        onToast={onToast}
      />
    )
  }

  return (
    <>
      <ThreeColumns
        testId="library-view"
        railCollapsed={railCollapsed}
        rail={rail}
        list={section === 'directions' ? (
          <ListColumn
            testId="library-list"
            eyebrow={t('library.title')}
            title={t('library.test_directions')}
          >
            <TestDirectionsPane slot="list" library={directions} canWrite={canWrite} onToast={onToast} />
          </ListColumn>
        ) : (
          <ListColumn
            testId="library-list"
            eyebrow={t('library.title')}
            title={t('library.templates')}
            search={{ value: search, onChange: setSearch, placeholder: t('library.search'), label: t('library.search'), name: 'library-search' }}
            chips={(
              <>
                <FilterChip label={t('library.all')} selected={category === 'all' && source === 'all'} testId="lib-filter-all" onClick={() => { setCategory('all'); setSource('all') }} />
                {TEMPLATE_CATEGORIES.map((value) => (
                  <FilterChip
                    key={value}
                    label={t(`library.categories.${value}`)}
                    selected={category === value}
                    testId={`lib-filter-${value}`}
                    onClick={() => setCategory((current) => (current === value ? 'all' : value))}
                  />
                ))}
                {(['builtin', 'custom'] as const).map((value) => (
                  <FilterChip
                    key={value}
                    label={t(`library.${value}`)}
                    selected={source === value}
                    testId={`lib-source-${value}`}
                    onClick={() => setSource((current) => (current === value ? 'all' : value))}
                  />
                ))}
                <button
                  type="button"
                  className={`${BUTTON_GHOST} ml-auto min-h-9 px-3`}
                  data-testid="lib-tpl-new"
                  disabled={!canWrite || library.busy}
                  onClick={() => setDialogOpen(true)}
                >
                  {t('library.new')}
                </button>
              </>
            )}
          >
            {library.sync?.state === 'failed' && (
              <p className="mb-3 rounded-md border border-red-b bg-red-t px-4 py-2 text-caption font-semibold text-red-d" role="status" data-testid="lib-sync-failed">
                {t('library.sync_failed')}
              </p>
            )}
            {rows.length === 0 ? (
              <p className="text-base text-text-2" data-testid="lib-empty">{t('library.empty_list')}</p>
            ) : (
              <ul className="grid gap-1">
                {rows.map((row) => {
                  const ref_: TemplateRef = { source: row.source, category: row.category, id: row.id }
                  const selected = library.selected?.source === row.source
                    && library.selected?.category === row.category && library.selected?.id === row.id
                  return (
                    <li key={`${row.source}/${row.category}/${row.id}`}>
                      <button
                        type="button"
                        className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md border border-transparent px-3 py-2.5 text-left outline-none hover:bg-fill focus-visible:ring-2 focus-visible:ring-(--accent) aria-[current=true]:border-accent-b aria-[current=true]:bg-accent-t"
                        aria-current={selected ? 'true' : undefined}
                        data-testid={`lib-tpl-${row.source}-${row.category}-${row.id}`}
                        onClick={() => library.select(ref_)}
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-base font-semibold text-text">{row.title}</span>
                          <span className="block truncate font-mono text-caption text-text-3">{`${row.category}/${row.id}`}</span>
                        </span>
                        <span className="flex items-center gap-2 whitespace-nowrap">
                          {row.errors.length > 0 && (
                            <span className="rounded-full bg-red-t px-2 py-0.5 text-micro font-bold text-red-d" data-testid={`lib-tpl-errors-${row.id}`}>
                              {row.errors.length}
                            </span>
                          )}
                          <span className="rounded-full bg-fill px-2 py-0.5 text-micro font-bold text-text-2">
                            {t(`library.${row.source}`)}
                          </span>
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </ListColumn>
        )}
        detail={section === 'directions' ? (
          <div className="min-h-0 overflow-y-auto px-10 pt-7 pb-8 max-[900px]:px-4" data-testid="library-direction-detail">
            <TestDirectionsPane slot="detail" library={directions} canWrite={canWrite} onToast={onToast} />
          </div>
        ) : library.selected === null || library.document === null ? (
          <DetailEmpty title={t('library.empty_detail')} desc={t('library.templates')} testId="lib-detail-empty" />
        ) : (
          <TemplateDetail
            ref_={library.selected}
            document={library.document}
            busy={library.busy}
            errorKey={library.errorKey}
            onSave={(text) => { void (async () => { if (await library.save(text)) onToast?.(t('library.save')) })() }}
            onCopy={onCopy}
            onDelete={() => { void (async () => { if (await library.remove()) onToast?.(t('library.delete')) })() }}
            onReload={() => { void library.reload() }}
          />
        )}
      />
      {dialogOpen && <NewTemplateDialog busy={library.busy} onClose={() => setDialogOpen(false)} onCreate={onCreate} />}
    </>
  )
}
