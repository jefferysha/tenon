import { FlaskConical } from 'lucide-react'
import { useT } from '../i18n'
import { StatusPill, type PillTone } from '../shell/ThreeColumns'
import { testStatusWord, type TestRow } from './stageTests'
import type { TestItemStatus } from '../types'
import { cn } from '@/lib/utils'
import { LIST_SELECTED } from '../shared/uiRecipes'

const STATUS_TONE: Record<TestItemStatus, PillTone> = {
  passed: 'done',
  failed: 'blocked',
  stale: 'pending',
  missing: 'neutral',
  running: 'pending',
}

const COLS = 'grid grid-cols-[minmax(0,1fr)_6rem_minmax(0,1fr)_6.5rem] items-center gap-4 whitespace-nowrap'

function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** 最近运行：耗时 · 时间 · 执行人，缺的项跳过。 */
function lastRun(row: TestRow): string {
  return [
    row.durationMs === undefined ? null : `${(row.durationMs / 1000).toFixed(1)}s`,
    row.finishedAt === undefined ? null : formatTime(row.finishedAt),
    row.actorName ?? null,
  ].filter((part): part is string => part !== null && part !== '').join(' · ')
}

/**
 * 所选阶段的测试 sheet：与 IO sheet 同款的带表头表 测试 · 类型 · 最近运行 · 状态，行间一条细分隔线。
 * 整行可点开抽屉（名称格里的按钮承担键盘路径）。标题由 sheet 页签承担。
 */
export function StageTestsPanel({
  rows,
  activeId,
  onOpen,
}: {
  rows: readonly TestRow[]
  activeId: string | null
  onOpen: (id: string) => void
}): JSX.Element {
  const { t } = useT()

  function row(item: TestRow): JSX.Element {
    const active = activeId === item.id
    const run = lastRun(item)
    return (
      <div
        key={item.id}
        className={cn(COLS, 'min-h-11 cursor-pointer border-b border-border px-1 py-1.5 text-body hover:bg-fill', active && LIST_SELECTED)}
        role="row"
        data-testid={`stage-test-${item.id}`}
        data-status={item.status}
        onClick={() => onOpen(item.id)}
      >
        <span className="flex min-w-0 items-center gap-2" role="cell">
          <FlaskConical className="size-4 flex-none text-text-3" aria-hidden="true" />
          <button
            type="button"
            className="min-w-0 truncate rounded-xs text-left font-semibold text-text outline-none focus-visible:ring-2 focus-visible:ring-(--accent)"
            aria-pressed={active}
            title={item.name}
            data-testid={`stage-test-open-${item.id}`}
            onClick={(event) => { event.stopPropagation(); onOpen(item.id) }}
          >
            {item.name}
          </button>
          {item.required && (
            <span
              className="inline-block size-1.5 flex-none rounded-full bg-(--accent)"
              title={t('workflow.test_required')}
              aria-label={t('workflow.test_required')}
              data-testid={`stage-test-required-${item.id}`}
            />
          )}
        </span>
        <span className="truncate font-mono text-caption text-text-2" role="cell" title={item.direction}>{item.direction}</span>
        <span className={cn('truncate font-mono text-caption', run === '' ? 'text-text-3' : 'text-text-2')} role="cell" title={run === '' ? undefined : run}>
          {run === '' ? '—' : run}
        </span>
        <span className="min-w-0" role="cell">
          <StatusPill tone={STATUS_TONE[item.status]}>{testStatusWord(item.status, t)}</StatusPill>
        </span>
      </div>
    )
  }

  return (
    <section data-testid="stage-tests">
      <div className="grid min-w-0" role="table" aria-label={t('workspace.tests')}>
        <div className={cn(COLS, 'border-b border-border px-1 pb-2 text-caption text-text-3')} role="row" data-testid="stage-tests-head">
          <span role="columnheader">{t('workspace.test_col_name')}</span>
          <span role="columnheader">{t('workspace.test_col_type')}</span>
          <span role="columnheader">{t('workspace.test_col_last_run')}</span>
          <span role="columnheader">{t('workspace.io_col_status')}</span>
        </div>
        {rows.length === 0
          ? <p className="py-3 text-body text-text-3" role="status">{t('workspace.none')}</p>
          : rows.map(row)}
      </div>
    </section>
  )
}
