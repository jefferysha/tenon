import { useEffect, useState } from 'react'
import { useT } from '../i18n'
import { getHistory } from '../api/governanceClient'
import type { ChangeHistoryEntry } from '../api/governanceTypes'

export interface RecordItem {
  key: string
  kind: string
  ts: string
  label: string
  actor: string
}

function refName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  return /^(.+) <[^<>]+>$/.exec(value)?.[1] ?? value
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** Operator-facing rows only: creation, transitions, owner changes and review request / confirmation. */
export function recordItems(entries: readonly ChangeHistoryEntry[], t: (key: string) => string, stageLabelOf: (id: string) => string = (id) => id): RecordItem[] {
  const items: RecordItem[] = []
  entries.forEach((entry, index) => {
    let label: string | null = null
    if (entry.kind === 'init') label = t('workspace.record_init')
    else if (entry.kind === 'transition' && entry.from !== undefined && entry.to !== undefined) label = `${stageLabelOf(entry.from)} → ${stageLabelOf(entry.to)}`
    else if (entry.kind === 'set' && entry.field === 'assignee') label = `${t('workspace.facet_owner')} ${refName(entry.to) ?? ''}`.trim()
    else if (entry.kind === 'tool' && entry.raw?.startsWith('review:request') === true) label = t('workspace.record_review_request')
    else if (entry.kind === 'tool' && entry.raw?.startsWith('review:acknowledge') === true) label = t('workspace.record_review_ack')
    if (label !== null) items.push({ key: String(index), kind: entry.kind, ts: entry.ts, label, actor: entry.actor?.name ?? '—' })
  })
  return items
}

/** 记录 section: one row per operator record, `time · label · actor`. Refetches when `signature` changes. */
export function TaskRecords({ root, change, signature, stageLabelOf }: {
  root: string
  change: string
  signature: string
  /** 阶段 id → 展示名（label 优先）；缺省原样。 */
  stageLabelOf?: (id: string) => string
}): JSX.Element | null {
  const { t } = useT()
  const [entries, setEntries] = useState<readonly ChangeHistoryEntry[]>([])
  useEffect(() => {
    let active = true
    getHistory(change, root)
      .then((next) => { if (active) setEntries(next) })
      .catch(() => { if (active) setEntries([]) })
    return () => { active = false }
  }, [root, change, signature])
  const items = recordItems(entries, t, stageLabelOf)
  if (items.length === 0) return null
  return (
    <section className="mt-8" data-testid="task-records">
      <h2 className="mb-3 text-title font-semibold text-text">
        {t('workspace.records')}
        <span className="ml-2 font-mono text-caption font-normal text-text-3">{items.length}</span>
      </h2>
      <ul className="grid gap-1.5">
        {items.map((item) => (
          <li key={item.key} data-kind={item.kind} className="flex min-w-0 items-center gap-2 whitespace-nowrap text-body text-text-2">
            <span className="flex-none font-mono text-caption text-text-3">{formatTime(item.ts)}</span>
            <span className="flex-none text-text-3" aria-hidden="true">·</span>
            <span className="min-w-0 truncate text-text">{item.label}</span>
            <span className="flex-none text-text-3" aria-hidden="true">·</span>
            <span className="max-w-[16ch] flex-none truncate text-text-3" data-testid="task-record-actor">{item.actor}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}
