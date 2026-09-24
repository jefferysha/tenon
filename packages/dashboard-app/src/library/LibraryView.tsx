import { useEffect, useMemo, useState } from 'react'
import { useT } from '../i18n'
import { getToken } from '../api/transport'
import { TEMPLATE_CATEGORIES, type TemplateCategory, type TemplateRef, type TemplateSource } from '../api/instructionsDecoders'
import { DetailEmpty, ListColumn, ThreeColumns } from '../shell/ThreeColumns'
import { FacetBar } from '../shared/FacetBar'
import { matchesQuery } from '../shell/GlobalSearch'
import { BUTTON_GHOST } from '../shared/uiRecipes'
import { BuiltinLock, LIST_ROW, LIST_ROW_NAME, ListSkeleton } from './libraryChrome'
import { AgentDetail } from './AgentDetail'
import { AgentList, NewAgentDialog, agentSkeleton } from './AgentList'
import { useAgentLibrary } from './useAgentLibrary'
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

function pickSource(id: string): SourceFilter {
  return id === 'builtin' || id === 'custom' ? id : 'all'
}

function pickCategory(id: string): CategoryFilter {
  return TEMPLATE_CATEGORIES.find((value) => value === id) ?? 'all'
}

/** 新建自定义模板的起始骨架：合法 frontmatter + 分类级别标题，保存后即可编辑。 */
function skeleton(category: TemplateCategory, id: string, title: string): string {
  const heading = category === 'state' || category === 'styling' ? '###' : '##'
  const frameworks = category === 'state' || category === 'styling' ? 'frameworks: [react]\n' : ''
  return `---\nid: ${id}\ncategory: ${category}\ntitle: ${id}\n${frameworks}---\n${heading} ${title}\n\n- \n`
}

