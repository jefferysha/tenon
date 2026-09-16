import { useCallback, useEffect, useState } from 'react'
import { useT } from '../i18n'
import { Drawer } from '../shared/Drawer'
import { StatusPill } from '../shell/ThreeColumns'
import {
  fetchTestArtifactText, fetchTestRun, fetchTestRuns, testArtifactUrl,
  type TestRunDetail, type TestRunListEntry,
} from '../api/testEvidenceClient'
import { testStatusWord, type TestRow } from './stageTests'

const LOG_TAIL = 262_144
const IMAGE_RE = /\.(?:png|jpe?g|webp)$/iu

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function rows(record: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const value = record[key]
  return Array.isArray(value) ? value.filter(isRecord) : []
}

function short(digest: unknown): string {
  return typeof digest === 'string' && digest.startsWith('sha256:') ? `${digest.slice(7, 15)}…` : '—'
}

/** 一次运行的详情：输入、输出、日志、截图、trace 与历史。产物字节由 server 直供，不在前端拼路径。 */
export function TestRunDrawer({
  root,
  change,
  row,
  onClose,
}: {
  root: string
  change: string
  row: TestRow | null
  onClose: () => void
}): JSX.Element | null {
  const { t } = useT()
  const [history, setHistory] = useState<readonly TestRunListEntry[]>([])
  const [selected, setSelected] = useState<{ user: string; runId: string } | null>(null)
  const [detail, setDetail] = useState<TestRunDetail | null>(null)
  const [log, setLog] = useState<string | null>(null)
  const testId = row?.id ?? null

  useEffect(() => {
    setDetail(null)
    setLog(null)
    setSelected(row?.run === undefined ? null : { user: row.run.user, runId: row.run.runId })
    if (testId === null) { setHistory([]); return }
    const controller = new AbortController()
    void fetchTestRuns(root, change, testId, controller.signal)
      .then((entries) => setHistory(entries))
      .catch(() => setHistory([]))
    return () => controller.abort()
  }, [root, change, testId, row?.run])

  useEffect(() => {
    if (selected === null) { setDetail(null); return }
    const controller = new AbortController()
    void fetchTestRun(root, change, selected.user, selected.runId, controller.signal)
      .then((found) => setDetail(found))
      .catch(() => setDetail(null))
    return () => controller.abort()
  }, [root, change, selected])

  const openLog = useCallback(() => {
    if (selected === null) return
    const url = testArtifactUrl(root, change, selected.user, selected.runId, 'output.log', LOG_TAIL)
    void fetchTestArtifactText(url).then((text) => setLog(text)).catch(() => setLog(''))
  }, [root, change, selected])

  if (row === null) return null
  const record = detail?.record ?? null
  const files = detail?.artifacts.files ?? []
  const url = (path: string): string =>
    selected === null ? '' : testArtifactUrl(root, change, selected.user, selected.runId, path)
  return (
    <Drawer
      open
      onClose={onClose}
      testId="test-run-drawer"
      ariaLabel={`${row.name} ${testStatusWord(row.status, t)}`}
      title={(
        <span className="flex items-center gap-2">
          <span className="truncate">{row.name}</span>
          <StatusPill tone={row.status === 'passed' ? 'done' : row.status === 'failed' ? 'blocked' : 'neutral'}>
            {testStatusWord(row.status, t)}
          </StatusPill>
        </span>
      )}
    >
      <div className="grid gap-6 text-base">
        <section data-testid="test-run-inputs">
          <h3 className="mb-2 text-title font-semibold text-text">{t('workspace.test_inputs')}</h3>
          {record === null || rows(record, 'inputs').length === 0
            ? <p className="text-body text-text-3">—</p>
            : (
              <ul className="grid gap-1 font-mono text-caption text-text-2">
                {rows(record, 'inputs').map((input, index) => (
                  <li key={index} className="truncate" data-testid="test-run-input">
                    {String(input.kind)} · {String(input.ref ?? input.path ?? input.name ?? '')} · {short(input.digest)}
                  </li>
                ))}
              </ul>
            )}
        </section>
        <section data-testid="test-run-outputs">
          <h3 className="mb-2 text-title font-semibold text-text">{t('workspace.test_outputs')}</h3>
          {record === null || rows(record, 'outputs').length === 0
            ? <p className="text-body text-text-3">—</p>
            : (
              <ul className="grid gap-1 font-mono text-caption text-text-2">
                {rows(record, 'outputs').map((output, index) => {
                  const artifact = typeof output.artifact === 'string' ? output.artifact : null
                  const present = artifact !== null && files.includes(artifact)
                  return (
                    <li key={index} className="flex items-center gap-2 truncate" data-testid="test-run-output">
                      <span className="truncate">{String(output.path)} · {String(output.bytes ?? 0)}</span>
                      {present
                        ? <a className="flex-none text-(--accent) underline" href={url(artifact)} download data-testid="test-run-open">{t('workspace.test_open')}</a>
                        : <span className="flex-none text-text-3">—</span>}
                    </li>
                  )
                })}
              </ul>
            )}
        </section>
        <section data-testid="test-run-log">
          <h3 className="mb-2 text-title font-semibold text-text">{t('workspace.test_log')}</h3>
          {log === null
            ? (
              <button
                type="button"
                className="min-h-10 rounded-md border border-border bg-card px-4 text-base font-semibold text-text hover:border-text-3 disabled:opacity-60"
                data-testid="test-run-log-open"
                disabled={detail === null || !detail.artifacts.log}
                onClick={openLog}
              >
                {t('workspace.test_open')}
              </button>
            )
            : <pre className="max-h-64 overflow-auto rounded-md border border-border bg-card p-3 font-mono text-caption text-text-2" data-testid="test-run-log-text">{log}</pre>}
        </section>
        {files.some((file) => IMAGE_RE.test(file)) && (
          <section data-testid="test-run-screenshots">
            <h3 className="mb-2 text-title font-semibold text-text">{t('workspace.test_screenshot')}</h3>
            <div className="grid gap-2">
              {files.filter((file) => IMAGE_RE.test(file)).map((file) => (
                <img key={file} src={url(file)} alt={file} className="max-w-full rounded-md border border-border" data-testid="test-run-image" />
              ))}
            </div>
          </section>
        )}
        <section data-testid="test-run-history">
          <h3 className="mb-2 text-title font-semibold text-text">{t('workspace.test_history')}</h3>
          {history.length === 0
            ? <p className="text-body text-text-3">—</p>
            : (
              <ul className="grid gap-1">
                {history.map((entry) => (
                  <li key={`${entry.user}/${entry.runId}`}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 truncate rounded-md border border-border bg-card px-3 py-2 text-left font-mono text-caption text-text-2 hover:border-accent-b aria-pressed:border-accent-b"
                      aria-pressed={selected?.runId === entry.runId}
                      data-testid={`test-run-history-${entry.runId}`}
                      onClick={() => setSelected({ user: entry.user, runId: entry.runId })}
                    >
                      <span className="truncate">{entry.finishedAt} · {entry.actor.name} · {entry.result} · {(entry.durationMs / 1000).toFixed(1)}s</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
        </section>
      </div>
    </Drawer>
  )
}
