import { Fragment, type MouseEvent } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { SkillSourceRow } from '../api/skillSourcesClient'
import { useT } from '../i18n'
import { CountRoll } from '../shared/CountRoll'
import { SkillFailureRow } from './SkillFailureRow'
import { referenceText, type SkillReference } from './useSkillReferences'

const CELL = 'truncate whitespace-nowrap px-3 py-2'
/** 表头与分组小标题都是 36px 高（h-9）：小标题贴在表头下面（top-9），两层粘性互不遮挡。 */
const HEAD = `${CELL} sticky top-0 z-20 h-9 border-b border-border bg-card text-left font-semibold text-text-2`
const GROUP = 'sticky top-9 z-10 h-9 truncate whitespace-nowrap bg-card px-3 text-left text-caption font-semibold text-text-2'
/** 链接平时是正文色，强调色只在悬停时出现。 */
const LINK = 'rounded-xs outline-none underline-offset-4 hover:text-(--accent) hover:underline focus-visible:ring-2 focus-visible:ring-(--accent)'

export const SKILL_COLUMNS = ['skill', 'used', 'commit', 'license', 'updated', 'status'] as const
export type SkillColumn = (typeof SKILL_COLUMNS)[number]
const COLUMN_WIDTHS: Record<SkillColumn, string> = {
  skill: 'w-[34%]', used: 'w-[24%]', commit: 'w-[14%]', license: 'w-[10%]', updated: 'w-[12%]', status: 'w-24',
}
const STATUS_TONE: Record<SkillSourceRow['status'], string> = {
  changed: 'text-amber-d', unchanged: 'text-text-2', failed: 'text-red-d', bundled: 'text-text-3',
}
/** 状态列只在「有事」时出字：变化 / 失败。无变化与随包技能留空，不在每一行重复同一个词。 */
export const SHOWN_STATUS: ReadonlySet<SkillSourceRow['status']> = new Set(['changed', 'failed'])

/** 一组 = 同一个来源（内建，或一个上游仓库）；组内保持服务端给的顺序。 */
export interface SkillGroup {
  readonly key: string
  readonly label: string
  readonly rows: readonly SkillSourceRow[]
}

