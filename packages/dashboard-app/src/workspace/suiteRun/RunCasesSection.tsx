import { useState } from 'react'
import { ChevronDown, ChevronRight, Download } from 'lucide-react'
import { useT } from '../../i18n'
import { COUNT_BADGE, TABLE_HEAD, TABLE_ROW, gridRow } from '../../tests/testStyles'
import { CaseStateMark } from '../../tests/TestState'
import { TestSection } from '../../tests/TestSection'
import { dataMessage, firstLine } from '../../tests/testText'
import type { RunArtifact, RunCase, SuiteRun } from '../../api/testSystemTypes'
import { runHref, type RunContext } from './runContext'

const COLUMNS = 'grid-cols-[1.25rem_minmax(0,1.6fr)_minmax(0,1.2fr)_minmax(0,2fr)_6rem_5.5rem]'
const ORDER: Readonly<Record<string, number>> = { fail: 0, 'known-fail': 1, flaky: 2 }
const IMAGE = /\.(?:png|jpe?g|webp|gif)$/iu
/** 报告没给用例所属文件时，记录里存的哨兵值（kernel UNKNOWN_CASE_FILE，记录契约的一部分）；页面上写「未报告文件」。 */
const NO_FILE_SENTINEL = '(unknown)'

function isListed(item: RunCase): boolean {
  return item.status === 'fail' || item.status === 'known-fail' || item.status === 'flaky'
}

function CaseDetail({ item, ctx, present, onZoom }: {
  item: RunCase
  ctx: RunContext
  present: ReadonlySet<string>
  onZoom: (path: string) => void
}): JSX.Element {
  const { t } = useT()
  const failure = item.failure
  const links = item.artifacts.filter((path) => present.has(path))
  return (
    <div className="grid gap-2 border-b border-border bg-fill/40 px-3 py-2" data-testid="run-case-detail">
      {failure?.stack !== undefined && (
        <div className="grid gap-1">
          <span className="whitespace-nowrap text-caption text-text-3">{t('tests.run.cases.stack')}</span>
          <pre className="max-h-48 overflow-auto whitespace-pre rounded-sm border border-border bg-(--code-bg) p-2 font-mono text-caption text-text-2" data-testid="run-case-stack">{failure.stack}</pre>
        </div>
      )}
      {(failure?.expected !== undefined || failure?.actual !== undefined) && (
        <div className="grid grid-cols-2 gap-3" data-testid="run-case-diff">
          {failure?.expected !== undefined && (
            <div className="grid min-w-0 gap-1">
              <span className="whitespace-nowrap text-caption text-text-3">{t('tests.run.cases.expected')}</span>
              <pre className="max-h-32 overflow-auto whitespace-pre rounded-sm border border-border bg-(--code-bg) p-2 font-mono text-caption text-text-2" data-testid="run-case-expected">{failure.expected}</pre>
            </div>
          )}
          {failure?.actual !== undefined && (
            <div className="grid min-w-0 gap-1">
              <span className="whitespace-nowrap text-caption text-text-3">{t('tests.run.cases.actual')}</span>
              <pre className="max-h-32 overflow-auto whitespace-pre rounded-sm border border-border bg-(--code-bg) p-2 font-mono text-caption text-text-2" data-testid="run-case-actual">{failure.actual}</pre>
            </div>
          )}
        </div>
      )}
      {links.length > 0 && (
        <ul className="flex min-w-0 flex-nowrap items-center gap-3 overflow-x-auto" data-testid="run-case-artifacts">
          {links.map((path) => (
            <li key={path} className="flex-none whitespace-nowrap">
              {IMAGE.test(path)
                ? <button type="button" className="font-mono text-caption text-(--accent) underline" onClick={() => onZoom(path)} data-testid="run-case-image">{path.split('/').pop()}</button>
                : (
                  <a className="inline-flex items-center gap-1 font-mono text-caption text-(--accent) underline" href={runHref(ctx, path)} download data-testid="run-case-file">
                    <Download className="size-3.5" aria-hidden="true" />{path.split('/').pop()}
                  </a>
                )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** 失败用例：名称 · 位置 · 消息 · 浏览器 · 状态；每行可展开看堆栈与 expected / actual。 */
export function RunCasesSection({ run, ctx, onZoom }: { run: SuiteRun; ctx: RunContext; onZoom: (path: string) => void }): JSX.Element | null {
  const { t } = useT()
  const [open, setOpen] = useState<string | null>(null)
  const items = run.cases.filter(isListed).sort((left, right) => (ORDER[left.status] ?? 9) - (ORDER[right.status] ?? 9))
  if (items.length === 0) return null
  const present = new Set(run.artifacts.filter((artifact: RunArtifact) => artifact.present).map((artifact) => artifact.path))
  return (
    <TestSection
      title={t('tests.run.section.cases')}
      count={items.length}
      testId="run-cases"
      action={run.casesTruncated ? <span className={COUNT_BADGE} title={t('tests.run.artifact.truncated')} data-testid="run-cases-truncated">{run.cases.length}+</span> : undefined}
    >
      <div role="table" aria-label={t('tests.run.section.cases')}>
        <div className={`${gridRow(COLUMNS)} ${TABLE_HEAD}`} role="row">
          <span role="columnheader" />
          <span role="columnheader">{t('tests.run.cases.name')}</span>
          <span role="columnheader">{t('tests.run.cases.location')}</span>
          <span role="columnheader">{t('tests.run.cases.message')}</span>
          <span role="columnheader">{t('tests.run.cases.browser')}</span>
          <span role="columnheader">{t('tests.word.result')}</span>
        </div>
        {items.map((item, index) => {
          const key = `${item.file}\u0000${item.name}\u0000${item.project ?? ''}\u0000${index}`
          const expanded = open === key
          const name = [...item.suitePath, item.name].join(' › ')
          const file = item.file === NO_FILE_SENTINEL ? t('tests.run.cases.no_file') : item.file
          const location = item.line === undefined ? file : `${file}:${item.line}`
          const full = item.failure === undefined ? '' : dataMessage(item.failure)
          const message = full === '' ? '—' : firstLine(full)
          return (
            <div key={key} data-testid="run-case" data-status={item.status}>
              <div className={`${gridRow(COLUMNS)} ${TABLE_ROW}`} role="row">
                <span role="cell">
                  <button
                    type="button"
                    className="grid size-5 place-items-center rounded-xs text-text-3 outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent)"
                    aria-expanded={expanded}
                    aria-label={`${expanded ? t('tests.run.cases.collapse') : t('tests.run.cases.expand')} ${name}`}
                    data-testid="run-case-toggle"
                    onClick={() => setOpen(expanded ? null : key)}
                  >
                    {expanded ? <ChevronDown className="size-4" aria-hidden="true" /> : <ChevronRight className="size-4" aria-hidden="true" />}
                  </button>
                </span>
                <span className="truncate font-semibold text-text" role="cell" title={name} data-testid="run-case-name">{name}</span>
                <span className="truncate font-mono text-caption text-text-2" role="cell" title={location} data-testid="run-case-location">{location}</span>
                <span className="truncate font-mono text-caption text-text-2" role="cell" title={full} data-testid="run-case-message">{message}</span>
                <span className="truncate font-mono text-caption text-text-3" role="cell">{item.project ?? '—'}</span>
                <span role="cell"><CaseStateMark status={item.status} /></span>
              </div>
              {expanded && <CaseDetail item={item} ctx={ctx} present={present} onZoom={onZoom} />}
            </div>
          )
        })}
      </div>
    </TestSection>
  )
}
