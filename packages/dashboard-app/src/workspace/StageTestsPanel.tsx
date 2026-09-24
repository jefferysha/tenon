import { FlaskConical } from 'lucide-react'
import { useT } from '../i18n'
import { StatusPill, type PillTone } from '../shell/ThreeColumns'
import { testStatusWord, type TestRow } from './stageTests'
import type { TestItemStatus } from '../types'
import { cn } from '@/lib/utils'
import { LIST_SELECTED } from './TaskCard'

const STATUS_TONE: Record<TestItemStatus, PillTone> = {
  passed: 'done',
  failed: 'blocked',
  stale: 'pending',
  missing: 'neutral',
  running: 'pending',
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** 所选阶段的测试 sheet：每行一项测试，点开看输入、输出、日志与历史。标题由 sheet 页签承担。 */
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
  return (
    <section data-testid="stage-tests">
      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-4 py-5 text-center text-body text-text-3" role="status">{t('workspace.none')}</p>
      ) : (
        <ul className="grid gap-2">
          {rows.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                className={cn(
                  'grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-md border bg-card px-4 py-3 text-left outline-none hover:border-accent-b focus-visible:ring-2 focus-visible:ring-(--accent)',
                  'border-border', activeId === row.id && LIST_SELECTED,
                )}
                aria-pressed={activeId === row.id}
                data-testid={`stage-test-${row.id}`}
                data-status={row.status}
                onClick={() => onOpen(row.id)}
              >
                <FlaskConical className="size-4 flex-none text-text-3" aria-hidden="true" />
                <span className="min-w-0">
                  <span className="block truncate text-base font-semibold text-text">
                    {row.name}
                    {row.required && (
                      <span
                        className="ml-2 inline-block size-1.5 rounded-full bg-(--accent) align-middle"
                        data-testid={`stage-test-required-${row.id}`}
                        aria-label={t('workflow.test_required')}
                      />
                    )}
                  </span>
                  <span className="block truncate font-mono text-caption text-text-2">
                    {[
                      row.direction,
                      row.durationMs === undefined ? null : `${(row.durationMs / 1000).toFixed(1)}s`,
                      row.finishedAt === undefined ? null : formatTime(row.finishedAt),
                      row.actorName ?? null,
                    ].filter((part): part is string => part !== null && part !== '').join(' · ')}
                  </span>
                </span>
                <span className="flex-none">
                  <StatusPill tone={STATUS_TONE[row.status]}>{testStatusWord(row.status, t)}</StatusPill>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