export function groupBySource(rows: readonly SkillSourceRow[], builtinLabel: string): SkillGroup[] {
  const groups = new Map<string, SkillSourceRow[]>()
  for (const row of rows) {
    const key = row.origin === 'tenon' ? '' : row.repo ?? ''
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  return [...groups].map(([key, members]) => ({ key, label: key === '' ? builtinLabel : key, rows: members }))
}

function full(value: string | null | undefined): string {
  return value === null || value === undefined ? '—' : value.slice(0, 16).replace('T', ' ')
}

/** 表里的更新时间用短格式：与页头「更新」同一年只写 `09-21`，跨年才带年；完整时间在 title。 */
export function shortDate(value: string | null | undefined, referenceYear: string): string {
  if (value === null || value === undefined) return '—'
  return value.slice(0, 4) === referenceYear ? value.slice(5, 10) : value.slice(0, 10)
}

function short(commit: string): string {
  return commit.slice(0, 7)
}

function CommitCell({ row }: { readonly row: SkillSourceRow }): JSX.Element {
  if (row.commit === undefined) return <td className={`${CELL} text-text-3`}>—</td>
  const cell = `${CELL} font-mono text-text-3`
  const previous = row.status === 'changed' && typeof row.previousCommit === 'string' ? row.previousCommit : null
  if (previous !== null && row.compareUrl !== undefined) {
    const label = `${short(previous)}→${short(row.commit)}`
    return (
      <td className={cell} title={`${previous}→${row.commit}`}>
        <a className={LINK} href={row.compareUrl} target="_blank" rel="noreferrer" data-testid={`skills-compare-${row.id}`}>{label}</a>
      </td>
    )
  }
  return (
    <td className={cell} title={row.commit}>
      {row.commitUrl === undefined ? short(row.commit) : <a className={LINK} href={row.commitUrl} target="_blank" rel="noreferrer">{short(row.commit)}</a>}
    </td>
  )
}

/** 引用列：第一处引用 + 「+N」，全部引用在悬停提示里（一行一处）。 */
function UsedCell({ id, references }: { readonly id: string; readonly references: readonly SkillReference[] }): JSX.Element {
  const first = references[0]
  if (first === undefined) return <td className={`${CELL} text-text-3`} data-testid={`skills-used-${id}`}>—</td>
  return (
    <td className={`${CELL} text-text-2`} title={references.map(referenceText).join('\n')} data-testid={`skills-used-${id}`}>
      {referenceText(first)}
      {references.length > 1 && <span className="ml-1.5 tabular-nums text-text-3">+{references.length - 1}</span>}
    </td>
  )
}

/**
 * 技能表：同来源的行归在一组，来源名是粘性小标题（不在每一行重复「obra/superpowers」）；列 = 技能 · 引用 · 提交 ·
 * 许可证 · 更新 · 状态，其中「引用」在还没有任何引用数据时不出现，「状态」只在有变化 / 失败时出现。
 * 整行悬停（背景在 tr 上，不是逐格）；技能名是比例字 500，等宽只留给提交哈希。
 */
export function SkillsTable({ groups, columns, references, referenceYear, expanded, statusTitle, onToggle, onRowClick, onOpen }: {
  groups: readonly SkillGroup[]
  columns: readonly SkillColumn[]
  references: ReadonlyMap<string, readonly SkillReference[]>
  referenceYear: string
  expanded: ReadonlySet<string>
  statusTitle: (row: SkillSourceRow) => string
  onToggle: (id: string) => void
  onRowClick: (event: MouseEvent<HTMLTableRowElement>, id: string) => void
  onOpen: (id: string) => void
}): JSX.Element {
  const { t } = useT()
  return (
    <div data-testid="skills-table">
      <table className="w-full table-fixed border-separate border-spacing-0 text-caption">
        <colgroup>{columns.map((column) => <col key={column} className={COLUMN_WIDTHS[column]} />)}</colgroup>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column} className={HEAD} scope="col">{t(`skills.col_${column}`)}</th>
            ))}
          </tr>
        </thead>
        {groups.map((group) => (
          <tbody key={group.key} aria-label={group.label} data-testid={`skills-group-${group.key === '' ? 'builtin' : group.key}`}>
            <tr>
              <td colSpan={columns.length} className={GROUP} title={group.label} data-testid={`skills-group-head-${group.key === '' ? 'builtin' : group.key}`}>
                {group.label}
                <span className="ml-2 font-normal text-text-3"><CountRoll value={group.rows.length} /></span>
              </td>
            </tr>
            {group.rows.map((row) => (
              <Fragment key={row.id}>
                <tr
                  className="cursor-pointer transition-colors hover:bg-fill motion-reduce:transition-none"
                  data-testid={`skills-row-${row.id}`}
                  onClick={(event) => onRowClick(event, row.id)}
                >
                  <td className={CELL} title={row.repo === undefined ? row.id : `${row.id} · ${row.repo}${row.path === undefined ? '' : `:${row.path}`}`}>
                    <button
                      type="button"
                      className={`max-w-full truncate font-medium text-text ${LINK}`}
                      data-testid={`skills-open-${row.id}`}
                      onClick={() => onOpen(row.id)}
                    >
                      {row.id}
                    </button>
                  </td>
                  {columns.includes('used') && <UsedCell id={row.id} references={references.get(row.id) ?? []} />}
                  <CommitCell row={row} />
                  <td className={`${CELL} text-text-2`} title={row.license ?? '—'}>{row.license ?? '—'}</td>
                  <td className={`${CELL} tabular-nums text-text-2`} title={full(row.fetchedAt)}>{shortDate(row.fetchedAt, referenceYear)}</td>
                  {columns.includes('status') && (
                    <td className={`${CELL} ${STATUS_TONE[row.status]}`} title={statusTitle(row)} data-testid={`skills-status-${row.id}`}>
                      {row.status === 'failed' ? (
                        <button
                          type="button"
                          className={`inline-flex max-w-full items-center gap-1 ${LINK}`}
                          aria-expanded={expanded.has(row.id)}
                          data-testid={`skills-expand-${row.id}`}
                          onClick={() => onToggle(row.id)}
                        >
                          {expanded.has(row.id) ? <ChevronDown className="size-3.5 flex-none" aria-hidden="true" /> : <ChevronRight className="size-3.5 flex-none" aria-hidden="true" />}
                          <span className="truncate">{t('skills.status_failed')}</span>
                        </button>
                      ) : SHOWN_STATUS.has(row.status) ? t(`skills.status_${row.status}`) : ''}
                    </td>
                  )}
                </tr>
                {row.status === 'failed' && expanded.has(row.id) && (
                  <SkillFailureRow id={row.id} reason={statusTitle(row)} columns={columns.length} />
                )}
              </Fragment>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  )
}
