import { useEffect, useMemo, useState, type MouseEvent } from 'react'
import { Layers, RefreshCw, TriangleAlert } from 'lucide-react'
import { fetchSkillSources, type SkillSourceRow, type SkillSourcesDto } from '../api/skillSourcesClient'
import { formatApiError } from '../api/transport'
import { useT } from '../i18n'
import { matchesQuery } from '../shell/GlobalSearch'
import { ListColumn, RailCard, RailColumn, ThreeColumns } from '../shell/ThreeColumns'
import { SkillDetailDrawer } from '../workflow/SkillDetail'
import { SHOWN_STATUS, SKILL_COLUMNS, SkillsTable, groupBySource, type SkillColumn } from './SkillsTable'
import { useSkillReferences } from './useSkillReferences'

type Filter = 'all' | 'changed' | 'failed'
type LoadState = { readonly kind: 'loading' } | { readonly kind: 'ok'; readonly view: SkillSourcesDto } | { readonly kind: 'error'; readonly detail: string }

const RAIL_KEY = 'tenon-dashboard-rail:skills'
const FILTERS: readonly { readonly id: Filter; readonly icon: JSX.Element }[] = [
  { id: 'all', icon: <Layers /> },
  { id: 'changed', icon: <RefreshCw /> },
  { id: 'failed', icon: <TriangleAlert /> },
]

function stamp(value: string | null | undefined): string {
  return value === null || value === undefined ? '—' : value.slice(0, 16).replace('T', ' ')
}

/**
 * 技能：每个 Tenon 内建与上游技能的来源、提交、许可证、更新时间与状态，只读。页面骨架与库 / 项目页一致：
 * 左栏是状态筛选（全部 · 变化 · 失败，带计数），中栏是标题 + 搜索 + 表，点行在共享的 SkillDetail 抽屉里打开。
 * 同来源的技能归成一组，来源是粘性小标题；「引用」列列出把它放进阶段技能的工作流 · 轨道 · 阶段，
 * 还没有任何引用数据时整列不出现；失败行的状态可展开，给出原因与可复制的修复命令。
 */
export function SkillsView(): JSX.Element {
  const { t } = useT()
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [railCollapsed, setRailCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(RAIL_KEY) === '1' } catch { return false }
  })
  useEffect(() => {
    try { localStorage.setItem(RAIL_KEY, railCollapsed ? '1' : '0') } catch { /* ignore */ }
  }, [railCollapsed])
  const references = useSkillReferences(state.kind === 'ok')
  const toggle = (id: string): void => setExpanded((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  useEffect(() => {
    let active = true
    fetchSkillSources()
      .then((view) => { if (active) setState({ kind: 'ok', view }) })
      .catch((error: unknown) => { if (active) setState({ kind: 'error', detail: formatApiError(error, t, { exposeServerDetail: true }) }) })
    return () => { active = false }
  }, [t])

  const rows = useMemo<readonly SkillSourceRow[]>(() => (state.kind === 'ok' ? state.view.rows : []), [state])
  const counts = useMemo(() => ({
    all: rows.length,
    changed: rows.filter((row) => row.status === 'changed').length,
    failed: rows.filter((row) => row.status === 'failed').length,
  }), [rows])
  const visible = rows.filter((row) => (filter === 'all' || row.status === filter) && matchesQuery(query, row.id, row.repo ?? ''))
  const groups = useMemo(() => groupBySource(visible, t('skills.source_tenon')), [visible, t])
  // 状态列只在可见行里有「变化 / 失败」时出现；引用列只在有任何一处引用时出现（还没数据就不占一整列「—」）。
  const showStatus = visible.some((row) => SHOWN_STATUS.has(row.status))
  const showUsed = rows.some((row) => (references.get(row.id)?.length ?? 0) > 0)
  const columns: readonly SkillColumn[] = SKILL_COLUMNS.filter((column) => (column === 'used' ? showUsed : column === 'status' ? showStatus : true))
  // 行内的链接（提交）照常跳转，不同时打开抽屉。
  const onRowClick = (event: MouseEvent<HTMLTableRowElement>, id: string): void => {
    if (event.target instanceof Element && event.target.closest('a, button') !== null) return
    setOpen(id)
  }

  const statusTitle = (row: SkillSourceRow): string => {
    if (row.status === 'bundled') return '—'
    if (row.status !== 'failed') return t(`skills.status_${row.status}`)
    const reason = row.reason === undefined ? t('skills.status_failed') : t(`skills.reason_${row.reason}`)
    return row.detail === undefined ? reason : `${reason} ${row.detail}`
  }

  const loaded = state.kind === 'ok'
  return (
    <>
      <ThreeColumns
        testId="skills-view"
        railCollapsed={railCollapsed}
        rail={(
          <RailColumn title={t('skills.col_status')} collapsed={railCollapsed} onToggle={() => setRailCollapsed((value) => !value)} testId="skills-rail">
            <div className="grid gap-1" role="group" aria-label={t('skills.col_status')} data-testid="skills-filter">
              {FILTERS.map(({ id, icon }) => (
                <RailCard
                  key={id}
                  mark={icon}
                  name={t(`skills.filter_${id}`)}
                  {...(loaded ? { count: counts[id] } : {})}
                  selected={filter === id}
                  collapsed={railCollapsed}
                  testId={`skills-filter-${id}`}
                  onClick={() => setFilter(id)}
                />
              ))}
            </div>
          </RailColumn>
        )}
        list={(
          <ListColumn
            testId="skills"
            title={t('nav.skills')}
            search={{ value: query, onChange: setQuery, placeholder: t('skills.search'), label: t('skills.search'), name: 'skills-search' }}
            action={loaded ? (
              <span className="whitespace-nowrap text-caption tabular-nums text-text-3" data-testid="skills-updated">{t('skills.updated')} {stamp(state.view.updatedAt)}</span>
            ) : undefined}
          >
            {state.kind === 'error' ? (
              <p className="whitespace-nowrap text-body text-red-d" role="alert" data-testid="skills-load-error">
                {t('skills.load_error')}：{state.detail}
              </p>
            ) : null}
            {loaded ? (
              <SkillsTable
                groups={groups}
                columns={columns}
                references={references}
                referenceYear={(state.view.updatedAt ?? '').slice(0, 4)}
                expanded={expanded}
                statusTitle={statusTitle}
                onToggle={toggle}
                onRowClick={onRowClick}
                onOpen={setOpen}
              />
            ) : null}
          </ListColumn>
        )}
        detail={null}
      />
      <SkillDetailDrawer name={open} onClose={() => setOpen(null)} />
    </>
  )
}