/** 库：左列种类（模板 / 资源 / 测试方向 / agent）/ 中列列表 / 右列详情。 */
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
  const [agentDialog, setAgentDialog] = useState(false)
  const [section, setSection] = useState<LibrarySection>('templates')
  const directions = useTestDirections()
  const agents = useAgentLibrary()

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
        onToast?.(t('library.done_template_created', { name: id }))
      }
    })()
  }

  const onCopy = (): void => {
    const current = library.selected
    if (current === null) return
    void (async () => {
      if (await library.copy(`${current.id}-copy`)) onToast?.(t('common.done_copied'))
    })()
  }

  const rail = (
    <LibraryRail
      section={section}
      templates={library.loading ? null : library.templates.length}
      directions={directions.loading ? null : directions.directions.length}
      agents={agents.loading ? null : agents.agents.length}
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
        list={section === 'agents' ? (
          <ListColumn
            testId="library-list"
            title={t('library.agents')}
            action={agents.loading ? undefined : (
              <button
                type="button"
                className={BUTTON_GHOST}
                data-testid="lib-agent-new"
                disabled={!canWrite || agents.busy}
                onClick={() => setAgentDialog(true)}
              >
                {t('library.agent_new')}
              </button>
            )}
          >
            <AgentList
              agents={agents.agents}
              loading={agents.loading}
              selected={agents.selected?.name ?? null}
              onSelect={agents.select}
            />
            {agentDialog && (
              <NewAgentDialog
                agents={agents.agents}
                busy={agents.busy}
                onClose={() => setAgentDialog(false)}
                onCreate={(name) => {
                  void (async () => {
                    if (await agents.create(name, agentSkeleton(name))) onToast?.(t('library.done_agent_created', { name }))
                  })()
                }}
              />
            )}
          </ListColumn>
        ) : section === 'directions' ? (
          <ListColumn
            testId="library-list"
            title={t('library.test_directions')}
          >
            <TestDirectionsPane slot="list" library={directions} canWrite={canWrite} onToast={onToast} />
          </ListColumn>
        ) : (
          <ListColumn
            testId="library-list"
            title={t('library.templates')}
            search={{ value: search, onChange: setSearch, placeholder: t('library.search'), label: t('library.search'), name: 'library-search' }}
            action={library.loading ? undefined : (
              <button
                type="button"
                className={BUTTON_GHOST}
                data-testid="lib-tpl-new"
                disabled={!canWrite || library.busy}
                onClick={() => setDialogOpen(true)}
              >
                {t('library.new')}
              </button>
            )}
            chips={library.templates.length === 0 ? undefined : (
              <FacetBar
                label={t('library.templates')}
                testId="lib-facets"
                groups={[
                  {
                    id: 'source',
                    kind: 'chips',
                    label: t('library.source'),
                    testId: 'lib-source',
                    value: source,
                    onChange: (id) => setSource(pickSource(id)),
                    options: [
                      { id: 'all', label: t('library.all'), testId: 'lib-source-all' },
                      { id: 'builtin', label: t('library.builtin'), testId: 'lib-source-builtin' },
                      { id: 'custom', label: t('library.custom'), testId: 'lib-source-custom' },
                    ],
                  },
                  {
                    id: 'category',
                    kind: 'menu',
                    label: t('library.category'),
                    testId: 'lib-facet-category',
                    value: category,
                    onChange: (id) => setCategory(pickCategory(id)),
                    options: [
                      { id: 'all', label: t('library.all'), testId: 'lib-filter-all' },
                      ...TEMPLATE_CATEGORIES.map((value) => ({ id: value, label: t(`library.categories.${value}`), testId: `lib-filter-${value}` })),
                    ],
                  },
                ]}
              />
            )}
          >
            {library.sync?.state === 'failed' && (
              <p className="mb-3 rounded-md border border-red-b bg-red-t px-4 py-2 text-caption font-semibold text-red-d" role="status" data-testid="lib-sync-failed">
                {t('library.sync_failed')}
              </p>
            )}
            {library.loading ? (
              <ListSkeleton testId="lib-loading" />
            ) : rows.length === 0 ? (
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
                        className={LIST_ROW}
                        aria-current={selected ? 'true' : undefined}
                        title={`${row.category}/${row.id}`}
                        data-testid={`lib-tpl-${row.source}-${row.category}-${row.id}`}
                        onClick={() => library.select(ref_)}
                      >
                        <span className={LIST_ROW_NAME}>{row.title}</span>
                        <span className="flex items-center gap-2 whitespace-nowrap">
                          {row.errors.length > 0 && (
                            <span className="grid h-5 min-w-5 place-items-center rounded-full bg-red-t px-1 text-micro font-semibold tabular-nums text-red-d" data-testid={`lib-tpl-errors-${row.id}`}>
                              {row.errors.length}
                            </span>
                          )}
                          {row.source === 'builtin' && <BuiltinLock quiet testId={`lib-tpl-builtin-${row.id}`} />}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </ListColumn>
        )}
        detail={section === 'agents' ? (
          agents.selected === null ? (
            <DetailEmpty label={t('library.agent_empty_detail')} testId="lib-agent-detail-empty" />
          ) : (
            <AgentDetail
              document={agents.selected}
              summary={agents.agents.find((row) => row.name === agents.selected?.name) ?? null}
              draft={agents.draft}
              busy={agents.busy}
              error={agents.error}
              blockedBy={agents.blockedBy}
              onDraft={agents.setDraft}
              onSave={() => { void (async () => { if (await agents.save()) onToast?.(t('common.done_saved')) })() }}
              onCopy={() => {
                const current = agents.selected
                if (current === null) return
                void (async () => { if (await agents.copy(`${current.name}-copy`)) onToast?.(t('common.done_copied')) })()
              }}
              onDelete={() => {
                const name = agents.selected?.name ?? ''
                void (async () => { if (await agents.remove()) onToast?.(t('common.done_deleted', { name })) })()
              }}
            />
          )
        ) : section === 'directions' ? (
          directions.selected === null ? (
            <DetailEmpty label={t('library.direction_empty_detail')} testId="lib-dir-empty" />
          ) : (
            <div className="min-h-0 overflow-y-auto px-10 pt-7 pb-8 max-[900px]:px-4" data-testid="library-direction-detail">
              <TestDirectionsPane slot="detail" library={directions} canWrite={canWrite} onToast={onToast} />
            </div>
          )
        ) : library.selected === null || library.document === null ? (
          <DetailEmpty label={t('library.empty_detail')} testId="lib-detail-empty" />
        ) : (
          <TemplateDetail
            ref_={library.selected}
            document={library.document}
            busy={library.busy}
            errorKey={library.errorKey}
            onSave={(text) => { void (async () => { if (await library.save(text)) onToast?.(t('common.done_saved')) })() }}
            onCopy={onCopy}
            onDelete={() => {
              const name = library.selected?.id ?? ''
              void (async () => { if (await library.remove()) onToast?.(t('common.done_deleted', { name })) })()
            }}
            onReload={() => { void library.reload() }}
          />
        )}
      />
      {dialogOpen && <NewTemplateDialog busy={library.busy} onClose={() => setDialogOpen(false)} onCreate={onCreate} />}
    </>
  )
}
